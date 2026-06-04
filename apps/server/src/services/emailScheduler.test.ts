import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Database as DatabaseType } from "better-sqlite3";
import { createTestDb, seedUser } from "../test/dbHelper";

const { mockSendEmail } = vi.hoisted(() => ({
  mockSendEmail: vi.fn().mockResolvedValue({ ok: true, providerMessageId: "msg-1" }),
}));
vi.mock("./email", async () => {
  const actual = await vi.importActual<typeof import("./email")>("./email");
  return { ...actual, sendEmail: mockSendEmail };
});

import {
  evaluateStreakRiskEmails,
  evaluateInactivityEmails,
  evaluateWeeklyDigestEmails,
  cleanupOldEmailData,
  pickSendTimeForUser,
} from "./emailScheduler";
import {
  updateEmailPreferences,
  createEmailTemplate,
  updateTriggerConfig,
} from "./emailNotification";

let db: DatabaseType;
let alice: string;
let bob: string;

beforeEach(() => {
  db = createTestDb();
  alice = seedUser(db, "alice", "alice@test.com");
  bob = seedUser(db, "bob", "bob@test.com");
  mockSendEmail.mockClear();
});

// ── streak_risk ────────────────────────────────────────────────────────────

describe("evaluateStreakRiskEmails", () => {
  it("does nothing when trigger is disabled", () => {
    updateEmailPreferences(db, alice, { emailEnabled: true, streakRisk: true });
    db.prepare(
      `UPDATE users SET daily_streak_current = 5, daily_streak_last_date = date('now','-1 day') WHERE id = ?`,
    ).run(alice);
    const n = evaluateStreakRiskEmails(db);
    expect(n).toBe(0);
  });

  it("enqueues for opted-in users whose streak missed yesterday", () => {
    const t = createEmailTemplate(db, {
      name: "streak",
      type: "streak_risk",
      subjectTemplate: "Save your {{streakCount}}-day streak",
      htmlTemplate: "<p>{{username}}</p>",
    });
    updateTriggerConfig(db, "streak_risk", { isEnabled: true, templateId: t.id });
    updateEmailPreferences(db, alice, { emailEnabled: true, streakRisk: true });
    db.prepare(
      `UPDATE users SET daily_streak_current = 5, daily_streak_last_date = date('now','-1 day') WHERE id = ?`,
    ).run(alice);

    const n = evaluateStreakRiskEmails(db);
    expect(n).toBe(1);
    const rows = db.prepare(`SELECT user_id, type, status FROM scheduled_emails`).all() as Array<{
      user_id: string;
      type: string;
      status: string;
    }>;
    expect(rows).toEqual([{ user_id: alice, type: "streak_risk", status: "pending" }]);
  });

  it("skips users below the streakMin threshold", () => {
    const t = createEmailTemplate(db, {
      name: "streak2",
      type: "streak_risk",
      subjectTemplate: "s",
      htmlTemplate: "h",
    });
    updateTriggerConfig(db, "streak_risk", {
      isEnabled: true,
      templateId: t.id,
      thresholdJson: JSON.stringify({ streakMin: 5 }),
    });
    updateEmailPreferences(db, alice, { emailEnabled: true, streakRisk: true });
    db.prepare(
      `UPDATE users SET daily_streak_current = 2, daily_streak_last_date = date('now','-1 day') WHERE id = ?`,
    ).run(alice);

    expect(evaluateStreakRiskEmails(db)).toBe(0);
  });

  it("does not enqueue twice — existing pending row blocks re-enqueue", () => {
    const t = createEmailTemplate(db, {
      name: "streak3",
      type: "streak_risk",
      subjectTemplate: "s",
      htmlTemplate: "h",
    });
    updateTriggerConfig(db, "streak_risk", { isEnabled: true, templateId: t.id });
    updateEmailPreferences(db, alice, { emailEnabled: true, streakRisk: true });
    db.prepare(
      `UPDATE users SET daily_streak_current = 3, daily_streak_last_date = date('now','-1 day') WHERE id = ?`,
    ).run(alice);

    expect(evaluateStreakRiskEmails(db)).toBe(1);
    expect(evaluateStreakRiskEmails(db)).toBe(0);
  });
});

// ── inactivity ─────────────────────────────────────────────────────────────

