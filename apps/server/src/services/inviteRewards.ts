/**
 * Lobby-invite reward service.
 *
 * This module is strictly distinct from `services/referrals.ts`. Referrals
 * reward a user for getting *new account signups*; this module rewards a host
 * for getting another player to join their *multiplayer room link* and
 * actually play.
 *
 * The reward is a one-time score buff (a multiplier applied to the host's
 * next N matches). Joiners get a smaller welcome buff. All anti-abuse rules
 * fire silently — a rejected attribution is invisible to the joiner.
 *
 * State machine:
 *   pending  →  earned    (joiner submits non-timeout guesses in INVITE_REWARD_TRIGGER_ROUNDS rounds)
 *   pending  →  rejected  (one of the abuse gates fires)
 *
 * (Kicked joiners simply never reach the round threshold; their pending row
 * remains until the room is deleted and the FK cascades it away.)
 */

import { randomBytes } from "crypto";
import type { Database as DatabaseType } from "better-sqlite3";
import type {
  PendingBuff,
  InviteRejectReason,
  BuffSource,
  InviteRewardEarnedEvent,
  InviteWelcomeBonusEvent,
} from "@price-game/shared";

/**
 * Sandbox-only escape hatch: when both `SANDBOX=1` and
 * `SKIP_INVITE_IP_CHECKS=1` are set, the IP-collision and per-IP daily-cap
 * gates are bypassed. The boot guard in `index.ts` refuses to start a
 * production process with this flag set without `SANDBOX=1`, so prod is
 * structurally safe.
 *
 * Used to test the +25% buff flow on a single host machine where the
 * inviter and joiner browsers necessarily share an IP.
 */
function shouldSkipInviteIpChecks(): boolean {
  return process.env.SANDBOX === "1" && process.env.SKIP_INVITE_IP_CHECKS === "1";
}

// === Tunables (export so docs + admin UI render the same numbers) ===

/** +25% score multiplier for the inviter on each of their next N matches. */
export const INVITE_REWARD_HOST_MULTIPLIER = 1.25;
/** Number of matches the host buff applies to. */
export const INVITE_REWARD_HOST_MATCHES = 3;
/** +10% welcome bonus for the joiner on their next match. */
export const INVITE_REWARD_JOINER_MULTIPLIER = 1.10;
/** Number of matches the joiner buff applies to. */
export const INVITE_REWARD_JOINER_MATCHES = 1;
/** +10% score multiplier awarded to every human player who completes
 *  a publicly-listed lobby. Applied to their next match. */
export const PUBLIC_GAME_BUFF_MULTIPLIER = 1.10;
/** Number of matches the public-game buff applies to. */
export const PUBLIC_GAME_BUFF_MATCHES = 1;
/** Buffs auto-expire 14 days after issue regardless of consumption. */
export const INVITE_BUFF_TTL_SECONDS = 14 * 24 * 60 * 60;
/** Joiner must submit guesses in this many rounds for the buff to be earned. */
export const INVITE_REWARD_TRIGGER_ROUNDS = 3;
/** Joiner's logged-in account must be at least this old. */
export const INVITE_NEW_ACCOUNT_GATE_SECONDS = 600; // 10 min
/** Same (inviter, joiner-identity) pair counts at most once per this window. */
export const INVITE_PAIR_DEDUP_SECONDS = 30 * 24 * 60 * 60; // 30 days
/** Per-host weekly cap on earned attributions. */
export const INVITE_HOST_WEEKLY_CAP = 5;
/** Per-host daily cap on earned attributions. */
export const INVITE_HOST_DAILY_CAP = 5;
/** Per-IP daily cap on earned attributions across all hosts. */
export const INVITE_IP_DAILY_CAP = 3;
/** Token length in URL-safe characters. */
export const INVITE_TOKEN_LENGTH = 10;

const TOKEN_CHARSET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

// === Inputs ===

export interface MintTokenInput {
  roomCode: string;
  inviterUserId: string | null;
  inviterVisitorId: string;
  inviterIp: string;
  inviterFp: string | null;
}

export interface MintTokenResult {
  token: string;
  url: string;
}

export interface AttributeJoinInput {
  token: string;
  joiner: {
    playerId: string;
    userId: string | null;
    visitorId: string;
    ip: string;
    fp: string | null;
  };
}

export type AttributeJoinResult =
  | { status: "pending"; attributionId: number }
  | { status: "rejected"; reason: InviteRejectReason };

