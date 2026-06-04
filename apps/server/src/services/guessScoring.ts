/**
 * Shared scoring dispatcher for all game modes.
 *
 * Used by both single-player (gameGuess) and multiplayer (mpGuess) to score
 * guesses consistently. Centralises mode-specific validation and scoring logic
 * so that a bug fix or rule change only needs to happen in one place.
 *
 * Returns a discriminated union (`ScoringResult`) containing the numeric score
 * plus mode-specific result data (pctOff, correct, correctOrder, etc.) so
 * callers can build response payloads without re-running scoring logic.
 */
import { DbProduct, getProductsByIds } from "./productMapper";
import {
  GameMode,
  scoreGuess,
  scoreHigherLower,
  scoreComparison,
  scoreClosest,
  scorePriceMatch,
  scoreRiser,
  identifyOutlier,
  scoreOddOneOut,
  scoreMarketBasket,
  scoreSortItOut,
  scoreBudgetBuilder,
  scoreChainSubGuess,
  scoreChainReaction,
  scoreBidding,
  scoreBiddingSolo,
} from "@price-game/shared";

/** Maximum allowed length for client-supplied arrays to prevent DoS. */
export const MAX_ARRAY_INPUT_LENGTH = 20;

// ── Result types ─────────────────────────────────────────────────────────

/** Discriminated union of all possible scoring results, keyed by `mode`. */
export type ScoringResult =
  | { mode: "classic"; score: number; pctOff: number; guessedPriceCents: number }
  | { mode: "higher-lower"; score: number; correct: boolean; guess: string }
  | { mode: "comparison"; score: number; correct: boolean; correctProductId: number; guessedProductId: number }
  | { mode: "closest-without-going-over"; score: number; pctOff: number; wentOver: boolean; guessedPriceCents: number }
  | { mode: "price-match"; score: number; correctCount: number; assignments: Record<number, number> }
  | { mode: "riser"; score: number; pctOff: number; wentOver: boolean; stoppedPriceCents: number }
  | { mode: "odd-one-out"; score: number; correct: boolean; outlierProductId: number; guessedProductId: number }
  | { mode: "market-basket"; score: number; pctOff: number; actualTotalCents: number; guessedTotalCents: number }
  | { mode: "sort-it-out"; score: number; correctCount: number; correctOrder: number[]; submittedOrder: number[] }
  | { mode: "budget-builder"; score: number; cartTotalCents: number; budgetCents: number; selectedProductIds: number[] }
  | { mode: "chain-reaction"; score: number; correctCount: number; chainLength: number; chainGuesses: string[] }
  | { mode: "bidding"; score: number; bidCents: number; pctOff?: number; wentOver?: boolean; isExact?: boolean }
  | { mode: "invalid"; score: 0 };

// ── Scoring dispatcher ───────────────────────────────────────────────────

/**
 * Score a guess for any game mode and return full result data.
 *
 * Performs runtime validation of `guessData` per mode before delegating to the
 * corresponding scoring function from `@price-game/shared`. Returns a
 * discriminated union containing the score plus all mode-specific result fields
 * (e.g. pctOff, correct, correctOrder) so callers can build response payloads
 * without duplicating scoring logic.
 *
 * @param mode - The game mode.
 * @param guessData - Raw (unvalidated) guess payload from the client.
 * @param productIds - Product IDs relevant to the current round.
 * @param roundMeta - Mode-specific metadata (question, referencePrice, budgetCents, etc.).
 * @returns A ScoringResult with mode-specific fields; score is 0 on invalid input.
 */
