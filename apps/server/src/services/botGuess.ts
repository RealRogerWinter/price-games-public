/**
 * Bot guess generator — produces mode-appropriate guesses scaled by difficulty.
 *
 * Price-based modes (classic, closest, riser, market-basket, bidding) use
 * per-bot archetype personalities from {@link botPersonality} so individual
 * bots vary in style and guesses spread across accuracy bands rather than
 * clustering around the actual price.
 *
 * Categorical modes (higher-lower, comparison, odd-one-out, chain-reaction,
 * price-match, sort-it-out, budget-builder) retain their original difficulty-
 * keyed correctness probabilities — they are binary/ordinal and do not exhibit
 * the clustering exploit.
 *
 * @module botGuess
 */
import type { GameMode, BotDifficulty, GuessData, RoundStartPayload } from "@price-game/shared";
import { identifyOutlier } from "@price-game/shared";
import {
  resolvePersonality,
  sampleBotPrice,
  sampleBotBid,
  type BiddingContext,
} from "./botPersonality";

/** Probability of a correct binary/categorical answer per difficulty. */
const CORRECT_PROB: Record<BotDifficulty, number> = {
  easy: 0.55,
  medium: 0.70,
  hard: 0.85,
};

/**
 * Snap a raw cent amount to a realistic retail-price lattice so bot bids look
 * like something a human would actually type ($20, $19.99, $50) rather than
 * uncanny-valley outputs ($17.43, $22.18, $4.07).
 *
 * Lattice: under $10 → $1; $10–$50 → $5; $50–$500 → $10; $500+ → $50.
 * Then one retail-ending roll: 20% ends in .99, 15% ends in .50, 65% whole.
 *
 * Exported for use by callers that want deterministic retail-lattice snapping
 * outside of the personality-driven path used inside generateBotGuess.
 *
 * @param cents Raw amount in cents
 * @returns Integer cents snapped to the retail lattice (minimum $1)
 */
export function snapToRetail(cents: number): number {
  const clamped = Math.max(100, Math.round(cents));
  const dollars = clamped / 100;
  let bucketCents: number;
  if (dollars < 10)       bucketCents = 100;
  else if (dollars < 50)  bucketCents = 500;
  else if (dollars < 500) bucketCents = 1000;
  else                    bucketCents = 5000;
  const snapped = Math.max(bucketCents, Math.round(clamped / bucketCents) * bucketCents);
  const roll = Math.random();
  if (roll < 0.20 && snapped >= 200) return snapped - 1;
  if (roll < 0.35 && snapped >= 500) return snapped + 50;
  return snapped;
}

/**
 * Snap to retail lattice but guarantee the result does not exceed `ceiling`.
 * Steps down in $1 increments if the lattice bucket rounds up past the
 * ceiling — subtracting whole dollars preserves the .99 / .50 / .00 ending
 * produced by {@link snapToRetail}. Used by over-penalty modes (closest,
 * riser, bidding) where any over-the-line guess is an instant zero.
 */
function snapToRetailUnder(cents: number, ceiling: number): number {
  if (ceiling < 100) return Math.max(1, Math.min(Math.round(cents), Math.max(1, ceiling)));
  const base = Math.min(Math.round(cents), ceiling);
  let val = snapToRetail(base);
  while (val > ceiling && val > 100) val -= 100;
  return Math.max(100, Math.min(val, ceiling));
}

/** Returns true with the given probability. */
function coinFlip(prob: number): boolean {
  return Math.random() < prob;
}

/** Pick a random element from an array. */
function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

/** Fisher-Yates shuffle (returns new array). */
function shuffle<T>(arr: T[]): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Optional per-call context for bot guess generation. */
export interface BotGuessContext {
  /** Stable bot player ID; drives deterministic archetype assignment. */
  botPlayerId?: string;
  /** Room code / per-game salt; combined with botPlayerId for assignment. */
  roomCode?: string;
  /** Bidding-mode context: previous bids + whether this bot bids last. */
  bidding?: BiddingContext;
}

/**
 * Generate a bot guess for any game mode.
 *
 * @param mode - The current game mode
 * @param difficulty - Bot difficulty level
 * @param roundPayload - The RoundStartPayload sent to clients
 * @param productPrices - Map of productId → priceCents (server-side truth)
 * @param context - Optional per-call context (bot ID, room, bidding state)
 * @returns Valid GuessData for the mode
 * @throws If mode is unknown
 */
