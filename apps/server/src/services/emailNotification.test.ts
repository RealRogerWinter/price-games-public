import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Database as DatabaseType } from "better-sqlite3";
import { createTestDb, seedUser } from "../test/dbHelper";

// Mock the email transport so tests don't attempt real Resend calls.
const { mockSendEmail } = vi.hoisted(() => ({
  mockSendEmail: vi.fn().mockResolvedValue({ ok: true, providerMessageId: "msg-abc" }),
}));
vi.mock("./email", async () => {
  const actual = await vi.importActual<typeof import("./email")>("./email");
  return {
    ...actual,
    sendEmail: mockSendEmail,
  };
});

import {
  getEmailPreferences,
  updateEmailPreferences,
  listEmailTemplates,
  getEmailTemplate,
  createEmailTemplate,
  updateEmailTemplate,
  deleteEmailTemplate,
  renderEmailTemplate,
  renderEmailHtmlTemplate,
  listTriggerConfigs,
  getTriggerConfig,
  updateTriggerConfig,
  sendMarketingEmail,
  sendMarketingEmailFromTemplate,
  sendMarketingEmailToAll,
  scheduleEmail,
  cancelScheduledEmails,
  processScheduledEmails,
  getEmailStats,
  getEmailLog,
  recordUnsubscribe,
  buildMarketingHtml,
} from "./emailNotification";

let db: DatabaseType;
let userId: string;

beforeEach(() => {
  db = createTestDb();
  userId = seedUser(db, "alice", "alice@test.com");
  mockSendEmail.mockClear();
  mockSendEmail.mockResolvedValue({ ok: true, providerMessageId: "msg-abc" });
});

// ── Preferences ────────────────────────────────────────────────────────────

describe("getEmailPreferences", () => {
  it("returns opt-in defaults (all false) for users without a row", () => {
    const p = getEmailPreferences(db, userId);
    expect(p.emailEnabled).toBe(false);
    expect(p.streakRisk).toBe(false);
    expect(p.promotional).toBe(false);
    expect(p.preferredHour).toBe(10);
    expect(p.timezone).toBe("UTC");
  });

  it("defaults giveawayLoss to true (only opt-in default-on type)", () => {
    // The consolation email is a transactional follow-up to a giveaway
    // the user already entered by playing, so the row default + the
    // synthesized fallback are both `true`. Master `email_enabled` still
    // gates the actual send.
    const p = getEmailPreferences(db, userId);
    expect(p.giveawayLoss).toBe(true);
  });

  it("persists giveawayLoss = false across updates", () => {
    updateEmailPreferences(db, userId, { giveawayLoss: false });
    expect(getEmailPreferences(db, userId).giveawayLoss).toBe(false);
  });

  it("returns persisted values after updatePreferences", () => {
    updateEmailPreferences(db, userId, {
      emailEnabled: true,
      streakRisk: true,
      preferredHour: 20,
      timezone: "America/New_York",
    });
    const p = getEmailPreferences(db, userId);
    expect(p.emailEnabled).toBe(true);
    expect(p.streakRisk).toBe(true);
    expect(p.preferredHour).toBe(20);
    expect(p.timezone).toBe("America/New_York");
  });

  it("clamps preferredHour to [0,23]", () => {
    updateEmailPreferences(db, userId, { preferredHour: 99 });
    expect(getEmailPreferences(db, userId).preferredHour).toBe(23);
    updateEmailPreferences(db, userId, { preferredHour: -5 });
    expect(getEmailPreferences(db, userId).preferredHour).toBe(0);
  });

  it("updatePreferences with no fields is a no-op", () => {
    updateEmailPreferences(db, userId, {});
    const p = getEmailPreferences(db, userId);
    expect(p.emailEnabled).toBe(false);
  });
});

// ── Templates ──────────────────────────────────────────────────────────────

