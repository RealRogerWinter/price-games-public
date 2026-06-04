import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestDb, seedUser } from "../test/dbHelper";
import type { Database as DatabaseType } from "better-sqlite3";

// Mock web-push before importing the module so the VAPID setup + sendNotification
// calls are observable without making real HTTP requests. vi.hoisted lets us
// declare the spy outside the factory while still getting it hoisted with the mock.
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
  saveSubscription,
  removeSubscription,
  deactivateSubscription,
  getActiveSubscriptions,
  getSubscriberCounts,
  getPreferences,
  updatePreferences,
  listTemplates,
  getTemplate,
  createTemplate,
  updateTemplate,
  deleteTemplate,
  renderTemplate,
  recordClick,
  getNotificationStats,
  getNotificationLog,
  relinkPushSubscriptionsForVisitor,
  sendPushToSubscription,
  sendPushToUser,
} from "./pushNotification";

let db: DatabaseType;
let userId: string;

beforeEach(() => {
  db = createTestDb();
  userId = seedUser(db, "testuser", "test@test.com");
});

const mockSubscription = {
  endpoint: "https://fcm.googleapis.com/fcm/send/test-123",
  expirationTime: null,
  keys: {
    p256dh: "BNhJy2c7DX0KZQKY1L7Hx2aF0LnW0v2xQy",
    auth: "VqPr2F4P_12345",
  },
};

// ── Subscription CRUD ─────────────────────────────────────────────────────

describe("saveSubscription", () => {
  it("saves a new subscription and creates default preferences", () => {
    saveSubscription(db, userId, mockSubscription, null, "TestAgent/1.0");

    const subs = getActiveSubscriptions(db, userId);
    expect(subs).toHaveLength(1);
    expect(subs[0].endpoint).toBe(mockSubscription.endpoint);
    expect(subs[0].p256dh).toBe(mockSubscription.keys.p256dh);
    expect(subs[0].auth).toBe(mockSubscription.keys.auth);
    expect(subs[0].user_agent).toBe("TestAgent/1.0");

    // Preferences should be auto-created
    const prefs = getPreferences(db, userId);
    expect(prefs.pushEnabled).toBe(true);
    expect(prefs.dailyPuzzle).toBe(true);
  });

  it("upserts on duplicate endpoint", () => {
    saveSubscription(db, userId, mockSubscription);
    const updatedSub = { ...mockSubscription, keys: { ...mockSubscription.keys, auth: "new-auth" } };
    saveSubscription(db, userId, updatedSub);

    const subs = getActiveSubscriptions(db, userId);
    expect(subs).toHaveLength(1);
    expect(subs[0].auth).toBe("new-auth");
  });

  it("reactivates a deactivated subscription on re-subscribe", () => {
    saveSubscription(db, userId, mockSubscription);
    deactivateSubscription(db, mockSubscription.endpoint);
    expect(getActiveSubscriptions(db, userId)).toHaveLength(0);

    saveSubscription(db, userId, mockSubscription);
    expect(getActiveSubscriptions(db, userId)).toHaveLength(1);
  });

  // Device-aware notifications: the subscription must carry the browser's
  // persistent visitor_id so the scheduler can filter on it.
  it("persists visitor_id on new subscriptions", () => {
    saveSubscription(db, userId, mockSubscription, "visitor-xyz");
    const row = db
      .prepare("SELECT visitor_id FROM push_subscriptions WHERE endpoint = ?")
      .get(mockSubscription.endpoint) as { visitor_id: string | null };
    expect(row.visitor_id).toBe("visitor-xyz");
  });

  // Browsers can re-sync a subscription after the visitor_id cookie rotates
  // (cache clear, new profile, etc.). The upsert must refresh visitor_id so
  // it always reflects the current browser identity.
  it("updates visitor_id on ON CONFLICT upsert", () => {
    saveSubscription(db, userId, mockSubscription, "visitor-old");
    saveSubscription(db, userId, mockSubscription, "visitor-new");
    const row = db
      .prepare("SELECT visitor_id FROM push_subscriptions WHERE endpoint = ?")
      .get(mockSubscription.endpoint) as { visitor_id: string | null };
    expect(row.visitor_id).toBe("visitor-new");
  });
});

