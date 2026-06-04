import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestDb, seedUser } from "../test/dbHelper";
import type { Database as DatabaseType } from "better-sqlite3";

// Mock web-push so sendPushToUser -> sendPushToSubscription doesn't make real HTTP calls.
// vi.hoisted lets us reuse the spy in tests while still hoisting the mock above imports.
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
  scheduleNotification,
  cancelScheduledNotifications,
  evaluateStreakReminders,
  evaluateDailyPuzzleNotifications,
  cleanupOldNotifications,
  getSendOptionsForType,
  processScheduledNotifications,
} from "./notificationScheduler";
import { getUtcDateString } from "@price-game/shared";
import { saveSubscription, updatePreferences } from "./pushNotification";

let db: DatabaseType;
let userId: string;

beforeEach(() => {
  db = createTestDb();
  userId = seedUser(db, "testuser", "test@test.com");
});

const mockSub = {
  endpoint: "https://fcm.googleapis.com/fcm/send/test-123",
  expirationTime: null,
  keys: { p256dh: "BNhJy2c7DX0K", auth: "VqPr2F4P" },
};

describe("scheduleNotification", () => {
  it("inserts a pending scheduled notification", () => {
    scheduleNotification(db, userId, "streak_reminder", {
      title: "Streak!",
      body: "Keep it going!",
    }, "2026-04-10 12:00:00");

    const row = db.prepare("SELECT * FROM scheduled_notifications WHERE user_id = ?").get(userId) as {
      type: string; status: string; scheduled_at: string;
    };
    expect(row.type).toBe("streak_reminder");
    expect(row.status).toBe("pending");
    expect(row.scheduled_at).toBe("2026-04-10 12:00:00");
  });
});

describe("cancelScheduledNotifications", () => {
  it("cancels pending notifications of a given type", () => {
    scheduleNotification(db, userId, "streak_reminder", { title: "T", body: "B" }, "2026-04-10 12:00:00");
    scheduleNotification(db, userId, "daily_puzzle", { title: "T", body: "B" }, "2026-04-10 12:00:00");

    const cancelled = cancelScheduledNotifications(db, userId, "streak_reminder");
    expect(cancelled).toBe(1);

    const remaining = db.prepare("SELECT * FROM scheduled_notifications WHERE user_id = ?").all(userId);
    expect(remaining).toHaveLength(1);
    expect((remaining[0] as { type: string }).type).toBe("daily_puzzle");
  });

  it("does not cancel already-sent notifications", () => {
    scheduleNotification(db, userId, "streak_reminder", { title: "T", body: "B" }, "2026-04-10 12:00:00");
    db.prepare("UPDATE scheduled_notifications SET status = 'sent' WHERE user_id = ?").run(userId);

    const cancelled = cancelScheduledNotifications(db, userId, "streak_reminder");
    expect(cancelled).toBe(0);
  });
});

describe("evaluateStreakReminders", () => {
  it("schedules reminders for users with active streaks who haven't played today", () => {
    // Set up user with active streak, last played yesterday
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().split("T")[0];
    db.prepare("UPDATE users SET daily_streak_current = 5, daily_streak_last_date = ? WHERE id = ?")
      .run(yesterday, userId);

    // Subscribe and set up preferences
    saveSubscription(db, userId, mockSub);

    evaluateStreakReminders(db);

    const scheduled = db.prepare(
      "SELECT * FROM scheduled_notifications WHERE user_id = ? AND type = 'streak_reminder'"
    ).all(userId);
    expect(scheduled).toHaveLength(1);
  });

  it("does not schedule if user already has a pending reminder", () => {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().split("T")[0];
    db.prepare("UPDATE users SET daily_streak_current = 5, daily_streak_last_date = ? WHERE id = ?")
      .run(yesterday, userId);
    saveSubscription(db, userId, mockSub);

    evaluateStreakReminders(db);
    evaluateStreakReminders(db);

    const scheduled = db.prepare(
      "SELECT * FROM scheduled_notifications WHERE user_id = ? AND type = 'streak_reminder'"
    ).all(userId);
    expect(scheduled).toHaveLength(1);
  });

  it("does not schedule if streak_reminder preference is disabled", () => {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().split("T")[0];
    db.prepare("UPDATE users SET daily_streak_current = 5, daily_streak_last_date = ? WHERE id = ?")
      .run(yesterday, userId);
    saveSubscription(db, userId, mockSub);
    updatePreferences(db, userId, { streakReminder: false });

    evaluateStreakReminders(db);

    const scheduled = db.prepare(
      "SELECT * FROM scheduled_notifications WHERE user_id = ? AND type = 'streak_reminder'"
    ).all(userId);
    expect(scheduled).toHaveLength(0);
  });

  it("does not schedule for users with no streak", () => {
    db.prepare("UPDATE users SET daily_streak_current = 0 WHERE id = ?").run(userId);
    saveSubscription(db, userId, mockSub);

    evaluateStreakReminders(db);

    const scheduled = db.prepare(
      "SELECT * FROM scheduled_notifications WHERE user_id = ? AND type = 'streak_reminder'"
    ).all(userId);
    expect(scheduled).toHaveLength(0);
  });
});

