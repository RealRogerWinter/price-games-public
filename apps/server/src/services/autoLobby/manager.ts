/**
 * Auto-lobby manager — maintains a target population of public, joinable
 * lobbies pre-populated with bots so the lobby browser is never empty.
 *
 * The exported pieces are split into:
 *  - Pure decision helpers ({@link decideSpawnTarget}, {@link pickModeForSpawn})
 *    so the policy is unit-testable without the DB.
 *  - DB-touching primitives ({@link spawnAutoLobby}, {@link closeIdleAutoLobby},
 *    counts) that the interval loop calls.
 *  - {@link runAutoLobbyTick}, the single public entry point the scheduler
 *    fires every N seconds. The scheduler itself (setInterval) is wired in
 *    `index.ts` so tests can drive ticks deterministically.
 *
 * Constraints enforced here:
 *  - Closing an auto-lobby is only permitted when zero humans are seated;
 *    this prevents the system from reaping a room a player just clicked.
 *  - Spawn burst is capped at 3 per tick so a freshly-empty lobby browser
 *    doesn't materialize 6 rooms in a single millisecond — the engagement
 *    expert flagged identical creation timestamps as the strongest fake-
 *    activity tell.
 *  - When the master toggle is off, no spawn ever happens; idle rooms get
 *    swept via the existing `cleanupStaleRooms` path within ~5 minutes.
 */

import type { Database as DatabaseType } from "better-sqlite3";
import { nanoid } from "nanoid";
import { v4 as uuidv4 } from "uuid";
import {
  VALID_GAME_MODES,
  RANDOMIZABLE_AVATARS,
  type Avatar,
  type BotDifficulty,
} from "@price-game/shared";
import { generateBotNames } from "../botNames";
import { getDisabledGameModes } from "../siteSettings";
import { generateHumanStyleNames } from "./nameGenerator";
import { getAutoLobbySettings } from "./settings";
import { pickSeatableGhosts } from "../ghostUsers/manager";
import type { DbGhostUser } from "../dbTypes";

/** Hard cap on how many auto-lobbies the manager creates in one tick. */
const SPAWN_BURST_CAP = 3;

/** Round-count weights for auto-lobby spawns. Mirrors the values a real
 *  user can pick (3, 5, 10, 15, 20) but heavily skews toward shorter
 *  games — 90% of auto-lobbies open as 3 or 5 rounds so a fresh player
 *  who walks in faces a low-commitment first game and the lobby browser
 *  doesn't fill up with multi-hour 20-round rooms. The 10/15/20 options
 *  exist so the population isn't suspiciously uniform. */
const AUTO_LOBBY_ROUND_WEIGHTS: ReadonlyArray<readonly [number, number]> = [
  [3, 0.50],
  [5, 0.40],
  [10, 0.06],
  [15, 0.02],
  [20, 0.02],
];

/** Pick a round count from {@link AUTO_LOBBY_ROUND_WEIGHTS}. */
function pickAutoLobbyRounds(): number {
  const r = Math.random();
  let acc = 0;
  for (const [rounds, weight] of AUTO_LOBBY_ROUND_WEIGHTS) {
    acc += weight;
    if (r < acc) return rounds;
  }
  return AUTO_LOBBY_ROUND_WEIGHTS[AUTO_LOBBY_ROUND_WEIGHTS.length - 1][0];
}

function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * Count of currently-live auto-lobby rooms (status='lobby').
 *
 * @param db - Database instance.
 */
export function countActiveAutoLobbies(db: DatabaseType): number {
  const row = db
    .prepare(
      "SELECT COUNT(*) AS n FROM mp_rooms WHERE is_auto_lobby = 1 AND status = 'lobby'",
    )
    .get() as { n: number };
  return row.n;
}

/**
 * Count of joinable public lobbies (auto + real). This is the number we
 * compare against {@link AutoLobbySettings.targetCount} when deciding whether
 * to spawn — a healthy population of *real* rooms reduces the auto-spawn
 * pressure to zero on its own.
 *
 * @param db - Database instance.
 */
export function countVisibleLobbies(db: DatabaseType): number {
  const row = db
    .prepare(
      "SELECT COUNT(*) AS n FROM mp_rooms WHERE is_public = 1 AND status = 'lobby'",
    )
    .get() as { n: number };
  return row.n;
}