describe("relinkPushSubscriptionsForVisitor", () => {
  it("returns 0 and does nothing when visitor_id is undefined", () => {
    saveSubscription(db, userId, mockSubscription, "visitor-alice");
    const changes = relinkPushSubscriptionsForVisitor(db, undefined, "someone-else");
    expect(changes).toBe(0);

    // Subscription must still belong to the original user.
    const row = db
      .prepare("SELECT user_id FROM push_subscriptions WHERE endpoint = ?")
      .get(mockSubscription.endpoint) as { user_id: string };
    expect(row.user_id).toBe(userId);
  });

  it("returns 0 and does nothing when visitor_id is null", () => {
    saveSubscription(db, userId, mockSubscription, "visitor-alice");
    const changes = relinkPushSubscriptionsForVisitor(db, null, "someone-else");
    expect(changes).toBe(0);
  });

  it("is idempotent when the subscription already belongs to the target user", () => {
    saveSubscription(db, userId, mockSubscription, "visitor-alice");
    const changes = relinkPushSubscriptionsForVisitor(db, "visitor-alice", userId);
    // user_id IS NOT ? is false for the same user → 0 rows updated.
    expect(changes).toBe(0);
  });

  it("relinks a matching subscription to a new user_id", () => {
    const otherUser = seedUser(db, "other", "other@test.com");
    saveSubscription(db, userId, mockSubscription, "visitor-shared");
    const changes = relinkPushSubscriptionsForVisitor(db, "visitor-shared", otherUser);
    expect(changes).toBe(1);

    const row = db
      .prepare("SELECT user_id FROM push_subscriptions WHERE endpoint = ?")
      .get(mockSubscription.endpoint) as { user_id: string };
    expect(row.user_id).toBe(otherUser);
  });
});

describe("removeSubscription", () => {
  it("removes a subscription by endpoint", () => {
    saveSubscription(db, userId, mockSubscription);
    const removed = removeSubscription(db, userId, mockSubscription.endpoint);
    expect(removed).toBe(true);
    expect(getActiveSubscriptions(db, userId)).toHaveLength(0);
  });

  it("returns false if endpoint not found", () => {
    const removed = removeSubscription(db, userId, "https://nonexistent.com");
    expect(removed).toBe(false);
  });

  it("does not remove another user's subscription", () => {
    saveSubscription(db, userId, mockSubscription);
    const otherUser = seedUser(db, "other", "other@test.com");
    const removed = removeSubscription(db, otherUser, mockSubscription.endpoint);
    expect(removed).toBe(false);
    expect(getActiveSubscriptions(db, userId)).toHaveLength(1);
  });
});

describe("deactivateSubscription", () => {
  it("marks subscription as inactive", () => {
    saveSubscription(db, userId, mockSubscription);
    deactivateSubscription(db, mockSubscription.endpoint);
    expect(getActiveSubscriptions(db, userId)).toHaveLength(0);
  });
});

describe("getSubscriberCounts", () => {
  it("returns correct counts", () => {
    expect(getSubscriberCounts(db)).toEqual({ total: 0, active: 0 });

    saveSubscription(db, userId, mockSubscription);
    expect(getSubscriberCounts(db)).toEqual({ total: 1, active: 1 });

    deactivateSubscription(db, mockSubscription.endpoint);
    expect(getSubscriberCounts(db)).toEqual({ total: 1, active: 0 });
  });
});

// ── Preferences ─────────────────────────────────────────────────────────

describe("getPreferences", () => {
  it("returns defaults when no preferences exist", () => {
    const prefs = getPreferences(db, userId);
    expect(prefs.pushEnabled).toBe(true);
    expect(prefs.streakReminder).toBe(true);
    expect(prefs.promotional).toBe(false);
    expect(prefs.timezone).toBe("UTC");
  });
});

