/**
 * Admin operations for the daily challenge mode.
 *
 * All callers must have passed `requireAdmin` middleware. The functions in
 * this module are pure-DB; they do NOT perform auth themselves.
 *
 * Surface:
 *   - getAdminDailyOverview: enable flag, schedule, and rolling window of
 *     today + N days (lazy-previewed for uncached dates).
 *   - updateAdminDailyEnabled: toggle the feature flag.
 *   - updateAdminDailySchedule: replace the 7-slot weekly schedule with
 *     validation against DAILY_ADMIN_ALLOWED_MODES.
 *   - setAdminDailyProducts: hand-curate the products for a specific date.
 *     Sets is_manual_override=1 so future regenerate calls skip the row.
 *   - regenerateAdminDailyPuzzle: regenerate from seed, optionally clearing
 *     a manual-override flag with `force=true`.
 *   - getAdminDailyStats: aggregate counters + last-30-days breakdown +
 *     top streaks.
 *   - clearAdminDailyPlay: support tool to delete a single user's play
 *     for a date. Does NOT mutate streak columns.
 */

import type { Database as DatabaseType } from "better-sqlite3";
import {
  DAILY_ADMIN_ALLOWED_MODES,
  DAILY_TOTAL_ROUNDS,
  addDays,
  getDailyModeForDate,
  getDailyProductsPerRound,
  getUtcDateString,
  isValidDailyDate,
  type AdminDailyOverviewResponse,
  type AdminDailyPuzzleRow,
  type AdminDailyStatsResponse,
  type GameMode,
} from "@price-game/shared";
import {
  isDailyEnabled,
  setDailyEnabled,
  getDailySchedule,
  setDailySchedule,
  getDisabledGameModes,
} from "./siteSettings";
import {
  DailyUnavailableError,
  getOrCreateDailyPuzzle,
  hashSeed,
  mulberry32,
  type DbDailyPuzzle,
} from "./dailyPuzzle";
import { composeDailyRounds } from "./dailyRoundComposer";
import { config } from "../config";

/** Errors thrown by the admin daily service that the route layer can map to 4xx. */
export class AdminDailyError extends Error {
  constructor(public readonly userMessage: string) {
    super(userMessage);
    this.name = "AdminDailyError";
  }
}

/** How many products a given mode needs per session for a 5-round daily. */
function requiredProductCount(mode: GameMode): number {
  return getDailyProductsPerRound(mode) * DAILY_TOTAL_ROUNDS;
}

function assertValidDailyDate(date: string): void {
  if (!isValidDailyDate(date)) {
    throw new AdminDailyError(`Invalid date: ${date}`);
  }
}

function assertAllowedMode(mode: GameMode): void {
  if (!DAILY_ADMIN_ALLOWED_MODES.includes(mode)) {
    throw new AdminDailyError(
      `Game mode "${mode}" is not allowed for the daily challenge`
    );
  }
}

/**
 * Build an AdminDailyPuzzleRow from a (possibly cached, possibly previewed)
 * puzzle plus play counts. Product titles, image URLs, and prices are
 * denormalized into the response so the admin UI doesn't need a follow-up
 * products fetch.
 */
function rowFromPuzzle(
  db: DatabaseType,
  date: string,
  gameMode: GameMode,
  productIds: number[],
  isManualOverride: boolean,
  cachedAt: string | null,
): AdminDailyPuzzleRow {
  const titles: string[] = [];
  const imageUrls: string[] = [];
  const priceCents: number[] = [];
  if (productIds.length > 0) {
    const placeholders = productIds.map(() => "?").join(",");
    const rows = db
      .prepare(
        `SELECT id, title, image_url, price_cents FROM products WHERE id IN (${placeholders})`
      )
      .all(...productIds) as {
        id: number;
        title: string;
        image_url: string | null;
        price_cents: number;
      }[];
    const lookup = new Map(rows.map((r) => [r.id, r]));
    for (const id of productIds) {
      const p = lookup.get(id);
      titles.push(p?.title ?? `(unknown product #${id})`);
      imageUrls.push(p?.image_url ?? "");
      priceCents.push(p?.price_cents ?? 0);
    }
  }

  const stats = db
    .prepare(
      `SELECT COUNT(*) as plays, AVG(score) as avg_score
         FROM daily_plays WHERE daily_date = ? AND completed_at IS NOT NULL`
    )
    .get(date) as { plays: number; avg_score: number | null };

  return {
    date,
    gameMode,
    productIds,
    productTitles: titles,
    productImageUrls: imageUrls,
    productPriceCents: priceCents,
    isManualOverride,
    playCount: stats.plays,
    averageScore: stats.avg_score,
    cachedAt,
  };
}