describe("evaluateInactivityEmails", () => {
  it("queues for users with last session activity around the threshold", () => {
    const t = createEmailTemplate(db, {
      name: "inactive",
      type: "inactivity_reminder",
      subjectTemplate: "Come back!",
      htmlTemplate: "<p>{{username}}</p>",
    });
    updateTriggerConfig(db, "inactivity_reminder", {
      isEnabled: true,
      templateId: t.id,
      thresholdJson: JSON.stringify({ days: 7 }),
    });
    updateEmailPreferences(db, alice, { emailEnabled: true, inactivityReminder: true });

    // Seed a 7-day-old session using the ISO format production uses. The
    // evaluator wraps the stored timestamp in datetime() so the 'T'
    // separator doesn't break the BETWEEN comparison.
    const sevenAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000 - 60 * 60 * 1000).toISOString();
    db.prepare(
      `INSERT INTO user_sessions (id, user_id, created_at, expires_at, last_active_at)
       VALUES ('s1', ?, ?, ?, ?)`,
    ).run(alice, sevenAgo, sevenAgo, sevenAgo);

    expect(evaluateInactivityEmails(db)).toBe(1);
  });

  it("does not queue for users inactive much longer than the threshold", () => {
    const t = createEmailTemplate(db, {
      name: "inactive2",
      type: "inactivity_reminder",
      subjectTemplate: "s",
      htmlTemplate: "h",
    });
    updateTriggerConfig(db, "inactivity_reminder", {
      isEnabled: true,
      templateId: t.id,
      thresholdJson: JSON.stringify({ days: 7 }),
    });
    updateEmailPreferences(db, alice, { emailEnabled: true, inactivityReminder: true });

    // 30 days old — outside the 7-day window
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare(
      `INSERT INTO user_sessions (id, user_id, created_at, expires_at, last_active_at)
       VALUES ('s2', ?, ?, ?, ?)`,
    ).run(alice, old, old, old);

    expect(evaluateInactivityEmails(db)).toBe(0);
  });
});

// ── weekly digest ──────────────────────────────────────────────────────────

describe("evaluateWeeklyDigestEmails", () => {
  it("only fires at configured weekday+hour", () => {
    const t = createEmailTemplate(db, {
      name: "digest",
      type: "weekly_digest",
      subjectTemplate: "Weekly digest",
      htmlTemplate: "<p>{{username}}</p>",
    });
    // Set threshold to a time that can't be "now" simultaneously on all
    // platforms, and confirm we get 0. We intentionally set hour to a
    // negative number so the match always fails.
    updateTriggerConfig(db, "weekly_digest", {
      isEnabled: true,
      templateId: t.id,
      thresholdJson: JSON.stringify({ weekday: -1, hour: -1 }),
    });
    updateEmailPreferences(db, alice, { emailEnabled: true, weeklyDigest: true });
    expect(evaluateWeeklyDigestEmails(db)).toBe(0);
  });

  it("fires for matching weekday+hour", () => {
    const t = createEmailTemplate(db, {
      name: "digest2",
      type: "weekly_digest",
      subjectTemplate: "s",
      htmlTemplate: "h",
    });
    const now = new Date();
    updateTriggerConfig(db, "weekly_digest", {
      isEnabled: true,
      templateId: t.id,
      thresholdJson: JSON.stringify({
        weekday: now.getUTCDay(),
        hour: now.getUTCHours(),
      }),
    });
    updateEmailPreferences(db, alice, { emailEnabled: true, weeklyDigest: true });
    updateEmailPreferences(db, bob, { emailEnabled: true, weeklyDigest: true });
    expect(evaluateWeeklyDigestEmails(db)).toBe(2);
  });
});

// ── cleanup ─────────────────────────────────────────────────────────────────

describe("cleanupOldEmailData", () => {
  it("removes old log and scheduled rows", () => {
    // Ancient log row
    db.prepare(
      `INSERT INTO email_log (user_id, type, to_address, subject, status, created_at)
       VALUES (?, 'promotional', 'x@y', 's', 'sent', datetime('now','-200 days'))`,
    ).run(alice);
    // Old-cancelled scheduled row
    db.prepare(
      `INSERT INTO scheduled_emails (user_id, type, scheduled_at, status, created_at)
       VALUES (?, 'promotional', '2000-01-01', 'cancelled', datetime('now','-60 days'))`,
    ).run(alice);

    cleanupOldEmailData(db);

    const logCount = (db.prepare(`SELECT COUNT(*) as c FROM email_log`).get() as { c: number }).c;
    const schedCount = (db.prepare(`SELECT COUNT(*) as c FROM scheduled_emails`).get() as { c: number }).c;
    expect(logCount).toBe(0);
    expect(schedCount).toBe(0);
  });
});

// ── pickSendTimeForUser ─────────────────────────────────────────────────────

describe("pickSendTimeForUser", () => {
  it("returns a SQLite datetime string", () => {
    const s = pickSendTimeForUser(10, "UTC");
    expect(s).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it("tolerates invalid timezones", () => {
    const s = pickSendTimeForUser(10, "Not/A_Zone");
    expect(s).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });
});
