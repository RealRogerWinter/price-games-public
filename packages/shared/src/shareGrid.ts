import type { GameMode } from "./types.js";
import { TOTAL_ROUNDS, DAILY_TOTAL_ROUNDS } from "./constants.js";

/**
 * Quality tiers for a single round's score, used to pick an emoji for the
 * Wordle-style share grid. Map: >= 90% => great, >= 50% => good, > 0 => ok,
 * 0 => miss.
 */
export type ShareTier = "great" | "good" | "ok" | "miss";

/** The tile emoji for each tier, in Wordle tradition. */
export const SHARE_TIER_EMOJI: Record<ShareTier, string> = {
  great: "🟩",
  good: "🟨",
  ok: "🟧",
  miss: "⬛",
};

/** Footer URL printed at the bottom of every share message. */
export const SHARE_FOOTER_URL = "price.games";

/**
 * Canonical per-round maximum score. Chain-reaction awards more per round
 * because it sums exponential sub-guess scores plus a perfect bonus (max 1313).
 * All other modes cap at 1000 per round.
 *
 * @param mode - The game mode
 * @returns The maximum achievable score for a single round in that mode
 */
export function getPerRoundMaxScore(mode: GameMode): number {
  // Chain-reaction: 4 sub-guesses at 100,150,225,338 = 813, +500 perfect bonus = 1313
  if (mode === "chain-reaction") return 1313;
  return 1000;
}

/**
 * Classify a round score into a share tier based on its ratio against the
 * per-round max. Thresholds: >=90% great, >=50% good, >0 ok, =0 miss.
 *
 * @param score - The raw round score
 * @param perRoundMax - The maximum achievable score for this mode's round
 * @returns The tier classification
 */
export function scoreToTier(score: number, perRoundMax: number): ShareTier {
  if (perRoundMax <= 0) return "miss";
  if (score <= 0) return "miss";
  const ratio = score / perRoundMax;
  if (ratio >= 0.9) return "great";
  if (ratio >= 0.5) return "good";
  return "ok";
}

/**
 * Return the tile emoji for a given share tier.
 * @param tier - The share tier
 * @returns The emoji character
 */
export function tierToEmoji(tier: ShareTier): string {
  return SHARE_TIER_EMOJI[tier];
}

// =============================================================================
// Shareable URL types — used by the /api/share endpoints and the /s/:id view.
//
// These are stored server-side (table: shared_games) and fetched read-only when
// a viewer opens a shared URL. See docs/SHARING.md for the design and
// apps/server/src/routes/share.ts for the handler.
// =============================================================================

/**
 * A single round's snapshot stored inside a shared game record. Loose schema:
 * only `score` and `products` are required; every other mode-specific field is
 * optional. The SharePage renderer handles missing fields gracefully.
 */
export interface SharedRoundSnapshot {
  /** 1-based round number. */
  roundNumber: number;
  /** Raw round score (0..perRoundMax). */
  score: number;
  /** Product(s) shown in this round. Multi-product modes store all; single-product modes store one. */
  products: Array<{
    title: string;
    imageUrl: string;
    priceCents: number;
    amazonUrl?: string;
  }>;
  /** Mode-specific: classic/closest/riser/market-basket */
  guessedPriceCents?: number;
  /** Mode-specific: comparison/odd-one-out */
  guessedProductId?: number;
  /** Mode-specific: higher-lower */
  guess?: "higher" | "lower";
  /** Mode-specific: higher-lower/comparison/odd-one-out — whether the guess matched */
  correct?: boolean;
  /** Mode-specific: price-match/sort-it-out/chain-reaction */
  correctCount?: number;
  /** Mode-specific: closest-without-going-over/riser — true when guess exceeded actual */
  wentOver?: boolean;
  /** Mode-specific: higher-lower — the reference price the player compared against */
  referencePrice?: number;
  /** Mode-specific: market-basket — the actual total of the basket */
  actualTotalCents?: number;
  /** Mode-specific: market-basket — what the player guessed */
  guessedTotalCents?: number;
  /** Mode-specific: budget-builder — budget target */
  budgetCents?: number;
  /** Mode-specific: budget-builder — what the player's cart totaled */
  cartTotalCents?: number;
  /** Mode-specific: odd-one-out — which product was the outlier */
  outlierProductId?: number;
}

