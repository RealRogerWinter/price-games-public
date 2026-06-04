import { useMemo } from "react";
import type {
  GameMode,
  RoundResultsPayload,
  ShareGridInput,
  SharedRoundSnapshot,
  RevealData,
} from "@price-game/shared";
import { getGameModeName, getPerRoundMaxScore } from "@price-game/shared";

/**
 * Minimal shape we need from a single-player round result: score plus the
 * optional mode-specific fields we surface in the shared-URL snapshot. Kept
 * deliberately loose (every field optional) so the hook can accept any of
 * the 11 mode-specific result variants without a switch.
 */
interface SPRoundWithScore {
  score: number;
  product?: {
    title: string;
    imageUrl: string;
    priceCents: number;
    amazonUrl?: string;
  };
  products?: Array<{
    id?: number;
    title: string;
    imageUrl: string;
    priceCents: number;
    amazonUrl?: string;
  }>;
  guessedPriceCents?: number;
  guessedProductId?: number;
  guess?: "higher" | "lower";
  correct?: boolean;
  correctCount?: number;
  wentOver?: boolean;
  referencePrice?: number;
  actualTotalCents?: number;
  guessedTotalCents?: number;
  budgetCents?: number;
  cartTotalCents?: number;
  outlierProductId?: number;
}

/** Single-player variant: scores come from the caller's roundResults array. */
export interface UseShareDataSPInput {
  variant: "sp";
  gameMode: GameMode;
  roundResults: SPRoundWithScore[];
  totalScore: number;
}

/**
 * Multiplayer variant: scores are extracted from each RoundResultsPayload's
 * playerResults for the current player id. If `currentPlayerId` is missing,
 * or the player is not found in a round (e.g. they joined late), that
 * round's score is treated as 0 (miss).
 *
 * `playerRank` and `playerCount` are forwarded to the resulting ShareGridInput
 * so the share header can carry a "#N of M" finishing-position suffix.
 */
export interface UseShareDataMPInput {
  variant: "mp";
  gameMode: GameMode;
  allRoundResults: RoundResultsPayload[];
  currentPlayerId: string | null | undefined;
  totalScore: number;
  /** Optional 1-based finishing position (see ShareGridInput.playerRank). */
  playerRank?: number;
  /** Optional total players in the game (see ShareGridInput.playerCount). */
  playerCount?: number;
}

export type UseShareDataInput = UseShareDataSPInput | UseShareDataMPInput;

/**
 * Pure derivation of a ShareGridInput from SP or MP state. Exposed separately
 * from the hook so it can be called directly from tests and other non-React
 * contexts.
 *
 * @param input - SP or MP input
 * @returns ShareGridInput ready to pass to buildShareText / renderShareImage
 */
export function buildShareData(input: UseShareDataInput): ShareGridInput {
  const perRoundMax = getPerRoundMaxScore(input.gameMode);
  const modeName = getGameModeName(input.gameMode);

  let roundScores: number[];
  if (input.variant === "sp") {
    roundScores = (input.roundResults ?? []).map((r) => r?.score ?? 0);
  } else {
    const pid = input.currentPlayerId;
    if (!pid) {
      // No player id — no way to pick out this player's scores. Return empty
      // array; buildShareText will pad with misses.
      roundScores = [];
    } else {
      roundScores = (input.allRoundResults ?? []).map((rr) => {
        const me = rr.playerResults.find((p) => p.playerId === pid);
        return me?.score ?? 0;
      });
    }
  }

  const out: ShareGridInput = {
    gameMode: input.gameMode,
    modeName,
    roundScores,
    totalScore: input.totalScore,
    perRoundMax,
  };
  // Only the MP variant carries placement; pass through when present so the
  // shared header can render the "#N of M" finishing-position suffix.
  if (input.variant === "mp") {
    if (input.playerRank !== undefined) out.playerRank = input.playerRank;
    if (input.playerCount !== undefined) out.playerCount = input.playerCount;
  }
  return out;
}

/**
 * Strip a product down to the four fields stored in a SharedRoundSnapshot.
 * Accepts the loose shape from either `SPRoundWithScore` or
 * `ProductWithPrice` (MP reveal data).
 */
function pickSnapshotProduct(p: {
  title: string;
  imageUrl: string;
  priceCents: number;
  amazonUrl?: string;
}): { title: string; imageUrl: string; priceCents: number; amazonUrl?: string } {
  const out: { title: string; imageUrl: string; priceCents: number; amazonUrl?: string } = {
    title: p.title,
    imageUrl: p.imageUrl,
    priceCents: p.priceCents,
  };
  if (p.amazonUrl) out.amazonUrl = p.amazonUrl;
  return out;
}

/**
 * Extract the product list from a multiplayer round's reveal data. Different
 * modes use different shapes (single `product` vs `products`) so we handle
 * both branches and return a uniform array.
 */
function productsFromReveal(reveal: RevealData | undefined | null): Array<{
  title: string;
  imageUrl: string;
  priceCents: number;
  amazonUrl?: string;
}> {
  if (!reveal) return [];
  if ("products" in reveal && Array.isArray(reveal.products)) {
    return reveal.products.map(pickSnapshotProduct);
  }
  if ("product" in reveal && reveal.product) {
    return [pickSnapshotProduct(reveal.product)];
  }
  return [];
}

/**
 * Build a SharedRoundSnapshot[] from single-player round results. Each entry
 * has the required `roundNumber`, `score`, and `products` plus whatever
 * mode-specific fields are present on the source object.
 *
 * @param roundResults - The per-round results array from SP game state
 * @returns Array of snapshots ready for POST /api/share
 */
