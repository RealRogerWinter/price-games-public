/**
 * Smooth scoring curve: `1000 * (1 - pctOff)^k` clamped to [0, 1000].
 *
 * Replaces the old step-function tiers with a continuous curve that:
 *   - eliminates perverse cliffs (e.g. 9.99% → 500 vs 10.01% → 250)
 *   - naturally collapses to ~0 for extreme errors without participation floors
 *
 * @param pctOff Fractional error (0 = exact, 1 = 100% off). Clamped to [0, 1].
 * @param k      Steepness exponent. Higher k = more punishing of larger errors.
 *               Tuned per mode (classic 2.5, closest/budget 3.0, riser 3.5).
 * @returns Integer score in [0, 1000].
 */
function smoothScore(pctOff: number, k: number): number {
  if (!Number.isFinite(pctOff) || pctOff <= 0) return Number.isFinite(pctOff) ? 1000 : 0;
  const clamped = Math.min(pctOff, 1);
  return Math.round(1000 * Math.pow(1 - clamped, k));
}

/**
 * Classic scoring. Symmetric percentage-error curve (over and under guesses
 * score equally). Uses the smooth curve with k=2.5.
 *
 * @param guessedCents Player's guess in cents
 * @param actualCents  True price in cents
 * @returns score in [0, 1000] and pctOff fractional error
 */
export function scoreGuess(guessedCents: number, actualCents: number): { score: number; pctOff: number } {
  if (actualCents === 0) return { score: 0, pctOff: 1 };
  const pctOff = Math.abs(guessedCents - actualCents) / actualCents;
  return { score: smoothScore(pctOff, 2.5), pctOff };
}

/**
 * Higher/Lower scoring. A binary-choice mode — the player picks "higher" or
 * "lower", so the reward is also binary: 1000 for correct, 0 for wrong.
 *
 * Previously this mode awarded 200..1000 based on how close the two prices
 * were (a "difficulty bonus"). This was removed because players reported it
 * as confusing — getting every round right but not scoring 1000 per round
 * feels broken when the mode is visibly binary. See the notes on
 * {@link scoreComparison}.
 */
export function scoreHigherLower(
  referencePrice: number,
  actualPrice: number,
  guess: "higher" | "lower"
): { score: number; correct: boolean } {
  const correctAnswer: "higher" | "lower" = actualPrice > referencePrice ? "higher" : "lower";
  const correct = guess === correctAnswer;
  return correct ? { score: 1000, correct: true } : { score: 0, correct: false };
}

/**
 * Comparison scoring. A binary-choice mode — the player picks which product
 * is most/least expensive, so the reward is also binary: 1000 for correct,
 * 0 for wrong.
 *
 * Previously this mode scaled the reward from 400..1000 based on the price
 * spread between the products (wider spread = "easier" = fewer points). This
 * was removed because the tiering was invisible to players and caused
 * "I got everything right but didn't get a perfect score" confusion.
 */
export function scoreComparison(
  products: { id: number; priceCents: number }[],
  question: "most-expensive" | "least-expensive",
  guessedProductId: number
): { score: number; correct: boolean; correctProductId: number } {
  const sorted = [...products].sort((a, b) => a.priceCents - b.priceCents);
  const correctProduct = question === "most-expensive" ? sorted[sorted.length - 1] : sorted[0];
  const correct = guessedProductId === correctProduct.id;
  return correct
    ? { score: 1000, correct: true, correctProductId: correctProduct.id }
    : { score: 0, correct: false, correctProductId: correctProduct.id };
}

/**
 * Closest-without-going-over scoring. Any overbid is an instant zero (bust rule).
 * Valid underbids use the smooth curve with k=3.0 — no participation floor.
 *
 * @param guessedCents Player's bid in cents
 * @param actualCents  True price in cents
 * @returns score, pctOff, and wentOver flag
 */
export function scoreClosest(
  guessedCents: number,
  actualCents: number
): { score: number; pctOff: number; wentOver: boolean } {
  if (actualCents === 0) return { score: 0, pctOff: 1, wentOver: false };
  if (guessedCents > actualCents) {
    return { score: 0, pctOff: (guessedCents - actualCents) / actualCents, wentOver: true };
  }
  const pctOff = (actualCents - guessedCents) / actualCents;
  return { score: smoothScore(pctOff, 3.0), pctOff, wentOver: false };
}