/** The full shape of a shared game record as returned by GET /api/share/:id. */
export interface SharedGameRecord {
  id: string;
  gameMode: GameMode;
  totalScore: number;
  perRoundMax: number;
  playerName: string | null;
  roundData: SharedRoundSnapshot[];
  /** Unix seconds when the record was created. */
  createdAt: number;
}

/** Request body for POST /api/share. */
export interface CreateShareRequest {
  gameMode: GameMode;
  totalScore: number;
  perRoundMax: number;
  playerName?: string | null;
  roundData: SharedRoundSnapshot[];
  /** Single-player session ID — links share to the user's game history entry. */
  sessionId?: string;
  /** Multiplayer room code — links share to the user's game history entry. */
  roomCode?: string;
}

/** Response body from POST /api/share. */
export interface CreateShareResponse {
  /** The newly-minted share id (URL-safe). */
  id: string;
  /** Relative path to the read-only view, e.g. "/s/aBcD1234". Caller prepends origin. */
  url: string;
}

/** Input shape for building a share grid. */
export interface ShareGridInput {
  gameMode: GameMode;
  /** Human-readable mode name (e.g. "Precision"). Pre-resolved by the caller. */
  modeName: string;
  /** Per-round scores in play order. Capped at TOTAL_ROUNDS max; not padded. */
  roundScores: number[];
  /** Player's total score across all rounds. */
  totalScore: number;
  /** Max achievable score for a single round (see getPerRoundMaxScore). */
  perRoundMax: number;
  /**
   * Optional finishing position in a multiplayer game (1-based). When both
   * `playerRank` and `playerCount` are provided and valid (rank>=1, count>=1,
   * rank<=count), the share header gains a ` · #N of M` suffix so viewers see
   * how the player placed against opponents. Omit for solo / SP shares.
   */
  playerRank?: number;
  /**
   * Total players in the multiplayer game. See `playerRank` for combined
   * semantics. Both fields are required to render the suffix.
   */
  playerCount?: number;
}

/**
 * Build the optional finishing-position suffix for a multiplayer share header.
 * Returns ` · #N of M` when both rank and count are valid positive integers
 * with rank<=count; otherwise returns an empty string. Centralized so the
 * text builder, accessible-text builder, and canvas renderer stay in sync.
 *
 * @param rank - 1-based finishing position
 * @param count - Total players in the game
 * @returns The suffix string (empty when inputs are missing/invalid)
 */
export function buildRankSuffix(rank?: number, count?: number): string {
  if (typeof rank !== "number" || typeof count !== "number") return "";
  if (!Number.isFinite(rank) || !Number.isFinite(count)) return "";
  if (rank < 1 || count < 1 || rank > count) return "";
  return ` · #${Math.floor(rank)} of ${Math.floor(count)}`;
}

/**
 * Normalize round scores: cap at TOTAL_ROUNDS (the maximum allowed) without
 * padding. The returned array has `min(roundScores.length, TOTAL_ROUNDS)`
 * entries, matching the actual number of rounds played.
 *
 * Exported so the canvas renderer can reuse it without drifting from the
 * text builder's behavior.
 *
 * @param roundScores - Raw per-round scores
 * @returns A defensive copy, capped at TOTAL_ROUNDS entries (no padding)
 */
export function normalizeRoundScores(roundScores: number[]): number[] {
  return roundScores.slice(0, TOTAL_ROUNDS);
}

/**
 * Convert a ShareGridInput into a 2D grid of tiers: rows of up to 5 tiles.
 * 3-round games produce 1 row of 3, 5-round games produce 1 row of 5,
 * 10-round games produce 2 rows of 5.
 */
