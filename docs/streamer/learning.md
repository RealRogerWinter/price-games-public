---
title: Streamer — Learning
status: beta
last_reviewed: 2026-06-03
owner: streamer
audience: contributor
category: streamer
summary: "The online-learning MLP: architecture, replay buffer, worker isolation, operational guards."
related_code:
  - packages/bot-streamer/src/learning
---
# Streamer Bot — Online Learning

> The bot learns from every round it plays. This doc covers the neural-net architecture, the worker-thread isolation, the operational guards, and the manual-ops commands. For the surrounding loop, see [`architecture.md`](./architecture.md). For the operator runbook (rollback, force-heuristic, snapshots), the canonical source is [`../STREAMER.md`](../STREAMER.md).

## The architecture in one breath

A tiny (~4,800 parameter) MLP runs in a Node worker thread, trains online from gameplay outcomes, and answers price-classification queries on a 150 ms staleness budget. When it can't answer in time, the strategy falls back to the heuristic. Six operational guards keep the system from wedging the bot during incidents (NaN-storms, disk pressure, worker stalls).

```
┌──────────────────────────────────────────────────────────────────────────┐
│ Main thread                              Worker thread                   │
│                                                                          │
│  LearningBridge ───── postMessage ─────▶ runWorkerLoop                   │
│      │                                       │                           │
│      │                                       ▼                           │
│      │  predict(req, 150ms budget)      featureExtractor                 │
│      │  ◀───────────────── PredictRes ────── │                           │
│      │                                       ▼                           │
│      │  update(roundOutcome) ──────────▶  replayBuffer (prioritized)     │
│      │                                       │                           │
│      │                                       ▼                           │
│      │                                  forward + backward + AdamW       │
│      │                                       │                           │
│      │                                       ▼                           │
│      │  ◀────── heartbeat (every 1s) ── NDJSON log + snapshots           │
│      │                                                                    │
│      ▼                                                                    │
│   /healthz includes learning block                                       │
│   /reset-learning POST → bridge.reset()                                  │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘
```

The bridge ([`src/learning/bridge.ts`](../../packages/bot-streamer/src/learning/bridge.ts)) is the only thing the runner talks to. The worker ([`src/learning/worker.ts`](../../packages/bot-streamer/src/learning/worker.ts), [`workerCore.ts`](../../packages/bot-streamer/src/learning/workerCore.ts)) does all the math.

## Operating modes

```typescript
type LearningMode = "off" | "shadow" | "active";
```

- **`off`** — the bridge no-ops. `predict()` always returns null, `update()` is dropped, no worker is spawned. Cheapest mode; effectively disables the learning subsystem.
- **`shadow`** — the worker runs (`predict` returns real predictions, `update` trains the model), but the strategy **ignores** predictions when picking candidates. Used to gather training data and watch loss curves without changing the bot's behavior. Safe rollout step before going `active`.
- **`active`** — predictions flow into `StrategyContext.nnPrediction` and drive candidate selection.

Set via `STREAMER_LEARNING_ENABLED=true` + `STREAMER_LEARNING_MODE=active`.

The `LEARNING_FORCE_HEURISTIC=1` env var (matching `1` / `true` / `yes`, case-insensitive) takes precedence over both and forces `off`. This is the kill-switch — an operator paging in mid-incident can flip one env var without re-checking the existing bridge config. Unrecognized values to this env var print a warning to stderr so an operator who typed `on` instead of `true` doesn't get silent no-op.

## The MLP

[`src/learning/mlp.ts`](../../packages/bot-streamer/src/learning/mlp.ts).

```
trunk:           Linear(124 → 32) → ReLU → Linear(32 → 16)
priceClassHead:  Linear(16 → K)   softmax over K canonical price classes
filmGen:         Linear(3 → 32)   mood conditioning (γ, β each 16-d, tanh-bounded)
```

- **~4,800 parameters total.** ~38 KB on disk. Cold-start is microseconds.
- **Hand-rolled.** Float32Array + manual loops. A tensor-library dependency would dwarf the network itself and slow cold-start. The trade-off: we own the serialization format byte-for-byte (so snapshots are stable across versions until `archHash` bumps).
- **Single objective: price classification.** Earlier iterations had a multi-task design (regression + pairs + category + tier + viz heads); PR-4 collapsed it to a single price-class head. The trunk is now shaped purely by the classification loss. Multi-task snapshots auto-archive on next start (the `archHash` constant bumps when the architecture changes — see [`src/learning/archHash.ts`](../../packages/bot-streamer/src/learning/archHash.ts)).
- **FiLM-style mood conditioning.** Three mood scalars (`arousal`, `valence`, `dominance`) go through a small generator → tanh-bounded γ and β that scale and shift the trunk's first hidden activations. So mood doesn't just pick a line; it actually warps the embedding.

