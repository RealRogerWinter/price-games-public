/**
 * Round composer — orchestrates difficulty curves, candidate pools, and
 * round composition for both single-player and multiplayer games.
 */

import db from "../db";
import type { GameMode } from "@price-game/shared";
import {
  TOTAL_ROUNDS,
  COMPARISON_PRODUCTS_PER_ROUND,
  PRICE_MATCH_PRODUCTS_PER_ROUND,
  ODD_ONE_OUT_PRODUCTS_PER_ROUND,
  MARKET_BASKET_MAX_PRODUCTS,
  SORT_IT_OUT_PRODUCTS_PER_ROUND,
  BUDGET_BUILDER_PRODUCTS_PER_ROUND,
  CHAIN_REACTION_PRODUCTS_PER_ROUND,
} from "@price-game/shared";
import {
  CandidateProduct,
  DifficultyTier,
  selectComparisonPair,
  selectPriceMatchGroup,
  selectSingleProduct,
  selectOddOneOutGroup,
  selectMarketBasketGroup,
  selectSortItOutGroup,
  selectBudgetBuilderGroup,
  selectChainGroup,
} from "./productPairing";
import { selectProducts } from "./productSelection";
import { UserFacingError } from "./errors";

export interface ComposeAllOptions {
  mode: GameMode;
  totalRounds: number;
  categories?: string[];
  userId?: string;
  excludeProductIds?: number[];
}

export interface ComposeOneOptions {
  mode: GameMode;
  totalRounds: number;
  roundNumber: number;
  categories?: string[];
  sessionUsedIds?: Set<number>;
}

export interface ComposedRounds {
  productIds: number[];
  roundData: Record<string, any> | null;
}

export interface ComposedRound {
  productIds: number[];
  roundMeta: Record<string, any>;
}

/**
 * Determine difficulty tier for a given round, using weighted random zones
 * with a 10% wildcard chance.
 *
 * @param roundNumber - Current round (1-indexed).
 * @param totalRounds - Total rounds in the game.
 * @returns The difficulty tier for this round.
 */
export function getDifficultyForRound(roundNumber: number, totalRounds: number): DifficultyTier {
  // 10% wildcard → random tier
  if (Math.random() < 0.10) {
    const tiers: DifficultyTier[] = ["easy", "medium", "hard"];
    return tiers[Math.floor(Math.random() * 3)];
  }

  const progress = (roundNumber - 1) / Math.max(totalRounds - 1, 1);

  let weights: [number, number, number];
  if (progress < 0.30) {
    weights = [0.70, 0.25, 0.05]; // early: mostly easy
  } else if (progress < 0.70) {
    weights = [0.20, 0.55, 0.25]; // mid: mostly medium
  } else {
    weights = [0.05, 0.25, 0.70]; // late: mostly hard
  }

  const roll = Math.random();
  if (roll < weights[0]) return "easy";
  if (roll < weights[0] + weights[1]) return "medium";
  return "hard";
}

/**
 * Fetch a pool of candidate products from the database, respecting user
 * history and exclusion lists.
 *
 * @param needed - Minimum number of products needed.
 * @param categories - Optional category filter.
 * @param userId - Optional user ID for per-user product memory.
 * @param excludeProductIds - Optional product IDs to hard-exclude.
 * @returns Array of candidate products.
 */
export function fetchCandidatePool(
  needed: number,
  categories?: string[],
  userId?: string,
  excludeProductIds?: number[]
): CandidateProduct[] {
  const poolSize = Math.max(needed * 4, 60);

  const result = fetchCandidatePoolInner(poolSize, categories, userId, excludeProductIds);

  // Graceful degradation: if not enough, retry without user exclusions
  if (result.length < needed && userId) {
    console.warn(
      `[RoundComposer] User ${userId}: candidate pool too small with exclusions (${result.length}/${needed}), dropping user history filter`
    );
    return fetchCandidatePoolInner(poolSize, categories, undefined, excludeProductIds);
  }

  return result;
}