/**
 * Admin overview: enabled flag, schedule, and rolling N-day window. Cached
 * rows are returned as-is; uncached future rows are previewed (composed in
 * memory but NOT persisted). Past uncached rows are returned with the
 * schedule-derived mode and empty product arrays.
 *
 * @param startDate - Optional start date (YYYY-MM-DD). Defaults to today.
 */
export function getAdminDailyOverview(
  db: DatabaseType,
  daysAhead = 14,
  startDate?: string,
): AdminDailyOverviewResponse {
  if (startDate) assertValidDailyDate(startDate);
  const enabled = isDailyEnabled(db);
  const schedule = [...getDailySchedule(db)];
  const currentDate = getUtcDateString(new Date());
  const baseDate = startDate ?? currentDate;
  const rows: AdminDailyPuzzleRow[] = [];

  for (let offset = 0; offset < daysAhead; offset++) {
    const date = addDays(baseDate, offset);
    const cached = db
      .prepare("SELECT * FROM daily_puzzles WHERE daily_date = ?")
      .get(date) as DbDailyPuzzle | undefined;

    if (cached) {
      rows.push(
        rowFromPuzzle(
          db,
          date,
          cached.game_mode as GameMode,
          JSON.parse(cached.product_ids) as number[],
          cached.is_manual_override === 1,
          cached.created_at,
        )
      );
      continue;
    }

    // Past dates without a cached row: return the schedule-derived mode
    // with empty product data (nobody triggered puzzle creation).
    if (date < currentDate) {
      const disabled = new Set(getDisabledGameModes(db) as GameMode[]);
      const mode = getDailyModeForDate(date, schedule, disabled) ?? "classic";
      rows.push(
        rowFromPuzzle(db, date, mode, [], false, null)
      );
      continue;
    }

    // Future/today: preview (resolve mode + compose without persisting).
    // Catches both DailyUnavailableError (no mode) and plain Error (too few
    // products in pool) — either way, the row shows as a gap.
    let previewMode: GameMode | null = null;
    let previewIds: number[] = [];
    try {
      const preview = previewDailyComposition(db, date);
      previewMode = preview.mode;
      previewIds = preview.productIds;
    } catch {
      // Preview failed (no available mode or insufficient products).
    }

    // Even if preview failed (no available mode), include the row so the
    // admin sees the gap. We use "classic" as a stub mode in that case.
    rows.push(
      rowFromPuzzle(
        db,
        date,
        previewMode ?? "classic",
        previewIds,
        false,
        null,
      )
    );
  }

  return { enabled, schedule, currentDate, rows };
}

/**
 * Compute the puzzle for a date WITHOUT persisting. Used by the admin
 * overview's preview path.
 */
function previewDailyComposition(
  db: DatabaseType,
  date: string,
): { mode: GameMode; productIds: number[] } {
  // Resolve the mode using the same logic the cache path uses.
  const schedule = getDailySchedule(db);
  const disabled = new Set(getDisabledGameModes(db) as GameMode[]);
  const mode = getDailyModeForDate(date, schedule, disabled);
  if (!mode) throw new DailyUnavailableError(date);

  const seed = hashSeed(config.dailySeedSalt, date, 1);
  const composed = composeDailyRounds(db, mode, mulberry32(seed));
  return { mode, productIds: composed.productIds };
}

/** Toggle the daily_enabled site setting. */
export function updateAdminDailyEnabled(db: DatabaseType, enabled: boolean): boolean {
  setDailyEnabled(db, enabled);
  return isDailyEnabled(db);
}

/**
 * Replace the weekly schedule. Each entry must be a member of
 * DAILY_ADMIN_ALLOWED_MODES (now the full GameMode catalog).
 */