The 124-d feature vector breaks down as 50 engineered features + 64 hashed-bigram features + 10 (unused / padding). See `FEATURE_DIM` and the breakdown in [`src/learning/featureExtractor.ts`](../../packages/bot-streamer/src/learning/featureExtractor.ts) and [`types.ts`](../../packages/bot-streamer/src/learning/types.ts).

## Features

```
Engineered (50):
  1   log(heuristic_cents + 1) / 12          ← the heuristic prior
  2   log(title_length + 1) / 6
  3   digit_count / 10
  4   log(description_length + 1) / 8
  5   has_image          (0/1)
  6   has_description    (0/1)
  7   has_reference_price (0/1)
  8   log(reference_price + 1) / 12
  9   uppercase_ratio
  10  punctuation_count / max(1, title_length)
  11..37   27 token-multiplier presence flags (mirrors heuristic table)
  38..49   12-mode one-hot
  50  has_pair_role     (0/1)

Hashed bigrams (64):
  Weinberger signed hash of consecutive char bigrams of the lowercased title.
  L2-normalized → magnitude independent of title length.
```

The output is **deterministic** for a given input — so the same product produces the same feature vector at predict time and update time, with no drift. This is what makes online training stable.

EMA normalization ([`src/learning/normalizer.ts`](../../packages/bot-streamer/src/learning/normalizer.ts)) shifts each engineered feature toward μ=0, σ=1 over a rolling window with a warmup grace period. Hashed bigrams are L2-normalized at extraction time and not re-normalized.

## Training loop

Per round:

1. **Feature extraction** from the round's products + mode.
2. **Forward pass** → logits → softmax over price classes → loss against the observed price's class.
3. **Backward pass.** GANE-style CMAR signed-credit-gain weighting from mood: high-arousal outcomes weight gradients more heavily. See [`src/persona/moodScale.ts`](../../packages/bot-streamer/src/persona/moodScale.ts) → `signedCreditGain`.
4. **AdamW step** ([`src/learning/adamw.ts`](../../packages/bot-streamer/src/learning/adamw.ts)) — `lr ≈ 1e-3`, `weight_decay ≈ 1e-4`.
5. **Sample from the replay buffer** (prioritized; high-loss samples re-weighted) and step again on the replay sample for a small reps count.
6. **Idle snapshot.** If no `predict` has come in for `≥2s`, write the current weights to disk so a container restart resumes from where we were.

Per-round overhead is `<2 ms` on one core. Snapshots are a few ms.

## Predict budget (150 ms)

[`src/learning/bridge.ts`](../../packages/bot-streamer/src/learning/bridge.ts) → `predict(req)`:

- The bridge posts the request to the worker and starts a 150 ms timer.
- If the worker answers in time → resolves with `PredictRes`.
- If the timer fires first → resolves with `null` and increments `staleResponses`. The strategy falls back to the heuristic.

Why 150 ms? Frame budget at 30 fps is ~33 ms; 150 ms is roughly 5 frames of tolerance — invisible to the audience.

## Operational guards

Six guards, all visible in `GET /healthz`'s `learning` block:

| # | Guard | Trigger | Action |
|---|---|---|---|
| 1 | Worker heartbeat | No heartbeat for >30s | Bridge respawns the worker |
| 2 | NaN-storm freeze | >10 step-rollbacks/hour (NaN gradients detected, weights restored from pre-step copy) | Freeze training (skip AdamW); auto-thaw after 10 min of clean steps |
| 3 | Disk pressure | `≥80%` disk used | Pause NDJSON log writes. `≥90%` → also stop snapshots |
| 4 | Snapshot age | Latest snapshot >10 min old during active stream | Ops dashboard alert only (no auto-action) |
| 5 | DB latency | `p95 > 50 ms` on snapshot writes | Telemetry only (suggests host iostat issue) |
| 6 | Predict latency | `>150 ms` | Stale response, fall back to heuristic |

