/**
 * Tests for the lobby-invite reward service. Strictly distinct from
 * apps/server/src/services/referrals.test.ts — that suite covers the
 * signup-based referral system; this one covers the gameplay-buff system
 * triggered by lobby room links.
 */

import { describe, it, expect, beforeEach } from "vitest";
import type { Database as DatabaseType } from "better-sqlite3";
import { createTestDb } from "../test/dbHelper";
import {
  mintInviteToken,
  revokeInviteToken,
  attributeJoin,
  recordRoundCompleted,
  applyBuffs,
  getActiveBuffs,
  buildInviteUrl,
  grantPublicGameBuff,
  PUBLIC_GAME_BUFF_MULTIPLIER,
  PUBLIC_GAME_BUFF_MATCHES,
  INVITE_REWARD_HOST_MULTIPLIER,
  INVITE_REWARD_HOST_MATCHES,
  INVITE_REWARD_JOINER_MULTIPLIER,
  INVITE_REWARD_JOINER_MATCHES,
  INVITE_REWARD_TRIGGER_ROUNDS,
  INVITE_HOST_WEEKLY_CAP,
  INVITE_HOST_DAILY_CAP,
  INVITE_IP_DAILY_CAP,
  INVITE_NEW_ACCOUNT_GATE_SECONDS,
} from "./inviteRewards";

let db: DatabaseType;
const NOW = 1_700_000_000; // fixed unix-second clock for determinism

beforeEach(() => {
  db = createTestDb();
  // Insert a room the inviter is hosting; FK requires it.
  db.prepare(
    `INSERT INTO mp_rooms (code, host_player_id, game_mode, status, created_at)
     VALUES (?, ?, 'classic', 'lobby', ?)`,
  ).run("ABCD", "host-player-1", new Date(NOW * 1000).toISOString());
});

// --- helpers ---

function seedAccount(userId: string, createdAtSeconds: number): void {
  const iso = new Date(createdAtSeconds * 1000).toISOString();
  db.prepare(
    `INSERT INTO users (id, username, username_normalized, email, password_hash, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'hash', ?, ?)`,
  ).run(userId, userId, userId.toLowerCase(), `${userId}@x.com`, iso, iso);
}

function mintHappy(now: number = NOW): { token: string; url: string } {
  return mintInviteToken(
    db,
    {
      roomCode: "ABCD",
      inviterUserId: null,
      inviterVisitorId: "v-host",
      inviterIp: "1.1.1.1",
      inviterFp: "fp-host",
    },
    now,
  );
}

// ---------------------------------------------------------------------------
// mintInviteToken
// ---------------------------------------------------------------------------

describe("mintInviteToken", () => {
  it("returns a 10-character token and a URL containing /r/<token>", () => {
    const { token, url } = mintHappy();
    expect(token).toHaveLength(10);
    expect(url).toMatch(/\/r\/[A-Za-z0-9]{10}$/);
    expect(url.endsWith(`/r/${token}`)).toBe(true);
  });

  it("persists the token row with all fields", () => {
    const { token } = mintHappy();
    const row = db
      .prepare("SELECT * FROM mp_invite_tokens WHERE token = ?")
      .get(token) as Record<string, unknown> | undefined;
    expect(row).toBeDefined();
    expect(row!.room_code).toBe("ABCD");
    expect(row!.inviter_visitor_id).toBe("v-host");
    expect(row!.inviter_ip).toBe("1.1.1.1");
    expect(row!.inviter_fp).toBe("fp-host");
    expect(row!.revoked_at).toBeNull();
  });

  it("generates unique tokens across many invocations", () => {
    const tokens = new Set<string>();
    for (let i = 0; i < 50; i++) {
      tokens.add(mintHappy().token);
    }
    expect(tokens.size).toBe(50);
  });
});

describe("buildInviteUrl", () => {
  it("composes /r/{token} on top of the supplied origin", () => {
    expect(buildInviteUrl("abc1234567", "https://price.games")).toBe(
      "https://price.games/r/abc1234567",
    );
  });
});