/**
 * Decide how many auto-lobbies to spawn this tick.
 *
 * Returns the smaller of `target - visible` and {@link SPAWN_BURST_CAP}.
 * Negative deficits clamp to 0 so the function is total.
 *
 * @param input.visible - Current count of joinable public lobbies.
 * @param input.target - Admin-configured target.
 */
export function decideSpawnTarget(input: { visible: number; target: number }): number {
  const deficit = Math.max(0, input.target - input.visible);
  return Math.min(deficit, SPAWN_BURST_CAP);
}

/**
 * Choose a game mode for a fresh auto-lobby.
 *
 * Uses uniform sampling within the admin allowlist (or all enabled modes if
 * the allowlist is empty). Returns `null` when every candidate is admin-
 * disabled — the caller should treat that as "skip this tick" rather than
 * fall back to a hardcoded default.
 *
 * @param opts.allowlist - Modes the admin has explicitly opted in (or [] for all).
 * @param opts.disabled - Modes admin-disabled site-wide (from `disabled_game_modes`).
 */
export function pickModeForSpawn(opts: { allowlist: string[]; disabled: string[] }): string | null {
  const all = Array.from(VALID_GAME_MODES);
  const disabledSet = new Set(opts.disabled);
  const candidates = (opts.allowlist.length > 0 ? opts.allowlist : all).filter(
    (m) => !disabledSet.has(m) && VALID_GAME_MODES.has(m),
  );
  if (candidates.length === 0) return null;
  return pick(candidates);
}

/** Picks `count` distinct avatars from the randomizable pool. */
function pickAvatarsFor(count: number): Avatar[] {
  const pool = [...RANDOMIZABLE_AVATARS];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, Math.min(count, pool.length)) as Avatar[];
}

/**
 * Create a fresh auto-lobby with the given bot composition.
 *
 * Bypasses the host-driven `createRoom` / `addBots` path because there is
 * no real human creator. The manager itself stands in as the room's host
 * (host_player_id = the first labeled bot) so admin/socket flows that read
 * `host_player_id` keep working; the host bot is never marked `is_host=1`
 * so the existing "auto-start when all humans ready" logic doesn't get
 * confused by the fake host.
 *
 * @param db - Database instance.
 * @param opts.mode - Game mode for the room.
 * @param opts.botCount - Number of bots to seat (3-6 sane range).
 * @param opts.disguiseRatio - Percentage (0-100) of bots to mark `is_disguised=1`.
 * @param opts.difficulty - Bot difficulty bucket. Defaults to "medium".
 * @returns The room code, or `null` when the inputs are invalid.
 */