export function scoreGuessForMode(
  mode: GameMode,
  // Kept as `any` — each branch below validates the expected shape at
  // runtime before using any properties (see GuessData for the typed shape).
  guessData: any,
  productIds: number[],
  roundMeta: Record<string, any>,
  cache?: Map<number, DbProduct>,
  /**
   * Context of the call. In "mp" mode, the bidding branch deliberately returns
   * score 0 because multiplayer bidding uses comparative scoring computed
   * after ALL bids are in (see finalizeBiddingScores). In "sp" mode (the
   * default), the bidding branch computes a single-player score immediately
   * using scoreBidding with just this one bid — used by the daily challenge.
   */
  context: "sp" | "mp" = "sp",
): ScoringResult {
  try {
    if (!guessData || typeof guessData !== "object") return { mode: "invalid", score: 0 };

    // Use pre-fetched cache if provided, otherwise batch fetch
    const productMap = cache ?? getProductsByIds(productIds);

    if (mode === "classic") {
      if (typeof guessData.guessedPriceCents !== "number" || guessData.guessedPriceCents < 0 || guessData.guessedPriceCents > 10_000_000) {
        return { mode: "classic", score: 0, pctOff: 100, guessedPriceCents: 0 };
      }
      const guessedPriceCents = guessData.guessedPriceCents;
      const product = productMap.get(productIds[0]);
      if (!product) return { mode: "classic", score: 0, pctOff: 100, guessedPriceCents };
      const { score, pctOff } = scoreGuess(guessedPriceCents, product.price_cents);
      return { mode: "classic", score, pctOff, guessedPriceCents };
    }

    if (mode === "higher-lower") {
      if (guessData.guess !== "higher" && guessData.guess !== "lower") {
        return { mode: "higher-lower", score: 0, correct: false, guess: guessData.guess ?? "higher" };
      }
      const guess = guessData.guess;
      const product = productMap.get(productIds[0]);
      if (!product) return { mode: "higher-lower", score: 0, correct: false, guess };
      const { score, correct } = scoreHigherLower(roundMeta.referencePrice, product.price_cents, guess);
      return { mode: "higher-lower", score, correct, guess };
    }

    if (mode === "comparison") {
      const guessedProductId = typeof guessData.guessedProductId === "number" ? guessData.guessedProductId : 0;
      const products = productIds.map((id) => {
        const row = productMap.get(id);
        if (!row) return null;
        return { id: row.id, priceCents: row.price_cents };
      }).filter((p): p is { id: number; priceCents: number } => p !== null);
      if (products.length !== productIds.length) {
        return { mode: "comparison", score: 0, correct: false, correctProductId: 0, guessedProductId };
      }
      const validGuess = productIds.includes(guessedProductId);
      const { score, correct, correctProductId } = validGuess
        ? scoreComparison(products, roundMeta.question, guessedProductId)
        : { score: 0, correct: false, correctProductId: products[0]?.id || 0 };
      return { mode: "comparison", score, correct, correctProductId, guessedProductId };
    }

    if (mode === "closest-without-going-over") {
      if (typeof guessData.guessedPriceCents !== "number" || guessData.guessedPriceCents < 0 || guessData.guessedPriceCents > 10_000_000) {
        return { mode: "closest-without-going-over", score: 0, pctOff: 100, wentOver: false, guessedPriceCents: 0 };
      }
      const guessedPriceCents = guessData.guessedPriceCents;
      const product = productMap.get(productIds[0]);
      if (!product) return { mode: "closest-without-going-over", score: 0, pctOff: 100, wentOver: false, guessedPriceCents };
      const { score, pctOff, wentOver } = scoreClosest(guessedPriceCents, product.price_cents);
      return { mode: "closest-without-going-over", score, pctOff, wentOver, guessedPriceCents };
    }

    if (mode === "price-match") {
      if (!guessData.assignments || typeof guessData.assignments !== "object") {
        return { mode: "price-match", score: 0, correctCount: 0, assignments: {} };
      }
      // Cap key count and validate values
      const entries = Object.entries(guessData.assignments).slice(0, MAX_ARRAY_INPUT_LENGTH);
      const assignments: Record<number, number> = {};
      for (const [k, v] of entries) {
        if (typeof v === "number" && v >= 0 && v <= 10_000_000) {
          assignments[Number(k)] = v;
        }
      }
      const products = productIds.map((id) => {
        const row = productMap.get(id);
        if (!row) return null;
        return { id: row.id, priceCents: row.price_cents };
      }).filter((p): p is { id: number; priceCents: number } => p !== null);
      if (products.length !== productIds.length) {
        return { mode: "price-match", score: 0, correctCount: 0, assignments };
      }
      const { score, correctCount } = scorePriceMatch(assignments, products);
      return { mode: "price-match", score, correctCount, assignments };
    }

    if (mode === "riser") {
      if (typeof guessData.stoppedPriceCents !== "number" || guessData.stoppedPriceCents < 0 || guessData.stoppedPriceCents > 10_000_000) {
        return { mode: "riser", score: 0, pctOff: 100, wentOver: false, stoppedPriceCents: 0 };
      }
      const stoppedPriceCents = guessData.stoppedPriceCents;
      const product = productMap.get(productIds[0]);
      if (!product) return { mode: "riser", score: 0, pctOff: 100, wentOver: false, stoppedPriceCents };
      const { score, pctOff, wentOver } = scoreRiser(stoppedPriceCents, product.price_cents);
      return { mode: "riser", score, pctOff, wentOver, stoppedPriceCents };
    }

    if (mode === "odd-one-out") {
      const guessedProductId = typeof guessData.guessedProductId === "number" ? guessData.guessedProductId : 0;
      const products = productIds.map((id) => {
        const row = productMap.get(id);
        if (!row) return null;
        return { id: row.id, priceCents: row.price_cents };
      }).filter((p): p is { id: number; priceCents: number } => p !== null);
      if (products.length === 0) {
        return { mode: "odd-one-out", score: 0, correct: false, outlierProductId: 0, guessedProductId };
      }
      const outlierProductId = identifyOutlier(products);
      const validGuess = productIds.includes(guessedProductId);
      const { score, correct } = validGuess
        ? scoreOddOneOut(products, outlierProductId, guessedProductId)
        : { score: 0, correct: false };
      return { mode: "odd-one-out", score, correct, outlierProductId, guessedProductId };
    }

    if (mode === "market-basket") {
      const guessedTotalCents = typeof guessData.guessedTotalCents === "number"
        && guessData.guessedTotalCents >= 0 && guessData.guessedTotalCents <= 10_000_000
        ? guessData.guessedTotalCents : 0;
      const actualTotalCents = productIds.reduce((s, id) => s + (productMap.get(id)?.price_cents ?? 0), 0);
      const { score, pctOff } = scoreMarketBasket(guessedTotalCents, actualTotalCents);
      return { mode: "market-basket", score, pctOff, actualTotalCents, guessedTotalCents };
    }

    if (mode === "sort-it-out") {
      if (!Array.isArray(guessData.submittedOrder)) {
        return { mode: "sort-it-out", score: 0, correctCount: 0, correctOrder: [], submittedOrder: [] };
      }
      const submittedOrder: number[] = guessData.submittedOrder.slice(0, MAX_ARRAY_INPUT_LENGTH).filter((id: unknown) => typeof id === "number");
      const products = productIds.map((id) => {
        const row = productMap.get(id);
        if (!row) return null;
        return { id: row.id, priceCents: row.price_cents };
      }).filter((p): p is { id: number; priceCents: number } => p !== null);
      const correctOrder = [...products].sort((a, b) => a.priceCents - b.priceCents).map((p) => p.id);
      const { score, correctCount } = scoreSortItOut(submittedOrder, correctOrder);
      return { mode: "sort-it-out", score, correctCount, correctOrder, submittedOrder };
    }

    if (mode === "budget-builder") {
      if (!Array.isArray(guessData.selectedProductIds)) {
        return { mode: "budget-builder", score: 0, cartTotalCents: 0, budgetCents: 0, selectedProductIds: [] };
      }
      const selectedProductIds: number[] = guessData.selectedProductIds
        .slice(0, MAX_ARRAY_INPUT_LENGTH)
        .filter((pid: unknown): pid is number => typeof pid === "number" && productIds.includes(pid));
      const cartTotalCents = selectedProductIds.reduce(
        (s: number, pid: number) => s + (productMap.get(pid)?.price_cents ?? 0), 0
      );
      const budgetCents = roundMeta.budgetCents || 0;
      const { score } = scoreBudgetBuilder(cartTotalCents, budgetCents);
      return { mode: "budget-builder", score, cartTotalCents, budgetCents, selectedProductIds };
    }

    if (mode === "chain-reaction") {
      if (!Array.isArray(guessData.chainGuesses)) {
        return { mode: "chain-reaction", score: 0, correctCount: 0, chainLength: 0, chainGuesses: [] };
      }
      const chainGuesses: string[] = guessData.chainGuesses
        .slice(0, MAX_ARRAY_INPUT_LENGTH)
        .filter((g: unknown): g is string => g === "more" || g === "less");
      const products = productIds.map((id) => productMap.get(id)).filter((p): p is DbProduct => p !== undefined);
      const chainLength = products.length - 1;
      let correctCount = 0;
      for (let i = 0; i < chainLength && i < chainGuesses.length; i++) {
        const guess = chainGuesses[i];
        if (guess !== "more" && guess !== "less") continue;
        if (scoreChainSubGuess(products[i].price_cents, products[i + 1].price_cents, guess)) {
          correctCount++;
        }
      }
      const { score } = scoreChainReaction(correctCount, chainLength);
      return { mode: "chain-reaction", score, correctCount, chainLength, chainGuesses };
    }

    if (mode === "bidding") {
      // Accept either `bidCents` (multiplayer bidding UI) or
      // `guessedPriceCents` (reused single-product UI like ClosestPage for
      // the daily challenge's solo-bidding mode).
      const rawBid = typeof guessData.bidCents === "number"
        ? guessData.bidCents
        : typeof guessData.guessedPriceCents === "number"
          ? guessData.guessedPriceCents
          : 0;
      const bidCents = rawBid >= 0 && rawBid <= 10_000_000 ? rawBid : 0;

      if (context === "mp") {
        // Multiplayer bidding uses comparative scoring via finalizeBiddingScores(),
        // so this branch returns a placeholder score for individual bid storage.
        return { mode: "bidding", score: 0, bidCents };
      }

      // Single-player bidding (e.g. the daily challenge). Use proximity-based
      // scoring — rank-based scoring is meaningless with a single bid and
      // previously handed 1000 pts to any valid underbid (including $0.01 bids).
      const product = productMap.get(productIds[0]);
      if (!product) return { mode: "bidding", score: 0, bidCents };
      const solo = scoreBiddingSolo(bidCents, product.price_cents);
      return {
        mode: "bidding",
        score: solo.score,
        bidCents,
        pctOff: solo.pctOff,
        wentOver: solo.wentOver,
        isExact: solo.isExact,
      };
    }

    return { mode: "invalid", score: 0 };
  } catch {
    return { mode: "invalid", score: 0 };
  }
}