export function updateAdminDailySchedule(
  db: DatabaseType,
  schedule: GameMode[],
): readonly GameMode[] {
  if (!Array.isArray(schedule) || schedule.length !== 7) {
    throw new AdminDailyError("Schedule must be a 7-element array");
  }
  for (const m of schedule) {
    if (!DAILY_ADMIN_ALLOWED_MODES.includes(m)) {
      throw new AdminDailyError(
        `Game mode "${String(m)}" is not allowed for the daily challenge`
      );
    }
  }
  // setDailySchedule has its own validation (against VALID_GAME_MODES)
  // but it's stricter to check DAILY_ADMIN_ALLOWED_MODES first so we
  // produce a clearer error message.
  setDailySchedule(db, schedule);
  return schedule;
}

/**
 * Hand-curate the products for a specific date. Sets is_manual_override=1.
 * Validates: date format, mode allowed, mode-specific product count, all
 * product IDs exist and are active.
 */
export function setAdminDailyProducts(
  db: DatabaseType,
  date: string,
  gameMode: GameMode,
  productIds: number[],
): AdminDailyPuzzleRow {
  assertValidDailyDate(date);
  assertAllowedMode(gameMode);

  const required = requiredProductCount(gameMode);
  if (!Array.isArray(productIds) || productIds.length !== required) {
    throw new AdminDailyError(
      `Mode "${gameMode}" requires exactly ${required} products (got ${productIds?.length ?? 0})`
    );
  }
  if (!productIds.every((id) => Number.isInteger(id) && id > 0)) {
    throw new AdminDailyError("All product IDs must be positive integers");
  }

  // Validate all products exist and are active.
  const placeholders = productIds.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT id, is_active FROM products WHERE id IN (${placeholders})`
    )
    .all(...productIds) as { id: number; is_active: number }[];

  if (rows.length !== productIds.length) {
    throw new AdminDailyError("One or more product IDs do not exist");
  }
  for (const row of rows) {
    if (row.is_active !== 1) {
      throw new AdminDailyError(`Product ${row.id} is not active`);
    }
  }

  // Compose round_data using the seeded RNG so per-round metadata
  // (referencePrice for higher-lower, question for comparison) is
  // populated. The product order matches the supplied IDs verbatim
  // because we override the snapshot to be the chosen products in
  // the chosen order.
  const roundData = buildOverrideRoundData(db, gameMode, productIds, date);

  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO daily_puzzles
       (daily_date, game_mode, product_ids, round_data, salt_version, is_manual_override, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1, 1, ?, ?)
     ON CONFLICT(daily_date) DO UPDATE SET
       game_mode          = excluded.game_mode,
       product_ids        = excluded.product_ids,
       round_data         = excluded.round_data,
       is_manual_override = 1,
       updated_at         = excluded.updated_at`
  ).run(
    date,
    gameMode,
    JSON.stringify(productIds),
    JSON.stringify(roundData),
    now,
    now,
  );

  return rowFromPuzzle(db, date, gameMode, productIds, true, now);
}

/**
 * Build the round_data blob for a manually overridden puzzle. Uses a
 * deterministic seed (date-based) so re-applying the same override
 * yields the same metadata. Looks up actual product prices for
 * higher-lower referencePrice.
 */
function buildOverrideRoundData(
  db: DatabaseType,
  mode: GameMode,
  productIds: number[],
  date: string,
): Record<string, unknown> {
  const seed = hashSeed("manual-override", date, 1);
  const rng = mulberry32(seed);

  // Build a price lookup for modes whose metadata depends on product price.
  const priceMap = new Map<number, number>();
  const needsPrices =
    mode === "higher-lower" || mode === "riser" || mode === "budget-builder";
  if (needsPrices && productIds.length > 0) {
    const placeholders = productIds.map(() => "?").join(",");
    const priceRows = db
      .prepare(`SELECT id, price_cents FROM products WHERE id IN (${placeholders})`)
      .all(...productIds) as { id: number; price_cents: number }[];
    for (const row of priceRows) {
      priceMap.set(row.id, row.price_cents);
    }
  }

  const rd: Record<string, unknown> = {};
  const perRound = productIds.length / DAILY_TOTAL_ROUNDS;
  for (let r = 1; r <= DAILY_TOTAL_ROUNDS; r++) {
    const slice = productIds.slice((r - 1) * perRound, r * perRound);
    const meta: Record<string, unknown> = { productIds: slice };

    if (mode === "higher-lower" && slice.length > 0) {
      meta.referencePrice = priceMap.get(slice[0]) ?? 0;
    }
    if (mode === "comparison") {
      meta.question = rng() < 0.5 ? "most-expensive" : "least-expensive";
    }
    if (mode === "riser" && slice.length > 0) {
      const patterns = ["linear", "accelerating", "decelerating", "wave"];
      const speedPattern = patterns[Math.floor(rng() * patterns.length)];
      const durationMs = 10000 + Math.floor(rng() * 4000);
      const targetPosition = 0.25 + rng() * 0.60;
      const actualPrice = priceMap.get(slice[0]) ?? 0;
      meta.speedPattern = speedPattern;
      meta.durationMs = durationMs;
      meta.maxPriceCents = actualPrice > 0
        ? Math.round(actualPrice / (0.1 + 0.9 * targetPosition))
        : 0;
    }
    if (mode === "market-basket") {
      meta.itemCount = slice.length;
    }
    if (mode === "budget-builder") {
      const totalProductValue = slice.reduce(
        (s, id) => s + (priceMap.get(id) ?? 0),
        0,
      );
      meta.budgetCents = Math.round(totalProductValue * 0.50);
    }

    rd[String(r)] = meta;
  }
  return rd;
}