describe("updatePreferences", () => {
  it("updates specific preferences", () => {
    updatePreferences(db, userId, { promotional: true, timezone: "America/New_York" });
    const prefs = getPreferences(db, userId);
    expect(prefs.promotional).toBe(true);
    expect(prefs.timezone).toBe("America/New_York");
    // Other defaults unchanged
    expect(prefs.dailyPuzzle).toBe(true);
  });

  it("handles boolean toggle", () => {
    updatePreferences(db, userId, { pushEnabled: false });
    expect(getPreferences(db, userId).pushEnabled).toBe(false);
    updatePreferences(db, userId, { pushEnabled: true });
    expect(getPreferences(db, userId).pushEnabled).toBe(true);
  });

  it("handles quiet hours", () => {
    updatePreferences(db, userId, { quietHoursStart: "22:00", quietHoursEnd: "08:00" });
    const prefs = getPreferences(db, userId);
    expect(prefs.quietHoursStart).toBe("22:00");
    expect(prefs.quietHoursEnd).toBe("08:00");
  });
});

// ── Template CRUD ────────────────────────────────────────────────────────

describe("template CRUD", () => {
  it("creates and retrieves a template", () => {
    const template = createTemplate(db, {
      name: "Daily Reminder",
      type: "daily_puzzle",
      titleTemplate: "Daily Puzzle Ready!",
      bodyTemplate: "Play today's puzzle, {{userName}}!",
      urlPath: "/daily",
    });

    expect(template.id).toBeGreaterThan(0);
    expect(template.name).toBe("Daily Reminder");
    expect(template.type).toBe("daily_puzzle");
    expect(template.isActive).toBe(true);
    expect(template.urgency).toBe("normal");

    const fetched = getTemplate(db, template.id);
    expect(fetched).toEqual(template);
  });

  it("lists all templates", () => {
    createTemplate(db, { name: "t1", type: "daily_puzzle", titleTemplate: "T1", bodyTemplate: "B1" });
    createTemplate(db, { name: "t2", type: "streak_reminder", titleTemplate: "T2", bodyTemplate: "B2" });
    expect(listTemplates(db)).toHaveLength(2);
  });

  it("updates a template", () => {
    const t = createTemplate(db, { name: "orig", type: "daily_puzzle", titleTemplate: "T", bodyTemplate: "B" });
    const updated = updateTemplate(db, t.id, { name: "renamed", isActive: false });
    expect(updated?.name).toBe("renamed");
    expect(updated?.isActive).toBe(false);
  });

  it("deletes a template", () => {
    const t = createTemplate(db, { name: "del", type: "daily_puzzle", titleTemplate: "T", bodyTemplate: "B" });
    expect(deleteTemplate(db, t.id)).toBe(true);
    expect(getTemplate(db, t.id)).toBeUndefined();
  });

  it("rejects duplicate names", () => {
    createTemplate(db, { name: "dup", type: "daily_puzzle", titleTemplate: "T", bodyTemplate: "B" });
    expect(() => createTemplate(db, { name: "dup", type: "daily_puzzle", titleTemplate: "T", bodyTemplate: "B" })).toThrow();
  });
});

// ── Template rendering ──────────────────────────────────────────────────

describe("renderTemplate", () => {
  it("replaces variables", () => {
    expect(renderTemplate("Hello {{userName}}, streak: {{count}}!", { userName: "Alice", count: 5 }))
      .toBe("Hello Alice, streak: 5!");
  });

  it("preserves unknown variables", () => {
    expect(renderTemplate("{{known}} and {{unknown}}", { known: "yes" }))
      .toBe("yes and {{unknown}}");
  });
});

// ── Click tracking ──────────────────────────────────────────────────────