function toTierGrid(input: ShareGridInput): ShareTier[][] {
  const normalized = normalizeRoundScores(input.roundScores);
  const tiers = normalized.map((s) => scoreToTier(s, input.perRoundMax));
  const rows: ShareTier[][] = [];
  for (let i = 0; i < tiers.length; i += 5) {
    rows.push(tiers.slice(i, i + 5));
  }
  // Guarantee at least one row for empty input
  if (rows.length === 0) rows.push([]);
  return rows;
}

/**
 * Format a number with thousands separators using the en-US convention.
 * Kept local so callers don't need to pass a locale formatter through the shared layer.
 */
function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

/** Options for buildShareText + drawShareCard. */
export interface BuildShareTextOptions {
  /**
   * If provided, the footer line becomes this URL verbatim (e.g. the
   * `price.games/s/<id>` short link from POST /api/share). When omitted,
   * the footer falls back to `play at price.games`.
   */
  shareUrl?: string;
  /**
   * If true, the footer line is suppressed entirely. Use when the caller
   * already passes the URL via a separate channel (e.g. the Web Share API's
   * `url` field) — including the URL in both `text` and `url` causes some
   * platforms to render two copies of the link in the shared message.
   */
  omitFooter?: boolean;
}

/**
 * Build the footer line used by both the text and canvas renderers. Kept
 * separate so `drawFooter` and `buildShareText` can't drift.
 */
export function buildShareFooter(options?: BuildShareTextOptions): string {
  if (options?.shareUrl) return options.shareUrl;
  return `play at ${SHARE_FOOTER_URL}`;
}

/**
 * Build the Wordle-style text payload for sharing a completed game. Safe to
 * paste into any clipboard target — uses `|` (not em-dash) as separators to
 * survive encoding quirks.
 *
 * Example output (without shareUrl):
 *
 *     Price Games | Precision | 7,420/10,000
 *     🟩🟩🟨🟩⬛
 *     🟨🟩🟩🟨🟩
 *     play at price.games
 *
 * Example output (with shareUrl):
 *
 *     Price Games | Precision | 7,420/10,000
 *     🟩🟩🟨🟩⬛
 *     🟨🟩🟩🟨🟩
 *     price.games/s/aBcD1234
 *
 * @param input - The grid input
 * @param options - Optional footer override (shareUrl)
 * @returns Multi-line shareable text (no trailing newline)
 */
export function buildShareText(
  input: ShareGridInput,
  options?: BuildShareTextOptions
): string {
  const grid = toTierGrid(input);
  const roundCount = normalizeRoundScores(input.roundScores).length;
  const totalMax = input.perRoundMax * roundCount;
  const rankSuffix = buildRankSuffix(input.playerRank, input.playerCount);
  const header = `Price Games | ${input.modeName} | ${fmt(input.totalScore)}/${fmt(totalMax)}${rankSuffix}`;
  const rows = grid.map((row) => row.map(tierToEmoji).join(""));
  if (options?.omitFooter) {
    return [header, ...rows].join("\n");
  }
  const footer = buildShareFooter(options);
  return [header, ...rows, footer].join("\n");
}

/**
 * Build a screen-reader-friendly equivalent of the emoji grid. Emitted into a
 * visually-hidden `<span>` alongside the visual grid so assistive tech users
 * get a meaningful description instead of raw emoji.
 *
 * Example output:
 *
 *     Price Games, Precision. Score 7,420 of 10,000.
 *     Row 1: 3 great, 1 good, 1 miss. Row 2: 2 great, 2 good, 1 miss.
 *
 * @param input - The grid input
 * @returns A prose description
 */