export function spawnAutoLobby(
  db: DatabaseType,
  opts: { mode: string; botCount: number; disguiseRatio: number; difficulty?: BotDifficulty },
): string | null {
  if (!VALID_GAME_MODES.has(opts.mode)) return null;
  if (!Number.isInteger(opts.botCount) || opts.botCount < 1 || opts.botCount > 6) return null;
  const ratio = Math.max(0, Math.min(100, opts.disguiseRatio));
  const difficulty: BotDifficulty = opts.difficulty ?? "medium";

  const code = nanoid(7);
  const now = new Date().toISOString();
  const totalRounds = pickAutoLobbyRounds();

  const disguisedCount = Math.round(opts.botCount * (ratio / 100));
  const labeledCount = opts.botCount - disguisedCount;

  // Pull as many on-shift ghosts as we can fit into the disguised slots.
  // Each ghost we seat carries its own username + avatar (overriding the
  // synthetic-name + random-avatar generators below) AND sets
  // mp_players.ghost_user_id so the round-end credit path knows who to
  // award score to. Any disguised slots not covered by a ghost fall back
  // to the original synthesized-name path — no degradation when ghosts
  // are sparse / disabled / kill-switched.
  const ghostsForLobby: DbGhostUser[] = pickSeatableGhosts(db, disguisedCount);
  const disguisedFallbackCount = Math.max(0, disguisedCount - ghostsForLobby.length);

  const disguisedNames = generateHumanStyleNames(
    disguisedFallbackCount,
    new Set(ghostsForLobby.map((g) => g.username.toLowerCase())),
  );
  const labeledNames = generateBotNames(
    labeledCount,
    new Set([
      ...disguisedNames,
      ...ghostsForLobby.map((g) => g.username),
    ]),
  );
  const avatars = pickAvatarsFor(opts.botCount);

  const create = db.transaction(() => {
    // Pick a stand-in "host" player id BEFORE inserting the room so the FK-
    // less host_player_id column has a stable value. The first bot's UUID is
    // generated up-front and shared between the room insert and the player
    // insert below.
    const standInHostId = uuidv4();
    db.prepare(
      `INSERT INTO mp_rooms
         (code, host_player_id, creator_player_id, game_mode, category, password,
          status, current_round, total_rounds, created_at, last_activity_at,
          is_public, bot_count, bot_difficulty, is_daily_game, daily_date,
          is_auto_lobby)
       VALUES (?, ?, ?, ?, NULL, NULL, 'lobby', 0, ?, ?, ?, 1, ?, ?, 0, NULL, 1)`,
    ).run(
      // bot_count records ONLY the labeled (visible) bots. Disguised bots
      // are intentionally excluded so a client computing
      // `playerCount - humanCount - botCount` can't back-derive that the
      // remaining "humans" are actually bots and collapse the disguise.
      // Server-side counts iterate mp_players directly (is_bot=1), which
      // still sees both groups.
      code, standInHostId, standInHostId, opts.mode,
      totalRounds, now, now, labeledCount, difficulty,
    );

    const seatBot = (
      id: string,
      name: string,
      disguised: number,
      avatar: Avatar,
      ghostUserId: string | null,
    ) => {
      db.prepare(
        `INSERT INTO mp_players
           (id, room_code, display_name, avatar, token, is_host, connected,
            joined_at, is_bot, is_disguised, ghost_user_id)
         VALUES (?, ?, ?, ?, ?, 0, 1, ?, 1, ?, ?)`,
      ).run(id, code, name, avatar, `bot-${uuidv4()}`, now, disguised, ghostUserId);
    };

    // Pick the host disguise: 70% of auto-lobbies should appear to be
    // hosted by a "human" (disguised bot or ghost) so the lobby browser
    // doesn't become a tell.
    const hostShouldBeDisguised = Math.random() < 0.70;
    const useDisguisedHost =
      (hostShouldBeDisguised && disguisedCount > 0) || labeledCount === 0;

    let avatarIdx = 0;
    let ghostIdx = 0;
    let fallbackIdx = 0;

    // Helper: seat one disguised slot, preferring a ghost over a
    // synthesized name. Each ghost carries its OWN avatar/name (we ignore
    // the random `avatars[]` slot for ghost seats); fallback seats use
    // the random avatar.
    const seatOneDisguised = (id: string) => {
      if (ghostIdx < ghostsForLobby.length) {
        const g = ghostsForLobby[ghostIdx++];
        seatBot(id, g.username, 1, g.avatar as Avatar, g.id);
      } else {
        const name = disguisedNames[fallbackIdx++];
        seatBot(id, name, 1, avatars[avatarIdx++] ?? "silhouette", null);
      }
    };

    if (useDisguisedHost) {
      // Stand-in host pulls from the disguised pool (ghost preferred).
      seatOneDisguised(standInHostId);
      for (let i = 1; i < disguisedCount; i++) seatOneDisguised(uuidv4());
      for (let i = 0; i < labeledCount; i++) {
        seatBot(uuidv4(), labeledNames[i], 0, avatars[avatarIdx++] ?? "silhouette", null);
      }
    } else {
      seatBot(standInHostId, labeledNames[0], 0, avatars[avatarIdx++] ?? "silhouette", null);
      for (let i = 1; i < labeledCount; i++) {
        seatBot(uuidv4(), labeledNames[i], 0, avatars[avatarIdx++] ?? "silhouette", null);
      }
      for (let i = 0; i < disguisedCount; i++) seatOneDisguised(uuidv4());
    }
  });
  create();
  return code;
}

/**
 * Tear down an idle auto-lobby. Returns `true` only if the row was actually
 * deleted; refuses (returning `false`) when the room is not auto, has any
 * human seated, or has already moved past `lobby` status.
 *
 * @param db - Database instance.
 * @param code - The room code to close.
 */
export function closeIdleAutoLobby(db: DatabaseType, code: string): boolean {
  const room = db
    .prepare(
      "SELECT is_auto_lobby, status FROM mp_rooms WHERE code = ?",
    )
    .get(code) as { is_auto_lobby: number; status: string } | undefined;
  if (!room) return false;
  if (room.is_auto_lobby !== 1) return false;
  if (room.status !== "lobby") return false;

  const humans = db
    .prepare(
      "SELECT COUNT(*) AS n FROM mp_players WHERE room_code = ? AND is_bot = 0 AND is_kicked = 0",
    )
    .get(code) as { n: number };
  if (humans.n > 0) return false;

  // Cascade-delete in a single transaction so a partial failure can't leave
  // orphan player rows pointing at a deleted room.
  db.transaction(() => {
    db.prepare("DELETE FROM mp_players WHERE room_code = ?").run(code);
    db.prepare("DELETE FROM mp_rooms WHERE code = ?").run(code);
  })();
  return true;
}

