import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, seedUser } from "../test/dbHelper";
import type { Database as DatabaseType } from "better-sqlite3";
import { v4 as uuidv4 } from "uuid";
import {
  generateReferralCode,
  backfillReferralCodes,
  createPendingReferral,
  isDisposableEmail,
  creditReferralOnVerify,
  getReferralDashboard,
  getCreditedReferralCount,
} from "./referrals";

let db: DatabaseType;

beforeEach(() => {
  db = createTestDb();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Assign a referral code to a user directly (seedUser does not auto-generate one). */
function assignReferralCode(userId: string, code: string): void {
  db.prepare("UPDATE users SET referral_code = ? WHERE id = ?").run(code, userId);
}

/** Insert a user_session row for IP-matching tests. */
function insertSession(
  userId: string,
  ip: string,
  lastActiveAt?: string,
): void {
  const id = uuidv4();
  const now = lastActiveAt ?? new Date().toISOString();
  db.prepare(
    `INSERT INTO user_sessions (id, user_id, ip_address, user_agent, created_at, expires_at, last_active_at)
     VALUES (?, ?, ?, 'test-agent', ?, ?, ?)`,
  ).run(id, userId, ip, now, now, now);
}

/** Insert a referral record directly. */
function insertReferral(opts: {
  referrerId: string;
  referredId: string;
  code: string;
  status: string;
  rejectionReason?: string | null;
  referrerIp?: string | null;
  referredIp?: string | null;
  creditedAt?: string | null;
}): string {
  const id = uuidv4();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO referrals (id, referrer_id, referred_id, referral_code, status, rejection_reason, referrer_ip, referred_ip, created_at, credited_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    opts.referrerId,
    opts.referredId,
    opts.code,
    opts.status,
    opts.rejectionReason ?? null,
    opts.referrerIp ?? null,
    opts.referredIp ?? null,
    now,
    opts.creditedAt ?? null,
  );
  return id;
}

// ---------------------------------------------------------------------------
// generateReferralCode
// ---------------------------------------------------------------------------

describe("generateReferralCode", () => {
  const CHARSET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

  it("generates an 8-character code", () => {
    const code = generateReferralCode(db);
    expect(code).toHaveLength(8);
  });

  it("uses only characters from the allowed charset", () => {
    for (let i = 0; i < 20; i++) {
      const code = generateReferralCode(db);
      for (const ch of code) {
        expect(CHARSET).toContain(ch);
      }
    }
  });

  it("generates unique codes across multiple calls", () => {
    const codes = new Set<string>();
    for (let i = 0; i < 50; i++) {
      codes.add(generateReferralCode(db));
    }
    expect(codes.size).toBe(50);
  });

  it("does not contain ambiguous characters (I, O, 0, 1)", () => {
    for (let i = 0; i < 20; i++) {
      const code = generateReferralCode(db);
      expect(code).not.toMatch(/[IO01]/);
    }
  });
});

// ---------------------------------------------------------------------------
// backfillReferralCodes
// ---------------------------------------------------------------------------

describe("backfillReferralCodes", () => {
  it("assigns codes to users that have no referral code", () => {
    const userId1 = seedUser(db, "user1", "u1@example.com");
    const userId2 = seedUser(db, "user2", "u2@example.com");

    const count = backfillReferralCodes(db);
    expect(count).toBe(2);

    const row1 = db
      .prepare("SELECT referral_code FROM users WHERE id = ?")
      .get(userId1) as { referral_code: string | null };
    const row2 = db
      .prepare("SELECT referral_code FROM users WHERE id = ?")
      .get(userId2) as { referral_code: string | null };

    expect(row1.referral_code).toBeTruthy();
    expect(row2.referral_code).toBeTruthy();
    expect(row1.referral_code).not.toBe(row2.referral_code);
  });

  it("skips users that already have a referral code", () => {
    const userId1 = seedUser(db, "user1", "u1@example.com");
    assignReferralCode(userId1, "EXISTING");
    const userId2 = seedUser(db, "user2", "u2@example.com");

    const count = backfillReferralCodes(db);
    expect(count).toBe(1);

    const row1 = db
      .prepare("SELECT referral_code FROM users WHERE id = ?")
      .get(userId1) as { referral_code: string | null };
    expect(row1.referral_code).toBe("EXISTING");
  });

  it("returns 0 when all users already have codes", () => {
    const userId1 = seedUser(db, "user1", "u1@example.com");
    assignReferralCode(userId1, "CODE1111");

    const count = backfillReferralCodes(db);
    expect(count).toBe(0);
  });

  it("returns 0 when there are no users", () => {
    const count = backfillReferralCodes(db);
    expect(count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// createPendingReferral
// ---------------------------------------------------------------------------

describe("createPendingReferral", () => {
  let referrerId: string;
  let referredId: string;

  beforeEach(() => {
    referrerId = seedUser(db, "referrer", "referrer@example.com");
    assignReferralCode(referrerId, "REF12345");
    referredId = seedUser(db, "referred", "referred@example.com");
  });

  it("creates a pending referral and returns true", () => {
    const result = createPendingReferral(db, referredId, "REF12345", "10.0.0.2");
    expect(result).toBe(true);

    const row = db
      .prepare("SELECT * FROM referrals WHERE referred_id = ?")
      .get(referredId) as Record<string, unknown>;

    expect(row.referrer_id).toBe(referrerId);
    expect(row.referred_id).toBe(referredId);
    expect(row.referral_code).toBe("REF12345");
    expect(row.status).toBe("pending");
    expect(row.referred_ip).toBe("10.0.0.2");
  });

  it("stores the referrer IP from the most recent session", () => {
    insertSession(referrerId, "192.168.1.1", "2025-01-01T00:00:00Z");
    insertSession(referrerId, "192.168.1.2", "2025-06-01T00:00:00Z");

    createPendingReferral(db, referredId, "REF12345", "10.0.0.2");

    const row = db
      .prepare("SELECT referrer_ip FROM referrals WHERE referred_id = ?")
      .get(referredId) as { referrer_ip: string | null };
    expect(row.referrer_ip).toBe("192.168.1.2");
  });

  it("sets referrer_ip to null when no sessions exist", () => {
    createPendingReferral(db, referredId, "REF12345", "10.0.0.2");

    const row = db
      .prepare("SELECT referrer_ip FROM referrals WHERE referred_id = ?")
      .get(referredId) as { referrer_ip: string | null };
    expect(row.referrer_ip).toBeNull();
  });

  it("returns false for an invalid referral code", () => {
    const result = createPendingReferral(db, referredId, "INVALID1", "10.0.0.2");
    expect(result).toBe(false);

    const row = db
      .prepare("SELECT id FROM referrals WHERE referred_id = ?")
      .get(referredId);
    expect(row).toBeUndefined();
  });

  it("returns false for self-referral", () => {
    const result = createPendingReferral(db, referrerId, "REF12345", "10.0.0.1");
    expect(result).toBe(false);
  });

  it("returns false when referred user already has a referral", () => {
    createPendingReferral(db, referredId, "REF12345", "10.0.0.2");

    // Create a second referrer
    const secondReferrer = seedUser(db, "referrer2", "r2@example.com");
    assignReferralCode(secondReferrer, "REF2ABCD");

    const result = createPendingReferral(db, referredId, "REF2ABCD", "10.0.0.3");
    expect(result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isDisposableEmail
// ---------------------------------------------------------------------------

describe("isDisposableEmail", () => {
  it("returns false for well-known non-disposable domains", () => {
    expect(isDisposableEmail("user@gmail.com")).toBe(false);
    expect(isDisposableEmail("user@outlook.com")).toBe(false);
    expect(isDisposableEmail("user@yahoo.com")).toBe(false);
  });

  it("returns false when the email has no domain part", () => {
    expect(isDisposableEmail("nodomain")).toBe(false);
  });

  it("handles uppercase email addresses", () => {
    // The function lowercases the domain before lookup, so standard domains stay false
    expect(isDisposableEmail("USER@GMAIL.COM")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// creditReferralOnVerify
// ---------------------------------------------------------------------------

describe("creditReferralOnVerify", () => {
  let referrerId: string;
  let referredId: string;

  beforeEach(() => {
    referrerId = seedUser(db, "referrer", "referrer@example.com");
    assignReferralCode(referrerId, "REF12345");
    referredId = seedUser(db, "referred", "referred@example.com");
  });

  it("credits a pending referral with different IPs", () => {
    insertReferral({
      referrerId,
      referredId,
      code: "REF12345",
      status: "pending",
      referrerIp: "192.168.1.1",
      referredIp: "10.0.0.2",
    });

    creditReferralOnVerify(db, referredId);

    const row = db
      .prepare("SELECT status, credited_at FROM referrals WHERE referred_id = ?")
      .get(referredId) as { status: string; credited_at: string | null };
    expect(row.status).toBe("credited");
    expect(row.credited_at).toBeTruthy();
  });

  it("rejects a pending referral when IPs match", () => {
    insertReferral({
      referrerId,
      referredId,
      code: "REF12345",
      status: "pending",
      referrerIp: "192.168.1.1",
      referredIp: "192.168.1.1",
    });

    creditReferralOnVerify(db, referredId);

    const row = db
      .prepare("SELECT status, rejection_reason FROM referrals WHERE referred_id = ?")
      .get(referredId) as { status: string; rejection_reason: string | null };
    expect(row.status).toBe("rejected");
    expect(row.rejection_reason).toBe("ip_match");
  });

  it("does not reject when only one IP is set (referrer_ip is null)", () => {
    insertReferral({
      referrerId,
      referredId,
      code: "REF12345",
      status: "pending",
      referrerIp: null,
      referredIp: "10.0.0.2",
    });

    creditReferralOnVerify(db, referredId);

    const row = db
      .prepare("SELECT status FROM referrals WHERE referred_id = ?")
      .get(referredId) as { status: string };
    expect(row.status).toBe("credited");
  });

  it("does not reject when only one IP is set (referred_ip is null)", () => {
    insertReferral({
      referrerId,
      referredId,
      code: "REF12345",
      status: "pending",
      referrerIp: "192.168.1.1",
      referredIp: null,
    });

    creditReferralOnVerify(db, referredId);

    const row = db
      .prepare("SELECT status FROM referrals WHERE referred_id = ?")
      .get(referredId) as { status: string };
    expect(row.status).toBe("credited");
  });

  it("does nothing when there is no pending referral", () => {
    // No referral inserted — should not throw
    creditReferralOnVerify(db, referredId);

    const row = db
      .prepare("SELECT id FROM referrals WHERE referred_id = ?")
      .get(referredId);
    expect(row).toBeUndefined();
  });

  it("ignores referrals that are already credited", () => {
    const refId = insertReferral({
      referrerId,
      referredId,
      code: "REF12345",
      status: "credited",
      referrerIp: "192.168.1.1",
      referredIp: "10.0.0.2",
      creditedAt: "2025-01-01T00:00:00Z",
    });

    creditReferralOnVerify(db, referredId);

    // Status should remain credited (the function only looks for 'pending')
    const row = db
      .prepare("SELECT status FROM referrals WHERE id = ?")
      .get(refId) as { status: string };
    expect(row.status).toBe("credited");
  });

  it("ignores referrals that are already rejected", () => {
    const refId = insertReferral({
      referrerId,
      referredId,
      code: "REF12345",
      status: "rejected",
      rejectionReason: "ip_match",
      referrerIp: "192.168.1.1",
      referredIp: "192.168.1.1",
    });

    creditReferralOnVerify(db, referredId);

    const row = db
      .prepare("SELECT status FROM referrals WHERE id = ?")
      .get(refId) as { status: string };
    expect(row.status).toBe("rejected");
  });
});

// ---------------------------------------------------------------------------
// getReferralDashboard
// ---------------------------------------------------------------------------

describe("getReferralDashboard", () => {
  let referrerId: string;

  beforeEach(() => {
    referrerId = seedUser(db, "referrer", "referrer@example.com");
    assignReferralCode(referrerId, "DASH1234");
  });

  it("returns an empty dashboard when user has no referrals", () => {
    const dashboard = getReferralDashboard(db, referrerId);

    expect(dashboard.referralCode).toBe("DASH1234");
    expect(dashboard.referralUrl).toContain("/r/DASH1234");
    expect(dashboard.totalReferrals).toBe(0);
    expect(dashboard.creditedReferrals).toBe(0);
    expect(dashboard.pendingReferrals).toBe(0);
    expect(dashboard.referrals).toEqual([]);
    expect(dashboard.multiAccountWarning).toBe(false);
  });

  it("returns correct counts for mixed referral statuses", () => {
    const user1 = seedUser(db, "ref1", "ref1@example.com");
    const user2 = seedUser(db, "ref2", "ref2@example.com");
    const user3 = seedUser(db, "ref3", "ref3@example.com");

    insertReferral({
      referrerId,
      referredId: user1,
      code: "DASH1234",
      status: "credited",
      creditedAt: "2025-01-01T00:00:00Z",
    });
    insertReferral({
      referrerId,
      referredId: user2,
      code: "DASH1234",
      status: "pending",
    });
    insertReferral({
      referrerId,
      referredId: user3,
      code: "DASH1234",
      status: "rejected",
      rejectionReason: "ip_match",
    });

    const dashboard = getReferralDashboard(db, referrerId);

    expect(dashboard.totalReferrals).toBe(3);
    expect(dashboard.creditedReferrals).toBe(1);
    expect(dashboard.pendingReferrals).toBe(1);
    expect(dashboard.referrals).toHaveLength(3);
  });

  it("includes referral entries with correct fields", () => {
    const referred = seedUser(db, "invited", "invited@example.com");
    insertReferral({
      referrerId,
      referredId: referred,
      code: "DASH1234",
      status: "credited",
      creditedAt: "2025-06-15T12:00:00Z",
    });

    const dashboard = getReferralDashboard(db, referrerId);

    expect(dashboard.referrals).toHaveLength(1);
    const entry = dashboard.referrals[0];
    expect(entry.referredUsername).toBe("invited");
    expect(entry.status).toBe("credited");
    expect(entry.rejectionReason).toBeNull();
    expect(entry.creditedAt).toBe("2025-06-15T12:00:00Z");
    expect(entry.id).toBeTruthy();
    expect(entry.createdAt).toBeTruthy();
  });

  it("includes rejection reason for rejected referrals", () => {
    const referred = seedUser(db, "rejected_user", "rej@example.com");
    insertReferral({
      referrerId,
      referredId: referred,
      code: "DASH1234",
      status: "rejected",
      rejectionReason: "disposable_email",
    });

    const dashboard = getReferralDashboard(db, referrerId);
    expect(dashboard.referrals[0].rejectionReason).toBe("disposable_email");
  });

  it("orders referrals by created_at descending", () => {
    const user1 = seedUser(db, "early", "early@example.com");
    const user2 = seedUser(db, "late", "late@example.com");

    // Insert with explicit timestamps by inserting directly
    const id1 = uuidv4();
    const id2 = uuidv4();
    db.prepare(
      `INSERT INTO referrals (id, referrer_id, referred_id, referral_code, status, created_at)
       VALUES (?, ?, ?, 'DASH1234', 'pending', '2025-01-01T00:00:00Z')`,
    ).run(id1, referrerId, user1);
    db.prepare(
      `INSERT INTO referrals (id, referrer_id, referred_id, referral_code, status, created_at)
       VALUES (?, ?, ?, 'DASH1234', 'credited', '2025-06-01T00:00:00Z')`,
    ).run(id2, referrerId, user2);

    const dashboard = getReferralDashboard(db, referrerId);
    expect(dashboard.referrals[0].referredUsername).toBe("late");
    expect(dashboard.referrals[1].referredUsername).toBe("early");
  });

  it("detects multi-account when another user shares an IP", () => {
    const otherUser = seedUser(db, "other", "other@example.com");

    // Both users have sessions from the same IP
    insertSession(referrerId, "203.0.113.5");
    insertSession(otherUser, "203.0.113.5");

    const dashboard = getReferralDashboard(db, referrerId);
    expect(dashboard.multiAccountWarning).toBe(true);
  });

  it("does not flag multi-account when IPs are different", () => {
    const otherUser = seedUser(db, "other", "other@example.com");

    insertSession(referrerId, "203.0.113.5");
    insertSession(otherUser, "198.51.100.10");

    const dashboard = getReferralDashboard(db, referrerId);
    expect(dashboard.multiAccountWarning).toBe(false);
  });

  it("does not flag multi-account when user has no sessions", () => {
    const dashboard = getReferralDashboard(db, referrerId);
    expect(dashboard.multiAccountWarning).toBe(false);
  });

  it("returns empty referralCode when user has no code set", () => {
    const noCodeUser = seedUser(db, "nocode", "nocode@example.com");
    const dashboard = getReferralDashboard(db, noCodeUser);
    expect(dashboard.referralCode).toBe("");
  });
});

// ---------------------------------------------------------------------------
// getCreditedReferralCount
// ---------------------------------------------------------------------------

describe("getCreditedReferralCount", () => {
  let referrerId: string;

  beforeEach(() => {
    referrerId = seedUser(db, "referrer", "referrer@example.com");
    assignReferralCode(referrerId, "COUNT123");
  });

  it("returns 0 when user has no referrals", () => {
    expect(getCreditedReferralCount(db, referrerId)).toBe(0);
  });

  it("counts only credited referrals", () => {
    const user1 = seedUser(db, "c1", "c1@example.com");
    const user2 = seedUser(db, "c2", "c2@example.com");
    const user3 = seedUser(db, "c3", "c3@example.com");
    const user4 = seedUser(db, "c4", "c4@example.com");

    insertReferral({ referrerId, referredId: user1, code: "COUNT123", status: "credited", creditedAt: "2025-01-01T00:00:00Z" });
    insertReferral({ referrerId, referredId: user2, code: "COUNT123", status: "credited", creditedAt: "2025-02-01T00:00:00Z" });
    insertReferral({ referrerId, referredId: user3, code: "COUNT123", status: "pending" });
    insertReferral({ referrerId, referredId: user4, code: "COUNT123", status: "rejected", rejectionReason: "ip_match" });

    expect(getCreditedReferralCount(db, referrerId)).toBe(2);
  });

  it("does not count referrals where this user is the referred party", () => {
    const otherReferrer = seedUser(db, "other", "other@example.com");
    assignReferralCode(otherReferrer, "OTHER123");

    // referrerId was referred by otherReferrer — should not count
    insertReferral({
      referrerId: otherReferrer,
      referredId: referrerId,
      code: "OTHER123",
      status: "credited",
      creditedAt: "2025-01-01T00:00:00Z",
    });

    expect(getCreditedReferralCount(db, referrerId)).toBe(0);
  });

  it("returns correct count for a user with only credited referrals", () => {
    const user1 = seedUser(db, "r1", "r1@example.com");
    const user2 = seedUser(db, "r2", "r2@example.com");
    const user3 = seedUser(db, "r3", "r3@example.com");

    insertReferral({ referrerId, referredId: user1, code: "COUNT123", status: "credited", creditedAt: "2025-01-01T00:00:00Z" });
    insertReferral({ referrerId, referredId: user2, code: "COUNT123", status: "credited", creditedAt: "2025-02-01T00:00:00Z" });
    insertReferral({ referrerId, referredId: user3, code: "COUNT123", status: "credited", creditedAt: "2025-03-01T00:00:00Z" });

    expect(getCreditedReferralCount(db, referrerId)).toBe(3);
  });
});
