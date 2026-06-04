/**
 * Backfill historical analytics events from the gameplay tables.
 *
 * v2 admin analytics reads from the `events` stream (rolled up into
 * `analytics_hourly`). Multiplayer + daily completions only started emitting
 * events when PR 205 landed; everything before that is invisible to v2,
 * producing a hard cliff in dashboards on the migration date.
 *
 * This script reconstructs the headline-count data — game completions, MP
 * room creations, daily completions — from the pre-existing gameplay
 * tables. Each synthesized event row carries `is_synthetic = 1` so:
 *
 *   - Headline count metrics (games per day, mode breakdown) include them
 *     and the historical chart looks continuous.
 *   - Cohort / funnel / retention / device / geo queries exclude them
 *     (they have no session, device, or attribution context — including
 *     them would silently corrupt those metrics with `unknown` buckets).
 *
 * Idempotent. Each synthetic event uses a deterministic
 * `client_event_id = synthetic:<event_name>:<source_table_id>` so the
 * existing UNIQUE(visitor_id, client_event_id) dedupe index absorbs
 * re-runs as no-ops. Safe to run repeatedly during development and after
 * partial failures.
 *
 * Usage:
 *   npx tsx apps/server/scripts/backfill-analytics-events.ts --dry-run
 *   npx tsx apps/server/scripts/backfill-analytics-events.ts
 *   npx tsx apps/server/scripts/backfill-analytics-events.ts --skip-mp
 *   npx tsx apps/server/scripts/backfill-analytics-events.ts --skip-daily
 */

import db from "../src/db";
import { ANALYTICS_EVENTS } from "@price-game/shared";
import { rebuildHourlyRange } from "../src/services/analyticsHourly";

interface BackfillStats {
  mpGamesCompleted: number;
  mpRoomsCreated: number;
  dailyCompleted: number;
  skippedNoVisitor: number;
  skippedAlreadyExists: number;
  earliestTs: number | null;
  latestTs: number | null;
}

interface BackfillOptions {
  dryRun: boolean;
  skipMp: boolean;
  skipDaily: boolean;
}

function parseTs(value: string | null | undefined): number | null {
  if (!value) return null;
  const ts = Date.parse(value);
  return Number.isFinite(ts) ? ts : null;
}

/**
 * Insert one synthetic event row. Honors the existing dedupe index on
 * (visitor_id, client_event_id) — rerunning the script after a partial
 * failure simply absorbs already-written rows.
 */
function insertSyntheticEvent(opts: {
  eventName: string;
  eventType: "mp" | "game";
  visitorId: string;
  userId: string | null;
  tsServer: number;
  gameMode: string | null;
  mpRoomCode: string | null;
  properties: Record<string, unknown>;
  clientEventId: string;
  dryRun: boolean;
}): { inserted: boolean; reason?: "dry-run" | "duplicate" } {
  if (opts.dryRun) return { inserted: false, reason: "dry-run" };

  const propertiesJson = JSON.stringify({ v: 1, synthetic: 1, ...opts.properties });
  // session_id is required (NOT NULL). Synthetic events don't belong to a
  // real session — use a deterministic per-event id so multi-row backfills
  // for the same visitor don't collapse onto a single fake session.
  const sessionId = `synthetic-${opts.clientEventId}`;

  const result = db
    .prepare(
      `INSERT OR IGNORE INTO events (
         ts_server, visitor_id, user_id, session_id,
         event_type, event_name,
         game_mode, mp_room_code,
         properties,
         device_type, is_bot, is_synthetic,
         client_event_id
       ) VALUES (
         @ts, @vid, @uid, @sid,
         @type, @name,
         @gameMode, @mpRoom,
         @properties,
         'unknown', 0, 1,
         @clientEventId
       )`,
    )
    .run({
      ts: opts.tsServer,
      vid: opts.visitorId,
      uid: opts.userId,
      sid: sessionId,
      type: opts.eventType,
      name: opts.eventName,
      gameMode: opts.gameMode,
      mpRoom: opts.mpRoomCode,
      properties: propertiesJson,
      clientEventId: opts.clientEventId,
    });

  if (result.changes === 0) return { inserted: false, reason: "duplicate" };
  return { inserted: true };
}