export interface RecordRoundInput {
  roomCode: string;
  joinerPlayerId: string;
}

export interface RecordRoundResult {
  earned: boolean;
  hostEvent?: InviteRewardEarnedEvent & { attributionId: number; inviterUserId: string | null; inviterVisitorId: string };
  joinerEvent?: InviteWelcomeBonusEvent & { attributionId: number; joinerUserId: string | null; joinerVisitorId: string };
}

// === Helpers ===

/**
 * Build the canonical /r/{token} share URL on top of an origin.
 *
 * @param token Token returned by mintInviteToken.
 * @param origin Origin like `https://price.games`. No trailing slash.
 */
export function buildInviteUrl(token: string, origin: string): string {
  return `${origin}/r/${token}`;
}

/**
 * Produce a cryptographically random URL-safe token of INVITE_TOKEN_LENGTH chars.
 * Uses rejection sampling so each char is uniformly distributed across TOKEN_CHARSET.
 */
function generateToken(): string {
  // 62-char alphabet → 6 bits per char with rejection sampling. Allocate
  // double the bytes we strictly need; rare to need a refill.
  const bytes = randomBytes(INVITE_TOKEN_LENGTH * 2);
  let out = "";
  for (let i = 0; i < bytes.length && out.length < INVITE_TOKEN_LENGTH; i++) {
    const byte = bytes[i] & 0x3f; // 6 bits
    if (byte < TOKEN_CHARSET.length) out += TOKEN_CHARSET[byte];
  }
  if (out.length < INVITE_TOKEN_LENGTH) {
    // Extremely unlikely; fall back to recursive call.
    return generateToken();
  }
  return out;
}

function joinerIdentityKey(joiner: { userId: string | null; visitorId: string }): string {
  return joiner.userId ? `u:${joiner.userId}` : `v:${joiner.visitorId}`;
}

// === mintInviteToken ===

interface InviteTokenRow {
  token: string;
  room_code: string;
  inviter_user_id: string | null;
  inviter_visitor_id: string;
  inviter_ip: string;
  inviter_fp: string | null;
  created_at: number;
  revoked_at: number | null;
}

/**
 * Mint a new invite token. The caller is the host of `roomCode`. The token
 * is opaque to the joiner; on join it's resolved server-side to attribute
 * the join back to the inviter.
 *
 * @param db SQLite handle.
 * @param input Inviter identity + room.
 * @param now Optional clock override (unix seconds) for tests.
 * @returns The token and the share URL placeholder (origin must be supplied
 * by the caller via `buildInviteUrl` if the URL needs the production origin).
 */