export function generateBotGuess(
  mode: GameMode,
  difficulty: BotDifficulty,
  roundPayload: RoundStartPayload,
  productPrices: Map<number, number>,
  context: BotGuessContext = {},
): GuessData {
  switch (mode) {
    case "classic":
      return guessClassic(difficulty, roundPayload, productPrices, context);
    case "higher-lower":
      return guessHigherLower(difficulty, roundPayload, productPrices);
    case "comparison":
      return guessComparison(difficulty, roundPayload, productPrices);
    case "closest-without-going-over":
      return guessClosest(difficulty, roundPayload, productPrices, context);
    case "price-match":
      return guessPriceMatch(difficulty, roundPayload, productPrices);
    case "riser":
      return guessRiser(difficulty, roundPayload, productPrices, context);
    case "odd-one-out":
      return guessOddOneOut(difficulty, roundPayload, productPrices);
    case "market-basket":
      return guessMarketBasket(difficulty, roundPayload, productPrices, context);
    case "sort-it-out":
      return guessSortItOut(difficulty, roundPayload, productPrices);
    case "budget-builder":
      return guessBudgetBuilder(difficulty, roundPayload, productPrices);
    case "chain-reaction":
      return guessChainReaction(difficulty, roundPayload, productPrices);
    case "bidding":
      return guessBidding(difficulty, roundPayload, productPrices, context);
    default:
      throw new Error(`Unknown game mode for bot: ${mode}`);
  }
}

function guessClassic(
  difficulty: BotDifficulty, rp: RoundStartPayload, prices: Map<number, number>, ctx: BotGuessContext,
): GuessData {
  const actual = prices.get(rp.product!.id) ?? 5000;
  const personality = resolvePersonality(ctx.botPlayerId, ctx.roomCode, difficulty);
  return { guessedPriceCents: snapToRetail(sampleBotPrice(actual, personality)) };
}

function guessHigherLower(
  difficulty: BotDifficulty, rp: RoundStartPayload, prices: Map<number, number>,
): GuessData {
  const actual = prices.get(rp.product!.id) ?? 5000;
  const ref = rp.referencePrice ?? actual;
  const correct: "higher" | "lower" = actual > ref ? "higher" : "lower";
  const wrong: "higher" | "lower" = correct === "higher" ? "lower" : "higher";
  return { guess: coinFlip(CORRECT_PROB[difficulty]) ? correct : wrong };
}

function guessComparison(
  difficulty: BotDifficulty, rp: RoundStartPayload, prices: Map<number, number>,
): GuessData {
  const products = rp.products ?? [];
  if (products.length === 0) return { guessedProductId: 0 };
  const question = rp.question as "most-expensive" | "least-expensive";
  const sorted = [...products].sort((a, b) => (prices.get(a.id) ?? 0) - (prices.get(b.id) ?? 0));
  const correct = question === "most-expensive" ? sorted[sorted.length - 1] : sorted[0];
  if (coinFlip(CORRECT_PROB[difficulty])) {
    return { guessedProductId: correct.id };
  }
  const wrong = products.filter((p) => p.id !== correct.id);
  return { guessedProductId: pick(wrong).id };
}

function guessClosest(
  difficulty: BotDifficulty, rp: RoundStartPayload, prices: Map<number, number>, ctx: BotGuessContext,
): GuessData {
  const actual = prices.get(rp.product!.id) ?? 5000;
  const personality = resolvePersonality(ctx.botPlayerId, ctx.roomCode, difficulty);
  // Closest-without-going-over has the same "over = 0" rule as bidding,
  // so route through the bidding wrapper (shade-down without +$1 clip
  // context since there's no turn order in single-shot modes).
  const bid = sampleBotBid(actual, personality);
  return { guessedPriceCents: snapToRetailUnder(bid, actual) };
}

function guessPriceMatch(
  difficulty: BotDifficulty, rp: RoundStartPayload, prices: Map<number, number>,
): GuessData {
  const products = rp.products ?? [];
  const availablePrices = rp.prices ?? [];
  if (products.length === 0) return { assignments: {} };

  const correctAssignments: Record<string, number> = {};
  for (const p of products) {
    correctAssignments[String(p.id)] = prices.get(p.id) ?? 0;
  }

  const correctTarget = difficulty === "hard" ? products.length
    : difficulty === "medium" ? Math.ceil(products.length * 0.6)
    : Math.ceil(products.length * 0.3);

  const shuffled = shuffle(products);
  const usedPrices = new Set<number>();
  const assignments: Record<string, number> = {};

  for (let i = 0; i < shuffled.length; i++) {
    const p = shuffled[i];
    const correctPrice = prices.get(p.id) ?? 0;
    if (i < correctTarget && availablePrices.includes(correctPrice) && !usedPrices.has(correctPrice)) {
      assignments[String(p.id)] = correctPrice;
      usedPrices.add(correctPrice);
    } else {
      const remaining = availablePrices.filter((pr) => !usedPrices.has(pr));
      const chosen = remaining.length > 0 ? pick(remaining) : (availablePrices[0] ?? 0);
      assignments[String(p.id)] = chosen;
      usedPrices.add(chosen);
    }
  }

  return { assignments };
}