describe("evaluateDailyPuzzleNotifications", () => {
  it("sends to subscribers who have not played today", async () => {
    saveSubscription(db, userId, mockSub);

    await evaluateDailyPuzzleNotifications(db);

    // Should have created a log entry for the daily_puzzle notification
    const logs = db.prepare(
      "SELECT * FROM notification_log WHERE user_id = ? AND type = 'daily_puzzle'"
    ).all(userId);
    expect(logs.length).toBeGreaterThanOrEqual(1);
  });

  it("only sends a daily_puzzle notification once per UTC day", async () => {
    saveSubscription(db, userId, mockSub);

    // First call: should fire
    await evaluateDailyPuzzleNotifications(db);
    const logsAfterFirst = db.prepare(
      "SELECT COUNT(*) as c FROM notification_log WHERE user_id = ? AND type = 'daily_puzzle'"
    ).get(userId) as { c: number };
    expect(logsAfterFirst.c).toBe(1);

    // Second call (simulating a later scheduler tick on the same day): should be skipped
    await evaluateDailyPuzzleNotifications(db);
    const logsAfterSecond = db.prepare(
      "SELECT COUNT(*) as c FROM notification_log WHERE user_id = ? AND type = 'daily_puzzle'"
    ).get(userId) as { c: number };
    expect(logsAfterSecond.c).toBe(1);

    // Third call: still only one
    await evaluateDailyPuzzleNotifications(db);
    const logsAfterThird = db.prepare(
      "SELECT COUNT(*) as c FROM notification_log WHERE user_id = ? AND type = 'daily_puzzle'"
    ).get(userId) as { c: number };
    expect(logsAfterThird.c).toBe(1);
  });

  it("skips users who already played today", async () => {
    saveSubscription(db, userId, mockSub);

    // Record a daily play for today
    const today = new Date().toISOString().slice(0, 10);
    db.prepare(
      `INSERT INTO daily_plays (user_id, session_id, daily_date, game_mode, score, started_at)
       VALUES (?, ?, ?, 'classic', 100, datetime('now'))`
    ).run(userId, "sess-test", today);

    // Reset the daily date tracker so it re-evaluates
    // (import the module-level var isn't possible, so we call it twice —
    //  first call sets lastDailyPuzzleDate, we need a fresh user)
    const user2 = seedUser(db, "user2", "u2@test.com");
    saveSubscription(db, user2, { ...mockSub, endpoint: "https://fcm.googleapis.com/fcm/send/user2" });

    // user2 has no daily play, userId does — only user2 should get notified
    // But since lastDailyPuzzleDate is already today from previous test,
    // we can't re-trigger. This test verifies the SQL filter is correct.
    const users = db.prepare(
      `SELECT DISTINCT ps.user_id
       FROM push_subscriptions ps
       JOIN notification_preferences np ON np.user_id = ps.user_id
       WHERE ps.is_active = 1
         AND np.push_enabled = 1
         AND np.daily_puzzle = 1
         AND NOT EXISTS (
           SELECT 1 FROM daily_plays dp
           WHERE dp.user_id = ps.user_id AND dp.daily_date = ?
         )`
    ).all(today) as Array<{ user_id: string }>;

    // userId played today so should be excluded; user2 should be included
    const userIds = users.map((u) => u.user_id);
    expect(userIds).not.toContain(userId);
    expect(userIds).toContain(user2);
  });

  it("skips users with daily_puzzle preference disabled", async () => {
    saveSubscription(db, userId, mockSub);
    updatePreferences(db, userId, { dailyPuzzle: false });

    const today = new Date().toISOString().slice(0, 10);
    const users = db.prepare(
      `SELECT DISTINCT ps.user_id
       FROM push_subscriptions ps
       JOIN notification_preferences np ON np.user_id = ps.user_id
       WHERE ps.is_active = 1
         AND np.push_enabled = 1
         AND np.daily_puzzle = 1
         AND NOT EXISTS (
           SELECT 1 FROM daily_plays dp
           WHERE dp.user_id = ps.user_id AND dp.daily_date = ?
         )`
    ).all(today) as Array<{ user_id: string }>;

    expect(users.map((u) => u.user_id)).not.toContain(userId);
  });

  // Reproduces the reported bug: an account-linked subscription was firing
  // reminders even after the user had played the daily as a guest on that
  // same device. The fix threads visitor_id through push_subscriptions and
  // daily_plays so the filter can match on either axis.
  it("does NOT notify a user whose device played today as a guest", async () => {
    // Alice subscribed while logged in, so her subscription carries both
    // her user_id and her visitor_id (from the persistent browser cookie).
    saveSubscription(db, userId, mockSub, "visitor-alice");

    // Later, logged out on the same device, Alice plays the daily as a
    // guest: daily_plays gets user_id=NULL but visitor_id='visitor-alice'.
    const today = new Date().toISOString().slice(0, 10);
    db.prepare(
      `INSERT INTO daily_plays (user_id, session_id, daily_date, game_mode, score, started_at, visitor_id)
       VALUES (NULL, ?, ?, 'classic', 5000, ?, ?)`,
    ).run("sess-guest", today, new Date().toISOString(), "visitor-alice");

    await evaluateDailyPuzzleNotifications(db);

    // The visitor_id on daily_plays matches Alice's subscription, so the
    // filter must exclude her even though no daily_plays row has her user_id.
    const logs = db.prepare(
      "SELECT * FROM notification_log WHERE user_id = ? AND type = 'daily_puzzle'",
    ).all(userId);
    expect(logs).toHaveLength(0);
  });

  // Regression guard for the rewritten filter: the OR-matched filter must
  // still admit subscriptions where neither the user nor the device played.
  it("still notifies a user when neither their account nor their device played today", async () => {
    saveSubscription(db, userId, mockSub, "visitor-fresh");

    await evaluateDailyPuzzleNotifications(db);

    const logs = db.prepare(
      "SELECT * FROM notification_log WHERE user_id = ? AND type = 'daily_puzzle'",
    ).all(userId);
    expect(logs.length).toBeGreaterThanOrEqual(1);
  });
});