// Price Match: 200 per correct match, 200 bonus for all 4 = max 1000
export function scorePriceMatch(
  assignments: Record<number, number>,
  products: { id: number; priceCents: number }[]
): { score: number; correctCount: number } {
  let correctCount = 0;
  for (const p of products) {
    if (assignments[p.id] === p.priceCents) correctCount++;
  }
  const baseScore = correctCount * 200;
  const bonus = correctCount === products.length ? 200 : 0;
  return { score: baseScore + bonus, correctCount };
}

/**
 * Identify the outlier product — the one whose price is farthest from the group mean
 * when excluded. Deterministic: picks the product whose removal minimizes group variance.
 * @param products Array of {id, priceCents}
 * @returns The id of the outlier product
 */
export function identifyOutlier(products: { id: number; priceCents: number }[]): number {
  if (products.length <= 1) return products[0]?.id ?? -1;
  let bestId = products[0].id;
  let bestVariance = Infinity;
  for (const candidate of products) {
    const others = products.filter((p) => p.id !== candidate.id);
    const mean = others.reduce((s, p) => s + p.priceCents, 0) / others.length;
    const variance = others.reduce((s, p) => s + (p.priceCents - mean) ** 2, 0) / others.length;
    if (variance < bestVariance || (variance === bestVariance && candidate.id < bestId)) {
      bestVariance = variance;
      bestId = candidate.id;
    }
  }
  return bestId;
}

/**
 * Score an Odd One Out guess. Wrong = 0, correct = 200-1000 based on difficulty
 * (how close the outlier's price is to the cluster — smaller gap = harder = more points).
 * @param products Array of products with prices
 * @param outlierProductId The correct outlier
 * @param guessedProductId The player's pick
 * @returns score and whether the guess was correct
 */
export function scoreOddOneOut(
  products: { id: number; priceCents: number }[],
  outlierProductId: number,
  guessedProductId: number
): { score: number; correct: boolean } {
  if (guessedProductId !== outlierProductId) return { score: 0, correct: false };
  const outlier = products.find((p) => p.id === outlierProductId);
  const others = products.filter((p) => p.id !== outlierProductId);
  if (!outlier || others.length === 0) return { score: 200, correct: true };
  const clusterMean = others.reduce((s, p) => s + p.priceCents, 0) / others.length;
  const gapRatio = clusterMean > 0 ? Math.abs(outlier.priceCents - clusterMean) / clusterMean : 1;
  // Smaller gap = harder = more points
  if (gapRatio <= 0.10) return { score: 1000, correct: true };
  if (gapRatio <= 0.20) return { score: 800, correct: true };
  if (gapRatio <= 0.35) return { score: 600, correct: true };
  if (gapRatio <= 0.50) return { score: 400, correct: true };
  return { score: 200, correct: true };
}

/**
 * Score a Market Basket guess. Uses the same classic scoring curve applied to the total.
 * @param guessedTotalCents Player's guessed total
 * @param actualTotalCents Real total of all basket items
 * @returns score and pctOff
 */
export function scoreMarketBasket(
  guessedTotalCents: number,
  actualTotalCents: number
): { score: number; pctOff: number } {
  return scoreGuess(guessedTotalCents, actualTotalCents);
}

/**
 * Score a Sort It Out guess. Count how many products are in the correct position.
 * 5/5=1000, 4/5=800, 3/5=600, 2/5=350, 1/5=150, 0/5=0
 * @param submittedOrder Player's ordering (array of product IDs)
 * @param correctOrder Correct ordering by ascending price
 * @returns score and correctCount
 */
export function scoreSortItOut(
  submittedOrder: number[],
  correctOrder: number[]
): { score: number; correctCount: number } {
  let correctCount = 0;
  for (let i = 0; i < correctOrder.length; i++) {
    if (submittedOrder[i] === correctOrder[i]) correctCount++;
  }
  const total = correctOrder.length;
  const scoreMap: Record<number, number> = { 0: 0, 1: 150, 2: 350, 3: 600, 4: 800, 5: 1000 };
  // For non-5 product counts, interpolate linearly
  const score = scoreMap[correctCount] ?? Math.round((correctCount / total) * 1000);
  return { score, correctCount };
}