export function mintInviteToken(
  db: DatabaseType,
  input: MintTokenInput,
  now: number = Math.floor(Date.now() / 1000),
): MintTokenResult {
  // Insert with retry on (very-rare) PK collision.
  const insert = db.prepare(
    `INSERT INTO mp_invite_tokens
      (token, room_code, inviter_user_id, inviter_visitor_id, inviter_ip, inviter_fp, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  for (let attempt = 0; attempt < 5; attempt++) {
    const token = generateToken();
    try {
      insert.run(
        token,
        input.roomCode,
        input.inviterUserId,
        input.inviterVisitorId,
        input.inviterIp,
        input.inviterFp,
        now,
      );
      return { token, url: `/r/${token}` };
    } catch (err) {
      // SQLITE_CONSTRAINT_PRIMARYKEY → try a new token.
      if (err instanceof Error && /UNIQUE/.test(err.message)) continue;
      throw err;
    }
  }
  throw new Error("Failed to mint a unique invite token after 5 attempts");
}

// === revokeInviteToken ===

/**
 * Mark an invite token as revoked. Only the visitor who minted it may revoke.
 *
 * @returns true if the row was updated, false otherwise (unknown token,
 * different inviter, or already revoked).
 */
export function revokeInviteToken(
  db: DatabaseType,
  token: string,
  requesterVisitorId: string,
  now: number = Math.floor(Date.now() / 1000),
): boolean {
  const result = db
    .prepare(
      `UPDATE mp_invite_tokens
        SET revoked_at = ?
        WHERE token = ?
          AND inviter_visitor_id = ?
          AND revoked_at IS NULL`,
    )
    .run(now, token, requesterVisitorId);
  return result.changes > 0;
}

// === attributeJoin ===

/**
 * Attribute a joiner to an inviter via the invite token. Runs every abuse
 * check inside a single IMMEDIATE transaction so two concurrent joiners can't
 * both slip past a cap.
 *
 * Always returns either pending (insertion of an attribution row) or
 * rejected (no row inserted; reject reason captured for analytics in a
 * separate row with status='rejected').
 */
export function attributeJoin(
  db: DatabaseType,
  input: AttributeJoinInput,
  now: number = Math.floor(Date.now() / 1000),
): AttributeJoinResult {
  const txn = db.transaction((): AttributeJoinResult => {
    // 1. Token lookup
    const tokenRow = db
      .prepare(
        `SELECT * FROM mp_invite_tokens WHERE token = ? AND revoked_at IS NULL`,
      )
      .get(input.token) as InviteTokenRow | undefined;
    if (!tokenRow) {
      return { status: "rejected", reason: "unknown_token" };
    }

    const identityKey = joinerIdentityKey(input.joiner);
    const writeReject = (reason: InviteRejectReason): void => {
      db.prepare(
        `INSERT INTO mp_invite_attributions
          (token, room_code, joiner_player_id, joiner_user_id, joiner_visitor_id, joiner_ip, joiner_fp, joiner_identity_key, status, reject_reason, rounds_completed, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'rejected', ?, 0, ?)`,
      ).run(
        input.token,
        tokenRow.room_code,
        input.joiner.playerId,
        input.joiner.userId,
        input.joiner.visitorId,
        input.joiner.ip,
        input.joiner.fp,
        identityKey,
        reason,
        now,
      );
    };

    // 2. Self-invite (same visitor) — record reject for analytics
    if (input.joiner.visitorId === tokenRow.inviter_visitor_id) {
      writeReject("self_invite");
      return { status: "rejected", reason: "self_invite" };
    }

    // 3. IP collision
    if (input.joiner.ip === tokenRow.inviter_ip && !shouldSkipInviteIpChecks()) {
      writeReject("ip_collision");
      return { status: "rejected", reason: "ip_collision" };
    }

    // 4. New-account gate (only if joiner is logged in)
    if (input.joiner.userId) {
      const userRow = db
        .prepare("SELECT created_at FROM users WHERE id = ?")
        .get(input.joiner.userId) as { created_at: string } | undefined;
      if (userRow) {
        const createdSec = Math.floor(new Date(userRow.created_at).getTime() / 1000);
        if (now - createdSec < INVITE_NEW_ACCOUNT_GATE_SECONDS) {
          writeReject("new_account");
          return { status: "rejected", reason: "new_account" };
        }
      }
    }

    // 5. Pair dedup (30d)
    const pairCutoff = now - INVITE_PAIR_DEDUP_SECONDS;
    const pairHit = db
      .prepare(
        `SELECT 1 FROM mp_invite_attributions a
          JOIN mp_invite_tokens t ON t.token = a.token
          WHERE t.inviter_visitor_id = ?
            AND a.joiner_identity_key = ?
            AND a.status IN ('pending','earned')
            AND a.created_at > ?
          LIMIT 1`,
      )
      .get(tokenRow.inviter_visitor_id, identityKey, pairCutoff) as
        | { 1: number }
        | undefined;
    if (pairHit) {
      writeReject("pair_dedup");
      return { status: "rejected", reason: "pair_dedup" };
    }

    // 6. Per-host daily cap (24h) — checked before weekly so it's the
    // narrower / more recent window that fires first.
    const dailyCount = (db
      .prepare(
        `SELECT COUNT(*) AS c FROM mp_invite_attributions a
          JOIN mp_invite_tokens t ON t.token = a.token
          WHERE t.inviter_visitor_id = ?
            AND a.status = 'earned'
            AND a.earned_at > ?`,
      )
      .get(tokenRow.inviter_visitor_id, now - 86_400) as { c: number }).c;
    if (dailyCount >= INVITE_HOST_DAILY_CAP) {
      writeReject("cap_daily");
      return { status: "rejected", reason: "cap_daily" };
    }

    // 7. Per-host weekly cap (7d)
    const weeklyCount = (db
      .prepare(
        `SELECT COUNT(*) AS c FROM mp_invite_attributions a
          JOIN mp_invite_tokens t ON t.token = a.token
          WHERE t.inviter_visitor_id = ?
            AND a.status = 'earned'
            AND a.earned_at > ?`,
      )
      .get(tokenRow.inviter_visitor_id, now - 604_800) as { c: number }).c;
    if (weeklyCount >= INVITE_HOST_WEEKLY_CAP) {
      writeReject("cap_weekly");
      return { status: "rejected", reason: "cap_weekly" };
    }

    // 8. Per-IP daily cap (joiner side). Skipped under
    // SANDBOX=1 + SKIP_INVITE_IP_CHECKS=1 so a tester sharing one IP can
    // burn through the cap during local QA.
    if (!shouldSkipInviteIpChecks()) {
      const ipCount = (db
        .prepare(
          `SELECT COUNT(*) AS c FROM mp_invite_attributions
            WHERE joiner_ip = ?
              AND status = 'earned'
              AND earned_at > ?`,
        )
        .get(input.joiner.ip, now - 86_400) as { c: number }).c;
      if (ipCount >= INVITE_IP_DAILY_CAP) {
        writeReject("ip_throttle");
        return { status: "rejected", reason: "ip_throttle" };
      }
    }

    // All gates passed. Insert pending row.
    const info = db
      .prepare(
        `INSERT INTO mp_invite_attributions
          (token, room_code, joiner_player_id, joiner_user_id, joiner_visitor_id, joiner_ip, joiner_fp, joiner_identity_key, status, rounds_completed, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?)`,
      )
      .run(
        input.token,
        tokenRow.room_code,
        input.joiner.playerId,
        input.joiner.userId,
        input.joiner.visitorId,
        input.joiner.ip,
        input.joiner.fp,
        identityKey,
        now,
      );
    return { status: "pending", attributionId: Number(info.lastInsertRowid) };
  });
  return txn.immediate();
}

// === recordRoundCompleted ===

/**
 * Increment the joiner's `rounds_completed` for any active attribution in
 * this room. When the count first reaches the trigger threshold, transition
 * the attribution to `earned` and insert two pending buffs (host + joiner).
 *
 * Idempotent: re-calling after the threshold is reached does nothing.
 *
 * @returns earned=true once, on the transition tick. The host/joiner events
 * are returned so the caller can emit them on the right sockets.
 */
export function recordRoundCompleted(
  db: DatabaseType,
  input: RecordRoundInput,
  now: number = Math.floor(Date.now() / 1000),
): RecordRoundResult {
  const txn = db.transaction((): RecordRoundResult => {
    const attrRow = db
      .prepare(
        `SELECT a.*, t.inviter_user_id, t.inviter_visitor_id
           FROM mp_invite_attributions a
           JOIN mp_invite_tokens t ON t.token = a.token
          WHERE a.room_code = ?
            AND a.joiner_player_id = ?
            AND a.status = 'pending'
          LIMIT 1`,
      )
      .get(input.roomCode, input.joinerPlayerId) as
        | (Record<string, unknown> & {
            id: number;
            rounds_completed: number;
            inviter_user_id: string | null;
            inviter_visitor_id: string;
            joiner_user_id: string | null;
            joiner_visitor_id: string;
          })
        | undefined;
    if (!attrRow) return { earned: false };

    const nextRounds = attrRow.rounds_completed + 1;
    if (nextRounds < INVITE_REWARD_TRIGGER_ROUNDS) {
      db.prepare(
        `UPDATE mp_invite_attributions SET rounds_completed = ? WHERE id = ?`,
      ).run(nextRounds, attrRow.id);
      return { earned: false };
    }

    // Transition to earned — flip status, stamp earned_at, insert buffs.
    db.prepare(
      `UPDATE mp_invite_attributions
         SET rounds_completed = ?,
             status = 'earned',
             earned_at = ?
       WHERE id = ?`,
    ).run(nextRounds, now, attrRow.id);

    const expiresAt = now + INVITE_BUFF_TTL_SECONDS;
    const insBuff = db.prepare(
      `INSERT INTO mp_pending_buffs
        (beneficiary_user_id, beneficiary_visitor_id, source, attribution_id, multiplier, matches_remaining, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insBuff.run(
      attrRow.inviter_user_id,
      attrRow.inviter_visitor_id,
      "invite_host",
      attrRow.id,
      INVITE_REWARD_HOST_MULTIPLIER,
      INVITE_REWARD_HOST_MATCHES,
      expiresAt,
      now,
    );
    insBuff.run(
      attrRow.joiner_user_id,
      attrRow.joiner_visitor_id,
      "invite_joiner",
      attrRow.id,
      INVITE_REWARD_JOINER_MULTIPLIER,
      INVITE_REWARD_JOINER_MATCHES,
      expiresAt,
      now,
    );

    return {
      earned: true,
      hostEvent: {
        source: "invite_host",
        multiplier: INVITE_REWARD_HOST_MULTIPLIER,
        matchesRemaining: INVITE_REWARD_HOST_MATCHES,
        joinerDisplayName: "", // filled by caller from mp_players
        attributionId: attrRow.id,
        inviterUserId: attrRow.inviter_user_id,
        inviterVisitorId: attrRow.inviter_visitor_id,
      },
      joinerEvent: {
        source: "invite_joiner",
        multiplier: INVITE_REWARD_JOINER_MULTIPLIER,
        matchesRemaining: INVITE_REWARD_JOINER_MATCHES,
        attributionId: attrRow.id,
        joinerUserId: attrRow.joiner_user_id,
        joinerVisitorId: attrRow.joiner_visitor_id,
      },
    };
  });
  return txn.immediate();
}