function guessRiser(
  difficulty: BotDifficulty, rp: RoundStartPayload, prices: Map<number, number>, ctx: BotGuessContext,
): GuessData {
  const actual = prices.get(rp.product!.id) ?? 5000;
  const personality = resolvePersonality(ctx.botPlayerId, ctx.roomCode, difficulty);
  const stoppedPriceCents = snapToRetailUnder(sampleBotBid(actual, personality), actual);
  return { stoppedPriceCents };
}

function guessOddOneOut(
  difficulty: BotDifficulty, rp: RoundStartPayload, prices: Map<number, number>,
): GuessData {
  const products = rp.products ?? [];
  if (products.length === 0) return { guessedProductId: 0 };

  const withPrices = products.map((p) => ({ id: p.id, priceCents: prices.get(p.id) ?? 0 }));
  const correctId = identifyOutlier(withPrices);

  if (coinFlip(CORRECT_PROB[difficulty])) {
    return { guessedProductId: correctId };
  }
  const wrong = products.filter((p) => p.id !== correctId);
  return { guessedProductId: pick(wrong).id };
}

function guessMarketBasket(
  difficulty: BotDifficulty, rp: RoundStartPayload, prices: Map<number, number>, ctx: BotGuessContext,
): GuessData {
  const products = rp.products ?? [];
  const actualTotal = products.reduce((sum, p) => sum + (prices.get(p.id) ?? 0), 0);
  const personality = resolvePersonality(ctx.botPlayerId, ctx.roomCode, difficulty);
  return { guessedTotalCents: sampleBotPrice(actualTotal, personality) };
}

function guessSortItOut(
  difficulty: BotDifficulty, rp: RoundStartPayload, prices: Map<number, number>,
): GuessData {
  const products = rp.products ?? [];
  const correctOrder = [...products]
    .sort((a, b) => (prices.get(a.id) ?? 0) - (prices.get(b.id) ?? 0))
    .map((p) => p.id);

  if (difficulty === "hard") {
    const order = [...correctOrder];
    if (Math.random() > 0.7 && order.length >= 2) {
      const i = Math.floor(Math.random() * (order.length - 1));
      [order[i], order[i + 1]] = [order[i + 1], order[i]];
    }
    return { submittedOrder: order };
  }

  if (difficulty === "medium") {
    const order = [...correctOrder];
    const swaps = 1 + Math.floor(Math.random() * 2);
    for (let s = 0; s < swaps && order.length >= 2; s++) {
      const i = Math.floor(Math.random() * (order.length - 1));
      [order[i], order[i + 1]] = [order[i + 1], order[i]];
    }
    return { submittedOrder: order };
  }

  return { submittedOrder: shuffle(correctOrder) };
}

function guessBudgetBuilder(
  difficulty: BotDifficulty, rp: RoundStartPayload, prices: Map<number, number>,
): GuessData {
  const products = rp.products ?? [];
  const budget = rp.budgetCents ?? 10000;

  const sorted = [...products].sort((a, b) => (prices.get(b.id) ?? 0) - (prices.get(a.id) ?? 0));
  const candidates = difficulty === "easy" ? shuffle(sorted) : sorted;
  const selected: number[] = [];
  let total = 0;

  for (const p of candidates) {
    const price = prices.get(p.id) ?? 0;
    if (total + price <= budget) {
      selected.push(p.id);
      total += price;
    }
  }

  if (selected.length === 0 && products.length > 0) {
    selected.push(products[0].id);
  }

  return { selectedProductIds: selected };
}

function guessChainReaction(
  difficulty: BotDifficulty, rp: RoundStartPayload, prices: Map<number, number>,
): GuessData {
  const products = rp.products ?? [];
  if (products.length <= 1) return { chainGuesses: [] };

  const guesses: ("more" | "less")[] = [];
  for (let i = 1; i < products.length; i++) {
    const prevPrice = prices.get(products[i - 1].id) ?? 0;
    const currPrice = prices.get(products[i].id) ?? 0;
    const correct: "more" | "less" = currPrice >= prevPrice ? "more" : "less";
    const wrong: "more" | "less" = correct === "more" ? "less" : "more";
    guesses.push(coinFlip(CORRECT_PROB[difficulty]) ? correct : wrong);
  }
  return { chainGuesses: guesses };
}

function guessBidding(
  difficulty: BotDifficulty, rp: RoundStartPayload, prices: Map<number, number>, ctx: BotGuessContext,
): GuessData {
  const actual = prices.get(rp.product!.id) ?? 5000;
  const personality = resolvePersonality(ctx.botPlayerId, ctx.roomCode, difficulty);
  const bid = sampleBotBid(actual, personality, ctx.bidding);
  return { bidCents: snapToRetailUnder(bid, actual) };
}
