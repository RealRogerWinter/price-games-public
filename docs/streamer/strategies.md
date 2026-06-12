---
title: Streamer — Strategies
status: stable
last_reviewed: 2026-06-03
owner: streamer
audience: contributor
category: streamer
summary: "How the bot decides what to do per game mode, and how to add a new strategy."
related_code:
  - packages/bot-streamer/src/strategies
---
# Streamer Bot — Strategies

> How the bot decides what to do every round. For the surrounding loop, see [`architecture.md`](./architecture.md).

## The contract

Every game mode that the bot can play has a strategy. The interface, in [`src/strategies/types.ts`](../../packages/bot-streamer/src/strategies/types.ts):

```typescript
interface ModeStrategy {
  mode: GameMode;
  /**
   * Returns a list of candidate answers with scores in [0, 1].
   * Pure function — no I/O, no clock, no socket. RNG is injected
   * via ctx for deterministic tests.
   */
  candidates(round: RoundStartPayload, ctx?: StrategyContext): StrategyCandidate[];
}

type StrategyCandidate = ScoredCandidate<GuessData> & {
  /** Plain-text reason — surfaced via TTS when viewers hit !hint. */
  rationale: string;
};
```

Strategies are **pure functions**. They never touch the network, the DOM, or the wall clock. RNG, NN predictions, and per-game opponent posteriors are all injected via `StrategyContext`. This is what lets the strategy layer be fully unit-tested with a few hundred lines of fixtures.

## Flow per round

```
RoundStartPayload (from observer)
       │
       ▼
strategyFor(mode) — registry lookup
       │
       ▼
strategy.candidates(round, ctx) → [{ guess, score, rationale }, ...]
       │
       ▼
Softmax sampler (temperature ← state.skillTemperature × mood multiplier)
       │
       ▼
Chosen candidate
       │
       ▼
Enactor for this mode — drives the actual UI
```

The softmax temperature comes from two places:
- `skillTemperature` (default 0.35; tunable live via `!skill easy|normal|hard`)
- Mood multiplier (focused tightens, despondent loosens)

Higher temperature → more random; lower → the bot more often picks its top candidate.

## The registry

Strategies are looked up by mode in [`src/strategies/index.ts`](../../packages/bot-streamer/src/strategies/index.ts):

```typescript
strategyFor(mode: GameMode): ModeStrategy  // throws if no strategy registered
hasStrategy(mode: GameMode): boolean
```

`strategyFor` **throws** rather than returning undefined so the lifecycle controller fails fast on a misconfigured rotation. Modes the bot doesn't yet play would never appear in a rotation anyway, but defense in depth.

## What ships today

| File | Mode(s) it handles | Notes |
|---|---|---|
| [`classic.ts`](../../packages/bot-streamer/src/strategies/classic.ts) | `classic` | Estimate around heuristic/NN centerpoint, candidates spread by log-noise. |
| [`higher-lower.ts`](../../packages/bot-streamer/src/strategies/higher-lower.ts) | `higher-lower` | Binary choice based on reference vs. estimate comparison. |
| [`comparison.ts`](../../packages/bot-streamer/src/strategies/comparison.ts) | `comparison` | Pick the more expensive of two products by estimate margin. |
| [`closest.ts`](../../packages/bot-streamer/src/strategies/closest.ts) | `closest-without-going-over` | Bid just under estimate; candidates undercut by varying margins. |
| [`riser.ts`](../../packages/bot-streamer/src/strategies/riser.ts) | `riser` | Stop the rising-price bar around the estimate; mood widens the band. |
| [`odd-one-out.ts`](../../packages/bot-streamer/src/strategies/odd-one-out.ts) | `odd-one-out` | Cluster three estimates, pick the outlier. |
| [`market-basket.ts`](../../packages/bot-streamer/src/strategies/market-basket.ts) | `market-basket` | Greedy bin-packing toward the budget. |
| [`sort-it-out.ts`](../../packages/bot-streamer/src/strategies/sort-it-out.ts) | `sort-it-out` | Sort by estimate; candidates introduce neighbor swaps. |
| [`chain-reaction.ts`](../../packages/bot-streamer/src/strategies/chain-reaction.ts) | `chain-reaction` | Sequential sub-guesses; carries over confidence between links. |
| [`bidding.ts`](../../packages/bot-streamer/src/strategies/bidding.ts) | `bidding` | Position-conditional bidding strategy. Reads `BiddingTurnPayload` from `ctx.turn` and the per-opponent posterior from `ctx.opponentPosteriors`. Falls back to closest-style safe bid when no turn context (single-player daily). |

The shared **softmax sampling** infrastructure lives in [`src/realism/softmax.ts`](../../packages/bot-streamer/src/realism/softmax.ts). Strategies emit `ScoredCandidate<T>` and the sampler picks one based on temperature.

## NN integration

When the learning bridge is enabled (`STREAMER_LEARNING_ENABLED=true` and `STREAMER_LEARNING_MODE=active`), the runner queries the NN for each round and threads the prediction into `StrategyContext.nnPrediction` before calling `candidates()`:

```typescript
interface StrategyContext {
  nnPrediction?: PredictRes | null;   // null when budget exceeded or NN off
  thompsonDraw?: number;              // exploration draw in cents
  exploration?: boolean;              // ε-greedy round flag
  // ... bidding-specific fields
}
```

