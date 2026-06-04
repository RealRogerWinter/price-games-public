/**
 * History recap — reconstruct a `SharedRoundSnapshot[]` for any completed
 * single-player or multiplayer game, and persist it as a `shared_games` row
 * so the existing `/s/:id` / `/recap/:historyId` renderer can display it.
 *
 * Two entry points:
 *   - {@link buildSPRecap} reads `game_sessions.round_data` + `game_rounds`
 *     + `products` for single-player games.
 *   - {@link buildMPRecap} reads `mp_rooms.round_data` + `mp_guesses`
 *     + `mp_players` + `products` for one player's view of an MP game.
 *
 * Both functions are pure and defensive: missing source rows (session
 * deleted, player never guessed, etc.) degrade to `roundData: []` rather
 * than throwing. The caller decides whether to persist `[]` or retry later.
 *
 * The third export {@link createShareRow} centralises the nanoid-based
 * insert logic so `POST /api/share` and the auto-share code paths share
 * one implementation.
 */

import { nanoid } from "nanoid";
import type { Database as DatabaseType } from "better-sqlite3";
import type { GameMode, SharedRoundSnapshot } from "@price-game/shared";
import { amazonProductUrl } from "@price-game/shared";
import { getRoundProductIds } from "./gameGuess";

// ── Shared insert helper ────────────────────────────────────────────────

/** Max collision retries when inserting a new share. nanoid(8) collisions are astronomically rare. */
const INSERT_MAX_RETRIES = 3;
/** Share id format: base64url, 8 chars (same alphabet nanoid uses by default). */
const SHARE_ID_LENGTH = 8;

/**
 * Insert a new row into `shared_games` with a freshly-minted nanoid id,
 * retrying up to {@link INSERT_MAX_RETRIES} times on primary-key collision.
 *
 * @param db - database handle (must be open; may be inside a transaction).
 * @param gameMode - the game mode that produced this record.
 * @param totalScore - the player's total score.
 * @param perRoundMax - max possible score per round (passed through for
 *   consistent tier bucketing on the renderer).
 * @param playerName - optional display name (already sanitized by the caller).
 * @param roundData - the per-round snapshots to persist.
 * @returns the newly-created share id.
 * @throws if all retry attempts collide, or any other sqlite error.
 */
