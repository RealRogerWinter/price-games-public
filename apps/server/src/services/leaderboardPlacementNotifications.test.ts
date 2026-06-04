import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Database as DatabaseType } from "better-sqlite3";
import { createTestDb, seedUser } from "../test/dbHelper";

// Mock web-push so sendPushToUser -> sendPushToSubscription doesn't make real HTTP calls.
const { mockSendNotification } = vi.hoisted(() => ({
  mockSendNotification: vi.fn().mockResolvedValue({ statusCode: 201 }),
}));
vi.mock("web-push", () => ({
  default: {
    setVapidDetails: vi.fn(),
    sendNotification: mockSendNotification,
  },
}));

import {
  getPeriodKey,
  getPeriodCutoff,
  getTopUsersForPeriod,
  claimLeaderboardPlacementSlot,
  evaluateLeaderboardPlacementPushes,
  evaluateLeaderboardPlacementEmails,
} from "./leaderboardPlacementNotifications";
import { saveSubscription, updatePreferences } from "./pushNotification";
import { updateEmailPreferences } from "./emailNotification";

let db: DatabaseType;
let userA: string;
let userB: string;
let userC: string;

const subFor = (suffix: string) => ({
  endpoint: `https://fcm.googleapis.com/fcm/send/test-${suffix}`,
  expirationTime: null,
  keys: { p256dh: `BNhJy2c7DX0K-${suffix}`, auth: `VqPr2F4P-${suffix}` },
});

beforeEach(() => {
  db = createTestDb();
  userA = seedUser(db, "alice", "alice@test.com");
  userB = seedUser(db, "bob", "bob@test.com");
  userC = seedUser(db, "carol", "carol@test.com");
  mockSendNotification.mockClear();
});

/** Insert a user_game_history row so the user appears in the leaderboard. */
function recordScore(userId: string, score: number, playedAt: string = new Date().toISOString().replace("T", " ").replace(/\.\d+Z$/, "")): void {
  db.prepare(
    `INSERT INTO user_game_history
       (user_id, game_type, game_mode, session_id, score, played_at)
     VALUES (?, 'sp', 'classic', ?, ?, ?)`,
  ).run(userId, `sess-${userId}-${score}-${playedAt}`, score, playedAt);
}

describe("getPeriodKey", () => {
  it("returns calendar-aligned UTC date for day", () => {
    const d = new Date(Date.UTC(2026, 3, 18, 15, 0, 0));
    expect(getPeriodKey("day", d)).toBe("2026-04-18");
  });
  it("returns YYYY-MM for month", () => {
    const d = new Date(Date.UTC(2026, 3, 18, 15, 0, 0));
    expect(getPeriodKey("month", d)).toBe("2026-04");
  });
  it("returns YYYY-Www for ISO week — Monday is start", () => {
    // 2026-04-13 is a Monday → ISO W16
    const monday = new Date(Date.UTC(2026, 3, 13, 0, 0, 0));
    expect(getPeriodKey("week", monday)).toBe("2026-W16");
    // Sunday of the same ISO week → still W16
    const sunday = new Date(Date.UTC(2026, 3, 19, 23, 59, 59));
    expect(getPeriodKey("week", sunday)).toBe("2026-W16");
    // Next Monday → W17
    const nextMonday = new Date(Date.UTC(2026, 3, 20, 0, 0, 0));
    expect(getPeriodKey("week", nextMonday)).toBe("2026-W17");
  });
});

describe("getPeriodCutoff", () => {
  const now = new Date(Date.UTC(2026, 3, 18, 15, 30, 0)); // Sat 2026-04-18 15:30 UTC
  it("returns UTC start of today for day", () => {
    expect(getPeriodCutoff("day", now)).toBe("2026-04-18 00:00:00");
  });
  it("returns UTC start of current month for month", () => {
    expect(getPeriodCutoff("month", now)).toBe("2026-04-01 00:00:00");
  });
  it("returns UTC start of current ISO week (Monday) for week", () => {
    // Saturday 2026-04-18 → Monday 2026-04-13
    expect(getPeriodCutoff("week", now)).toBe("2026-04-13 00:00:00");
  });
});