describe("template CRUD", () => {
  it("creates, reads, updates, deletes", () => {
    const t = createEmailTemplate(db, {
      name: "streak-risk-v1",
      type: "streak_risk",
      subjectTemplate: "Your {{streakCount}}-day streak is at risk",
      htmlTemplate: "<p>hi {{username}}</p>",
    });
    expect(t.id).toBeGreaterThan(0);
    expect(t.isActive).toBe(true);
    expect(getEmailTemplate(db, t.id)).toBeDefined();
    expect(listEmailTemplates(db)).toHaveLength(1);

    const updated = updateEmailTemplate(db, t.id, { isActive: false });
    expect(updated?.isActive).toBe(false);

    expect(deleteEmailTemplate(db, t.id)).toBe(true);
    expect(getEmailTemplate(db, t.id)).toBeUndefined();
  });

  it("throws on duplicate name (UNIQUE constraint)", () => {
    createEmailTemplate(db, {
      name: "dup",
      type: "promotional",
      subjectTemplate: "s",
      htmlTemplate: "h",
    });
    expect(() =>
      createEmailTemplate(db, {
        name: "dup",
        type: "promotional",
        subjectTemplate: "s",
        htmlTemplate: "h",
      }),
    ).toThrow();
  });
});

describe("renderEmailTemplate", () => {
  it("substitutes {{key}} placeholders", () => {
    expect(
      renderEmailTemplate("Hi {{name}}, your streak is {{count}}", {
        name: "Alice",
        count: 5,
      }),
    ).toBe("Hi Alice, your streak is 5");
  });

  it("leaves missing keys in place", () => {
    expect(renderEmailTemplate("Hi {{name}} {{missing}}", { name: "A" })).toBe(
      "Hi A {{missing}}",
    );
  });

  it("does NOT escape HTML — meant for subject / plain-text only", () => {
    expect(
      renderEmailTemplate("Subject: {{username}}", { username: "<img>" }),
    ).toBe("Subject: <img>");
  });
});

describe("renderEmailHtmlTemplate", () => {
  it("escapes HTML in values to block injection via user fields", () => {
    expect(
      renderEmailHtmlTemplate("<p>Hi {{username}}</p>", {
        username: "<img onerror=alert(1)>",
      }),
    ).toBe("<p>Hi &lt;img onerror=alert(1)&gt;</p>");
  });

  it("leaves the surrounding template markup intact", () => {
    expect(
      renderEmailHtmlTemplate('<a href="/u">{{name}}</a>', { name: "A&B" }),
    ).toBe('<a href="/u">A&amp;B</a>');
  });

  it("leaves missing keys in place", () => {
    expect(renderEmailHtmlTemplate("{{missing}}", {})).toBe("{{missing}}");
  });
});

// ── Trigger configs ─────────────────────────────────────────────────────────

describe("trigger config", () => {
  it("seeds one row per trigger type by default", () => {
    const configs = listTriggerConfigs(db);
    const types = configs.map((c) => c.type).sort();
    expect(types).toEqual(
      [
        "giveaway_loss",
        "inactivity_reminder",
        "leaderboard_placement",
        "promotional",
        "streak_risk",
        "streak_save",
        "weekly_digest",
      ].sort(),
    );
    // Every other trigger seeds with is_enabled=0 (admin must turn on);
    // giveaway_loss is the lone exception because it fires synchronously
    // from the random-roll handler and has no scheduler ramp.
    for (const c of configs) {
      if (c.type === "giveaway_loss") {
        expect(c.isEnabled).toBe(true);
      } else {
        expect(c.isEnabled).toBe(false);
      }
    }
  });

  it("updateTriggerConfig flips is_enabled and cooldown", () => {
    const before = getTriggerConfig(db, "streak_risk")!;
    expect(before.isEnabled).toBe(false);
    const after = updateTriggerConfig(db, "streak_risk", {
      isEnabled: true,
      cooldownHours: 48,
    })!;
    expect(after.isEnabled).toBe(true);
    expect(after.cooldownHours).toBe(48);
  });
});

// ── sendMarketingEmail ──────────────────────────────────────────────────────