The strategy uses the NN's μ as the centerpoint when present, otherwise falls back to the heuristic from [`src/heuristics/priceEstimator.ts`](../../packages/bot-streamer/src/heuristics/priceEstimator.ts). On Thompson-sampling rounds, `thompsonDraw` replaces μ for the centerpoint. On exploration rounds, the candidate spread widens.

The 150 ms predict budget lives in the learning bridge — exceed it, predict resolves to `null`, the strategy uses the heuristic, and `staleResponses` increments. See [`learning.md`](./learning.md) for the full guard story.

## Bidding: the special case

The bidding strategy ([`bidding.ts`](../../packages/bot-streamer/src/strategies/bidding.ts)) is materially more complex than the others because:

1. **Order matters.** Bidding turns are sequential. The bot's strategy depends on whether it bids first, last, or somewhere in the middle.
2. **Opponents are modeled.** [`biddingOpponents.ts`](../../packages/bot-streamer/src/strategies/biddingOpponents.ts) maintains a per-opponent posterior over NPC archetype (6 archetypes), updated from observed (bid, actual) pairs across the rounds of one game. The posterior is precision-weighted with a floor.
3. **The decoder simulates.** [`biddingDecoder.ts`](../../packages/bot-streamer/src/strategies/biddingDecoder.ts) Monte-Carlo simulates the remaining bidders' likely bids and picks a bid amount that maximizes expected win probability under that distribution.
4. **`competitiveness` knob.** Defaults to 0.7; higher → more aggressive (lower-quantile bid, smaller σ-floor on opponent simulator). Set globally; not surfaced to chat.

If you're touching bidding, read the full [`biddingDecoder.ts`](../../packages/bot-streamer/src/strategies/biddingDecoder.ts) doc comment first — there's nuance around how the posterior interacts with `turnIdx` and `totalPlayers`.

## How to add a new strategy

The bot supports every mode the game does, but if you're adding a 13th mode (or replacing a strategy with a smarter one):

### 1. Implement the `ModeStrategy` interface

```typescript
// src/strategies/my-new-mode.ts
import type { ModeStrategy } from "./types";

export const myNewModeStrategy: ModeStrategy = {
  mode: "my-new-mode",
  candidates(round, ctx) {
    const rng = ctx?.rng ?? Math.random;
    const estimate = ctx?.nnPrediction?.mu ?? estimatePriceCents(round.products[0]);
    // ... build 3-5 candidates with scores in [0, 1] and rationales
    return [
      { guess: { ... }, score: 0.8, rationale: "high-confidence anchor" },
      { guess: { ... }, score: 0.5, rationale: "spread for safety" },
      // ...
    ];
  },
};
```

### 2. Register it

```typescript
// src/strategies/index.ts
import { myNewModeStrategy } from "./my-new-mode";

const REGISTRY: Partial<Record<GameMode, ModeStrategy>> = {
  // ... existing entries
  "my-new-mode": myNewModeStrategy,
};
```

### 3. Add an enactor

Strategies pick *what* to do; enactors do it. Add [`src/runner/enact/my-new-mode.ts`](../../packages/bot-streamer/src/runner/enact/) that takes the chosen candidate's `guess` payload and drives the UI (`page.click`, `page.fill`, etc.). Wire it into the enactor index.

### 4. Test it

Drop a vitest file in `tests/`:

```typescript
import { describe, it, expect } from "vitest";
import { myNewModeStrategy } from "../src/strategies/my-new-mode";
import { mockRoundStart } from "./fixtures"; // exists

describe("my-new-mode strategy", () => {
  it("returns at least one candidate", () => {
    const cands = myNewModeStrategy.candidates(mockRoundStart("my-new-mode"));
    expect(cands.length).toBeGreaterThan(0);
    expect(cands.every(c => c.score >= 0 && c.score <= 1)).toBe(true);
    expect(cands.every(c => c.rationale.length > 0)).toBe(true);
  });
});
```

See the existing tests under [`packages/bot-streamer/tests/strategies.test.ts`](../../packages/bot-streamer/tests/strategies.test.ts) for the patterns.

## Heuristics fallback

Every strategy that needs a price estimate has the same fallback chain:

```
ctx.thompsonDraw  →  ctx.nnPrediction.mu  →  estimatePriceCents(product)
```

`estimatePriceCents` lives in [`src/heuristics/priceEstimator.ts`](../../packages/bot-streamer/src/heuristics/priceEstimator.ts) and is documented in [`heuristics.md`](./heuristics.md). The takeaway: strategies never crash because the NN is cold or off — there's always a sensible baseline.

## Test patterns

Strategy tests sit at [`packages/bot-streamer/tests/strategies.test.ts`](../../packages/bot-streamer/tests/strategies.test.ts), [`strategies.batch3.test.ts`](../../packages/bot-streamer/tests/strategies.batch3.test.ts), and [`strategies.nn.test.ts`](../../packages/bot-streamer/tests/strategies.nn.test.ts). The patterns:

- Inject a deterministic RNG via `ctx.rng` so candidate output is reproducible.
- Assert `candidates.length > 0`, scores in `[0, 1]`, rationales non-empty.
- For NN-aware strategies, pass a fake `nnPrediction` and assert the centerpoint shifts.
- For bidding, build a synthetic `BiddingTurnPayload` + opponent posterior and assert the decoder's expected-bid output.

Fixtures live in [`packages/bot-streamer/src/test-helpers/`](../../packages/bot-streamer/src/test-helpers/).