describe("getTopUsersForPeriod", () => {
  it("ranks users by summed score in the period with stable ordering", () => {
    recordScore(userA, 500);
    recordScore(userB, 1200);
    recordScore(userC, 800);
    const top = getTopUsersForPeriod(db, "day");
    expect(top.map((r) => r.user_id)).toEqual([userB, userC, userA]);
    expect(top.map((r) => r.rank)).toEqual([1, 2, 3]);
  });

  it("ignores plays that predate the period cutoff", () => {
    // Far past: older than a month ago
    recordScore(userA, 9999, "2025-01-01 00:00:00");
    // Today
    recordScore(userB, 100);
    const top = getTopUsersForPeriod(db, "day");
    expect(top).toHaveLength(1);
    expect(top[0].user_id).toBe(userB);
  });

  it("excludes inactive users", () => {
    db.prepare("UPDATE users SET is_active = 0 WHERE id = ?").run(userA);
    recordScore(userA, 9999);
    recordScore(userB, 900);
    recordScore(userC, 500);
    const top = getTopUsersForPeriod(db, "day");
    expect(top.map((r) => r.user_id)).toEqual([userB, userC]);
  });
});

describe("claimLeaderboardPlacementSlot", () => {
  it("returns true on first claim and persists the rank", () => {
    expect(claimLeaderboardPlacementSlot(db, userA, "day", "2026-04-18", 3)).toBe(true);
    const row = db
      .prepare("SELECT best_rank FROM leaderboard_placement_notifications WHERE user_id = ?")
      .get(userA) as { best_rank: number };
    expect(row.best_rank).toBe(3);
  });

  it("returns false when repeating the same or worse rank in the same bucket", () => {
    expect(claimLeaderboardPlacementSlot(db, userA, "day", "2026-04-18", 2)).toBe(true);
    expect(claimLeaderboardPlacementSlot(db, userA, "day", "2026-04-18", 2)).toBe(false);
    expect(claimLeaderboardPlacementSlot(db, userA, "day", "2026-04-18", 3)).toBe(false);
  });

  it("returns true when the rank strictly improves", () => {
    claimLeaderboardPlacementSlot(db, userA, "day", "2026-04-18", 3);
    expect(claimLeaderboardPlacementSlot(db, userA, "day", "2026-04-18", 1)).toBe(true);
    const row = db
      .prepare("SELECT best_rank FROM leaderboard_placement_notifications WHERE user_id = ?")
      .get(userA) as { best_rank: number };
    expect(row.best_rank).toBe(1);
  });

  it("keeps push and email buckets independent", () => {
    expect(claimLeaderboardPlacementSlot(db, userA, "day", "2026-04-18", 3)).toBe(true);
    // Email uses a `:email`-suffixed key — separate row, should succeed.
    expect(claimLeaderboardPlacementSlot(db, userA, "day", "2026-04-18:email", 3)).toBe(true);
  });
});