// === grantPublicGameBuff ===

/**
 * Grant a one-shot +10% score buff to a single beneficiary for completing
 * a publicly-listed lobby. Idempotent per match: if the beneficiary
 * already has an active `public_game` buff (from a previous public game
 * they finished today), this no-ops rather than stacking — the consumer
 * picks the highest-multiplier buff anyway, so granting more wouldn't
 * help, and skipping the insert keeps the buffs table tidy.
 *
 * Identity rules: at least one of `beneficiaryUserId` or
 * `beneficiaryVisitorId` must be a non-empty string. When the user is
 * logged in but `visitor_id` is unknown (legacy mp_players rows where
 * the column is null/empty), the dedup checks ONLY by user_id — passing
 * `""` as a sentinel would collide across all such users via the OR
 * branch. Symmetric for guests with no user_id.
 *
 * @returns true if a new buff row was inserted, false if the beneficiary
 * already had an unconsumed public_game buff, or if neither identity
 * was supplied (refusal — caller should ensure at least one).
 */
export function grantPublicGameBuff(
  db: DatabaseType,
  input: { beneficiaryUserId: string | null; beneficiaryVisitorId: string },
  now: number = Math.floor(Date.now() / 1000),
): boolean {
  const hasUser = !!input.beneficiaryUserId;
  const hasVisitor = !!input.beneficiaryVisitorId; // empty string is "no visitor"
  if (!hasUser && !hasVisitor) return false;

  // Build the dedup WHERE so each branch only references identifiers
  // that are actually present. The OR-both-set branch is the only path
  // that previously could collide on empty-string `beneficiary_visitor_id`
  // — by gating on `hasVisitor`, an unknown visitor never falls into
  // the OR with `''` and therefore can't false-positive against another
  // user's empty-visitor row.
  const params: (string | number)[] = [];
  let where = "source = 'public_game'";
  if (hasUser && hasVisitor) {
    where += " AND (beneficiary_user_id = ? OR beneficiary_visitor_id = ?)";
    params.push(input.beneficiaryUserId!, input.beneficiaryVisitorId);
  } else if (hasUser) {
    where += " AND beneficiary_user_id = ?";
    params.push(input.beneficiaryUserId!);
  } else {
    where += " AND beneficiary_visitor_id = ?";
    params.push(input.beneficiaryVisitorId);
  }
  params.push(now);
  const existing = db
    .prepare(
      `SELECT 1 FROM mp_pending_buffs
        WHERE ${where}
          AND matches_remaining > 0
          AND expires_at > ?
        LIMIT 1`,
    )
    .get(...params);
  if (existing) return false;

  // For the INSERT, the schema requires `beneficiary_visitor_id NOT NULL`.
  // Logged-in users without a visitor_id get a stable per-user sentinel
  // (`u:<userId>`) so future dedup queries — and the `applyBuffs`
  // OR-branch — can't cross-match against another user's empty-string
  // sentinel. Guests always have a real visitor_id.
  const visitorForInsert = hasVisitor
    ? input.beneficiaryVisitorId
    : `u:${input.beneficiaryUserId}`;

  db.prepare(
    `INSERT INTO mp_pending_buffs
      (beneficiary_user_id, beneficiary_visitor_id, source, attribution_id,
       multiplier, matches_remaining, expires_at, created_at)
     VALUES (?, ?, 'public_game', NULL, ?, ?, ?, ?)`,
  ).run(
    input.beneficiaryUserId,
    visitorForInsert,
    PUBLIC_GAME_BUFF_MULTIPLIER,
    PUBLIC_GAME_BUFF_MATCHES,
    now + INVITE_BUFF_TTL_SECONDS,
    now,
  );
  return true;
}