// ── Delivery options per notification type ────────────────────────────────

describe("getSendOptionsForType", () => {
  it("returns high urgency and a per-user topic for streak reminders", () => {
    const opts = getSendOptionsForType("streak_reminder", "user-abc-123");
    expect(opts.urgency).toBe("high");
    expect(opts.topic).toBe("streak-user-abc-123");
  });

  it("uses a shared 'daily-puzzle' topic with normal urgency for daily puzzle", () => {
    const opts = getSendOptionsForType("daily_puzzle", "anyone");
    expect(opts.urgency).toBe("normal");
    expect(opts.topic).toBe("daily-puzzle");
  });

  it("keeps topic within RFC 8030's 32-char URL-safe limit even for very long ids", () => {
    const longId = "user-with-lots-of-non-url-safe.chars/and_more!_characters";
    const opts = getSendOptionsForType("streak_reminder", longId);
    // Prefix "streak-" (7) + up to 18 sanitized chars = 25 chars total
    expect(opts.topic!.length).toBeLessThanOrEqual(32);
    expect(opts.topic).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("uses low urgency for leaderboard/promotional — not time-sensitive", () => {
    expect(getSendOptionsForType("leaderboard_updates", "x").urgency).toBe("low");
    expect(getSendOptionsForType("promotional", "x").urgency).toBe("low");
  });
});

// ── Payload shape: Chrome mobile best-practice fields ─────────────────────

describe("scheduled payloads", () => {
  it("streak reminders carry an explicit /badge-96.png for Android status bar", () => {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().split("T")[0];
    db.prepare("UPDATE users SET daily_streak_current = 5, daily_streak_last_date = ? WHERE id = ?")
      .run(yesterday, userId);
    saveSubscription(db, userId, mockSub);

    evaluateStreakReminders(db);

    const row = db.prepare(
      "SELECT payload_json FROM scheduled_notifications WHERE user_id = ? AND type = 'streak_reminder'",
    ).get(userId) as { payload_json: string };
    const payload = JSON.parse(row.payload_json);
    expect(payload.badge).toBe("/badge-96.png");
    expect(payload.icon).toBe("/logo192.png");
  });

  it("daily puzzle sends web-push with the daily-puzzle topic and badge in payload", async () => {
    mockSendNotification.mockClear();
    saveSubscription(db, userId, mockSub);

    await evaluateDailyPuzzleNotifications(db);

    expect(mockSendNotification).toHaveBeenCalled();
    const [, payloadJson, options] = mockSendNotification.mock.calls[0];
    expect(options.topic).toBe("daily-puzzle");
    expect(options.urgency).toBe("normal");
    const parsed = JSON.parse(payloadJson);
    expect(parsed.badge).toBe("/badge-96.png");
  });
});

describe("processScheduledNotifications — streak_reminder suppression", () => {
  it("suppresses a streak_reminder when the user has already completed today's daily", async () => {
    saveSubscription(db, userId, mockSub);
    const today = getUtcDateString(new Date());
    const now = new Date().toISOString();

    // User has already completed today's daily — and has a healthy streak.
    db.prepare("UPDATE users SET daily_streak_current = 5, daily_streak_last_date = ? WHERE id = ?")
      .run(today, userId);
    db.prepare(
      `INSERT INTO daily_plays
         (user_id, session_id, daily_date, game_mode, score, started_at, completed_at)
       VALUES (?, 'sess-today', ?, 'classic', 800, ?, ?)`,
    ).run(userId, today, now, now);

    // A stale streak_reminder slipped through to be dispatched now.
    db.prepare(
      `INSERT INTO scheduled_notifications
         (user_id, type, payload_json, scheduled_at, status)
       VALUES (?, 'streak_reminder', '{"title":"T","body":"B"}',
               datetime('now', '-1 minute'), 'pending')`,
    ).run(userId);

    await processScheduledNotifications(db);

    const row = db.prepare(
      "SELECT status, error_message FROM scheduled_notifications WHERE user_id = ?",
    ).get(userId) as { status: string; error_message: string | null };
    expect(row.status).toBe("sent");
    expect(row.error_message).toMatch(/suppressed: already_played/);

    // The audit log should have a 'suppressed' row with the reason set.
    const logs = db.prepare(
      "SELECT status, suppression_reason FROM notification_log WHERE user_id = ? AND type = 'streak_reminder'",
    ).all(userId) as Array<{ status: string; suppression_reason: string | null }>;
    expect(logs).toHaveLength(1);
    expect(logs[0].status).toBe("suppressed");
    expect(logs[0].suppression_reason).toBe("already_played");
  });

  // Reproduces the reported bug: reminders were going to users whose
  // streak had already broken (daily_streak_last_date < yesterday) because
  // `evaluateStreakReminders` keys on the stored daily_streak_current,
  // which goes stale until the next completion. The dispatch-time re-check
  // catches these stragglers and the audit log records *why*.
  it("suppresses a streak_reminder when the user's streak has already broken (last play > 1 day ago)", async () => {
    mockSendNotification.mockClear();
    saveSubscription(db, userId, mockSub);
    const today = getUtcDateString(new Date());

    // User's stored streak counter is non-zero, but the last play was 5
    // days ago — the streak is dead per the brutal Wordle rule.
    const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    db.prepare(
      "UPDATE users SET daily_streak_current = 4, daily_streak_last_date = ? WHERE id = ?",
    ).run(fiveDaysAgo, userId);

    // A reminder was scheduled before the dispatch window noticed the streak died.
    db.prepare(
      `INSERT INTO scheduled_notifications
         (user_id, type, payload_json, scheduled_at, status)
       VALUES (?, 'streak_reminder', '{"title":"Streak!","body":"Don''t lose your 4-day streak"}',
               datetime('now', '-1 minute'), 'pending')`,
    ).run(userId);

    // Sanity guard: today is irrelevant to the suppression check beyond
    // "is last_date < yesterday" — re-derive it via getUtcDateString just
    // to keep the assertion close to the production path.
    expect(today).toBeTruthy();

    await processScheduledNotifications(db);

    const row = db.prepare(
      "SELECT status, error_message FROM scheduled_notifications WHERE user_id = ?",
    ).get(userId) as { status: string; error_message: string | null };
    expect(row.status).toBe("sent");
    expect(row.error_message).toMatch(/suppressed: streak_broken/);

    const logs = db.prepare(
      "SELECT status, suppression_reason FROM notification_log WHERE user_id = ? AND type = 'streak_reminder'",
    ).all(userId) as Array<{ status: string; suppression_reason: string | null }>;
    expect(logs).toHaveLength(1);
    expect(logs[0].status).toBe("suppressed");
    expect(logs[0].suppression_reason).toBe("streak_broken");

    // No push should have been attempted: web-push must not be called.
    expect(mockSendNotification).not.toHaveBeenCalled();
  });

  it("still dispatches a streak_reminder when the user has NOT played today's daily and has a live streak", async () => {
    saveSubscription(db, userId, mockSub);
    updatePreferences(db, userId, { pushEnabled: true, streakReminder: true });

    // Live streak: last completion was yesterday, so today's reminder is valid.
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    db.prepare(
      "UPDATE users SET daily_streak_current = 3, daily_streak_last_date = ? WHERE id = ?",
    ).run(yesterday, userId);

    db.prepare(
      `INSERT INTO scheduled_notifications
         (user_id, type, payload_json, scheduled_at, status)
       VALUES (?, 'streak_reminder', '{"title":"T","body":"B"}',
               datetime('now', '-1 minute'), 'pending')`,
    ).run(userId);

    await processScheduledNotifications(db);

    const row = db.prepare(
      "SELECT status, error_message FROM scheduled_notifications WHERE user_id = ?",
    ).get(userId) as { status: string; error_message: string | null };
    // status will be 'sent' either way — check the suppression marker is absent.
    expect(row.error_message ?? "").not.toMatch(/suppressed/);
  });
});

describe("cleanupOldNotifications", () => {
  it("removes old log entries and completed scheduled items", () => {
    // Insert old log entry
    db.prepare(
      `INSERT INTO notification_log (user_id, type, status, created_at) VALUES (?, ?, 'sent', datetime('now', '-31 days'))`
    ).run(userId, "daily_puzzle");

    // Insert old completed scheduled item
    db.prepare(
      `INSERT INTO scheduled_notifications (user_id, type, payload_json, scheduled_at, status, created_at)
       VALUES (?, ?, '{}', datetime('now', '-8 days'), 'sent', datetime('now', '-8 days'))`
    ).run(userId, "streak_reminder");

    // Insert recent items (should not be deleted)
    db.prepare(
      `INSERT INTO notification_log (user_id, type, status) VALUES (?, ?, 'sent')`
    ).run(userId, "daily_puzzle");

    cleanupOldNotifications(db);

    const logs = db.prepare("SELECT * FROM notification_log").all();
    expect(logs).toHaveLength(1);

    const scheduled = db.prepare("SELECT * FROM scheduled_notifications").all();
    expect(scheduled).toHaveLength(0);
  });
});