function fetchCandidatePoolInner(
  poolSize: number,
  categories?: string[],
  userId?: string,
  excludeProductIds?: number[]
): CandidateProduct[] {
  const conditions: string[] = ["is_active = 1", "price_cents > 0"];
  const params: any[] = [];

  // Category filter
  if (categories && categories.length > 0) {
    conditions.push(`category IN (${categories.map(() => "?").join(", ")})`);
    params.push(...categories);
  }

  // Hard exclude specific product IDs
  if (excludeProductIds && excludeProductIds.length > 0) {
    conditions.push(`id NOT IN (${excludeProductIds.map(() => "?").join(", ")})`);
    params.push(...excludeProductIds);
  }

  // User-specific exclusions (capped at 500 to bound IN-clause size)
  const MAX_USER_EXCLUSIONS = 500;
  if (userId) {
    const recentViewed = getRecentlyViewedProductIds(userId, 5);
    if (recentViewed.size > 0) {
      const userExcludedIds = [...recentViewed].slice(0, MAX_USER_EXCLUSIONS);
      conditions.push(`id NOT IN (${userExcludedIds.map(() => "?").join(", ")})`);
      params.push(...userExcludedIds);
    }
  }

  const where = conditions.join(" AND ");

  // ORDER BY: unseen first (by LRU), then random
  const query = `
    SELECT id, price_cents, title, category, manufacturer
    FROM products
    WHERE ${where}
    ORDER BY
      CASE WHEN last_used_at IS NULL THEN 0 ELSE 1 END,
      last_used_at ASC,
      RANDOM()
    LIMIT ?
  `;
  params.push(poolSize);

  return db.prepare(query).all(...params) as CandidateProduct[];
}

/**
 * Compose all rounds for a single-player game.
 *
 * @param options - Composition options including mode, categories, user context.
 * @returns Product IDs and round data for the entire game.
 */
export function composeRounds(options: ComposeAllOptions): ComposedRounds {
  const { mode, totalRounds, categories, userId, excludeProductIds } = options;

  const productsPerRound = getProductsPerRound(mode);
  const totalNeeded = totalRounds * productsPerRound;

  const candidates = fetchCandidatePool(totalNeeded, categories, userId, excludeProductIds);

  const allProductIds: number[] = [];
  const roundData: Record<string, any> = {};
  const usedIds = new Set<number>();

  for (let round = 1; round <= totalRounds; round++) {
    const difficulty = getDifficultyForRound(round, totalRounds);
    const roundProducts = selectProductsForRound(mode, difficulty, candidates, usedIds);

    if (roundProducts) {
      const roundProductIds = roundProducts.map((p) => p.id);
      for (const id of roundProductIds) {
        allProductIds.push(id);
        usedIds.add(id);
      }
      roundData[String(round)] = { productIds: roundProductIds, ...generateRoundMeta(mode, difficulty, roundProducts) };
    } else {
      // Fallback: use legacy product selection
      const fallbackProducts = selectFallbackProducts(productsPerRound, categories);
      for (const p of fallbackProducts) {
        allProductIds.push(p.id);
        usedIds.add(p.id);
      }
      roundData[String(round)] = generateRoundMetaFallback(mode, fallbackProducts);
    }
  }

  // Verify every round got at least 1 product (the loop may produce variable counts
  // for modes like market-basket where difficulty controls product count per round)
  if (allProductIds.length === 0) {
    throw new UserFacingError("Not enough products to compose any rounds.");
  }

  // Mark all selected products as recently used
  markProductsUsed(allProductIds);

  const hasRoundData = Object.values(roundData).some((rd) => Object.keys(rd).length > 0)
    ? roundData
    : null;

  return { productIds: allProductIds, roundData: hasRoundData };
}

/**
 * Compose a single round for multiplayer games.
 *
 * @param options - Composition options for a single round.
 * @returns Product IDs and round metadata.
 */
export function composeRound(options: ComposeOneOptions): ComposedRound {
  const { mode, totalRounds, roundNumber, categories, sessionUsedIds } = options;

  const productsPerRound = getProductsPerRound(mode);

  // No userId for multiplayer (fairness); pass sessionUsedIds as excludeProductIds for better pool diversity
  const excludeIds = sessionUsedIds ? [...sessionUsedIds] : undefined;
  const candidates = fetchCandidatePool(productsPerRound, categories, undefined, excludeIds);
  const usedIds = sessionUsedIds || new Set<number>();
  const difficulty = getDifficultyForRound(roundNumber, totalRounds);

  const roundProducts = selectProductsForRound(mode, difficulty, candidates, usedIds);

  if (roundProducts) {
    const productIds = roundProducts.map((p) => p.id);
    const roundMeta = generateRoundMeta(mode, difficulty, roundProducts);
    markProductsUsed(productIds);
    return { productIds, roundMeta };
  }

  // Fallback
  const fallbackProducts = selectFallbackProducts(productsPerRound, categories);
  const productIds = fallbackProducts.map((p) => p.id);
  markProductsUsed(productIds);
  return { productIds, roundMeta: generateRoundMetaFallback(mode, fallbackProducts) };
}

