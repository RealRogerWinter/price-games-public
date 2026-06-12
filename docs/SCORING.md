---
title: Scoring
status: stable
last_reviewed: 2026-06-03
owner: core
audience: all
category: game-design
summary: "The scoring formulas, tiers, and bonuses for each mode."
related_code:
  - packages/shared/src/scoring.ts
---
# Scoring

All scoring functions live in `packages/shared/src/scoring.ts` and are shared between server and client.

## Smooth scoring curve

Asymmetric "closest" modes and the classic mode all use a smooth curve rather than step-function tiers:

```
score = round(1000 * (1 - min(pctOff, 1))^k)
```

Where `pctOff` is the fractional error (0 = exact, 1 = 100% off) and `k` is the steepness exponent tuned per mode. This replaces the legacy 7-tier step tables that produced perverse cliffs (e.g. 9.99% off → 500 pts, 10.01% off → 250 pts) and eliminates the old "participation floors" that awarded 25–50 pts for obviously-trolling bids like $0.01 on a $30 item.

## Precision (Classic)

**Function**: `scoreGuess(guessedCents, actualCents) -> { score, pctOff }`

Symmetric smooth curve with `k = 2.5`.

| % Off | Score |
|-------|-------|
| 0% (exact) | 1000 |
| 1% | 975 |
| 5% | 880 |
| 10% | 768 |
| 25% | 487 |
| 50% | 177 |
| 75% | 31 |
| ≥ 100% | 0 |

## Higher or Lower

**Function**: `scoreHigherLower(referencePrice, actualPrice, guess) -> { score, correct }`

Binary-choice mode: correct = 1000, wrong = 0.

## Comparison

**Function**: `scoreComparison(products, question, guessedProductId) -> { score, correct, correctProductId }`

Binary-choice mode: correct pick = 1000, wrong = 0.

## Underbid (Closest Without Going Over)

**Function**: `scoreClosest(guessedCents, actualCents) -> { score, pctOff, wentOver }`

Guess must be **at or below** the actual price. Going over = 0 points. Valid underbids use the smooth curve with `k = 3.0`.

| % Under | Score |
|---------|-------|
| 0% (exact) | 1000 |
| 2% | 941 |
| 5% | 857 |
| 10% | 729 |
| 25% | 422 |
| 50% | 125 |
| 75% | 16 |
| ≥ 100% | 0 |

No participation floor — an ultra-low underbid (e.g. $0.01 on $30) scores ~0 rather than the old 50-pt token.

## Price Match

**Function**: `scorePriceMatch(assignments, products) -> { score, correctCount }`

- **200 points** per correct match (of 4)
- **+200 bonus** if all 4 correct
- **Max: 1000**

## Riser

**Function**: `scoreRiser(stoppedCents, actualCents) -> { score, pctOff, wentOver }`