// === applyBuffs ===

interface BuffRow {
  id: number;
  source: string;
  multiplier: number;
  matches_remaining: number;
  expires_at: number;
  created_at: number;
}

/**
 * Consume the highest-multiplier active buff for this beneficiary. Returns
 * the post-buff score and the consumed buff (if any). Buffs do NOT stack —
 * picking the largest is the deliberate design choice.
 *
 * @param input rawScore is the pre-buff score the caller computed.
 */
export function applyBuffs(
  db: DatabaseType,
  input: {
    rawScore: number;
    beneficiaryUserId: string | null;
    beneficiaryVisitorId: string;
  },
  now: number = Math.floor(Date.now() / 1000),
): { finalScore: number; applied: PendingBuff | null } {
  const txn = db.transaction((): { finalScore: number; applied: PendingBuff | null } => {
    const candidate = pickActiveBuffRow(db, input, now);
    if (!candidate) {
      return { finalScore: input.rawScore, applied: null };
    }
    const finalScore = Math.round(input.rawScore * candidate.multiplier);
    const newRemaining = candidate.matches_remaining - 1;
    if (newRemaining <= 0) {
      db.prepare("DELETE FROM mp_pending_buffs WHERE id = ?").run(candidate.id);
    } else {
      db.prepare(
        "UPDATE mp_pending_buffs SET matches_remaining = ? WHERE id = ?",
      ).run(newRemaining, candidate.id);
    }
    const applied: PendingBuff = {
      id: candidate.id,
      source: candidate.source as BuffSource,
      multiplier: candidate.multiplier,
      matchesRemaining: newRemaining,
      expiresAt: candidate.expires_at,
      createdAt: candidate.created_at,
    };
    return { finalScore, applied };
  });
  return txn.immediate();
}