/**
 * Score a Budget Builder guess. Over budget = 0. Under budget uses the smooth
 * curve with k=3.0 — no participation floor for abandoning-the-round cart totals.
 *
 * @param cartTotalCents Total of selected items
 * @param budgetCents The budget target
 * @returns score
 */
export function scoreBudgetBuilder(
  cartTotalCents: number,
  budgetCents: number
): { score: number } {
  if (budgetCents <= 0) return { score: 0 };
  if (cartTotalCents > budgetCents) return { score: 0 };
  if (cartTotalCents === 0) return { score: 0 };
  const pctUnder = (budgetCents - cartTotalCents) / budgetCents;
  return { score: smoothScore(pctUnder, 3.0) };
}

/**
 * Score a single chain sub-guess: is the next product more or less expensive?
 * @param prevPriceCents Price of the previous product in the chain
 * @param currPriceCents Price of the current product
 * @param guess Player's guess: "more" or "less"
 * @returns true if correct
 */
export function scoreChainSubGuess(
  prevPriceCents: number,
  currPriceCents: number,
  guess: "more" | "less"
): boolean {
  if (prevPriceCents === currPriceCents) return true; // Equal prices accept either
  const correct = currPriceCents > prevPriceCents ? "more" : "less";
  return guess === correct;
}

/**
 * Score a full Chain Reaction round. Exponential: sum(100 * 1.5^(i-1)) for i=1..correctCount,
 * +500 perfect bonus, capped at 3500.
 * @param correctCount Number of correct sub-guesses
 * @param chainLength Total chain comparisons (products - 1)
 * @returns score
 */
export function scoreChainReaction(
  correctCount: number,
  chainLength: number
): { score: number } {
  let total = 0;
  for (let i = 1; i <= correctCount; i++) {
    total += Math.round(100 * Math.pow(1.5, i - 1));
  }
  if (correctCount === chainLength && chainLength > 0) total += 500;
  return { score: Math.min(total, 3500) };
}

/**
 * Score all bids in a multiplayer bidding round using closest-without-going-over rules.
 * Bids over the actual price score 0. Valid bids are ranked by proximity
 * (closest without going over wins), then each rank's base score is scaled
 * by a proximity factor `(1 - pctOff)^k` so that a rank-0 bid of $0.01 on a
 * $30 item no longer collapses to a full 1000 points. Exact matches bypass
 * the scaling and receive the full base plus the +500 exact-bid bonus.
 *
 * Only used for multiplayer Bidding War. Solo Bidding War uses
 * {@link scoreBiddingSolo} — rank-based scoring is meaningless with one bid.
 *
 * @param bids - Array of { playerId, bidCents }
 * @param actualPriceCents - The product's real price
 * @returns Array of { playerId, score, pctOff, isExact, wentOver }
 */