function trackTsBounds(stats: BackfillStats, ts: number): void {
  if (stats.earliestTs === null || ts < stats.earliestTs) stats.earliestTs = ts;
  if (stats.latestTs === null || ts > stats.latestTs) stats.latestTs = ts;
}

/**
 * Backfill mp_game_completed events. One synthetic event per mp_leaderboard
 * row, keyed off the row id. Bot- and ghost-filtering already happened at
 * insert time (mpRoundEnd.saveToLeaderboard skips both for human-bucket
 * leaderboard inserts), so every row is a real-player completion.
 *
 * visitor_id is looked up via mp_players (room_code + player_name +
 * matching user_id when present). Rows whose mp_players row was purged
 * during room cleanup (only non-finished rooms get purged; finished rooms
 * are retained — see roomManager.cleanupStaleRooms) are skipped with a
 * counter bump so the operator can see the gap size.
 */
function backfillMpCompletions(opts: BackfillOptions, stats: BackfillStats): void {
  if (opts.skipMp) return;

  const rows = db
    .prepare(
      `SELECT id, room_code, player_name, score, placement, players_count,
              game_mode, played_at, user_id
         FROM mp_leaderboard
        WHERE ghost_user_id IS NULL`,
    )
    .all() as Array<{
      id: number;
      room_code: string | null;
      player_name: string;
      score: number;
      placement: number;
      players_count: number;
      game_mode: string;
      played_at: string;
      user_id: string | null;
    }>;

  // The lookup matches on (room_code + display_name + user_id-equality).
  // For logged-in players user_id uniquely disambiguates. For anonymous
  // players (user_id NULL on both sides) two players who shared the same
  // display_name in the same room would both match — picking one
  // arbitrarily would mis-attribute the other player's leaderboard row
  // to the same visitor. We detect that ambiguity and skip the row,
  // bumping skippedNoVisitor so the operator sees the gap.
  const lookupVisitors = db.prepare(
    `SELECT visitor_id FROM mp_players
      WHERE room_code = ? AND display_name = ?
        AND ((user_id IS NULL AND ? IS NULL) OR user_id = ?)
        AND visitor_id IS NOT NULL`,
  );

  for (const row of rows) {
    const ts = parseTs(row.played_at);
    if (!ts || !row.room_code) continue;

    const candidates = lookupVisitors.all(
      row.room_code,
      row.player_name,
      row.user_id,
      row.user_id,
    ) as Array<{ visitor_id: string }>;

    // Distinct visitor_ids — same player rejoining produces two
    // mp_players rows with identical visitor_id, and that's safe to
    // collapse. Different visitor_ids under the same display_name is
    // the ambiguous case we have to abandon.
    const distinctVisitors = new Set(candidates.map((c) => c.visitor_id));
    if (distinctVisitors.size === 0 || distinctVisitors.size > 1) {
      stats.skippedNoVisitor += 1;
      continue;
    }
    const visitorId = distinctVisitors.values().next().value as string;

    const result = insertSyntheticEvent({
      eventName: ANALYTICS_EVENTS.MP_GAME_COMPLETED,
      eventType: "mp",
      visitorId,
      userId: row.user_id,
      tsServer: ts,
      gameMode: row.game_mode,
      mpRoomCode: row.room_code,
      properties: {
        room_code: row.room_code,
        game_mode: row.game_mode,
        score: row.score,
        placement: row.placement,
        players_count: row.players_count,
        is_logged_in: !!row.user_id,
      },
      clientEventId: `synthetic:mp_game_completed:${row.id}`,
      dryRun: opts.dryRun,
    });

    if (result.inserted) {
      stats.mpGamesCompleted += 1;
      trackTsBounds(stats, ts);
    } else if (result.reason === "duplicate") {
      stats.skippedAlreadyExists += 1;
    }
  }
}