Guards 1, 2, 3 are auto-recoverable. Guards 4 and 5 are alert-only — they tell the operator something's wrong with the host, not the bot itself. Guard 6 is per-call.

## Persistence layout

`STREAMER_LEARNING_DATA_DIR` (default `/var/streamer/data`) holds:

```
data/
├── learning.db                         # SQLite — brand tiers, golden eval, replay metadata
├── snapshots/
│   ├── snapshot_<archHash>_<ts>.bin    # weights blob (latest plus N rotated)
│   └── current → snapshot_…bin         # symlink to active snapshot
├── round_log.ndjson                    # one row per round (NDJSON), rotated daily
└── archive/                            # old-arch snapshots auto-moved here on archHash bump
```

`archHash` ([`src/learning/archHash.ts`](../../packages/bot-streamer/src/learning/archHash.ts)) is a content hash of the network's structural constants. Bumping `MODEL_SPEC` bumps the hash; on next boot, old-arch snapshots auto-archive rather than getting loaded into the wrong shape.

## Manual ops

```bash
# Inspect learning health
curl -H "X-Streamer-Bot: $STREAMER_BOT_SECRET" http://127.0.0.1:9101/healthz | jq .learning

# Force-flush a snapshot (POST endpoint exposed via the runner's health server when STREAMER_LEARNING_DEBUG=1)
# Otherwise rely on the idle-write auto-snapshot

# Reset learning state (warning: wipes the brain)
curl -X POST -H "X-Streamer-Bot: $STREAMER_BOT_SECRET" http://127.0.0.1:9101/reset-learning

# Roll back to round N (filename pattern under data/snapshots/)
./scripts/nn-rollback.sh <round_number>
```

For long-form runbooks (incident playbooks, partial rollback, what to do if NaN-storm hits while you're asleep), see [`../STREAMER.md`](../STREAMER.md).

## Why a worker thread?

Three reasons:

1. **No event-loop blocking.** A 2-ms forward+backward step on the main thread would still be 2 ms of latency added to Socket.IO ack handling and ffmpeg PCM forwarding. Isolating to a worker decouples them.
2. **Crash isolation.** If the network code throws an unhandled exception (rare, but possible during arch changes), the worker dies and the bridge auto-respawns. The main runner keeps streaming.
3. **Snapshot/rollback testability.** The worker's contract is `WorkerInbound` / `WorkerOutbound` message pairs. A test transport substitutes for `worker_threads.Worker` so we can drive the worker core in-process for unit tests.

The transport interface ([`WorkerTransport`](../../packages/bot-streamer/src/learning/bridge.ts)) is what the test suite uses — see [`packages/bot-streamer/tests/learning/`](../../packages/bot-streamer/tests/learning/) for patterns.

## Test patterns

The learning subsystem has the highest test-to-source ratio in the bot. Cover the math (forward/backward gradient checks), the bridge (predict timeout, update fan-out, worker respawn), and the integration (snapshot round-trip, archHash auto-archive). See:

- [`packages/bot-streamer/tests/learning/`](../../packages/bot-streamer/tests/learning/) — unit tests for MLP, normalizer, replay buffer, losses, brand-tier table, golden eval, OOD blender.
- [`tests/strategies.nn.test.ts`](../../packages/bot-streamer/tests/strategies.nn.test.ts) — strategies + NN integration with fake `nnPrediction`.

A gradient check ([`tests/learning/mlp.gradient.test.ts`](../../packages/bot-streamer/tests/learning/) — pattern) numerically estimates ∂loss/∂W via finite differences and compares against the backward pass. Catches sign / index bugs that produce nominally working but mathematically wrong gradients.

## Tuning levers

| Env var / constant | What it does |
|---|---|
| `STREAMER_LEARNING_PREDICT_TIMEOUT_MS` | Override the 150 ms budget (lower → more stale responses, less stall risk) |
| `STREAMER_LEARNING_LR` | Override AdamW learning rate (default 1e-3) |
| `STREAMER_LEARNING_REPLAY_REPS` | Steps to take on replay-buffer samples per round (default 4) |
| `LEARNING_FORCE_HEURISTIC=1` | Kill-switch — bypass NN entirely |
| `MODEL_SPEC` constants in `types.ts` | Architectural changes (dims, layers). Bumping these bumps `archHash`. |