/**
 * Record which products a user has seen in a session.
 *
 * @param userId - The user's ID.
 * @param productIds - Array of product IDs shown.
 * @param sessionId - The game session ID.
 */
export function recordUserProductViews(userId: string, productIds: number[], sessionId: string): void {
  // Cap to prevent unbounded inserts (price-match = 40 products max per game)
  const MAX_VIEWS_PER_CALL = 100;
  const capped = productIds.slice(0, MAX_VIEWS_PER_CALL);
  const now = new Date().toISOString();
  const insert = db.prepare(
    "INSERT OR IGNORE INTO user_product_views (user_id, product_id, session_id, seen_at) VALUES (?, ?, ?, ?)"
  );
  const record = db.transaction(() => {
    for (const pid of capped) {
      insert.run(userId, pid, sessionId, now);
    }
  });
  record();
}

/**
 * Get product IDs the user has seen in their most recent N sessions.
 *
 * @param userId - The user's ID.
 * @param sessionCount - Number of recent sessions to look back (default 5).
 * @returns Set of product IDs.
 */
export function getRecentlyViewedProductIds(userId: string, sessionCount: number = 5): Set<number> {
  // Find last N distinct session_ids (GROUP BY + MAX for deterministic ordering)
  const sessions = db.prepare(
    `SELECT session_id FROM user_product_views
     WHERE user_id = ?
     GROUP BY session_id
     ORDER BY MAX(seen_at) DESC
     LIMIT ?`
  ).all(userId, sessionCount) as { session_id: string }[];

  if (sessions.length === 0) return new Set();

  const sessionIds = sessions.map((s) => s.session_id);
  const placeholders = sessionIds.map(() => "?").join(", ");
  const products = db.prepare(
    `SELECT DISTINCT product_id FROM user_product_views
     WHERE user_id = ? AND session_id IN (${placeholders})`
  ).all(userId, ...sessionIds) as { product_id: number }[];

  return new Set(products.map((p) => p.product_id));
}

// --- Internal helpers ---

/**
 * Return the expected number of products per round for a given game mode.
 *
 * @param mode - The game mode.
 * @returns Product count for one round.
 */
function getProductsPerRound(mode: GameMode): number {
  switch (mode) {
    case "comparison": return COMPARISON_PRODUCTS_PER_ROUND;
    case "price-match": return PRICE_MATCH_PRODUCTS_PER_ROUND;
    case "odd-one-out": return ODD_ONE_OUT_PRODUCTS_PER_ROUND;
    case "market-basket": return MARKET_BASKET_MAX_PRODUCTS;
    case "sort-it-out": return SORT_IT_OUT_PRODUCTS_PER_ROUND;
    case "budget-builder": return BUDGET_BUILDER_PRODUCTS_PER_ROUND;
    case "chain-reaction": return CHAIN_REACTION_PRODUCTS_PER_ROUND;
    default: return 1;
  }
}

function selectProductsForRound(
  mode: GameMode,
  difficulty: DifficultyTier,
  candidates: CandidateProduct[],
  usedIds: Set<number>
): CandidateProduct[] | null {
  if (mode === "comparison") {
    const pair = selectComparisonPair(difficulty, candidates, usedIds);
    return pair ? [pair[0], pair[1]] : null;
  }

  if (mode === "price-match") {
    return selectPriceMatchGroup(difficulty, candidates, usedIds);
  }

  if (mode === "odd-one-out") {
    return selectOddOneOutGroup(difficulty, candidates, usedIds);
  }

  if (mode === "market-basket") {
    return selectMarketBasketGroup(difficulty, candidates, usedIds);
  }

  if (mode === "sort-it-out") {
    return selectSortItOutGroup(difficulty, candidates, usedIds);
  }

  if (mode === "budget-builder") {
    return selectBudgetBuilderGroup(difficulty, candidates, usedIds);
  }

  if (mode === "chain-reaction") {
    return selectChainGroup(difficulty, candidates, usedIds);
  }

  // Single product modes
  const product = selectSingleProduct(difficulty, mode, candidates, usedIds);
  return product ? [product] : null;
}