describe("recordClick", () => {
  it("records a click and returns the url", () => {
    db.prepare(
      `INSERT INTO notification_log (user_id, type, title, url_path, status) VALUES (?, ?, ?, ?, 'sent')`,
    ).run(userId, "daily_puzzle", "Test", "/daily");

    const logId = (db.prepare("SELECT last_insert_rowid() as id").get() as { id: number }).id;
    const url = recordClick(db, logId);
    expect(url).toBe("/daily");

    const row = db.prepare("SELECT status, clicked_at FROM notification_log WHERE id = ?").get(logId) as { status: string; clicked_at: string | null };
    expect(row.status).toBe("clicked");
    expect(row.clicked_at).not.toBeNull();
  });

  it("returns / for unknown log ID", () => {
    expect(recordClick(db, 99999)).toBe("/");
  });
});

// ── Analytics ───────────────────────────────────────────────────────────

describe("getNotificationStats", () => {
  it("returns zero stats for empty db", () => {
    const stats = getNotificationStats(db);
    expect(stats.totalSubscribers).toBe(0);
    expect(stats.totalSent).toBe(0);
    expect(stats.deliveryRate).toBe(0);
  });
});

describe("getNotificationLog", () => {
  it("returns paginated results", () => {
    for (let i = 0; i < 5; i++) {
      db.prepare(
        `INSERT INTO notification_log (user_id, type, title, status) VALUES (?, ?, ?, 'sent')`,
      ).run(userId, "daily_puzzle", `Notif ${i}`);
    }

    const result = getNotificationLog(db, { page: 1, limit: 3 });
    expect(result.entries).toHaveLength(3);
    expect(result.total).toBe(5);
  });

  it("filters by type", () => {
    db.prepare(`INSERT INTO notification_log (user_id, type, status) VALUES (?, ?, 'sent')`).run(userId, "daily_puzzle");
    db.prepare(`INSERT INTO notification_log (user_id, type, status) VALUES (?, ?, 'sent')`).run(userId, "streak_reminder");

    const result = getNotificationLog(db, { type: "daily_puzzle" });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].type).toBe("daily_puzzle");
  });

  it("joins on users to surface the recipient's username", () => {
    db.prepare(`INSERT INTO notification_log (user_id, type, status) VALUES (?, ?, 'sent')`).run(userId, "daily_puzzle");

    const result = getNotificationLog(db, {});
    expect(result.entries[0].userId).toBe(userId);
    expect(result.entries[0].username).toBe("testuser");
  });
});

// ── Send path: urgency / topic / TTL forwarding ───────────────────────────

describe("sendPushToSubscription", () => {
  beforeEach(() => {
    mockSendNotification.mockClear();
    mockSendNotification.mockResolvedValue({ statusCode: 201 });
  });

  it("forwards urgency, topic, and TTL options to web-push", async () => {
    saveSubscription(db, userId, mockSubscription);
    const [sub] = getActiveSubscriptions(db, userId);

    await sendPushToSubscription(
      db,
      sub,
      { title: "Hi", body: "Hello" },
      { urgency: "high", topic: "streak-user123", ttl: 1800 },
    );

    expect(mockSendNotification).toHaveBeenCalledTimes(1);
    const [, , options] = mockSendNotification.mock.calls[0];
    expect(options).toMatchObject({
      TTL: 1800,
      urgency: "high",
      topic: "streak-user123",
    });
  });

  it("defaults urgency to 'normal' and TTL to 3600 when not provided", async () => {
    saveSubscription(db, userId, mockSubscription);
    const [sub] = getActiveSubscriptions(db, userId);

    await sendPushToSubscription(db, sub, { title: "Hi", body: "Hello" });

    const [, , options] = mockSendNotification.mock.calls[0];
    expect(options.urgency).toBe("normal");
    expect(options.TTL).toBe(3600);
  });

  it("deactivates the subscription on 410 Gone", async () => {
    saveSubscription(db, userId, mockSubscription);
    const [sub] = getActiveSubscriptions(db, userId);

    mockSendNotification.mockRejectedValueOnce({ statusCode: 410, body: "gone" });

    const result = await sendPushToSubscription(db, sub, { title: "Hi", body: "Hello" });

    expect(result.success).toBe(false);
    expect(result.httpStatus).toBe(410);
    expect(getActiveSubscriptions(db, userId)).toHaveLength(0);
  });
});