export function buildShareAccessibleText(input: ShareGridInput): string {
  const grid = toTierGrid(input);
  const roundCount = normalizeRoundScores(input.roundScores).length;
  const totalMax = input.perRoundMax * roundCount;
  // Reuse the same finishing-position semantics as the visual header so screen
  // readers describe the placement identically (e.g. "Finished #3 of 6.").
  const rankSuffix = buildRankSuffix(input.playerRank, input.playerCount);
  const placeSentence = rankSuffix
    ? ` Finished #${Math.floor(input.playerRank as number)} of ${Math.floor(input.playerCount as number)}.`
    : "";
  const header = `Price Games, ${input.modeName}. Score ${fmt(input.totalScore)} of ${fmt(totalMax)}.${placeSentence}`;

  const tierLabel: Record<ShareTier, string> = {
    great: "great",
    good: "good",
    ok: "ok",
    miss: "miss",
  };

  function describeRow(row: ShareTier[]): string {
    const counts: Record<ShareTier, number> = { great: 0, good: 0, ok: 0, miss: 0 };
    for (const t of row) counts[t]++;
    // Include only non-zero buckets so the description stays short and natural.
    const parts: string[] = [];
    (Object.keys(counts) as ShareTier[]).forEach((t) => {
      if (counts[t] > 0) parts.push(`${counts[t]} ${tierLabel[t]}`);
    });
    return parts.length > 0 ? parts.join(", ") : "no rounds";
  }

  const rowDescriptions = grid
    .map((row, i) => `Row ${i + 1}: ${describeRow(row)}.`)
    .join(" ");

  return `${header} ${rowDescriptions}`;
}

// =============================================================================
// Daily Challenge share variant — single-row 5-tile grid + Daily #N header.
//
// The daily share format intentionally omits the `/s/:id` short URL because
// daily puzzles are shared globally and a short link to a results page would
// spoil the products for any visitor who hasn't played yet. The footer
// always falls back to the bare `play at price.games` form.
// =============================================================================

/** Input shape for building a daily-challenge share grid. */
export interface DailyShareGridInput {
  gameMode: GameMode;
  /** Human-readable mode name (e.g. "Precision"). */
  modeName: string;
  /** Per-round scores in play order. Padded/truncated to DAILY_TOTAL_ROUNDS. */
  roundScores: number[];
  /** Total score across the daily's 5 rounds. */
  totalScore: number;
  /** Max achievable score per round (typically 1000; 1313 for chain-reaction). */
  perRoundMax: number;
  /** The user-visible "Daily #N" sequence number. */
  dailyNumber: number;
  /** Optional current streak; rendered only when >= 3 to avoid humblebrags. */
  streak?: number;
}

/**
 * Normalize round scores to exactly DAILY_TOTAL_ROUNDS (5) entries. Short
 * arrays are right-padded with zeros (treated as misses); long arrays are
 * truncated. Mirrors the standard `normalizeRoundScores` helper but for
 * daily's 5-round shape.
 *
 * @param roundScores - Raw per-round scores
 * @returns A new array of exactly DAILY_TOTAL_ROUNDS numeric scores
 */
export function normalizeDailyRoundScores(roundScores: number[]): number[] {
  const out = roundScores.slice(0, DAILY_TOTAL_ROUNDS);
  while (out.length < DAILY_TOTAL_ROUNDS) out.push(0);
  return out;
}

/**
 * Build the share-text payload for a completed daily challenge. Format:
 *
 *     Price Games Daily #42 | Precision | 4,500/5,000
 *     🟩🟩🟨🟩⬛
 *     🔥 7-day streak              ← only when streak >= 3
 *     play at price.games
 *
 * No short URL is ever included — daily share text is spoiler-free.
 *
 * @param input - The daily share grid input
 * @returns Multi-line shareable text (no trailing newline)
 */
export function buildDailyShareText(input: DailyShareGridInput): string {
  const normalized = normalizeDailyRoundScores(input.roundScores);
  const tiles = normalized
    .map((s) => tierToEmoji(scoreToTier(s, input.perRoundMax)))
    .join("");
  const totalMax = input.perRoundMax * DAILY_TOTAL_ROUNDS;
  const header = `Price Games Daily #${input.dailyNumber} | ${input.modeName} | ${fmt(input.totalScore)}/${fmt(totalMax)}`;
  const lines: string[] = [header, tiles];
  if (typeof input.streak === "number" && input.streak >= 3) {
    lines.push(`🔥 ${input.streak}-day streak`);
  }
  lines.push(`play at ${SHARE_FOOTER_URL}`);
  return lines.join("\n");
}