function generateRoundMeta(
  mode: GameMode,
  difficulty: DifficultyTier,
  products: CandidateProduct[]
): Record<string, any> {
  if (mode === "higher-lower") {
    const actual = products[0].price_cents;
    const range = HIGHER_LOWER_OFFSETS[difficulty];
    const pctOffset = range.min + Math.random() * (range.max - range.min);
    const direction = Math.random() < 0.5 ? 1 : -1;
    const referencePrice = Math.max(100, Math.round(actual * (1 + direction * pctOffset)));
    return { referencePrice };
  }

  if (mode === "comparison") {
    return { question: Math.random() < 0.5 ? "most-expensive" : "least-expensive" };
  }

  if (mode === "riser") {
    const riserConfig = RISER_CONFIGS[difficulty];
    const patterns = riserConfig.patterns;
    const speedPattern = patterns[Math.floor(Math.random() * patterns.length)];
    const durationMs = riserConfig.minDuration +
      Math.floor(Math.random() * (riserConfig.maxDuration - riserConfig.minDuration));
    const targetPosition = 0.25 + Math.random() * 0.60;
    const maxPriceCents = Math.round(products[0].price_cents / (0.1 + 0.9 * targetPosition));
    return { maxPriceCents, speedPattern, durationMs };
  }

  if (mode === "market-basket") {
    return { itemCount: products.length };
  }

  if (mode === "budget-builder") {
    const totalProductValue = products.reduce((s, p) => s + p.price_cents, 0);
    const budgetFraction = difficulty === "easy" ? 0.65 : difficulty === "medium" ? 0.50 : 0.40;
    const budgetCents = Math.round(totalProductValue * budgetFraction);
    return { budgetCents };
  }

  // classic, closest, price-match, odd-one-out, sort-it-out, chain-reaction: no extra metadata
  return {};
}

function generateRoundMetaFallback(
  mode: GameMode,
  products: { id: number; price_cents: number }[]
): Record<string, any> {
  if (mode === "higher-lower") {
    const actual = products[0].price_cents;
    const pctOffset = 0.15 + Math.random() * 0.30;
    const direction = Math.random() < 0.5 ? 1 : -1;
    return { referencePrice: Math.max(100, Math.round(actual * (1 + direction * pctOffset))) };
  }

  if (mode === "comparison") {
    return { question: Math.random() < 0.5 ? "most-expensive" : "least-expensive" };
  }

  if (mode === "riser") {
    const speedPatterns = ["linear", "accelerating", "decelerating", "wave"];
    const targetPosition = 0.25 + Math.random() * 0.60;
    const maxPriceCents = Math.round(products[0].price_cents / (0.1 + 0.9 * targetPosition));
    return {
      maxPriceCents,
      speedPattern: speedPatterns[Math.floor(Math.random() * speedPatterns.length)],
      durationMs: 8000 + Math.floor(Math.random() * 10000),
    };
  }

  return {};
}

/** Difficulty-aware reference price offsets for Higher/Lower mode. */
const HIGHER_LOWER_OFFSETS: Record<DifficultyTier, { min: number; max: number }> = {
  easy: { min: 0.35, max: 0.45 },
  medium: { min: 0.20, max: 0.35 },
  hard: { min: 0.15, max: 0.20 },
};

/** Difficulty-aware riser configurations. */
const RISER_CONFIGS: Record<DifficultyTier, { minDuration: number; maxDuration: number; patterns: string[] }> = {
  easy: { minDuration: 14000, maxDuration: 18000, patterns: ["linear", "decelerating"] },
  medium: { minDuration: 10000, maxDuration: 14000, patterns: ["linear", "accelerating", "decelerating", "wave"] },
  hard: { minDuration: 8000, maxDuration: 10000, patterns: ["accelerating", "wave"] },
};

function selectFallbackProducts(
  count: number,
  categories: string[] | undefined
): { id: number; price_cents: number }[] {
  try {
    return selectProducts(count, categories);
  } catch {
    // If even the legacy selector fails, try without category filter
    try {
      return selectProducts(count);
    } catch {
      return [];
    }
  }
}

function markProductsUsed(productIds: number[]): void {
  if (productIds.length === 0) return;
  const now = new Date().toISOString();
  const update = db.prepare("UPDATE products SET last_used_at = ? WHERE id = ?");
  const mark = db.transaction(() => {
    for (const id of productIds) {
      update.run(now, id);
    }
  });
  mark();
}