describe("sendPushToUser", () => {
  beforeEach(() => {
    mockSendNotification.mockClear();
    mockSendNotification.mockResolvedValue({ statusCode: 201 });
  });

  it("threads urgency and topic through to web-push", async () => {
    saveSubscription(db, userId, mockSubscription);

    const count = await sendPushToUser(
      db,
      userId,
      "streak_reminder",
      { title: "Streak!", body: "Don't break it", badge: "/badge-96.png" },
      { urgency: "high", topic: "streak-abc" },
    );

    expect(count).toBe(1);
    const [subscription, payloadJson, options] = mockSendNotification.mock.calls[0];
    expect(subscription.endpoint).toBe(mockSubscription.endpoint);
    expect(options.urgency).toBe("high");
    expect(options.topic).toBe("streak-abc");
    // payload is JSON-stringified — confirm badge survives the serialization
    const parsed = JSON.parse(payloadJson);
    expect(parsed.badge).toBe("/badge-96.png");
  });

  it("skips the user entirely when push_enabled is false", async () => {
    saveSubscription(db, userId, mockSubscription);
    updatePreferences(db, userId, { pushEnabled: false });

    const count = await sendPushToUser(db, userId, "daily_puzzle", { title: "x", body: "y" });

    expect(count).toBe(0);
    expect(mockSendNotification).not.toHaveBeenCalled();
  });

  it("UTM-tags the payload URL before storing it on notification_log", async () => {
    saveSubscription(db, userId, mockSubscription);

    await sendPushToUser(db, userId, "daily_puzzle", {
      title: "Today's puzzle",
      body: "Play now",
      url: "/daily",
    });

    const logRow = db
      .prepare(`SELECT url_path FROM notification_log WHERE user_id = ? ORDER BY id DESC LIMIT 1`)
      .get(userId) as { url_path: string };
    expect(logRow.url_path).toContain("/daily");
    expect(logRow.url_path).toContain("utm_source=push");
    expect(logRow.url_path).toContain("utm_medium=web_push");
    expect(logRow.url_path).toContain("utm_campaign=daily_puzzle");
  });

  it("wraps the tagged URL inside the click tracker before sending to web-push", async () => {
    saveSubscription(db, userId, mockSubscription);

    await sendPushToUser(db, userId, "streak_reminder", {
      title: "Streak",
      body: "Don't break it",
      url: "/",
    });

    const payloadJson = mockSendNotification.mock.calls[0]![1];
    const parsed = JSON.parse(payloadJson);
    // The SW receives /api/push/click/<logId>?r=<encoded-tagged-url>
    expect(parsed.url).toMatch(/^\/api\/push\/click\/\d+\?r=/);
    // The encoded tail must contain the UTMs from the streak_reminder origin.
    const decoded = decodeURIComponent(parsed.url.split("?r=")[1]);
    expect(decoded).toContain("utm_source=push");
    expect(decoded).toContain("utm_campaign=streak_reminder");
  });

  it("leaves payload.url unset when input had none", async () => {
    saveSubscription(db, userId, mockSubscription);

    await sendPushToUser(db, userId, "daily_puzzle", { title: "T", body: "B" });

    const payloadJson = mockSendNotification.mock.calls[0]![1];
    const parsed = JSON.parse(payloadJson);
    expect(parsed.url).toBeUndefined();

    const logRow = db
      .prepare(`SELECT url_path FROM notification_log WHERE user_id = ? ORDER BY id DESC LIMIT 1`)
      .get(userId) as { url_path: string | null };
    expect(logRow.url_path).toBeNull();
  });
});