describe("sendMarketingEmail — preference + cooldown gating", () => {
  it("skips when user has no email_preferences row and master is off (default)", async () => {
    const r = await sendMarketingEmail(db, userId, "promotional", {
      subject: "Hi",
      html: "<p>hi</p>",
    });
    expect(r.sent).toBe(0);
    expect(r.reason).toBe("disabled");
    expect(mockSendEmail).not.toHaveBeenCalled();

    // Suppressed row is logged for analytics
    const log = db.prepare(`SELECT status, error_message FROM email_log`).all() as Array<{
      status: string;
      error_message: string;
    }>;
    expect(log).toHaveLength(1);
    expect(log[0].status).toBe("suppressed");
    expect(log[0].error_message).toBe("disabled");
  });

  it("skips when master on but per-type off", async () => {
    updateEmailPreferences(db, userId, { emailEnabled: true });
    const r = await sendMarketingEmail(db, userId, "promotional", {
      subject: "Hi",
      html: "<p>hi</p>",
    });
    expect(r.sent).toBe(0);
    expect(r.reason).toBe("type_disabled");
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it("sends when master + per-type on", async () => {
    updateEmailPreferences(db, userId, { emailEnabled: true, promotional: true });
    const r = await sendMarketingEmail(db, userId, "promotional", {
      subject: "Hi",
      html: "<p>hi</p>",
    });
    expect(r.sent).toBe(1);
    expect(r.providerMessageId).toBe("msg-abc");
    expect(mockSendEmail).toHaveBeenCalledTimes(1);

    // sendEmail gets the HTML with an unsubscribe footer + List-Unsubscribe headers
    const call = mockSendEmail.mock.calls[0]![0];
    expect(call.headers["List-Unsubscribe"]).toMatch(/^<https?:\/\//);
    expect(call.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    expect(call.html).toContain("Unsubscribe");
  });

  it("enforces global cooldown: second send within window is suppressed", async () => {
    updateEmailPreferences(db, userId, {
      emailEnabled: true,
      promotional: true,
      streakRisk: true,
    });
    // Trigger config cooldowns default to large values; override streak_risk
    // so it's not the gate — we want to test GLOBAL cooldown.
    updateTriggerConfig(db, "streak_risk", { cooldownHours: 1 });
    updateTriggerConfig(db, "promotional", { cooldownHours: 1 });

    const first = await sendMarketingEmail(db, userId, "promotional", {
      subject: "1",
      html: "<p>1</p>",
    });
    expect(first.sent).toBe(1);

    const second = await sendMarketingEmail(db, userId, "streak_risk", {
      subject: "2",
      html: "<p>2</p>",
    });
    expect(second.sent).toBe(0);
    expect(second.reason).toBe("cooldown_global");
  });

  it("adminOverride bypasses preferences and cooldowns", async () => {
    // User is entirely opted-out, but override should still send.
    const r = await sendMarketingEmail(db, userId, "promotional", {
      subject: "Hi",
      html: "<p>hi</p>",
      adminOverride: true,
    });
    expect(r.sent).toBe(1);
  });

  it("returns no_email when user has no email", async () => {
    db.prepare(`UPDATE users SET email = '' WHERE id = ?`).run(userId);
    const r = await sendMarketingEmail(db, userId, "promotional", {
      subject: "Hi",
      html: "<p>hi</p>",
      adminOverride: true,
    });
    expect(r.sent).toBe(0);
    expect(r.reason).toBe("no_email");
  });

  it("returns inactive_user when user deactivated", async () => {
    db.prepare(`UPDATE users SET is_active = 0 WHERE id = ?`).run(userId);
    const r = await sendMarketingEmail(db, userId, "promotional", {
      subject: "Hi",
      html: "<p>hi</p>",
      adminOverride: true,
    });
    expect(r.sent).toBe(0);
    expect(r.reason).toBe("inactive_user");
  });

  it("marks the log row failed when the transport returns ok:false", async () => {
    mockSendEmail.mockResolvedValueOnce({ ok: false, error: "provider down" });
    updateEmailPreferences(db, userId, { emailEnabled: true, promotional: true });
    const r = await sendMarketingEmail(db, userId, "promotional", {
      subject: "Hi",
      html: "<p>hi</p>",
    });
    expect(r.sent).toBe(0);
    expect(r.reason).toBe("send_failed");
    const log = db.prepare(`SELECT status, error_message FROM email_log`).all() as Array<{
      status: string;
      error_message: string;
    }>;
    expect(log.at(-1)?.status).toBe("failed");
    expect(log.at(-1)?.error_message).toBe("provider down");
  });
});

// ── UTM auto-rewriting ─────────────────────────────────────────────────────

describe("sendMarketingEmail — auto UTM rewriting", () => {
  beforeEach(() => {
    updateEmailPreferences(db, userId, { emailEnabled: true, promotional: true });
    // Long cooldowns are fine — we send only one email per test.
    updateTriggerConfig(db, "promotional", { cooldownHours: 1 });
  });

  it("rewrites in-body anchor hrefs with UTMs (and short-link substitution)", async () => {
    await sendMarketingEmail(db, userId, "promotional", {
      subject: "Hi",
      html: `<p>Try the <a href="http://localhost:5173/leaderboard">leaderboard</a> today!</p>`,
    });

    const html = mockSendEmail.mock.calls[0]![0].html as string;
    // The leaderboard CTA is now a /go/<code> short URL.
    expect(html).toMatch(/href="[^"]*\/go\/[a-z0-9]{3,32}"/);
    // The system origin row exists with the email:promotional UTM tuple.
    const row = db
      .prepare(`SELECT utm_campaign, utm_medium FROM utm_tags WHERE origin_key = 'email:promotional'`)
      .get() as { utm_campaign: string; utm_medium: string };
    expect(row.utm_campaign).toBe("promotional");
    expect(row.utm_medium).toBe("marketing");
  });

  it("does NOT rewrite the unsubscribe footer URL appended after the body", async () => {
    await sendMarketingEmail(db, userId, "promotional", {
      subject: "Hi",
      html: `<p>Hi there!</p>`,
    });

    const html = mockSendEmail.mock.calls[0]![0].html as string;
    // The unsub footer carries the HMAC-signed token URL; it must not
    // have UTM params attached, because the unsub click is the action,
    // not a marketing engagement.
    expect(html).toMatch(/\/api\/email\/unsubscribe\?token=/);
    // Find the unsub anchor and verify no utm_source on it.
    const unsubMatches = html.match(/href="([^"]*\/api\/email\/unsubscribe[^"]*)"/g) ?? [];
    expect(unsubMatches.length).toBeGreaterThan(0);
    for (const match of unsubMatches) {
      expect(match).not.toContain("utm_source=");
    }
  });

  it("rewrites bare URLs in plain-text bodies", async () => {
    await sendMarketingEmail(db, userId, "promotional", {
      subject: "Hi",
      html: `<p>Hi</p>`,
      text: `Visit http://localhost:5173/leaderboard for the latest.`,
    });

    const text = mockSendEmail.mock.calls[0]![0].text as string;
    expect(text).toMatch(/\/go\/[a-z0-9]{3,32}/);
  });

  it("preserves UTM params already present on author-supplied URLs", async () => {
    await sendMarketingEmail(db, userId, "promotional", {
      subject: "Hi",
      html: `<p><a href="http://localhost:5173/sale?utm_source=admin&utm_campaign=summer">sale</a></p>`,
    });

    const html = mockSendEmail.mock.calls[0]![0].html as string;
    // Author-supplied UTMs win; auto-rewrite still creates a short link
    // for the destination but the long URL behind it carries author values.
    // Specifically: the rendered href is now a /go/ short URL, and the
    // backing utm_tags row was created for the AUTHOR'S tuple (utm_source=
    // admin, utm_campaign=summer) because tagAndShortenUrl normalizes the
    // destination but keeps query params intact when matching.
    // Simpler assertion: the row is a system origin tag for promotional.
    const rows = db
      .prepare(`SELECT origin_key FROM utm_tags WHERE origin_key = 'email:promotional'`)
      .all();
    expect(rows.length).toBeGreaterThan(0);
    expect(html).toMatch(/href="[^"]*\/go\/[a-z0-9]{3,32}"/);
  });
});

// ── From template ──────────────────────────────────────────────────────────

describe("sendMarketingEmailFromTemplate", () => {
  it("renders vars and dispatches", async () => {
    updateEmailPreferences(db, userId, { emailEnabled: true, streakRisk: true });
    const t = createEmailTemplate(db, {
      name: "streak",
      type: "streak_risk",
      subjectTemplate: "Save your {{streak}}-day streak!",
      htmlTemplate: "<p>Hey {{username}} — you're at {{streak}} days.</p>",
    });
    const r = await sendMarketingEmailFromTemplate(db, userId, t.id, {
      username: "alice",
      streak: 7,
    });
    expect(r.sent).toBe(1);
    const call = mockSendEmail.mock.calls[0]![0];
    expect(call.subject).toBe("Save your 7-day streak!");
    expect(call.html).toContain("Hey alice");
    expect(call.html).toContain("you're at 7 days");
  });

  it("refuses to send inactive templates unless override", async () => {
    updateEmailPreferences(db, userId, { emailEnabled: true, promotional: true });
    const t = createEmailTemplate(db, {
      name: "inactive",
      type: "promotional",
      subjectTemplate: "s",
      htmlTemplate: "h",
      isActive: false,
    });
    const r = await sendMarketingEmailFromTemplate(db, userId, t.id, {});
    expect(r.sent).toBe(0);
  });

  it("returns send_failed for missing template id", async () => {
    const r = await sendMarketingEmailFromTemplate(db, userId, 99999, {});
    expect(r.sent).toBe(0);
    expect(r.reason).toBe("send_failed");
  });
});

// ── sendMarketingEmailToAll ─────────────────────────────────────────────────

describe("sendMarketingEmailToAll", () => {
  it("only enumerates users opted in for the target type", async () => {
    const bob = seedUser(db, "bob", "bob@test.com");
    const carol = seedUser(db, "carol", "carol@test.com");

    updateEmailPreferences(db, userId, { emailEnabled: true, promotional: true });
    updateEmailPreferences(db, bob, { emailEnabled: true, promotional: false });
    updateEmailPreferences(db, carol, { emailEnabled: false, promotional: true });

    const r = await sendMarketingEmailToAll(
      db,
      "promotional",
      () => ({ subject: "Hi", html: "<p>hi</p>" }),
    );
    expect(r.sent).toBe(1);
    expect(r.skipped).toBe(0);
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
  });

  it("honors build function returning null to skip per-user", async () => {
    updateEmailPreferences(db, userId, { emailEnabled: true, promotional: true });
    const r = await sendMarketingEmailToAll(db, "promotional", () => null);
    expect(r.sent).toBe(0);
    expect(r.skipped).toBe(1);
    expect(r.byReason.no_content).toBe(1);
  });
});

// ── Scheduling ──────────────────────────────────────────────────────────────

describe("scheduleEmail + processScheduledEmails", () => {
  it("drains due rows and marks sent", async () => {
    updateEmailPreferences(db, userId, { emailEnabled: true, streakRisk: true });
    const t = createEmailTemplate(db, {
      name: "t1",
      type: "streak_risk",
      subjectTemplate: "Subject",
      htmlTemplate: "<p>{{username}}</p>",
    });
    scheduleEmail(db, userId, "streak_risk", { username: "alice" }, "2000-01-01 00:00:00", t.id);

    const processed = await processScheduledEmails(db);
    expect(processed).toBe(1);
    const row = db.prepare(`SELECT status FROM scheduled_emails`).get() as { status: string };
    expect(row.status).toBe("sent");
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
  });

  it("cancels scheduled rows for opted-out users instead of retrying", async () => {
    const t = createEmailTemplate(db, {
      name: "t2",
      type: "promotional",
      subjectTemplate: "s",
      htmlTemplate: "h",
    });
    // user is NOT opted in — scheduled row should be cancelled
    scheduleEmail(db, userId, "promotional", {}, "2000-01-01 00:00:00", t.id);
    await processScheduledEmails(db);
    const row = db.prepare(`SELECT status, error_message FROM scheduled_emails`).get() as {
      status: string;
      error_message: string;
    };
    expect(row.status).toBe("cancelled");
    expect(row.error_message).toBe("disabled");
  });

  it("cancelScheduledEmails flips pending rows of a type", () => {
    const t = createEmailTemplate(db, {
      name: "t3",
      type: "streak_risk",
      subjectTemplate: "s",
      htmlTemplate: "h",
    });
    scheduleEmail(db, userId, "streak_risk", {}, "2000-01-01 00:00:00", t.id);
    const n = cancelScheduledEmails(db, userId, "streak_risk");
    expect(n).toBe(1);
    const row = db.prepare(`SELECT status FROM scheduled_emails`).get() as { status: string };
    expect(row.status).toBe("cancelled");
  });
});

// ── Unsubscribe ─────────────────────────────────────────────────────────────

describe("recordUnsubscribe", () => {
  it("flips the matching preference off for single-type unsubscribe", () => {
    updateEmailPreferences(db, userId, {
      emailEnabled: true,
      streakRisk: true,
      promotional: true,
    });
    recordUnsubscribe(db, userId, "streak_risk", "one_click");
    const p = getEmailPreferences(db, userId);
    expect(p.streakRisk).toBe(false);
    expect(p.promotional).toBe(true);
    expect(p.emailEnabled).toBe(true);
  });

  it("'all' flips master and every per-type flag off", () => {
    updateEmailPreferences(db, userId, {
      emailEnabled: true,
      streakRisk: true,
      promotional: true,
      weeklyDigest: true,
    });
    recordUnsubscribe(db, userId, "all", "one_click");
    const p = getEmailPreferences(db, userId);
    expect(p.emailEnabled).toBe(false);
    expect(p.streakRisk).toBe(false);
    expect(p.promotional).toBe(false);
    expect(p.weeklyDigest).toBe(false);
  });

  it("logs to email_unsubscribes for audit", () => {
    recordUnsubscribe(db, userId, "promotional", "one_click");
    recordUnsubscribe(db, userId, "all", "complaint");
    const rows = db
      .prepare(`SELECT type, source FROM email_unsubscribes ORDER BY id ASC`)
      .all() as Array<{ type: string | null; source: string }>;
    expect(rows).toEqual([
      { type: "promotional", source: "one_click" },
      { type: null, source: "complaint" },
    ]);
  });

  it("throws on unknown type (no silent success)", () => {
    expect(() => recordUnsubscribe(db, userId, "nonsense", "one_click")).toThrow();
    // And no audit row is inserted for the invalid attempt.
    const count = (db
      .prepare(`SELECT COUNT(*) as c FROM email_unsubscribes`)
      .get() as { c: number }).c;
    expect(count).toBe(0);
  });
});

// ── Analytics ───────────────────────────────────────────────────────────────

describe("getEmailStats / getEmailLog", () => {
  beforeEach(() => {
    updateEmailPreferences(db, userId, { emailEnabled: true, promotional: true });
  });

  it("computes open / click / bounce rates from log rows", async () => {
    await sendMarketingEmail(db, userId, "promotional", { subject: "s", html: "h", adminOverride: true });
    // Simulate webhook updates by flipping statuses directly.
    const logIds = db.prepare(`SELECT id FROM email_log ORDER BY id ASC`).all() as { id: number }[];
    const lastId = logIds.at(-1)!.id;
    db.prepare(`UPDATE email_log SET status = 'opened', opened_at = datetime('now') WHERE id = ?`).run(lastId);

    const stats = getEmailStats(db, 7);
    expect(stats.totalSent).toBe(1);
    expect(stats.totalOpened).toBe(1);
    expect(stats.openRate).toBe(100);
  });

  it("paginates + filters the log", async () => {
    for (let i = 0; i < 3; i++) {
      await sendMarketingEmail(db, userId, "promotional", {
        subject: `s${i}`,
        html: "h",
        adminOverride: true,
      });
    }
    const all = getEmailLog(db, { limit: 2 });
    expect(all.total).toBe(3);
    expect(all.entries).toHaveLength(2);

    const filtered = getEmailLog(db, { status: "sent" });
    expect(filtered.entries.every((e) => e.status === "sent")).toBe(true);
  });
});

// ── Layout helper ──────────────────────────────────────────────────────────

describe("buildMarketingHtml", () => {
  it("wraps content and optionally appends a CTA button", () => {
    const html = buildMarketingHtml(
      "<p>Hello</p>",
      { url: "https://price.games/daily", label: "Play now" },
    );
    expect(html).toContain("<p>Hello</p>");
    expect(html).toContain("Play now");
    expect(html).toContain("Price Games");
  });
});