/**
 * Backfill mp_room_created events from finished mp_rooms. Looks up the
 * host's visitor_id from mp_players (is_host=1). Rooms whose host row
 * was purged are skipped.
 */
function backfillMpRoomsCreated(opts: BackfillOptions, stats: BackfillStats): void {
  if (opts.skipMp) return;

  const rows = db
    .prepare(
      `SELECT code, game_mode, total_rounds, is_public, is_daily_game, created_at
         FROM mp_rooms
        WHERE created_at IS NOT NULL`,
    )
    .all() as Array<{
      code: string;
      game_mode: string;
      total_rounds: number;
      is_public: number;
      is_daily_game: number;
      created_at: string;
    }>;

  const lookupHost = db.prepare(
    `SELECT visitor_id, user_id FROM mp_players
      WHERE room_code = ? AND is_host = 1 AND is_bot = 0
      LIMIT 1`,
  );

  for (const row of rows) {
    const ts = parseTs(row.created_at);
    if (!ts) continue;

    const host = lookupHost.get(row.code) as
      | { visitor_id: string | null; user_id: string | null }
      | undefined;
    if (!host?.visitor_id) {
      stats.skippedNoVisitor += 1;
      continue;
    }

    const result = insertSyntheticEvent({
      eventName: ANALYTICS_EVENTS.MP_ROOM_CREATED,
      eventType: "mp",
      visitorId: host.visitor_id,
      userId: host.user_id,
      tsServer: ts,
      gameMode: row.game_mode,
      mpRoomCode: row.code,
      properties: {
        room_code: row.code,
        game_mode: row.game_mode,
        total_rounds: row.total_rounds,
        is_public: row.is_public === 1,
        is_daily_game: row.is_daily_game === 1,
        is_logged_in: !!host.user_id,
      },
      clientEventId: `synthetic:mp_room_created:${row.code}`,
      dryRun: opts.dryRun,
    });

    if (result.inserted) {
      stats.mpRoomsCreated += 1;
      trackTsBounds(stats, ts);
    } else if (result.reason === "duplicate") {
      stats.skippedAlreadyExists += 1;
    }
  }
}

/**
 * Backfill daily_completed events from completed daily_plays rows. Both SP
 * and MP daily completions land here since they share the same table.
 * `via` property is approximated from `session_id` shape: MP daily uses
 * `<roomCode>:<playerId>` (UUIDs); SP uses the bare game_session_id.
 */
function backfillDailyCompletions(opts: BackfillOptions, stats: BackfillStats): void {
  if (opts.skipDaily) return;

  const rows = db
    .prepare(
      `SELECT id, user_id, session_id, daily_date, game_mode,
              score, completed_at, visitor_id
         FROM daily_plays
        WHERE completed_at IS NOT NULL`,
    )
    .all() as Array<{
      id: number;
      user_id: string | null;
      session_id: string;
      daily_date: string;
      game_mode: string;
      score: number;
      completed_at: string;
      visitor_id: string | null;
    }>;

  for (const row of rows) {
    const ts = parseTs(row.completed_at);
    if (!ts) continue;
    if (!row.visitor_id) {
      stats.skippedNoVisitor += 1;
      continue;
    }

    // MP daily uses session_id="<roomCode>:<playerId>" (see
    // mpRoundEnd.recordDailyPlaysForRoom); SP daily uses the bare
    // game_session_id (a UUID with no colon).
    const via = row.session_id.includes(":") ? "multiplayer" : "single_player";
    const mpRoomCode =
      via === "multiplayer" ? row.session_id.split(":")[0] : null;

    const result = insertSyntheticEvent({
      eventName: ANALYTICS_EVENTS.DAILY_COMPLETED,
      eventType: "game",
      visitorId: row.visitor_id,
      userId: row.user_id,
      tsServer: ts,
      gameMode: row.game_mode,
      mpRoomCode,
      properties: {
        daily_date: row.daily_date,
        game_mode: row.game_mode,
        score: row.score,
        via,
        is_logged_in: !!row.user_id,
      },
      clientEventId: `synthetic:daily_completed:${row.id}`,
      dryRun: opts.dryRun,
    });

    if (result.inserted) {
      stats.dailyCompleted += 1;
      trackTsBounds(stats, ts);
    } else if (result.reason === "duplicate") {
      stats.skippedAlreadyExists += 1;
    }
  }
}