function pickActiveBuffRow(
  db: DatabaseType,
  input: { beneficiaryUserId: string | null; beneficiaryVisitorId: string },
  now: number,
): BuffRow | undefined {
  // Prefer rows keyed on user_id when the caller is logged in; fall back to
  // visitor_id otherwise. Rows from before signup keyed on visitor_id stay
  // accessible until the existing visitor→user merge re-keys them.
  const params: (string | number)[] = [];
  let where = "";
  if (input.beneficiaryUserId) {
    where = "(beneficiary_user_id = ? OR beneficiary_visitor_id = ?)";
    params.push(input.beneficiaryUserId, input.beneficiaryVisitorId);
  } else {
    where = "beneficiary_visitor_id = ?";
    params.push(input.beneficiaryVisitorId);
  }
  params.push(now);
  return db
    .prepare(
      `SELECT id, source, multiplier, matches_remaining, expires_at, created_at
         FROM mp_pending_buffs
        WHERE ${where}
          AND matches_remaining > 0
          AND expires_at > ?
        ORDER BY multiplier DESC, id ASC
        LIMIT 1`,
    )
    .get(...params) as BuffRow | undefined;
}

// === getActiveBuffs ===

/**
 * List the beneficiary's active (non-expired, matches_remaining > 0) buffs.
 * Used by the client HUD to show "Bonus active" chips.
 */
export function getActiveBuffs(
  db: DatabaseType,
  input: { beneficiaryUserId: string | null; beneficiaryVisitorId: string },
  now: number = Math.floor(Date.now() / 1000),
): PendingBuff[] {
  const params: (string | number)[] = [];
  let where = "";
  if (input.beneficiaryUserId) {
    where = "(beneficiary_user_id = ? OR beneficiary_visitor_id = ?)";
    params.push(input.beneficiaryUserId, input.beneficiaryVisitorId);
  } else {
    where = "beneficiary_visitor_id = ?";
    params.push(input.beneficiaryVisitorId);
  }
  params.push(now);
  const rows = db
    .prepare(
      `SELECT id, source, multiplier, matches_remaining, expires_at, created_at
         FROM mp_pending_buffs
        WHERE ${where}
          AND matches_remaining > 0
          AND expires_at > ?
        ORDER BY multiplier DESC, id ASC`,
    )
    .all(...params) as BuffRow[];
  return rows.map((r) => ({
    id: r.id,
    source: r.source as BuffSource,
    multiplier: r.multiplier,
    matchesRemaining: r.matches_remaining,
    expiresAt: r.expires_at,
    createdAt: r.created_at,
  }));
}