/**
 * Regenerate a date's puzzle from seed. Refuses to overwrite a manual
 * override unless `force=true` is passed.
 */
export function regenerateAdminDailyPuzzle(
  db: DatabaseType,
  date: string,
  force = false,
): AdminDailyPuzzleRow {
  assertValidDailyDate(date);

  const existing = db
    .prepare("SELECT * FROM daily_puzzles WHERE daily_date = ?")
    .get(date) as DbDailyPuzzle | undefined;

  if (existing?.is_manual_override === 1 && !force) {
    throw new AdminDailyError("manual_override_protected");
  }

  // Delete existing row so getOrCreateDailyPuzzle re-composes from scratch.
  db.prepare("DELETE FROM daily_puzzles WHERE daily_date = ?").run(date);

  let puzzle: DbDailyPuzzle;
  try {
    puzzle = getOrCreateDailyPuzzle(db, date);
  } catch (err) {
    if (err instanceof DailyUnavailableError) {
      throw new AdminDailyError("no_available_mode");
    }
    throw err;
  }

  return rowFromPuzzle(
    db,
    date,
    puzzle.game_mode as GameMode,
    JSON.parse(puzzle.product_ids) as number[],
    false,
    puzzle.created_at,
  );
}

/** Aggregate stats for the admin dashboard. */
export function getAdminDailyStats(db: DatabaseType): AdminDailyStatsResponse {
  const totals = db
    .prepare(
      `SELECT COUNT(*) as total_plays, COUNT(DISTINCT user_id) as unique_players
         FROM daily_plays WHERE completed_at IS NOT NULL`
    )
    .get() as { total_plays: number; unique_players: number };

  const last30Rows = db
    .prepare(
      `SELECT daily_date as date, COUNT(*) as plays, AVG(score) as avg
         FROM daily_plays
         WHERE completed_at IS NOT NULL
           AND daily_date >= date('now', '-30 days')
         GROUP BY daily_date
         ORDER BY daily_date DESC`
    )
    .all() as { date: string; plays: number; avg: number | null }[];

  const topStreakRows = db
    .prepare(
      `SELECT username, daily_streak_current as current, daily_streak_best as best
         FROM users
         WHERE daily_streak_best > 0
         ORDER BY daily_streak_best DESC, daily_streak_current DESC
         LIMIT 10`
    )
    .all() as { username: string; current: number; best: number }[];

  return {
    totalPlays: totals.total_plays,
    uniquePlayers: totals.unique_players,
    last30Days: last30Rows.map((r) => ({
      date: r.date,
      plays: r.plays,
      averageScore: r.avg ?? 0,
    })),
    topStreaks: topStreakRows.map((r) => ({
      username: r.username,
      currentStreak: r.current,
      bestStreak: r.best,
    })),
  };
}

/**
 * Clear a user's play for a specific date. Returns the number of rows
 * deleted (0 or 1). Does NOT mutate streak columns — admins must adjust
 * those separately if needed.
 */
export function clearAdminDailyPlay(
  db: DatabaseType,
  userId: string,
  date: string,
): { deleted: number } {
  assertValidDailyDate(date);
  const result = db
    .prepare("DELETE FROM daily_plays WHERE user_id = ? AND daily_date = ?")
    .run(userId, date);
  return { deleted: result.changes };
}