export function buildSPRoundSnapshots(
  roundResults: SPRoundWithScore[]
): SharedRoundSnapshot[] {
  return roundResults.map((r, idx): SharedRoundSnapshot => {
    const products: SharedRoundSnapshot["products"] = r.products
      ? r.products.map(pickSnapshotProduct)
      : r.product
      ? [pickSnapshotProduct(r.product)]
      : [];
    const snap: SharedRoundSnapshot = {
      roundNumber: idx + 1,
      score: r.score ?? 0,
      products,
    };
    // Copy through optional mode-specific fields only when present.
    if (r.guessedPriceCents !== undefined) snap.guessedPriceCents = r.guessedPriceCents;
    if (r.guessedProductId !== undefined) snap.guessedProductId = r.guessedProductId;
    if (r.guess !== undefined) snap.guess = r.guess;
    if (r.correct !== undefined) snap.correct = r.correct;
    if (r.correctCount !== undefined) snap.correctCount = r.correctCount;
    if (r.wentOver !== undefined) snap.wentOver = r.wentOver;
    if (r.referencePrice !== undefined) snap.referencePrice = r.referencePrice;
    if (r.actualTotalCents !== undefined) snap.actualTotalCents = r.actualTotalCents;
    if (r.guessedTotalCents !== undefined) snap.guessedTotalCents = r.guessedTotalCents;
    if (r.budgetCents !== undefined) snap.budgetCents = r.budgetCents;
    if (r.cartTotalCents !== undefined) snap.cartTotalCents = r.cartTotalCents;
    if (r.outlierProductId !== undefined) snap.outlierProductId = r.outlierProductId;
    return snap;
  });
}

/**
 * Build a SharedRoundSnapshot[] from multiplayer round-results payloads.
 * Each snapshot is constructed from:
 * - the reveal data (products, actualTotalCents, budget, etc.) stored on
 *   the round, and
 * - the current player's per-round `score` looked up by playerId.
 *
 * Defends against missing `currentPlayerId` (returns empty) and late-joining
 * players (per-round score defaults to 0).
 *
 * @param allRoundResults - Array of per-round payloads for this game
 * @param currentPlayerId - The viewing player's id
 * @returns Array of snapshots ready for POST /api/share
 */
export function buildMPRoundSnapshots(
  allRoundResults: RoundResultsPayload[],
  currentPlayerId: string | null | undefined
): SharedRoundSnapshot[] {
  if (!currentPlayerId) return [];
  return allRoundResults.map((rr): SharedRoundSnapshot => {
    const me = rr.playerResults.find((p) => p.playerId === currentPlayerId);
    const score = me?.score ?? 0;
    const products = productsFromReveal(rr.revealData);

    const snap: SharedRoundSnapshot = {
      roundNumber: rr.roundNumber,
      score,
      products,
    };

    // Surface mode-specific reveal fields where they exist. The reveal union
    // carries different fields per mode; we probe for each safely.
    const reveal = rr.revealData as RevealData | undefined;
    if (reveal && "referencePrice" in reveal) {
      snap.referencePrice = reveal.referencePrice;
    }
    if (reveal && "actualTotalCents" in reveal) {
      snap.actualTotalCents = reveal.actualTotalCents;
    }
    if (reveal && "budgetCents" in reveal) {
      snap.budgetCents = reveal.budgetCents;
    }
    if (reveal && "outlierProductId" in reveal) {
      snap.outlierProductId = reveal.outlierProductId;
    }
    return snap;
  });
}

/**
 * Unified wrapper: returns snapshots for whichever variant was supplied.
 * Makes callers site-agnostic.
 *
 * @param input - SP or MP input (same shape as useShareData)
 * @returns Array of snapshots ready for POST /api/share
 */
export function buildSharedRoundSnapshots(
  input: UseShareDataInput
): SharedRoundSnapshot[] {
  if (input.variant === "sp") {
    return buildSPRoundSnapshots(input.roundResults ?? []);
  }
  return buildMPRoundSnapshots(
    input.allRoundResults ?? [],
    input.currentPlayerId
  );
}

/**
 * React hook wrapper around `buildShareData` that memoizes the output so
 * components can pass a stable reference to ShareModal without triggering
 * extra renders.
 *
 * **Why deps are destructured**: callers typically pass an inline object
 * literal (`useShareData({ variant: "sp", gameMode, ... })`). If we used
 * `[input]` as the dep, every parent render would allocate a fresh object
 * and bust the memo. Listing each field individually lets the memo survive
 * unrelated parent re-renders (e.g. typing into the leaderboard name input
 * while the share modal is open), which avoids re-running the canvas encode.
 *
 * @param input - SP or MP input
 * @returns Memoized ShareGridInput
 */
export function useShareData(input: UseShareDataInput): ShareGridInput {
  const variant = input.variant;
  const gameMode = input.gameMode;
  const totalScore = input.totalScore;
  const spRoundResults = input.variant === "sp" ? input.roundResults : undefined;
  const mpAllRoundResults = input.variant === "mp" ? input.allRoundResults : undefined;
  const mpCurrentPlayerId = input.variant === "mp" ? input.currentPlayerId : undefined;
  const mpPlayerRank = input.variant === "mp" ? input.playerRank : undefined;
  const mpPlayerCount = input.variant === "mp" ? input.playerCount : undefined;

  return useMemo(
    () => buildShareData(input),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [variant, gameMode, totalScore, spRoundResults, mpAllRoundResults, mpCurrentPlayerId, mpPlayerRank, mpPlayerCount]
  );
}