Stop the rising price before it exceeds the actual price. Going over = 0. Smooth curve with `k = 3.5` (steeper than Closest because Riser's moving bar makes precision harder).

| % Under | Score |
|---------|-------|
| 0% (exact) | 1000 |
| 5% | 836 |
| 10% | 692 |
| 25% | 365 |
| 50% | 88 |
| 75% | 8 |
| ≥ 100% | 0 |

## Odd One Out

**Function**: `scoreOddOneOut(products, outlierProductId, guessedProductId) -> { score, correct }`

Difficulty-scaled reward based on `gapRatio` (how close the outlier is to the cluster):

| Gap Ratio | Score |
|-----------|-------|
| ≤ 10% (hardest) | 1000 |
| ≤ 20% | 800 |
| ≤ 35% | 600 |
| ≤ 50% | 400 |
| > 50% (easiest) | 200 |

Wrong product: 0.

**Helper**: `identifyOutlier(products) -> number` — returns the `id` of the product whose removal minimizes the remaining group's variance.

## Market Basket

**Function**: `scoreMarketBasket(guessedTotalCents, actualTotalCents) -> { score, pctOff }`

Delegates to `scoreGuess` (Classic smooth curve, `k = 2.5`) applied to the basket total.

## Sort It Out

**Function**: `scoreSortItOut(submittedOrder, correctOrder) -> { score, correctCount }`

| Correct Positions | Score |
|-------------------|-------|
| 5/5 | 1000 |
| 4/5 | 800 |
| 3/5 | 600 |
| 2/5 | 350 |
| 1/5 | 150 |
| 0/5 | 0 |

## Budget Builder

**Function**: `scoreBudgetBuilder(cartTotalCents, budgetCents) -> { score }`

Over budget = 0. Under budget uses the smooth curve with `k = 3.0` (same as Closest).

| % Under Budget | Score |
|----------------|-------|
| 0% (exact) | 1000 |
| 5% | 857 |
| 10% | 729 |
| 25% | 422 |
| 50% | 125 |
| 75% | 16 |
| ≥ 100% (empty) | 0 |

## Chain Reaction

**Functions**: `scoreChainSubGuess(prevPriceCents, currPriceCents, guess) -> boolean` per link, `scoreChainReaction(correctCount, chainLength) -> { score }` for the round.

Each link in the chain is a "more / less" comparison against the previous product. `scoreChainSubGuess` returns `true` when the guess matches the actual direction; equal prices accept either choice. The runner accumulates the boolean results and hands `correctCount` to `scoreChainReaction` for the round total.

Exponential scaling per correct link:

```
score = sum(100 * 1.5^(i-1)) for i = 1..correctCount
```

- **+500 bonus** if all links correct
- **Capped at 3500**

With the default 5-product chain (4 comparisons):

| Correct Links (of 4) | Score |
|----------------------|-------|
| 0 | 0 |
| 1 | 100 |
| 2 | 250 |
| 3 | 475 |
| 4 (all) | 813 + 500 bonus = 1313 |

## Bidding War (multiplayer)

**Function**: `scoreBidding(bids, actualCents) -> BiddingResult[]`

Closest-without-going-over rank-based scoring across all players' bids, **scaled by proximity** so rank placement alone can't reward a $0.01 lowball with a full 1000. After the final bid:

1. Bids over the actual price are disqualified (score 0).
2. Valid bids ranked by proximity (closest-without-going-over wins).
3. Each rank's base score is multiplied by `(1 - pctOff)^k` with `k = 2.5` (matches Classic's curve). Exact matches skip scaling.
4. Base scores by placement:

| Placement | Base | × proximity at 5% off | × proximity at 20% off | × proximity at 95% off |
|-----------|------|-----------------------|------------------------|------------------------|
| 1st | 1000 | ≈ 881 | ≈ 572 | ≈ 0 |
| 2nd | 700  | ≈ 617 | ≈ 400 | ≈ 0 |
| 3rd | 400  | ≈ 352 | ≈ 229 | ≈ 0 |
| 4th | 200  | ≈ 176 | ≈ 114 | ≈ 0 |
| 5th+ | 100 | ≈ 88  | ≈ 57  | ≈ 0 |

5. **Exact-match bonus**: +500 points on top of the unscaled base (so an exact bid is worth 1500).

Tied bids share the same (highest) rank. Score table constant: `[1000, 700, 400, 200, 100, 100]`. `scoreBidding` also returns `pctOff` so the UI can label the round with the same universal narrator used by other modes.

## Bidding War (single-player — daily challenge)

**Function**: `scoreBiddingSolo(bidCents, actualCents) -> { score, pctOff, isExact, wentOver }`

Solo bidding uses **proximity-based scoring**, not rank-based. Rank scoring with a single bidder collapsed every valid underbid to rank 0 = 1000 pts, which made bidding $0.01 on a $30 item an optimal strategy. `scoreBiddingSolo` shares the Closest curve (`k = 3.0`) and preserves the +500 exact-match bonus:

| Outcome | Score |
|---------|-------|
| Exact match | 1500 (1000 + 500 exact bonus) |
| Over the price | 0 |
| Under the price | smoothScore(pctOff, 3.0) |

The server dispatches through `scoreGuessForMode(mode, guessData, productIds, roundMeta, cache, context)` with `context = "sp"` (the default) for single-player paths and `"mp"` for multiplayer. In `"mp"` mode, the bidding branch returns a placeholder score of 0 because final scores are computed later across all bids via `finalizeBiddingScores`.