/**
 * Rebuild analytics_hourly across the timestamp range we just touched so
 * v2 dashboards see the synthetic events in the rollup. The standard 48h
 * cron only covers recent windows; backfill data can stretch back months.
 */
function rebuildHourlyForBackfill(stats: BackfillStats): number {
  if (stats.earliestTs === null || stats.latestTs === null) return 0;
  const HOUR_MS = 60 * 60 * 1000;
  const startBucket = Math.floor(stats.earliestTs / HOUR_MS) * HOUR_MS;
  const endBucket = Math.floor(stats.latestTs / HOUR_MS) * HOUR_MS;
  return rebuildHourlyRange(startBucket, endBucket);
}

function parseArgs(argv: string[]): BackfillOptions {
  return {
    dryRun: argv.includes("--dry-run"),
    skipMp: argv.includes("--skip-mp"),
    skipDaily: argv.includes("--skip-daily"),
  };
}

/**
 * Entry point. Exposed for tests so the script can be exercised against an
 * isolated in-memory database.
 */
export function runBackfill(opts: BackfillOptions): BackfillStats {
  const stats: BackfillStats = {
    mpGamesCompleted: 0,
    mpRoomsCreated: 0,
    dailyCompleted: 0,
    skippedNoVisitor: 0,
    skippedAlreadyExists: 0,
    earliestTs: null,
    latestTs: null,
  };

  backfillMpRoomsCreated(opts, stats);
  backfillMpCompletions(opts, stats);
  backfillDailyCompletions(opts, stats);

  return stats;
}

function main(): void {
  const opts = parseArgs(process.argv.slice(2));
  console.log(
    `Backfill starting (dryRun=${opts.dryRun}, skipMp=${opts.skipMp}, skipDaily=${opts.skipDaily})`,
  );
  const startedAt = Date.now();
  const stats = runBackfill(opts);
  const elapsedMs = Date.now() - startedAt;

  console.log("\nResults:");
  console.log(`  mp_room_created      : ${stats.mpRoomsCreated}`);
  console.log(`  mp_game_completed    : ${stats.mpGamesCompleted}`);
  console.log(`  daily_completed      : ${stats.dailyCompleted}`);
  console.log(`  skipped (no visitor) : ${stats.skippedNoVisitor}`);
  console.log(`  skipped (duplicate)  : ${stats.skippedAlreadyExists}`);
  if (stats.earliestTs && stats.latestTs) {
    console.log(
      `  ts range             : ${new Date(stats.earliestTs).toISOString()} → ${new Date(stats.latestTs).toISOString()}`,
    );
  }
  console.log(`  elapsed              : ${elapsedMs}ms`);

  if (!opts.dryRun && (stats.mpGamesCompleted + stats.mpRoomsCreated + stats.dailyCompleted) > 0) {
    console.log("\nRebuilding analytics_hourly across backfilled range…");
    const rolledUp = rebuildHourlyForBackfill(stats);
    console.log(`  rollup rows written  : ${rolledUp}`);
  }
}

// Server tsconfig compiles to CommonJS, so `require.main === module` is the
// correct entry-point check. Tests import `runBackfill` directly and the
// guard prevents `main()` from running when the file is imported as a module.
if (require.main === module) main();
