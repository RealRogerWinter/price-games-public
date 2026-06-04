/**
 * Tests for the giveaway-loss consolation send.
 *
 * Covers `notifyGiveawayNonWinners` directly. The integration with
 * `executeRandomRoll` (capturing the non-winner list and firing the
 * batch on commit) is asserted in `rewards.test.ts`.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Database as DatabaseType } from "better-sqlite3";
import type { QualifyingPlayer } from "@price-game/shared";
import { createTestDb, seedUser } from "../test/dbHelper";

// Hoisted mock for sendEmail. Defined via vi.hoisted so the reference is
// usable inside the vi.mock factory, which itself is hoisted to the top
// of the file before module-level imports run.
const { sendEmailMock } = vi.hoisted(() => ({
  sendEmailMock: vi.fn(async () => ({ ok: true, providerMessageId: "msg_test" })),
}));

vi.mock("./email", async (importActual) => {
  const actual = await importActual<typeof import("./email")>();
  return {
    ...actual,
    sendEmail: sendEmailMock,
  };
});

import { notifyGiveawayNonWinners } from "./rewards";
import { updateEmailPreferences, updateTriggerConfig } from "./emailNotification";

let db: DatabaseType;

function makePlayer(id: string, username: string, email: string): QualifyingPlayer {
  return { id, username, email, points: 100, gamesPlayed: 1, streak: 0 };
}

beforeEach(() => {
  db = createTestDb();
  sendEmailMock.mockClear();
  sendEmailMock.mockResolvedValue({ ok: true, providerMessageId: "msg_test" });
});

describe("notifyGiveawayNonWinners", () => {
  it("sends a giveaway_loss email to each non-winner with the master flag + giveaway_loss enabled", async () => {
    const u1 = seedUser(db, "loser1", "loser1@test.com");
    const u2 = seedUser(db, "loser2", "loser2@test.com");
    // Default-on for new rows; but be explicit so the test documents intent.
    updateEmailPreferences(db, u1, { emailEnabled: true, giveawayLoss: true });
    updateEmailPreferences(db, u2, { emailEnabled: true, giveawayLoss: true });

    const result = await notifyGiveawayNonWinners(
      db,
      [makePlayer(u1, "loser1", "loser1@test.com"), makePlayer(u2, "loser2", "loser2@test.com")],
      "last_month",
    );

    expect(result.sent).toBe(2);
    expect(result.skipped).toBe(0);
    expect(sendEmailMock).toHaveBeenCalledTimes(2);

    // email_log should record both sends with type=giveaway_loss.
    const logRows = db
      .prepare(`SELECT user_id, type, status FROM email_log ORDER BY id`)
      .all() as Array<{ user_id: string; type: string; status: string }>;
    expect(logRows).toHaveLength(2);
    expect(logRows.every((r) => r.type === "giveaway_loss")).toBe(true);
    expect(logRows.every((r) => r.status === "sent")).toBe(true);
  });

  it("skips users who have giveaway_loss disabled", async () => {
    const u1 = seedUser(db, "optedin", "optedin@test.com");
    const u2 = seedUser(db, "optedout", "optedout@test.com");
    updateEmailPreferences(db, u1, { emailEnabled: true, giveawayLoss: true });
    updateEmailPreferences(db, u2, { emailEnabled: true, giveawayLoss: false });

    const result = await notifyGiveawayNonWinners(
      db,
      [makePlayer(u1, "optedin", "optedin@test.com"), makePlayer(u2, "optedout", "optedout@test.com")],
      "last_month",
    );

    expect(result.sent).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.byReason.type_disabled).toBe(1);
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
  });

  it("skips users with the master email_enabled flag off", async () => {
    const userId = seedUser(db, "noemail", "noemail@test.com");
    // Master off; per-type flag is irrelevant.
    updateEmailPreferences(db, userId, { emailEnabled: false, giveawayLoss: true });

    const result = await notifyGiveawayNonWinners(
      db,
      [makePlayer(userId, "noemail", "noemail@test.com")],
      "last_month",
    );

    expect(result.sent).toBe(0);
    expect(result.byReason.disabled).toBe(1);
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("returns a zero result when given an empty list", async () => {
    const result = await notifyGiveawayNonWinners(db, [], "last_month");
    expect(result.sent).toBe(0);
    expect(result.skipped).toBe(0);
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("aborts the entire batch when the trigger config is disabled", async () => {
    updateTriggerConfig(db, "giveaway_loss", { isEnabled: false });
    const u1 = seedUser(db, "trigoff", "trigoff@test.com");
    updateEmailPreferences(db, u1, { emailEnabled: true, giveawayLoss: true });

    const result = await notifyGiveawayNonWinners(
      db,
      [makePlayer(u1, "trigoff", "trigoff@test.com")],
      "last_month",
    );

    expect(result.sent).toBe(0);
    expect(result.byReason.trigger_disabled).toBe(1);
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("bypasses the 24h global cooldown — recipients still hear results even after recent marketing", async () => {
    const userId = seedUser(db, "recent", "recent@test.com");
    updateEmailPreferences(db, userId, { emailEnabled: true, giveawayLoss: true });

    // Simulate a marketing email sent in the last 24h, which would
    // normally trigger the global-cooldown short-circuit.
    db.prepare(
      `INSERT INTO email_log (user_id, type, to_address, status, sent_at)
       VALUES (?, 'weekly_digest', ?, 'sent', datetime('now', '-1 hour'))`,
    ).run(userId, "recent@test.com");

    const result = await notifyGiveawayNonWinners(
      db,
      [makePlayer(userId, "recent", "recent@test.com")],
      "last_month",
    );

    expect(result.sent).toBe(1);
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
  });
});