/** Per-tick probability that an idle auto-lobby is closed for churn.
 *  At a 30s spawn-tick cadence, p=0.20 yields a Poisson-ish 1 close every
 *  90-300s on average — matches the engagement-expert recommended churn
 *  band of 90-240s. Without this, the visible lobby count pins at
 *  `targetCount` once the population is full; with it, the count
 *  visibly breathes up and down. */
const CHURN_PROB_PER_TICK = 0.20;

/**
 * Pick one closeable auto-lobby code at random for churn. Returns `null`
 * when nothing is closeable. Excludes auto-lobbies whose countdown is
 * already running so a player who just walked into a room never sees it
 * vanish under them, and excludes any room with a connected human seated.
 */
function pickChurnTarget(db: DatabaseType): string | null {
  const rows = db
    .prepare(
      `SELECT r.code FROM mp_rooms r
        WHERE r.is_auto_lobby = 1
          AND r.status = 'lobby'
          AND r.countdown_target_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM mp_players
             WHERE room_code = r.code AND is_kicked = 0 AND is_bot = 0
                AND connected = 1
          )`,
    )
    .all() as { code: string }[];
  if (rows.length === 0) return null;
  return rows[Math.floor(Math.random() * rows.length)].code;
}

/**
 * Run a single tick of the auto-lobby manager.
 *
 * Three jobs in order:
 *   1. With probability {@link CHURN_PROB_PER_TICK}, close one idle
 *      auto-lobby so the visible count fluctuates instead of pinning at
 *      `targetCount`. The spawn step in (2) refills it if we're still
 *      below target after the close.
 *   2. Top up to `targetCount`, capped at SPAWN_BURST_CAP per tick so the
 *      lobby browser never materializes a flock of rooms with identical
 *      created_at timestamps.
 *
 * Skip everything when the master toggle is off (idle auto-lobbies are
 * swept by cleanupStaleRooms within ~5 min anyway).
 *
 * @param db - Database instance.
 * @returns Object with the room codes spawned and the room code (if any)
 *   churned this tick.
 */
export function runAutoLobbyTick(
  db: DatabaseType,
): { spawned: string[]; churned: string | null } {
  const settings = getAutoLobbySettings(db);
  if (!settings.enabled) return { spawned: [], churned: null };

  // Churn first: prefer close-then-respawn in the same tick over refusing
  // to close just because we're already at target.
  let churned: string | null = null;
  if (Math.random() < CHURN_PROB_PER_TICK) {
    const target = pickChurnTarget(db);
    if (target && closeIdleAutoLobby(db, target)) {
      churned = target;
    }
  }

  // Sample an effective target uniformly in [targetMin, targetCount].
  // Without this band, the visible count pins at targetCount once full
  // and only the Poisson churn (one close every ~5 min on average)
  // creates motion. With it, the target itself wobbles each tick so the
  // visible count breathes between targetMin and targetCount.
  const lo = Math.min(settings.targetMin, settings.targetCount);
  const hi = settings.targetCount;
  const effectiveTarget = lo + Math.floor(Math.random() * (hi - lo + 1));

  const visible = countVisibleLobbies(db);
  const toSpawn = decideSpawnTarget({ visible, target: effectiveTarget });
  if (toSpawn === 0) return { spawned: [], churned };

  const disabled = getDisabledGameModes(db);
  const spawned: string[] = [];
  for (let i = 0; i < toSpawn; i++) {
    const mode = pickModeForSpawn({ allowlist: settings.modeAllowlist, disabled });
    if (!mode) break;
    // 3-4 bots — leaves at least 2 human seats in a MAX_PLAYERS=6 room so
    // a second human can still join during the countdown and the
    // reset-on-additional-join behavior is reachable. (5-bot rooms only
    // leave one human seat, making the reset path unreachable in practice.)
    const botCount = 3 + Math.floor(Math.random() * 2);
    const ratio = settings.disguiseRatioMin
      + Math.random() * (settings.disguiseRatioMax - settings.disguiseRatioMin);
    const code = spawnAutoLobby(db, { mode, botCount, disguiseRatio: ratio });
    if (code) spawned.push(code);
  }
  return { spawned, churned };
}