describe("evaluateLeaderboardPlacementPushes", () => {
  function enablePushForUser(userId: string): void {
    saveSubscription(db, userId, subFor(userId));
    updatePreferences(db, userId, {
      pushEnabled: true,
      leaderboardPlacement: true,
    });
  }

  it("sends a push to each top-3 user who has opted in", async () => {
    enablePushForUser(userA);
    enablePushForUser(userB);
    enablePushForUser(userC);
    recordScore(userA, 500);
    recordScore(userB, 1200);
    recordScore(userC, 800);

    const sent = await evaluateLeaderboardPlacementPushes(db);
    // 3 users × 3 periods (day/week/month all capture today's single row) = 9
    expect(sent).toBe(9);
    expect(mockSendNotification).toHaveBeenCalledTimes(9);
  });

  it("skips users with the leaderboard_placement toggle off", async () => {
    saveSubscription(db, userA, subFor("a"));
    updatePreferences(db, userA, {
      pushEnabled: true,
      leaderboardPlacement: false,
    });
    recordScore(userA, 1000);

    const sent = await evaluateLeaderboardPlacementPushes(db);
    expect(sent).toBe(0);
    expect(mockSendNotification).not.toHaveBeenCalled();
  });

  it("does not re-send for the same rank on a second tick", async () => {
    enablePushForUser(userA);
    recordScore(userA, 1000);

    await evaluateLeaderboardPlacementPushes(db);
    const firstCallCount = mockSendNotification.mock.calls.length;
    expect(firstCallCount).toBeGreaterThan(0);

    // Second tick with unchanged top 3 should send nothing new.
    await evaluateLeaderboardPlacementPushes(db);
    expect(mockSendNotification.mock.calls.length).toBe(firstCallCount);
  });

  it("re-sends when the rank improves within a bucket", async () => {
    enablePushForUser(userA);
    enablePushForUser(userB);
    // Start: B leads A.
    recordScore(userB, 2000);
    recordScore(userA, 500);
    await evaluateLeaderboardPlacementPushes(db);
    const afterFirst = mockSendNotification.mock.calls.length;

    // A surges ahead → was rank 2, now rank 1 → should re-fire.
    recordScore(userA, 5000);
    await evaluateLeaderboardPlacementPushes(db);
    expect(mockSendNotification.mock.calls.length).toBeGreaterThan(afterFirst);
  });
});

describe("evaluateLeaderboardPlacementEmails", () => {
  function enableEmailForUser(userId: string): void {
    updateEmailPreferences(db, userId, {
      emailEnabled: true,
      leaderboardPlacement: true,
    });
  }

  function enableTrigger(): void {
    // Seed a template + point the trigger config at it.
    const info = db
      .prepare(
        `INSERT INTO email_templates (name, type, subject_template, html_template, text_template, is_active)
         VALUES ('Leaderboard placement', 'leaderboard_placement', '#{{rank}} {{periodLabel}}', '<p>{{username}}</p>', 'text', 1)`,
      )
      .run();
    db.prepare(
      `UPDATE email_trigger_config SET is_enabled = 1, template_id = ? WHERE type = 'leaderboard_placement'`,
    ).run(info.lastInsertRowid as number);
  }

  it("returns 0 when the trigger is disabled", () => {
    enableEmailForUser(userA);
    recordScore(userA, 1000);
    expect(evaluateLeaderboardPlacementEmails(db)).toBe(0);
  });

  it("queues one scheduled email per top-3 user per period when opted in", () => {
    enableTrigger();
    enableEmailForUser(userA);
    recordScore(userA, 1000);

    const queued = evaluateLeaderboardPlacementEmails(db);
    // 1 user across 3 periods.
    expect(queued).toBe(3);
    const rows = db
      .prepare(`SELECT type, status FROM scheduled_emails WHERE user_id = ?`)
      .all(userA) as Array<{ type: string; status: string }>;
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.type === "leaderboard_placement" && r.status === "pending")).toBe(true);
  });

  it("skips users with the per-type email toggle off", () => {
    enableTrigger();
    recordScore(userA, 1000);
    // Master on but per-type off.
    updateEmailPreferences(db, userA, { emailEnabled: true, leaderboardPlacement: false });
    expect(evaluateLeaderboardPlacementEmails(db)).toBe(0);
  });

  it("does not re-queue for the same rank on a second tick", () => {
    enableTrigger();
    enableEmailForUser(userA);
    recordScore(userA, 1000);

    const first = evaluateLeaderboardPlacementEmails(db);
    expect(first).toBe(3);
    const second = evaluateLeaderboardPlacementEmails(db);
    expect(second).toBe(0);
  });
});
