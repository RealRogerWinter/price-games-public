---
title: Streamer — Heuristics
status: stable
last_reviewed: 2026-06-03
owner: streamer
audience: contributor
category: streamer
summary: Domain knowledge (brand tiers, category ranges) used as fallback or grounding.
related_code:
  - packages/bot-streamer/src/heuristics
---
# Streamer Bot — Heuristics

> The bot's "domain knowledge" — category baselines and keyword multipliers used to estimate a product's price without ML. For the surrounding loop, see [`architecture.md`](./architecture.md).

## Why heuristics still matter

The bot has a neural net (see [`learning.md`](./learning.md)). The heuristic estimator is what:

- **Seeds the NN's training signal.** Feature extraction normalizes around `log(heuristic_cents + 1)`, so the heuristic is the implicit prior the network learns to correct against.
- **Carries the bot through cold start.** A fresh container with a fresh learning DB has no NN to consult for the first few hundred rounds. The strategies fall back to the heuristic and the broadcast doesn't look broken while the network warms up.
- **Is the kill-switch baseline.** Setting `LEARNING_FORCE_HEURISTIC=1` bypasses the NN entirely — the bot streams on heuristics alone. Used during incidents (predict timeouts, NaN storms, disk pressure) so an operator can stabilize the broadcast without redeploying.
- **Has a stable performance floor.** Pinball-q40 in the bidding decoder uses a heuristic-derived robustness floor so a misbehaving NN can't push the bot into clearly-broken bids.

## The function

[`src/heuristics/priceEstimator.ts`](../../packages/bot-streamer/src/heuristics/priceEstimator.ts) — `estimatePriceCents(product, opts)`:

```typescript
function estimatePriceCents(
  product: Product,
  opts?: EstimateOptions,
): number;
```

Returns a single integer in cents. The pipeline:

1. **Category baseline.** Match the product's lowercased category against `CATEGORY_BASELINE_CENTS` (electronics, appliances, home & kitchen, …). Unknown category → `DEFAULT_BASELINE_CENTS` ($30).
2. **Token multipliers.** Walk `TOKEN_MULTIPLIERS` (~30 regexes against the title + description). Each match multiplies the running estimate.
3. **Clamp.** Hard floor `$1`, hard ceiling `$500,000`, so a degenerate title can't yield an absurd guess.
4. **(Optional) log-noise.** When `noiseScale > 0`, apply multiplicative gaussian noise in log-space. This is what makes the bot's heuristic guesses cluster around plausible values rather than deterministically picking the median.

The category and multiplier tables are deliberately conservative — they're meant to make the bot's guesses *plausible*, not *correct*. The point isn't "the bot wins every round on heuristics"; it's "the bot's heuristic guess is plausible enough that the audience doesn't laugh at it while the NN is cold".

## What's in the multiplier table

A sample (see source for the full list at [`src/heuristics/priceEstimator.ts`](../../packages/bot-streamer/src/heuristics/priceEstimator.ts)):

| Token | Multiplier | Why |
|---|---|---|
| `\bpro\b`, `\bprofessional\b`, `\bcommercial\b`, `\bheavy[\s-]?duty\b` | 1.4–1.7× | Premium product tier signal |
| `\bsmart\b`, `\bwireless\b`, `\b4k\b`, `\b8k\b`, `\bgaming\b` | 1.2–1.6× | Tech/feature premium |
| `\bstainless steel\b`, `\bleather\b` | 1.3–1.4× | Material premium |
| `\bmini\b`, `\bbasic\b`, `\brefurbished\b`, `\brenewed\b`, `\bgeneric\b` | 0.6–0.7× | Lower-tier signals |
| `\bbundle\b`, `\bset of \d+\b`, `\bpack of \d+\b` | 1.3–1.5× | Bundle/quantity bumps |

These are pure pattern matches against the title/description. They don't combine cleverly — a 4K stainless-steel professional bundle would have all four multipliers applied (1.4 × 1.3 × 1.6 × 1.5 ≈ 4.4×). The conservatism in individual multipliers is what keeps that from running away.

## Where it gets called

```
StrategyContext.nnPrediction?.mu     ← preferred when NN is active and answered in time
        │
   else fall through
        ▼
estimatePriceCents(product)          ← used by every mode strategy as the centerpoint
        │
        ▼
softmax candidates around centerpoint
```

The strategies don't know whether their centerpoint came from the NN or the heuristic — they treat it as a price estimate either way. This is what lets the bot survive arbitrary NN failures (off / cold / stale / NaN-frozen / kill-switched) without changing its strategy code path.

## Feature normalization

The NN's feature extractor ([`src/learning/featureExtractor.ts`](../../packages/bot-streamer/src/learning/featureExtractor.ts)) uses the heuristic as feature #1:

```
features[0] = log(heuristic_cents + 1) / 12   // centered into ~[0, 2]
```

This makes the heuristic the **implicit prior** the NN learns to correct against. The trunk's job is essentially "given this baseline estimate plus the engineered features and the hashed title bigrams, predict which canonical-price-class wins." A well-trained net is the heuristic + learned corrections; a cold net falls back to roughly the heuristic.

## Brand-tier seed file

Optional helper for the NN, not the heuristic itself:

```bash
node scripts/build-brand-tier-seed.mjs --db app.db --out brand-tiers.json
```

Builds a `{brand: tier ∈ {luxury, mid, budget}}` JSON from production gameplay history. The NN's feature extractor includes a 3-way brand-tier one-hot when this seed file is present and a brand can be extracted from the title; absent → all products see tier=mid. Lives at [`src/learning/brandTierTable.ts`](../../packages/bot-streamer/src/learning/brandTierTable.ts).

## Golden-eval seed

```bash
node scripts/build-golden-eval-seed.mjs --db app.db --out golden-eval.json
```

Per-mode MAE baseline for OOD drift detection. The learning bridge compares the NN's recent MAE to this golden baseline; if the NN is materially worse, it surfaces on the ops dashboard ([`src/learning/goldenEval.ts`](../../packages/bot-streamer/src/learning/goldenEval.ts)).

## Tuning

The category baselines and token multipliers are deliberately under-tuned. They were set by intuition and have *not* been calibrated against real Amazon prices in any rigorous way. If you want to improve them:

1. Pull a representative sample of products + true prices from `app.db`.
2. Run the heuristic over each product, log `(estimated, actual, category, matched_tokens)`.
3. Fit category baselines to the median true price per category.
4. Fit token multipliers via linear regression in log-space.
5. Update the constants in [`src/heuristics/priceEstimator.ts`](../../packages/bot-streamer/src/heuristics/priceEstimator.ts) and the snapshot test in [`packages/bot-streamer/tests/priceEstimator.test.ts`](../../packages/bot-streamer/tests/priceEstimator.test.ts) (it pins outputs for a hand-picked product set).

Because the NN uses the heuristic as its prior, improving the heuristic can either help the NN (better prior → faster convergence) or hurt it (the NN had been learning to correct the old baseline). Re-train + re-eval against golden after any non-trivial heuristic change.

## Tests

[`packages/bot-streamer/tests/priceEstimator.test.ts`](../../packages/bot-streamer/tests/priceEstimator.test.ts) covers:

- Snapshot of estimates for a hand-picked product set (catches accidental regressions).
- Floor/ceiling clamp behavior.
- Noise is deterministic when `rng` is injected.
- Category-baseline fallthrough for unknown categories.
- Multiplier interactions don't compose past the ceiling.