export function scoreBidding(
  bids: Array<{ playerId: string; bidCents: number }>,
  actualPriceCents: number
): Array<{ playerId: string; score: number; pctOff: number; isExact: boolean; wentOver: boolean }> {
  const SCORE_TABLE = [1000, 700, 400, 200, 100, 100];
  const EXACT_BONUS = 500;
  // Proximity steepness. Matches Classic's k=2.5 — gentle enough that rank
  // placement still dominates in a realistic bid range, steep enough that a
  // 95%-off lowball collapses to near-zero regardless of rank.
  const PROXIMITY_K = 2.5;

  if (actualPriceCents <= 0) {
    return bids.map((b) => ({ playerId: b.playerId, score: 0, pctOff: 1, isExact: false, wentOver: false }));
  }

  // Separate valid bids (under or equal to actual) from overbids
  const validBids = bids.filter((b) => b.bidCents <= actualPriceCents);

  // Sort descending by bid amount (closest to actual first)
  const sortedValid = [...validBids].sort((a, b) => b.bidCents - a.bidCents);

  // Assign rank by bid value — tied bids share the same (highest) rank,
  // so two players bidding the same amount both get the top score.
  // Example: [4900, 4900, 4700] → ranks [0, 0, 2] → scores [1000, 1000, 400]
  const rankByBid = new Map<number, number>();
  let currentRank = 0;
  for (let i = 0; i < sortedValid.length; i++) {
    if (i > 0 && sortedValid[i].bidCents !== sortedValid[i - 1].bidCents) {
      currentRank = i;
    }
    rankByBid.set(sortedValid[i].bidCents, currentRank);
  }

  return bids.map((bid) => {
    if (bid.bidCents > actualPriceCents) {
      return {
        playerId: bid.playerId,
        score: 0,
        pctOff: (bid.bidCents - actualPriceCents) / actualPriceCents,
        isExact: false,
        wentOver: true,
      };
    }
    const isExact = bid.bidCents === actualPriceCents;
    const pctOff = isExact ? 0 : (actualPriceCents - bid.bidCents) / actualPriceCents;
    const rank = rankByBid.get(bid.bidCents) ?? 0;
    const baseScore = rank < SCORE_TABLE.length ? SCORE_TABLE[rank] : SCORE_TABLE[SCORE_TABLE.length - 1];
    // Proximity factor collapses rank scores for bids far under actual.
    // Exact matches skip scaling (factor = 1).
    const proximityFactor = isExact ? 1 : Math.pow(1 - Math.min(pctOff, 1), PROXIMITY_K);
    const scaledBase = Math.round(baseScore * proximityFactor);
    const bonus = isExact ? EXACT_BONUS : 0;
    return {
      playerId: bid.playerId,
      score: scaledBase + bonus,
      pctOff,
      isExact,
      wentOver: false,
    };
  });
}

/**
 * Solo Bidding War scoring (e.g. the daily challenge). Uses proximity-based
 * scoring rather than rank — a single bid cannot meaningfully be "ranked",
 * so {@link scoreBidding} in the solo context produced the absurd result
 * of awarding 1000 points for bidding $0.01 on a $30 item.
 *
 * Rules:
 *   - over actual  → 0 pts, wentOver: true
 *   - exact        → 1500 pts (1000 base + 500 exact-bid bonus), pctOff: 0
 *   - under actual → smoothScore(pctOff, k=3.0), matching Closest mode
 *
 * @param bidCents     The bid in cents
 * @param actualCents  The product's real price in cents
 * @returns score, pctOff, isExact, wentOver
 */
export function scoreBiddingSolo(
  bidCents: number,
  actualCents: number
): { score: number; pctOff: number; isExact: boolean; wentOver: boolean } {
  if (actualCents <= 0) return { score: 0, pctOff: 1, isExact: false, wentOver: false };
  if (bidCents > actualCents) {
    return {
      score: 0,
      pctOff: (bidCents - actualCents) / actualCents,
      isExact: false,
      wentOver: true,
    };
  }
  if (bidCents === actualCents) {
    return { score: 1500, pctOff: 0, isExact: true, wentOver: false };
  }
  const pctOff = (actualCents - bidCents) / actualCents;
  return { score: smoothScore(pctOff, 3.0), pctOff, isExact: false, wentOver: false };
}

/**
 * Riser scoring. Any overshoot is an instant zero. Valid undershoots use the
 * smooth curve with k=3.5 — steeper than Closest because Riser's moving bar
 * makes precision harder, so the decay should accelerate as the stop drifts.
 *
 * @param stoppedCents Where the player stopped the rising price
 * @param actualCents  True price in cents
 * @returns score, pctOff, wentOver
 */
export function scoreRiser(
  stoppedCents: number,
  actualCents: number
): { score: number; pctOff: number; wentOver: boolean } {
  if (actualCents === 0) return { score: 0, pctOff: 1, wentOver: false };
  if (stoppedCents > actualCents) {
    return { score: 0, pctOff: (stoppedCents - actualCents) / actualCents, wentOver: true };
  }
  const pctOff = (actualCents - stoppedCents) / actualCents;
  return { score: smoothScore(pctOff, 3.5), pctOff, wentOver: false };
}