export function createShareRow(
  db: DatabaseType,
  gameMode: GameMode,
  totalScore: number,
  perRoundMax: number,
  playerName: string | null,
  roundData: SharedRoundSnapshot[],
): string {
  const insert = db.prepare(
    `INSERT INTO shared_games
     (id, game_mode, total_score, per_round_max, player_name, round_data, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const createdAt = Math.floor(Date.now() / 1000);
  const serialized = JSON.stringify(roundData);

  for (let attempt = 0; attempt < INSERT_MAX_RETRIES; attempt++) {
    const candidate = nanoid(SHARE_ID_LENGTH);
    try {
      insert.run(candidate, gameMode, totalScore, perRoundMax, playerName, serialized, createdAt);
      return candidate;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("UNIQUE") && attempt < INSERT_MAX_RETRIES - 1) continue;
      throw err;
    }
  }
  throw new Error("Failed to generate unique share id");
}

// ── Shared helpers ──────────────────────────────────────────────────────

/** Minimum product-row shape we need to build a snapshot. */
interface ProductRow {
  id: number;
  asin: string | null;
  title: string;
  price_cents: number;
}

/**
 * Fetch products by id using the provided db handle. Unlike
 * `productMapper.getProductsByIds`, this accepts a db parameter rather than
 * using the module-level singleton, so it's usable in tests with an
 * in-memory DB.
 */
function fetchProducts(db: DatabaseType, ids: number[]): Map<number, ProductRow> {
  if (ids.length === 0) return new Map();
  const placeholders = ids.map(() => "?").join(",");
  const rows = db
    .prepare(`SELECT id, asin, title, price_cents FROM products WHERE id IN (${placeholders})`)
    .all(...ids) as ProductRow[];
  return new Map(rows.map((r) => [r.id, r]));
}

/** Convert a DB product row to the `{title, imageUrl, priceCents, amazonUrl?}` shape a snapshot needs. */
function toSnapshotProduct(row: ProductRow): SharedRoundSnapshot["products"][number] {
  const p: SharedRoundSnapshot["products"][number] = {
    title: row.title,
    imageUrl: `/api/image/${row.id}`,
    priceCents: row.price_cents,
  };
  if (row.asin) p.amazonUrl = amazonProductUrl(row.asin);
  return p;
}

/** Safe JSON parse; returns null on any failure. */
function safeJsonParse<T>(s: string | null | undefined): T | null {
  if (!s) return null;
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

/**
 * Fold mode-specific fields from `game_rounds.guess_data` + the static
 * `round_data[roundNum]` metadata into a `SharedRoundSnapshot`. Tolerant of
 * missing fields — the renderer handles absent optionals gracefully.
 */
function applyModeSpecificFields(
  snap: SharedRoundSnapshot,
  mode: GameMode,
  guessData: Record<string, unknown> | null,
  roundMeta: Record<string, unknown> | null,
  products: SharedRoundSnapshot["products"],
  guessedPriceCents: number | null | undefined,
): void {
  const meta = roundMeta ?? {};
  const g = guessData ?? {};

  if (mode === "classic" || mode === "closest-without-going-over") {
    if (guessedPriceCents != null) snap.guessedPriceCents = guessedPriceCents;
    if (typeof g.wentOver === "boolean") snap.wentOver = g.wentOver;
  } else if (mode === "higher-lower") {
    if (g.guess === "higher" || g.guess === "lower") snap.guess = g.guess;
    if (typeof g.referencePrice === "number") snap.referencePrice = g.referencePrice;
    else if (typeof meta.referencePrice === "number") snap.referencePrice = meta.referencePrice;
    // Correct if they earned any score; scoring is binary for this mode.
    if (typeof snap.score === "number") snap.correct = snap.score > 0;
  } else if (mode === "comparison") {
    if (typeof g.guessedProductId === "number") snap.guessedProductId = g.guessedProductId;
    if (typeof snap.score === "number") snap.correct = snap.score > 0;
  } else if (mode === "odd-one-out") {
    if (typeof g.guessedProductId === "number") snap.guessedProductId = g.guessedProductId;
    if (typeof meta.outlierProductId === "number") snap.outlierProductId = meta.outlierProductId;
    if (typeof snap.score === "number") snap.correct = snap.score > 0;
  } else if (mode === "riser") {
    if (typeof g.stoppedPriceCents === "number") snap.guessedPriceCents = g.stoppedPriceCents;
    else if (guessedPriceCents != null) snap.guessedPriceCents = guessedPriceCents;
    if (typeof g.wentOver === "boolean") snap.wentOver = g.wentOver;
  } else if (mode === "price-match" || mode === "sort-it-out" || mode === "chain-reaction") {
    if (typeof g.correctCount === "number") snap.correctCount = g.correctCount;
  } else if (mode === "market-basket") {
    if (typeof g.guessedTotalCents === "number") snap.guessedTotalCents = g.guessedTotalCents;
    // Compute actual by summing product priceCents — canonical and cheap.
    const actual = products.reduce((s, p) => s + (p.priceCents || 0), 0);
    if (actual > 0) snap.actualTotalCents = actual;
  } else if (mode === "budget-builder") {
    if (typeof meta.budgetCents === "number") snap.budgetCents = meta.budgetCents;
    if (typeof g.cartTotalCents === "number") snap.cartTotalCents = g.cartTotalCents;
  } else if (mode === "bidding") {
    if (typeof g.bidCents === "number") snap.guessedPriceCents = g.bidCents;
    if (typeof g.wentOver === "boolean") snap.wentOver = g.wentOver;
  }
}

// ── Single-player recap ─────────────────────────────────────────────────

/**
 * Build a {@link SharedRoundSnapshot} array reconstructing every round of
 * the given single-player session from `game_sessions.round_data`,
 * `game_rounds`, and `products`.
 *
 * Returns an empty array if the session row is missing, the session is
 * incomplete (never finished), or any other unrecoverable read failure.
 *
 * @param db - db handle.
 * @param sessionId - the `game_sessions.id` to reconstruct.
 * @returns one `SharedRoundSnapshot` per recorded round, ordered ascending.
 */
export function buildSPRecap(db: DatabaseType, sessionId: string): SharedRoundSnapshot[] {
  interface SessionRow {
    game_mode: string | null;
    selected_products: string | null;
    round_data: string | null;
  }
  const session = db
    .prepare("SELECT game_mode, selected_products, round_data FROM game_sessions WHERE id = ?")
    .get(sessionId) as SessionRow | undefined;
  if (!session) return [];

  const mode = ((session.game_mode ?? "classic") as GameMode);
  const selectedIds = safeJsonParse<number[]>(session.selected_products) ?? [];
  const roundData = safeJsonParse<Record<string, Record<string, unknown>>>(session.round_data) ?? {};

  interface RoundRow {
    round_number: number;
    guessed_price_cents: number | null;
    score: number | null;
    guess_data: string | null;
  }
  const rounds = db
    .prepare(
      `SELECT round_number, guessed_price_cents, score, guess_data
       FROM game_rounds WHERE session_id = ? ORDER BY round_number ASC`,
    )
    .all(sessionId) as RoundRow[];

  if (rounds.length === 0) return [];

  // Gather every product id we need up-front for a single batched fetch.
  const allProductIds = new Set<number>();
  const perRoundIds: number[][] = rounds.map((r) => {
    const ids = getRoundProductIds(mode, selectedIds, r.round_number, roundData);
    for (const id of ids) if (typeof id === "number" && !Number.isNaN(id)) allProductIds.add(id);
    return ids.filter((id) => typeof id === "number" && !Number.isNaN(id));
  });
  const products = fetchProducts(db, Array.from(allProductIds));

  return rounds.map((r, idx): SharedRoundSnapshot => {
    const ids = perRoundIds[idx];
    const productObjs: SharedRoundSnapshot["products"] = ids
      .map((id) => products.get(id))
      .filter((p): p is ProductRow => !!p)
      .map(toSnapshotProduct);

    const snap: SharedRoundSnapshot = {
      roundNumber: r.round_number,
      score: r.score ?? 0,
      products: productObjs,
    };

    const guessData = safeJsonParse<Record<string, unknown>>(r.guess_data);
    const roundMeta = roundData[String(r.round_number)] ?? null;
    applyModeSpecificFields(snap, mode, guessData, roundMeta, productObjs, r.guessed_price_cents);
    return snap;
  });
}

// ── Multiplayer recap ───────────────────────────────────────────────────

/**
 * Build a {@link SharedRoundSnapshot} array reconstructing one player's view
 * of an MP game. Uses `mp_rooms.round_data` for per-round product IDs +
 * mode metadata, `mp_guesses` for that player's score and guess data, and
 * the `products` table for the decorative product info.
 *
 * Users may rejoin a room, which creates a new `mp_players` row with a
 * fresh `id`. This function aggregates guesses across **every** `mp_players`
 * row for the given `user_id` so early-round guesses made under a previous
 * incarnation aren't silently dropped. When multiple incarnations both
 * submitted for the same round (pathological), the highest-scoring guess
 * wins — matches the user's lived experience of "my best attempt for round N".
 *
 * @param db - db handle.
 * @param roomCode - the `mp_rooms.code` of the finished game.
 * @param userId - the account id whose perspective to reconstruct.
 * @returns one snapshot per round; `[]` if the room or player can't be resolved.
 */
export function buildMPRecap(
  db: DatabaseType,
  roomCode: string,
  userId: string,
): SharedRoundSnapshot[] {
  interface RoomRow {
    game_mode: string | null;
    round_data: string | null;
    total_rounds: number | null;
  }
  const room = db
    .prepare("SELECT game_mode, round_data, total_rounds FROM mp_rooms WHERE code = ?")
    .get(roomCode) as RoomRow | undefined;
  if (!room) return [];

  const mode = ((room.game_mode ?? "classic") as GameMode);
  const roundData = safeJsonParse<
    Record<string, { productIds?: number[]; [k: string]: unknown }>
  >(room.round_data) ?? {};

  // Collect every player_id this user ever held in this room (rejoin safe).
  const playerIds = (
    db
      .prepare("SELECT id FROM mp_players WHERE room_code = ? AND user_id = ?")
      .all(roomCode, userId) as { id: string }[]
  ).map((r) => r.id);
  if (playerIds.length === 0) return [];

  interface GuessRow {
    round_number: number;
    guess_data: string | null;
    score: number | null;
  }
  // Pull guesses for *every* incarnation, not just the most recent one.
  // See the rejoin note in the docstring.
  const placeholders = playerIds.map(() => "?").join(",");
  const guesses = db
    .prepare(
      `SELECT round_number, guess_data, score FROM mp_guesses
       WHERE room_code = ? AND player_id IN (${placeholders})
       ORDER BY round_number ASC`,
    )
    .all(roomCode, ...playerIds) as GuessRow[];

  // A player may have missed rounds (disconnected, late-join). Determine
  // the round count from whichever source is largest — round_data keys,
  // the configured total, or the guesses we actually have.
  const roundKeys = Object.keys(roundData).map(Number).filter((n) => Number.isFinite(n));
  const maxRound = Math.max(
    room.total_rounds ?? 0,
    roundKeys.length > 0 ? Math.max(...roundKeys) : 0,
    guesses.length > 0 ? Math.max(...guesses.map((g) => g.round_number)) : 0,
  );
  if (maxRound === 0) return [];

  // Pick the best-scoring guess per round when incarnations collide.
  const guessByRound = new Map<number, GuessRow>();
  for (const g of guesses) {
    const prior = guessByRound.get(g.round_number);
    if (!prior || (g.score ?? 0) > (prior.score ?? 0)) {
      guessByRound.set(g.round_number, g);
    }
  }

  // Batch-fetch all products referenced in round_data.
  const allProductIds = new Set<number>();
  for (const key of Object.keys(roundData)) {
    const ids = roundData[key]?.productIds;
    if (Array.isArray(ids)) for (const id of ids) if (typeof id === "number") allProductIds.add(id);
  }
  const products = fetchProducts(db, Array.from(allProductIds));

  const out: SharedRoundSnapshot[] = [];
  for (let roundNum = 1; roundNum <= maxRound; roundNum++) {
    const meta = roundData[String(roundNum)] ?? null;
    const ids = meta?.productIds ?? [];
    const productObjs: SharedRoundSnapshot["products"] = ids
      .map((id) => products.get(id))
      .filter((p): p is ProductRow => !!p)
      .map(toSnapshotProduct);

    const g = guessByRound.get(roundNum);
    const snap: SharedRoundSnapshot = {
      roundNumber: roundNum,
      score: g?.score ?? 0,
      products: productObjs,
    };

    const guessData = g ? safeJsonParse<Record<string, unknown>>(g.guess_data) : null;
    applyModeSpecificFields(snap, mode, guessData, meta, productObjs, null);
    out.push(snap);
  }
  return out;
}