The SP bidding branch accepts either `{ bidCents }` or `{ guessedPriceCents }` as the guess shape so that the daily UI (`ClosestPage`) can submit the familiar `guessedPriceCents` payload.

## Feedback tiers (UI narrator)

Result labels in `apps/web/src/components/RoundResult.tsx` are driven by `pctOff`, not by `score`. This decouples the *ledger* (mode-specific, asymmetric) from the *narrator* (universal across modes). A 30%-off bid reads "Rough Swing" whether you're playing Classic, Closest, or Riser, even though the numeric score differs per curve.

| # | pctOff ≤ | Label |
|---|---|---|
| 1 | 0.00 | PIXEL PERFECT! |
| 2 | 0.01 | Laser-Guided |
| 3 | 0.03 | Sharpshooter |
| 4 | 0.07 | Dialed In |
| 5 | 0.12 | In the Ballpark |
| 6 | 0.20 | Solid Guess |
| 7 | 0.30 | Rough Swing |
| 8 | 0.45 | Way Off |
| 9 | 0.60 | Did You Even Look? |
| 10 | 0.80 | Are You Bidding in Yen? |
| 11 | 1.20 | Things Cost Money, Friend |
| 12 | ∞ | Technically a Number |

The bottom four tiers are deliberately deadpan-snarky so a ~0-point score no longer pairs with a consoling "Not Bad" label.

## Win / Loss classification

A completed game is classified as a **win**, **loss**, or **skipped** for the
W/L/Streak tracker. The classification is computed server-side by
`computeIsWin()` in `packages/shared/src/winRecord.ts` and persisted as
`user_game_history.is_win` (1 = win, 0 = loss, NULL = skipped).

| Game type | Rule |
|---|---|
| Single-player | `score / (perRoundMax × totalRounds) ≥ 0.5` is a win, otherwise a loss. |
| Multiplayer (≥ 2 players) | Placement #1 is a win; everything else is a loss. Ties at #1 produce a win for every tied player. |
| Multiplayer (solo room) | Skipped — anti streak-farming. |
| Labeled auto-lobby bots (`is_bot=1`, no ghost) | Skipped. |
| Streamer-bot (`is_streamer_bot=1`) | **Tracked** — its `visitor_attribution` row's W/L cache + signed streak update so the in-game HUD chip on the bot's own browser shows real numbers. Excluded from `mp_leaderboard`, `user_game_history`, UTM cohort fields (`first_game_*`, `games_played`), and the `MP_GAME_COMPLETED` / `GAME_COMPLETED` analytics emits. The W/L row uses `utm_source='direct'` (auto-created on first game). |
| Disconnect with no placement | Skipped. |

The 50% threshold corresponds to the boundary between "Not bad!" and
"Nice work!" tiers in `getResultHeadline`. Anything that produces a
"Not bad!" or "Tough round!" headline is therefore a loss.

The signed lifetime streak is cached on `users.current_streak` and
`visitor_attribution.current_streak` (anonymous players). It increments
by +1 on a win, decrements by -1 on a loss, and flips through zero when
the direction changes (e.g. losing from a +5 streak yields -1, not 4).
Best-positive-peak is tracked in `best_win_streak`; loss-direction peaks
are intentionally not recorded.

## Bot bid realism

Bot bids from `apps/server/src/services/botGuess.ts` are snapped to a realistic retail lattice via `snapToRetail()` after the gaussian noise step. Lattice buckets by magnitude:

- under $10 → $1 increments
- $10–$50 → $5 increments
- $50–$500 → $10 increments
- $500+ → $50 increments

After snapping, a single retail-ending roll: 20% ends in `.99`, 15% ends in `.50`, 65% stays on whole dollars. Closest / Riser / Bidding bots use `snapToRetailUnder(raw, actual)` which steps down one bucket if the .50 uplift would push the bot over the actual price. This produces human-looking bids like `$20`, `$19.99`, `$50.50`, `$100` instead of uncanny-valley gaussian outputs like `$17.43`.
