/**
 * Tests for the admin referral analytics service.
 *
 * Covers summary KPIs, daily time-series, top-referrer leaderboard,
 * and rejection-reason breakdowns across configurable time windows.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { v4 as uuidv4 } from "uuid";
import type { Database as DatabaseType } from "better-sqlite3";
import { createTestDb, seedUser } from "../test/dbHelper";
import {
  getReferralSummary,
  getReferralDaily,
  getReferralTopReferrers,
  getRejectionBreakdown,
  getReferredUsersByReferrer,
} from "./adminReferrals";

let db: DatabaseType;

/**
 * Insert a referral row directly (bypassing IP/disposable-email logic) so
 * tests can construct any combination of status, reason, and createdAt.
 */
function insertReferral(opts: {
  referrerId: string;
  referredId: string;
  status: "pending" | "credited" | "rejected";
  rejectionReason?: string | null;
  createdAt: string;
  creditedAt?: string | null;
}): string {
  const id = uuidv4();
  const code = id.slice(0, 8).toUpperCase().replace(/-/g, "A");
  db.prepare(
    `INSERT INTO referrals
       (id, referrer_id, referred_id, referral_code, status, rejection_reason, created_at, credited_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    opts.referrerId,
    opts.referredId,
    code,
    opts.status,
    opts.rejectionReason ?? null,
    opts.createdAt,
    opts.creditedAt ?? (opts.status === "credited" ? opts.createdAt : null),
  );
  return id;
}

function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString();
}

beforeEach(() => {
  db = createTestDb();
});

// ── getReferralSummary ──────────────────────────────────────────────────────

describe("getReferralSummary", () => {
  it("returns all-zero summary for empty database", () => {
    const summary = getReferralSummary(db, "28d");
    expect(summary.total).toBe(0);
    expect(summary.credited).toBe(0);
    expect(summary.pending).toBe(0);
    expect(summary.rejected).toBe(0);
    expect(summary.conversionRate).toBe(0);
    expect(summary.uniqueReferrers).toBe(0);
  });

  it("aggregates referrals by status within window", () => {
    const a = seedUser(db, "alice", "alice@example.com");
    const b = seedUser(db, "bob", "bob@example.com");
    const c = seedUser(db, "carol", "carol@example.com");
    const d = seedUser(db, "dan", "dan@example.com");
    const e = seedUser(db, "eve", "eve@example.com");

    insertReferral({ referrerId: a, referredId: b, status: "credited", createdAt: isoDaysAgo(2) });
    insertReferral({ referrerId: a, referredId: c, status: "credited", createdAt: isoDaysAgo(5) });
    insertReferral({ referrerId: a, referredId: d, status: "pending", createdAt: isoDaysAgo(1) });
    insertReferral({
      referrerId: b,
      referredId: e,
      status: "rejected",
      rejectionReason: "ip_match",
      createdAt: isoDaysAgo(3),
    });

    const summary = getReferralSummary(db, "28d");
    expect(summary.total).toBe(4);
    expect(summary.credited).toBe(2);
    expect(summary.pending).toBe(1);
    expect(summary.rejected).toBe(1);
    expect(summary.conversionRate).toBeCloseTo(0.5, 5);
    expect(summary.uniqueReferrers).toBe(2);
    expect(summary.periodStart).not.toBeNull();
    expect(summary.periodEnd).toBeTruthy();
  });

  it("excludes referrals outside the window", () => {
    const a = seedUser(db, "alice", "alice@example.com");
    const b = seedUser(db, "bob", "bob@example.com");
    const c = seedUser(db, "carol", "carol@example.com");

    insertReferral({ referrerId: a, referredId: b, status: "credited", createdAt: isoDaysAgo(100) });
    insertReferral({ referrerId: a, referredId: c, status: "credited", createdAt: isoDaysAgo(2) });

    const sevenDay = getReferralSummary(db, "7d");
    expect(sevenDay.total).toBe(1);

    const all = getReferralSummary(db, "all");
    expect(all.total).toBe(2);
    expect(all.periodStart).toBeNull();
  });
});

// ── getReferralDaily ────────────────────────────────────────────────────────

describe("getReferralDaily", () => {
  it("returns a zero-filled series with correct length for the range", () => {
    const series = getReferralDaily(db, "7d");
    expect(series).toHaveLength(7);
    for (const point of series) {
      expect(point.created).toBe(0);
      expect(point.credited).toBe(0);
      expect(point.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("buckets counts by created_at and credited_at days", () => {
    const a = seedUser(db, "alice", "alice@example.com");
    const b = seedUser(db, "bob", "bob@example.com");
    const c = seedUser(db, "carol", "carol@example.com");

    insertReferral({ referrerId: a, referredId: b, status: "credited", createdAt: isoDaysAgo(2) });
    insertReferral({ referrerId: a, referredId: c, status: "pending", createdAt: isoDaysAgo(1) });

    const series = getReferralDaily(db, "7d");
    const totalCreated = series.reduce((s, p) => s + p.created, 0);
    const totalCredited = series.reduce((s, p) => s + p.credited, 0);
    expect(totalCreated).toBe(2);
    expect(totalCredited).toBe(1);
  });
});

// ── getReferralTopReferrers ─────────────────────────────────────────────────

describe("getReferralTopReferrers", () => {
  it("returns referrers ordered by credited count desc", () => {
    const a = seedUser(db, "alice", "alice@example.com");
    const b = seedUser(db, "bob", "bob@example.com");
    const c = seedUser(db, "carol", "carol@example.com");
    const d = seedUser(db, "dan", "dan@example.com");
    const e = seedUser(db, "eve", "eve@example.com");
    const f = seedUser(db, "frank", "frank@example.com");

    // bob has 2 credited; alice has 1 credited + 1 pending
    insertReferral({ referrerId: b, referredId: c, status: "credited", createdAt: isoDaysAgo(1) });
    insertReferral({ referrerId: b, referredId: d, status: "credited", createdAt: isoDaysAgo(1) });
    insertReferral({ referrerId: a, referredId: e, status: "credited", createdAt: isoDaysAgo(1) });
    insertReferral({ referrerId: a, referredId: f, status: "pending", createdAt: isoDaysAgo(1) });

    const top = getReferralTopReferrers(db, "28d", 10);
    expect(top.length).toBe(2);
    expect(top[0].username).toBe("bob");
    expect(top[0].credited).toBe(2);
    expect(top[0].total).toBe(2);
    expect(top[1].username).toBe("alice");
    expect(top[1].credited).toBe(1);
    expect(top[1].pending).toBe(1);
    expect(top[1].total).toBe(2);
  });

  it("clamps limit to [1, 100]", () => {
    const a = seedUser(db, "alice", "alice@example.com");
    const b = seedUser(db, "bob", "bob@example.com");
    insertReferral({ referrerId: a, referredId: b, status: "credited", createdAt: isoDaysAgo(1) });

    expect(getReferralTopReferrers(db, "28d", 0)).toHaveLength(1);
    expect(getReferralTopReferrers(db, "28d", 9999)).toHaveLength(1);
  });

  it("respects the time window", () => {
    const a = seedUser(db, "alice", "alice@example.com");
    const b = seedUser(db, "bob", "bob@example.com");
    insertReferral({ referrerId: a, referredId: b, status: "credited", createdAt: isoDaysAgo(100) });

    expect(getReferralTopReferrers(db, "7d", 10)).toHaveLength(0);
    expect(getReferralTopReferrers(db, "all", 10)).toHaveLength(1);
  });
});

// ── getRejectionBreakdown ───────────────────────────────────────────────────

describe("getRejectionBreakdown", () => {
  it("returns empty array when no rejections exist", () => {
    expect(getRejectionBreakdown(db, "28d")).toEqual([]);
  });

  it("groups rejections by reason and counts them", () => {
    const a = seedUser(db, "alice", "alice@example.com");
    const b = seedUser(db, "bob", "bob@example.com");
    const c = seedUser(db, "carol", "carol@example.com");
    const d = seedUser(db, "dan", "dan@example.com");
    const e = seedUser(db, "eve", "eve@example.com");

    insertReferral({
      referrerId: a,
      referredId: b,
      status: "rejected",
      rejectionReason: "ip_match",
      createdAt: isoDaysAgo(1),
    });
    insertReferral({
      referrerId: a,
      referredId: c,
      status: "rejected",
      rejectionReason: "ip_match",
      createdAt: isoDaysAgo(2),
    });
    insertReferral({
      referrerId: a,
      referredId: d,
      status: "rejected",
      rejectionReason: "disposable_email",
      createdAt: isoDaysAgo(3),
    });
    insertReferral({
      referrerId: a,
      referredId: e,
      status: "rejected",
      rejectionReason: null,
      createdAt: isoDaysAgo(4),
    });

    const breakdown = getRejectionBreakdown(db, "28d");
    const byReason = Object.fromEntries(breakdown.map((b) => [b.reason, b.count]));
    expect(byReason.ip_match).toBe(2);
    expect(byReason.disposable_email).toBe(1);
    expect(byReason.unknown).toBe(1);
  });
});

// ── getReferredUsersByReferrer ──────────────────────────────────────────────

describe("getReferredUsersByReferrer", () => {
  it("returns the referred-user list for a given referrer, newest first", () => {
    const a = seedUser(db, "alice", "alice@example.com");
    const b = seedUser(db, "bob", "bob@example.com");
    const c = seedUser(db, "carol", "carol@example.com");
    const d = seedUser(db, "dan", "dan@example.com");

    insertReferral({ referrerId: a, referredId: b, status: "credited", createdAt: isoDaysAgo(5) });
    insertReferral({ referrerId: a, referredId: c, status: "pending", createdAt: isoDaysAgo(1) });
    insertReferral({
      referrerId: a,
      referredId: d,
      status: "rejected",
      rejectionReason: "ip_match",
      createdAt: isoDaysAgo(10),
    });

    const rows = getReferredUsersByReferrer(db, a, "all");
    expect(rows).toHaveLength(3);
    // Newest first
    expect(rows[0].username).toBe("carol");
    expect(rows[0].status).toBe("pending");
    expect(rows[1].username).toBe("bob");
    expect(rows[1].status).toBe("credited");
    expect(rows[1].creditedAt).not.toBeNull();
    expect(rows[2].username).toBe("dan");
    expect(rows[2].status).toBe("rejected");
    expect(rows[2].rejectionReason).toBe("ip_match");
  });

  it("excludes referrals from other referrers", () => {
    const a = seedUser(db, "alice", "alice@example.com");
    const b = seedUser(db, "bob", "bob@example.com");
    const c = seedUser(db, "carol", "carol@example.com");
    const d = seedUser(db, "dan", "dan@example.com");

    insertReferral({ referrerId: a, referredId: c, status: "credited", createdAt: isoDaysAgo(1) });
    insertReferral({ referrerId: b, referredId: d, status: "credited", createdAt: isoDaysAgo(1) });

    const rows = getReferredUsersByReferrer(db, a, "all");
    expect(rows).toHaveLength(1);
    expect(rows[0].username).toBe("carol");
  });

  it("respects the time window", () => {
    const a = seedUser(db, "alice", "alice@example.com");
    const b = seedUser(db, "bob", "bob@example.com");
    const c = seedUser(db, "carol", "carol@example.com");

    insertReferral({ referrerId: a, referredId: b, status: "credited", createdAt: isoDaysAgo(100) });
    insertReferral({ referrerId: a, referredId: c, status: "credited", createdAt: isoDaysAgo(2) });

    expect(getReferredUsersByReferrer(db, a, "7d")).toHaveLength(1);
    expect(getReferredUsersByReferrer(db, a, "all")).toHaveLength(2);
  });

  it("returns empty array for unknown referrer", () => {
    expect(getReferredUsersByReferrer(db, "no-such-user", "all")).toEqual([]);
  });
});
