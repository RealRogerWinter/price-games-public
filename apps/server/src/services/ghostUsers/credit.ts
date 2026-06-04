/**
 * Score-credit helper for ghost users.
 *
 * `creditGhostScore` is the single mutation point that adds points to a
 * ghost's `lifetime_score` and writes a `ghost_game_history` row. All
 * callers (`mpRoundEnd` integration, future modes) route through here so
 * the percentile-cap rule is impossible to bypass.
 *
 * The cap is applied as a soft-limit: the credited amount is reduced so
 * the ghost's new total exactly equals the cap, rather than rejected
 * outright. This avoids a player-visible "ghost mysteriously stopped
 * scoring" behavioral tell.
 *
 * Defense-in-depth backstop: if the ghost's current score is already
 * above the cap (admin manual override, schema drift, etc.),
 * `creditGhostScore` refuses to add any score on top — capping at the
 * existing value rather than letting the row drift further.
 */

import type { Database as DatabaseType } from "better-sqlite3";
import { getCachedCap } from "./cap";

/** Required input fields for a credit call. */
export interface CreditOpts {
  /** Raw score to add (will be soft-capped). Must be a non-negative finite number. */
  addedScore: number;
  /** Game type label written to ghost_game_history. The first surface
   *  was multiplayer; the daily-play simulator now also routes through
   *  here with `"single"` so it shares the same percentile-cap logic. */
  gameType: "multiplayer" | "single";
  /** Game mode label written to ghost_game_history. */
  gameMode: string;
  /** Optional room code for cross-reference. */
  roomCode?: string;
  /** Optional placement (1=winner). */
  placement?: number;
  /** Optional player count for context. */
  playersCount?: number;
}

/** Outcome of a credit call. */
export interface CreditResult {
  /** Score actually written (post-cap). May be 0 if at or above cap. */
  credited: number;
  /** Cap value if the credit was clipped, else null. */
  cappedTo: number | null;
}

/**
 * Credit a ghost's score with the percentile-cap soft-limit applied.
 *
 * Updates `ghost_users.lifetime_score` and inserts a `ghost_game_history`
 * row with the credited (post-cap) score. Atomic via a transaction.
 *
 * Edge cases:
 *  - Negative / non-finite `addedScore` → no-op, returns { credited: 0 }.
 *  - Unknown ghost id → no-op, returns { credited: 0 }.
 *  - Ghost already at cap → credited 0, cappedTo set so the caller can log.
 *  - Ghost already past cap (defensive) → credited 0; row not modified.
 *
 * @param db - Database instance.
 * @param ghostUserId - Target ghost id.
 * @param opts - Credit payload.
 */
export function creditGhostScore(
  db: DatabaseType,
  ghostUserId: string,
  opts: CreditOpts,
): CreditResult {
  if (!Number.isFinite(opts.addedScore) || opts.addedScore <= 0) {
    return { credited: 0, cappedTo: null };
  }

  const ghost = db
    .prepare("SELECT lifetime_score FROM ghost_users WHERE id = ?")
    .get(ghostUserId) as { lifetime_score: number } | undefined;
  if (!ghost) return { credited: 0, cappedTo: null };

  const cap = getCachedCap(db);
  const current = ghost.lifetime_score;

  let credited = opts.addedScore;
  let cappedTo: number | null = null;
  if (current >= cap) {
    // Backstop: at or past cap already. Refuse further credit; never
    // pull the score down (we don't want flicker visible to anyone).
    credited = 0;
    cappedTo = cap;
  } else if (current + opts.addedScore > cap) {
    credited = cap - current;
    cappedTo = cap;
  }

  if (credited === 0 && opts.addedScore > 0) {
    // Still write the history row so admin reports show the round
    // happened, even if no points stuck.
  }

  const now = new Date().toISOString();
  db.transaction(() => {
    // Always bump last_played_at — even when the credited score is 0
    // (already at cap). The cycling-out lifecycle treats "ghost is still
    // playing" as the activity signal, regardless of whether points
    // landed.
    if (credited > 0) {
      db.prepare(
        "UPDATE ghost_users SET lifetime_score = lifetime_score + ?, last_played_at = ?, updated_at = ? WHERE id = ?",
      ).run(credited, now, now, ghostUserId);
    } else {
      db.prepare(
        "UPDATE ghost_users SET last_played_at = ?, updated_at = ? WHERE id = ?",
      ).run(now, now, ghostUserId);
    }
    db.prepare(
      `INSERT INTO ghost_game_history
         (ghost_user_id, game_type, game_mode, room_code, score, placement, players_count, played_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      ghostUserId,
      opts.gameType,
      opts.gameMode,
      opts.roomCode ?? null,
      credited,
      opts.placement ?? null,
      opts.playersCount ?? null,
      now,
    );
  })();

  return { credited, cappedTo };
}
