/**
 * Identity helpers for the disguise layer of the auto-lobby system.
 *
 * The DB always knows the truth (`is_bot`, `is_disguised`); the wire payload
 * sent to clients is what hides it. These two helpers are the single source
 * of truth for "what gets exposed" vs "what the server treats as a bot."
 *
 * Invariants:
 *  - `is_disguised = 1` is meaningful only when `is_bot = 1`. If you see
 *    `(is_bot=0, is_disguised=1)`, treat the player as a human — never let a
 *    standalone `is_disguised` flag change behavior.
 *  - All scoring, scheduling, and cleanup paths must call
 *    {@link isServerSideBot}, never `row.is_bot === 1` directly, so the
 *    disguise toggle never accidentally turns a bot into a real player on
 *    the server side.
 */

import type { DbPlayer } from "../dbTypes";

/**
 * The value the client receives in the `isBot` field of the player payload.
 *
 * Disguised bots return `false` — that's the entire point of the disguise.
 * Server-side code MUST NOT use this for branching; use
 * {@link isServerSideBot} for any logic that depends on whether the player
 * is actually a bot.
 *
 * @param row - The player row from the database.
 */
export function wirePayloadIsBot(row: DbPlayer): boolean {
  return row.is_bot === 1 && row.is_disguised !== 1;
}

/**
 * Whether server-side code (scoring, scheduling, ready-checks, cleanup, etc.)
 * should treat this player as a bot.
 *
 * Returns true for both labeled and disguised bots; ignores `is_disguised`
 * unless `is_bot` is also set so a corrupted row can never elevate a real
 * player into a bot.
 *
 * @param row - The player row from the database.
 */
export function isServerSideBot(row: DbPlayer): boolean {
  return row.is_bot === 1;
}