// ---------------------------------------------------------------------------
// revokeInviteToken
// ---------------------------------------------------------------------------

describe("revokeInviteToken", () => {
  it("marks the token as revoked when called by the issuing visitor", () => {
    const { token } = mintHappy();
    expect(revokeInviteToken(db, token, "v-host", NOW + 10)).toBe(true);
    const row = db
      .prepare("SELECT revoked_at FROM mp_invite_tokens WHERE token = ?")
      .get(token) as { revoked_at: number | null };
    expect(row.revoked_at).toBe(NOW + 10);
  });

  it("refuses to revoke a token belonging to a different visitor", () => {
    const { token } = mintHappy();
    expect(revokeInviteToken(db, token, "someone-else", NOW + 1)).toBe(false);
    const row = db
      .prepare("SELECT revoked_at FROM mp_invite_tokens WHERE token = ?")
      .get(token) as { revoked_at: number | null };
    expect(row.revoked_at).toBeNull();
  });

  it("returns false for unknown tokens", () => {
    expect(revokeInviteToken(db, "nope0000aa", "v-host", NOW)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// attributeJoin — happy path
// ---------------------------------------------------------------------------

describe("attributeJoin happy path", () => {
  it("creates a pending attribution when the joiner passes all gates", () => {
    const { token } = mintHappy();
    const result = attributeJoin(
      db,
      {
        token,
        joiner: {
          playerId: "p-joiner",
          userId: null,
          visitorId: "v-joiner",
          ip: "2.2.2.2",
          fp: "fp-joiner",
        },
      },
      NOW + 60,
    );
    expect(result.status).toBe("pending");
    if (result.status !== "pending") return;
    const row = db
      .prepare("SELECT * FROM mp_invite_attributions WHERE id = ?")
      .get(result.attributionId) as Record<string, unknown>;
    expect(row.status).toBe("pending");
    expect(row.token).toBe(token);
    expect(row.joiner_player_id).toBe("p-joiner");
    expect(row.joiner_identity_key).toBe("v:v-joiner");
    expect(row.rounds_completed).toBe(0);
  });

  it("uses 'u:<userId>' as the identity key when joiner is logged in", () => {
    seedAccount("user-joiner", NOW - 86_400);
    const { token } = mintHappy();
    const result = attributeJoin(
      db,
      {
        token,
        joiner: {
          playerId: "p-joiner",
          userId: "user-joiner",
          visitorId: "v-joiner",
          ip: "2.2.2.2",
          fp: null,
        },
      },
      NOW + 60,
    );
    expect(result.status).toBe("pending");
    const row = db
      .prepare("SELECT joiner_identity_key FROM mp_invite_attributions LIMIT 1")
      .get() as { joiner_identity_key: string };
    expect(row.joiner_identity_key).toBe("u:user-joiner");
  });
});

// ---------------------------------------------------------------------------
// attributeJoin — every reject branch
// ---------------------------------------------------------------------------

describe("attributeJoin reject paths", () => {
  it("rejects when token is unknown", () => {
    const r = attributeJoin(
      db,
      {
        token: "doesnotexist",
        joiner: { playerId: "p", userId: null, visitorId: "v-j", ip: "2.2.2.2", fp: null },
      },
      NOW,
    );
    expect(r.status).toBe("rejected");
    if (r.status === "rejected") expect(r.reason).toBe("unknown_token");
  });

  it("rejects when token is revoked", () => {
    const { token } = mintHappy();
    revokeInviteToken(db, token, "v-host", NOW + 1);
    const r = attributeJoin(
      db,
      {
        token,
        joiner: { playerId: "p", userId: null, visitorId: "v-j", ip: "2.2.2.2", fp: null },
      },
      NOW + 5,
    );
    expect(r.status).toBe("rejected");
    if (r.status === "rejected") expect(r.reason).toBe("unknown_token");
  });

  it("rejects with ip_collision when joiner IP equals inviter IP", () => {
    const { token } = mintHappy();
    const r = attributeJoin(
      db,
      {
        token,
        joiner: { playerId: "p", userId: null, visitorId: "v-j", ip: "1.1.1.1", fp: null },
      },
      NOW + 1,
    );
    expect(r.status).toBe("rejected");
    if (r.status === "rejected") expect(r.reason).toBe("ip_collision");
  });

  it("rejects with self_invite when joiner visitor equals inviter visitor", () => {
    const { token } = mintHappy();
    const r = attributeJoin(
      db,
      {
        token,
        joiner: { playerId: "p", userId: null, visitorId: "v-host", ip: "9.9.9.9", fp: null },
      },
      NOW + 1,
    );
    expect(r.status).toBe("rejected");
    if (r.status === "rejected") expect(r.reason).toBe("self_invite");
  });

  it("rejects with new_account when the joiner account is younger than the gate", () => {
    seedAccount("fresh-user", NOW - INVITE_NEW_ACCOUNT_GATE_SECONDS + 30);
    const { token } = mintHappy();
    const r = attributeJoin(
      db,
      {
        token,
        joiner: {
          playerId: "p",
          userId: "fresh-user",
          visitorId: "v-j",
          ip: "2.2.2.2",
          fp: null,
        },
      },
      NOW + 1,
    );
    expect(r.status).toBe("rejected");
    if (r.status === "rejected") expect(r.reason).toBe("new_account");
  });

  it("rejects with pair_dedup when the same pair attempted within 30 days", () => {
    const { token } = mintHappy();
    // First attribution succeeds (pending).
    const first = attributeJoin(
      db,
      {
        token,
        joiner: {
          playerId: "p1",
          userId: null,
          visitorId: "v-j",
          ip: "2.2.2.2",
          fp: null,
        },
      },
      NOW + 60,
    );
    expect(first.status).toBe("pending");
    // Second attempt by the same joiner identity (different player session, same visitor).
    const { token: t2 } = mintHappy(NOW + 120);
    const second = attributeJoin(
      db,
      {
        token: t2,
        joiner: {
          playerId: "p2",
          userId: null,
          visitorId: "v-j",
          ip: "3.3.3.3",
          fp: null,
        },
      },
      NOW + 200,
    );
    expect(second.status).toBe("rejected");
    if (second.status === "rejected") expect(second.reason).toBe("pair_dedup");
  });

  it("rejects with cap_weekly after the host has earned the weekly limit", () => {
    // Manually inject INVITE_HOST_WEEKLY_CAP earned attributions for v-host within the past week.
    const earnedTokens: string[] = [];
    for (let i = 0; i < INVITE_HOST_WEEKLY_CAP; i++) {
      const { token } = mintHappy(NOW - 1000 + i);
      earnedTokens.push(token);
    }
    const insertAttr = db.prepare(
      `INSERT INTO mp_invite_attributions
        (token, room_code, joiner_player_id, joiner_visitor_id, joiner_ip, joiner_identity_key, status, rounds_completed, created_at, earned_at)
       VALUES (?, 'ABCD', ?, ?, ?, ?, 'earned', 3, ?, ?)`,
    );
    // Space the earns across the past 7 days (one per day) so the weekly
    // cap is hit but the daily cap (any 24h window) is not — which lets
    // us isolate the weekly-cap branch from the daily one.
    const ONE_DAY = 86_400;
    for (let i = 0; i < INVITE_HOST_WEEKLY_CAP; i++) {
      const ago = (i + 1) * ONE_DAY + 100; // 1d, 2d, 3d, 4d, 5d ago
      insertAttr.run(
        earnedTokens[i],
        `pp${i}`,
        `v-jj${i}`,
        `9.9.9.${i}`,
        `v:v-jj${i}`,
        NOW - ago,
        NOW - ago,
      );
    }
    const { token } = mintHappy(NOW + 5);
    const r = attributeJoin(
      db,
      {
        token,
        joiner: {
          playerId: "fresh",
          userId: null,
          visitorId: "v-fresh",
          ip: "8.8.8.8",
          fp: null,
        },
      },
      NOW + 10,
    );
    expect(r.status).toBe("rejected");
    if (r.status === "rejected") expect(r.reason).toBe("cap_weekly");
  });

  it("rejects with cap_daily after the host has earned the daily limit", () => {
    // Daily and weekly caps share the same magnitude (5). Use a tighter window:
    // place 5 'earned' rows within the past 24h but spread the same set across
    // 7 days so the weekly cap doesn't fire first.
    const insertAttr = db.prepare(
      `INSERT INTO mp_invite_attributions
        (token, room_code, joiner_player_id, joiner_visitor_id, joiner_ip, joiner_identity_key, status, rounds_completed, created_at, earned_at)
       VALUES (?, 'ABCD', ?, ?, ?, ?, 'earned', 3, ?, ?)`,
    );
    // Drop 1 row per hour for INVITE_HOST_DAILY_CAP hours → all in last 24h.
    for (let i = 0; i < INVITE_HOST_DAILY_CAP; i++) {
      const { token } = mintHappy(NOW - 100 + i);
      insertAttr.run(
        token,
        `dp${i}`,
        `v-dj${i}`,
        `5.5.5.${i}`,
        `v:v-dj${i}`,
        NOW - 60 + i,
        NOW - 60 + i,
      );
    }
    const { token } = mintHappy(NOW + 5);
    const r = attributeJoin(
      db,
      {
        token,
        joiner: {
          playerId: "fresh",
          userId: null,
          visitorId: "v-fresh-d",
          ip: "8.8.8.9",
          fp: null,
        },
      },
      NOW + 10,
    );
    expect(r.status).toBe("rejected");
    // Daily must be checked before weekly so that a 24h burst surfaces the
    // tighter signal — otherwise abuse dashboards lose context. Assert the
    // exact reason.
    if (r.status === "rejected") expect(r.reason).toBe("cap_daily");
  });

  it("rejects with ip_throttle after INVITE_IP_DAILY_CAP earns from one joiner-IP", () => {
    const insertAttr = db.prepare(
      `INSERT INTO mp_invite_attributions
        (token, room_code, joiner_player_id, joiner_visitor_id, joiner_ip, joiner_identity_key, status, rounds_completed, created_at, earned_at)
       VALUES (?, 'ABCD', ?, ?, '4.4.4.4', ?, 'earned', 3, ?, ?)`,
    );
    for (let i = 0; i < INVITE_IP_DAILY_CAP; i++) {
      const { token } = mintHappy(NOW - 200 + i);
      insertAttr.run(
        token,
        `ip-p${i}`,
        `v-ipj${i}`,
        `v:v-ipj${i}`,
        NOW - 100 + i,
        NOW - 100 + i,
      );
    }
    const { token } = mintHappy(NOW + 5);
    const r = attributeJoin(
      db,
      {
        token,
        joiner: {
          playerId: "ip-fresh",
          userId: null,
          visitorId: "v-ip-fresh",
          ip: "4.4.4.4", // same as the cap-busting cohort
          fp: null,
        },
      },
      NOW + 10,
    );
    expect(r.status).toBe("rejected");
    if (r.status === "rejected") expect(r.reason).toBe("ip_throttle");
  });
});

// ---------------------------------------------------------------------------
// recordRoundCompleted + buff issuance
// ---------------------------------------------------------------------------

describe("recordRoundCompleted", () => {
  function setupPending(): { token: string; attributionId: number } {
    const { token } = mintHappy();
    const r = attributeJoin(
      db,
      {
        token,
        joiner: {
          playerId: "p-joiner",
          userId: null,
          visitorId: "v-joiner",
          ip: "2.2.2.2",
          fp: null,
        },
      },
      NOW + 1,
    );
    if (r.status !== "pending") throw new Error("expected pending");
    return { token, attributionId: r.attributionId };
  }

  it("increments rounds_completed without issuing a buff before the threshold", () => {
    const { attributionId } = setupPending();
    for (let i = 0; i < INVITE_REWARD_TRIGGER_ROUNDS - 1; i++) {
      const out = recordRoundCompleted(
        db,
        { roomCode: "ABCD", joinerPlayerId: "p-joiner" },
        NOW + 100 + i,
      );
      expect(out.earned).toBe(false);
    }
    const row = db
      .prepare("SELECT status, rounds_completed FROM mp_invite_attributions WHERE id = ?")
      .get(attributionId) as { status: string; rounds_completed: number };
    expect(row.status).toBe("pending");
    expect(row.rounds_completed).toBe(INVITE_REWARD_TRIGGER_ROUNDS - 1);
    expect(
      db.prepare("SELECT COUNT(*) AS c FROM mp_pending_buffs").get(),
    ).toMatchObject({ c: 0 });
  });

  it("transitions to earned and issues 2 buffs at the trigger round", () => {
    const { attributionId } = setupPending();
    let earnedSeen = false;
    for (let i = 0; i < INVITE_REWARD_TRIGGER_ROUNDS; i++) {
      const out = recordRoundCompleted(
        db,
        { roomCode: "ABCD", joinerPlayerId: "p-joiner" },
        NOW + 100 + i,
      );
      if (i < INVITE_REWARD_TRIGGER_ROUNDS - 1) {
        expect(out.earned).toBe(false);
      } else {
        expect(out.earned).toBe(true);
        earnedSeen = true;
        expect(out.hostEvent?.multiplier).toBeCloseTo(INVITE_REWARD_HOST_MULTIPLIER);
        expect(out.hostEvent?.matchesRemaining).toBe(INVITE_REWARD_HOST_MATCHES);
        expect(out.joinerEvent?.multiplier).toBeCloseTo(INVITE_REWARD_JOINER_MULTIPLIER);
        expect(out.joinerEvent?.matchesRemaining).toBe(INVITE_REWARD_JOINER_MATCHES);
      }
    }
    expect(earnedSeen).toBe(true);
    const row = db
      .prepare("SELECT status, earned_at FROM mp_invite_attributions WHERE id = ?")
      .get(attributionId) as { status: string; earned_at: number | null };
    expect(row.status).toBe("earned");
    expect(row.earned_at).toBeGreaterThan(0);
    const buffs = db
      .prepare("SELECT source, multiplier, matches_remaining FROM mp_pending_buffs ORDER BY id")
      .all() as Array<{
        source: string;
        multiplier: number;
        matches_remaining: number;
      }>;
    expect(buffs).toHaveLength(2);
    const host = buffs.find((b) => b.source === "invite_host");
    const joiner = buffs.find((b) => b.source === "invite_joiner");
    expect(host).toBeDefined();
    expect(joiner).toBeDefined();
    expect(host!.multiplier).toBeCloseTo(INVITE_REWARD_HOST_MULTIPLIER);
    expect(host!.matches_remaining).toBe(INVITE_REWARD_HOST_MATCHES);
    expect(joiner!.multiplier).toBeCloseTo(INVITE_REWARD_JOINER_MULTIPLIER);
    expect(joiner!.matches_remaining).toBe(INVITE_REWARD_JOINER_MATCHES);
  });

  it("only issues the buff pair once even if more rounds tick after the threshold", () => {
    setupPending();
    for (let i = 0; i < INVITE_REWARD_TRIGGER_ROUNDS + 4; i++) {
      recordRoundCompleted(
        db,
        { roomCode: "ABCD", joinerPlayerId: "p-joiner" },
        NOW + 100 + i,
      );
    }
    const buffs = db
      .prepare("SELECT COUNT(*) AS c FROM mp_pending_buffs")
      .get() as { c: number };
    expect(buffs.c).toBe(2);
  });

  it("is a no-op for an unknown joiner (no pending row in this room)", () => {
    const out = recordRoundCompleted(
      db,
      { roomCode: "ABCD", joinerPlayerId: "ghost-player" },
      NOW + 100,
    );
    expect(out.earned).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// applyBuffs + getActiveBuffs
// ---------------------------------------------------------------------------

describe("applyBuffs", () => {
  function insertBuff(opts: {
    visitorId: string;
    multiplier: number;
    matches: number;
    expiresAt?: number;
  }): number {
    // mp_invite_attributions has a NOT NULL FK; use a stub attribution row.
    const { token } = mintHappy();
    const insAttr = db.prepare(
      `INSERT INTO mp_invite_attributions
        (token, room_code, joiner_player_id, joiner_visitor_id, joiner_ip, joiner_identity_key, status, rounds_completed, created_at, earned_at)
       VALUES (?, 'ABCD', 'p', ?, '0.0.0.0', ?, 'earned', 3, ?, ?)`,
    );
    const attrInfo = insAttr.run(
      token,
      `vstub-${opts.visitorId}`,
      `v:vstub-${opts.visitorId}`,
      NOW - 100,
      NOW - 100,
    );
    const ins = db.prepare(
      `INSERT INTO mp_pending_buffs
        (beneficiary_user_id, beneficiary_visitor_id, source, attribution_id, multiplier, matches_remaining, expires_at, created_at)
       VALUES (NULL, ?, 'invite_host', ?, ?, ?, ?, ?)`,
    );
    const info = ins.run(
      opts.visitorId,
      attrInfo.lastInsertRowid,
      opts.multiplier,
      opts.matches,
      opts.expiresAt ?? NOW + 86_400,
      NOW - 50,
    );
    return Number(info.lastInsertRowid);
  }

  it("returns the raw score unchanged and applied=null when no buff exists", () => {
    const r = applyBuffs(
      db,
      { rawScore: 1000, beneficiaryUserId: null, beneficiaryVisitorId: "v-noone" },
      NOW + 10,
    );
    expect(r.finalScore).toBe(1000);
    expect(r.applied).toBeNull();
  });

  it("multiplies rawScore by the highest active multiplier and decrements matches", () => {
    const id = insertBuff({ visitorId: "v-bene", multiplier: 1.25, matches: 3 });
    const r = applyBuffs(
      db,
      { rawScore: 1000, beneficiaryUserId: null, beneficiaryVisitorId: "v-bene" },
      NOW + 10,
    );
    expect(r.finalScore).toBe(1250);
    expect(r.applied).toBeDefined();
    expect(r.applied!.matchesRemaining).toBe(2); // post-decrement value reported
    const row = db
      .prepare("SELECT matches_remaining FROM mp_pending_buffs WHERE id = ?")
      .get(id) as { matches_remaining: number };
    expect(row.matches_remaining).toBe(2);
  });

  it("deletes the buff row when matches_remaining reaches 0", () => {
    const id = insertBuff({ visitorId: "v-bene", multiplier: 1.25, matches: 1 });
    const r = applyBuffs(
      db,
      { rawScore: 800, beneficiaryUserId: null, beneficiaryVisitorId: "v-bene" },
      NOW + 10,
    );
    expect(r.finalScore).toBe(1000);
    const row = db
      .prepare("SELECT matches_remaining FROM mp_pending_buffs WHERE id = ?")
      .get(id);
    expect(row).toBeUndefined();
  });

  it("ignores expired buffs", () => {
    insertBuff({
      visitorId: "v-bene",
      multiplier: 1.5,
      matches: 5,
      expiresAt: NOW - 1, // expired
    });
    const r = applyBuffs(
      db,
      { rawScore: 1000, beneficiaryUserId: null, beneficiaryVisitorId: "v-bene" },
      NOW,
    );
    expect(r.finalScore).toBe(1000);
    expect(r.applied).toBeNull();
  });

  it("picks the highest multiplier when multiple are active (no stacking)", () => {
    insertBuff({ visitorId: "v-bene", multiplier: 1.10, matches: 1 });
    insertBuff({ visitorId: "v-bene", multiplier: 1.25, matches: 3 });
    const r = applyBuffs(
      db,
      { rawScore: 1000, beneficiaryUserId: null, beneficiaryVisitorId: "v-bene" },
      NOW + 5,
    );
    expect(r.finalScore).toBe(1250);
    // The 1.10 buff is untouched.
    const remaining = db
      .prepare("SELECT multiplier, matches_remaining FROM mp_pending_buffs ORDER BY multiplier")
      .all() as Array<{ multiplier: number; matches_remaining: number }>;
    expect(remaining).toHaveLength(2);
    const lower = remaining.find((b) => b.multiplier < 1.2)!;
    const higher = remaining.find((b) => b.multiplier > 1.2)!;
    expect(lower.matches_remaining).toBe(1); // unchanged
    expect(higher.matches_remaining).toBe(2); // decremented
  });

  it("rounds the final score to an integer", () => {
    insertBuff({ visitorId: "v-bene", multiplier: 1.25, matches: 1 });
    const r = applyBuffs(
      db,
      { rawScore: 333, beneficiaryUserId: null, beneficiaryVisitorId: "v-bene" },
      NOW + 10,
    );
    // 333 * 1.25 = 416.25 → 416 (Math.round)
    expect(Number.isInteger(r.finalScore)).toBe(true);
    expect(r.finalScore).toBe(416);
  });
});

describe("getActiveBuffs", () => {
  it("returns only non-expired buffs with matches_remaining > 0", () => {
    const insAttr = db.prepare(
      `INSERT INTO mp_invite_attributions
        (token, room_code, joiner_player_id, joiner_visitor_id, joiner_ip, joiner_identity_key, status, rounds_completed, created_at, earned_at)
       VALUES (?, 'ABCD', 'p', 'v', '0.0.0.0', 'v:v', 'earned', 3, ?, ?)`,
    );
    const { token } = mintHappy();
    const a = insAttr.run(token, NOW - 100, NOW - 100).lastInsertRowid;
    const ins = db.prepare(
      `INSERT INTO mp_pending_buffs
        (beneficiary_user_id, beneficiary_visitor_id, source, attribution_id, multiplier, matches_remaining, expires_at, created_at)
       VALUES (NULL, 'v-bene', 'invite_host', ?, 1.25, ?, ?, ?)`,
    );
    ins.run(a, 3, NOW + 86_400, NOW); // active
    ins.run(a, 0, NOW + 86_400, NOW); // exhausted
    ins.run(a, 2, NOW - 1, NOW - 86_400); // expired
    const list = getActiveBuffs(
      db,
      { beneficiaryUserId: null, beneficiaryVisitorId: "v-bene" },
      NOW,
    );
    expect(list).toHaveLength(1);
    expect(list[0].matchesRemaining).toBe(3);
  });
});

describe("grantPublicGameBuff", () => {
  function rowsForVisitor(visitorId: string): number {
    return (db
      .prepare(
        `SELECT COUNT(*) AS c FROM mp_pending_buffs
          WHERE source = 'public_game' AND beneficiary_visitor_id = ?`,
      )
      .get(visitorId) as { c: number }).c;
  }

  it("inserts a public_game buff for a guest with only a visitor id", () => {
    const ok = grantPublicGameBuff(
      db,
      { beneficiaryUserId: null, beneficiaryVisitorId: "guest-v" },
      NOW,
    );
    expect(ok).toBe(true);
    const list = getActiveBuffs(
      db,
      { beneficiaryUserId: null, beneficiaryVisitorId: "guest-v" },
      NOW,
    );
    expect(list).toHaveLength(1);
    expect(list[0].source).toBe("public_game");
    expect(list[0].multiplier).toBeCloseTo(PUBLIC_GAME_BUFF_MULTIPLIER);
    expect(list[0].matchesRemaining).toBe(PUBLIC_GAME_BUFF_MATCHES);
  });

  it("is idempotent — second call while a buff is still active is a no-op", () => {
    expect(
      grantPublicGameBuff(
        db,
        { beneficiaryUserId: null, beneficiaryVisitorId: "v-once" },
        NOW,
      ),
    ).toBe(true);
    expect(
      grantPublicGameBuff(
        db,
        { beneficiaryUserId: null, beneficiaryVisitorId: "v-once" },
        NOW,
      ),
    ).toBe(false);
    expect(rowsForVisitor("v-once")).toBe(1);
  });

  it("issues a fresh buff after the previous one is consumed", () => {
    grantPublicGameBuff(
      db,
      { beneficiaryUserId: null, beneficiaryVisitorId: "v-cycle" },
      NOW,
    );
    // Consume it.
    const result = applyBuffs(
      db,
      { rawScore: 100, beneficiaryUserId: null, beneficiaryVisitorId: "v-cycle" },
      NOW,
    );
    expect(result.applied?.source).toBe("public_game");
    // Now no active buff — second grant should land.
    const ok = grantPublicGameBuff(
      db,
      { beneficiaryUserId: null, beneficiaryVisitorId: "v-cycle" },
      NOW + 1,
    );
    expect(ok).toBe(true);
    expect(rowsForVisitor("v-cycle")).toBe(1); // old row was deleted by applyBuffs
  });

  it("treats two logged-in users with empty-string visitor as distinct", () => {
    // Regression: previously `?? ""` made every logged-in user with a
    // null visitor_id share the same dedup key, so the second grant was
    // silently skipped. Each user should now get their own buff via the
    // `u:<userId>` sentinel.
    expect(
      grantPublicGameBuff(
        db,
        { beneficiaryUserId: "user-A", beneficiaryVisitorId: "" },
        NOW,
      ),
    ).toBe(true);
    expect(
      grantPublicGameBuff(
        db,
        { beneficiaryUserId: "user-B", beneficiaryVisitorId: "" },
        NOW,
      ),
    ).toBe(true);
    const aBuffs = getActiveBuffs(
      db,
      { beneficiaryUserId: "user-A", beneficiaryVisitorId: "" },
      NOW,
    );
    const bBuffs = getActiveBuffs(
      db,
      { beneficiaryUserId: "user-B", beneficiaryVisitorId: "" },
      NOW,
    );
    expect(aBuffs).toHaveLength(1);
    expect(bBuffs).toHaveLength(1);
  });

  it("refuses to insert when neither identity is provided", () => {
    const ok = grantPublicGameBuff(
      db,
      { beneficiaryUserId: null, beneficiaryVisitorId: "" },
      NOW,
    );
    expect(ok).toBe(false);
    expect(
      (db
        .prepare("SELECT COUNT(*) AS c FROM mp_pending_buffs WHERE source = 'public_game'")
        .get() as { c: number }).c,
    ).toBe(0);
  });

  it("public_game buff is consumable by applyBuffs", () => {
    grantPublicGameBuff(
      db,
      { beneficiaryUserId: null, beneficiaryVisitorId: "consumer" },
      NOW,
    );
    const result = applyBuffs(
      db,
      { rawScore: 1000, beneficiaryUserId: null, beneficiaryVisitorId: "consumer" },
      NOW,
    );
    expect(result.applied).not.toBeNull();
    expect(result.applied?.source).toBe("public_game");
    expect(result.finalScore).toBe(Math.round(1000 * PUBLIC_GAME_BUFF_MULTIPLIER));
  });

  it("expires after INVITE_BUFF_TTL_SECONDS", () => {
    grantPublicGameBuff(
      db,
      { beneficiaryUserId: null, beneficiaryVisitorId: "expiry" },
      NOW,
    );
    const list = getActiveBuffs(
      db,
      { beneficiaryUserId: null, beneficiaryVisitorId: "expiry" },
      NOW + 14 * 24 * 60 * 60 + 1, // one second past TTL
    );
    expect(list).toHaveLength(0);
  });
});
