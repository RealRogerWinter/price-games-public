/**
 * Tests for the anonymous visitor attribution service.
 *
 * Covers first-touch insertion, idempotent claim, game-play counter
 * semantics, and interaction with `mergeVisitorAttributionIntoUser`.
 */

import { describe, it, expect, beforeEach } from "vitest";
import type { Database as DatabaseType } from "better-sqlite3";
import { createTestDb, seedUser } from "../test/dbHelper";
import {
  recordVisitorAttribution,
  recordVisitorGamePlay,
  getVisitorAttribution,
  claimVisitorAttribution,
} from "./visitorAttribution";
import { mergeVisitorAttributionIntoUser } from "./attribution";

let db: DatabaseType;

beforeEach(() => {
  db = createTestDb();
});

// ── recordVisitorAttribution ──────────────────────────────────────────────

describe("recordVisitorAttribution", () => {
  it("inserts a new row when the visitor has no attribution", () => {
    const ok = recordVisitorAttribution(db, "visitor-a", {
      utm_source: "reddit",
      utm_medium: "social",
      utm_campaign: "launch",
      landing_page: "/",
    });
    expect(ok).toBe(true);

    const row = getVisitorAttribution(db, "visitor-a");
    expect(row).not.toBeNull();
    expect(row!.utmSource).toBe("reddit");
    expect(row!.utmMedium).toBe("social");
    expect(row!.utmCampaign).toBe("launch");
    expect(row!.landingPage).toBe("/");
    expect(row!.gamesPlayed).toBe(0);
    expect(row!.firstGameAt).toBeNull();
    expect(row!.claimedUserId).toBeNull();
  });

  it("is a no-op if the visitor already has attribution (first-touch wins)", () => {
    recordVisitorAttribution(db, "visitor-a", { utm_source: "reddit" });
    const second = recordVisitorAttribution(db, "visitor-a", {
      utm_source: "google",
    });
    expect(second).toBe(false);

    const row = getVisitorAttribution(db, "visitor-a");
    expect(row!.utmSource).toBe("reddit");
  });

  it("returns false when attribution is null", () => {
    const ok = recordVisitorAttribution(db, "visitor-a", null);
    expect(ok).toBe(false);
    expect(getVisitorAttribution(db, "visitor-a")).toBeNull();
  });

  it("returns false when visitor_id is empty", () => {
    const ok = recordVisitorAttribution(db, "", { utm_source: "reddit" });
    expect(ok).toBe(false);
  });

  it("refuses to write a row without utm_source (defense in depth)", () => {
    // validateAttribution would normally reject this, but call the service
    // directly to confirm the guard.
    const ok = recordVisitorAttribution(db, "visitor-a", {
      utm_medium: "social",
    } as never);
    expect(ok).toBe(false);
  });
});

// ── recordVisitorGamePlay ─────────────────────────────────────────────────

describe("recordVisitorGamePlay", () => {
  it("sets first_game_* on the first play and bumps the counter", () => {
    recordVisitorAttribution(db, "visitor-a", { utm_source: "reddit" });
    const updated = recordVisitorGamePlay(db, "visitor-a", "single", "classic");
    expect(updated).toBe(true);

    const row = getVisitorAttribution(db, "visitor-a")!;
    expect(row.firstGameAt).not.toBeNull();
    expect(row.firstGameType).toBe("single");
    expect(row.firstGameMode).toBe("classic");
    expect(row.gamesPlayed).toBe(1);
  });

  it("preserves first_game_* on subsequent plays but keeps bumping the counter", () => {
    recordVisitorAttribution(db, "visitor-a", { utm_source: "reddit" });
    recordVisitorGamePlay(db, "visitor-a", "single", "classic");
    recordVisitorGamePlay(db, "visitor-a", "multiplayer", "higher-lower");

    const row = getVisitorAttribution(db, "visitor-a")!;
    expect(row.firstGameType).toBe("single");
    expect(row.firstGameMode).toBe("classic");
    expect(row.gamesPlayed).toBe(2);
  });

  it("creates a 'direct' attribution row for visitors with no prior UTM", () => {
    // Pre-v69 this was a no-op (returned false), but the W/L tracker
    // requires a row for every anonymous player so their counters can
    // accumulate. Untracked visitors get utm_source='direct'.
    const updated = recordVisitorGamePlay(db, "visitor-ghost", "single", "classic");
    expect(updated).toBe(true);
    const row = getVisitorAttribution(db, "visitor-ghost")!;
    expect(row.utmSource).toBe("direct");
    expect(row.gamesPlayed).toBe(1);
    expect(row.firstGameType).toBe("single");
    expect(row.firstGameMode).toBe("classic");
  });

  it("is a no-op for null/empty visitor ids", () => {
    expect(recordVisitorGamePlay(db, null, "single", "classic")).toBe(false);
    expect(recordVisitorGamePlay(db, undefined, "single", "classic")).toBe(false);
    expect(recordVisitorGamePlay(db, "", "single", "classic")).toBe(false);
  });
});

// ── claimVisitorAttribution ───────────────────────────────────────────────

describe("claimVisitorAttribution", () => {
  it("sets claimed_user_id and claimed_at", () => {
    recordVisitorAttribution(db, "visitor-a", { utm_source: "reddit" });
    const userId = seedUser(db, "claimer", "claim@example.com", "password1234");

    const claimed = claimVisitorAttribution(db, "visitor-a", userId);
    expect(claimed).not.toBeNull();
    expect(claimed!.claimedUserId).toBe(userId);
    expect(claimed!.claimedAt).not.toBeNull();
  });

  it("is idempotent for the same user", () => {
    recordVisitorAttribution(db, "visitor-a", { utm_source: "reddit" });
    const userId = seedUser(db, "claimer", "claim@example.com", "password1234");

    const first = claimVisitorAttribution(db, "visitor-a", userId)!;
    const second = claimVisitorAttribution(db, "visitor-a", userId)!;
    expect(second.claimedUserId).toBe(userId);
    expect(second.claimedAt).toBe(first.claimedAt); // unchanged
  });

  it("refuses to reclaim for a different user", () => {
    recordVisitorAttribution(db, "visitor-a", { utm_source: "reddit" });
    const first = seedUser(db, "first", "first@example.com", "password1234");
    const second = seedUser(db, "second", "second@example.com", "password1234");

    claimVisitorAttribution(db, "visitor-a", first);
    const hijacked = claimVisitorAttribution(db, "visitor-a", second);
    expect(hijacked).toBeNull();

    const row = getVisitorAttribution(db, "visitor-a")!;
    expect(row.claimedUserId).toBe(first);
  });

  it("returns null when no visitor row exists", () => {
    const userId = seedUser(db, "nobody", "nobody@example.com", "password1234");
    expect(claimVisitorAttribution(db, "visitor-ghost", userId)).toBeNull();
  });
});

// ── mergeVisitorAttributionIntoUser ───────────────────────────────────────

describe("mergeVisitorAttributionIntoUser", () => {
  it("merges UTM fields from the visitor row onto a user with no attribution", () => {
    recordVisitorAttribution(db, "visitor-a", {
      utm_source: "reddit",
      utm_medium: "social",
      utm_campaign: "launch",
      landing_page: "/",
      referrer: "https://reddit.com/r/foo",
    });
    const userId = seedUser(db, "merger", "merger@example.com", "password1234");

    const merged = mergeVisitorAttributionIntoUser(db, userId, "visitor-a");
    expect(merged).toBe(true);

    const userRow = db
      .prepare(
        "SELECT utm_source, utm_medium, utm_campaign, landing_page, signup_referrer FROM users WHERE id = ?",
      )
      .get(userId) as Record<string, string | null>;
    expect(userRow.utm_source).toBe("reddit");
    expect(userRow.utm_medium).toBe("social");
    expect(userRow.utm_campaign).toBe("launch");
    expect(userRow.landing_page).toBe("/");
    expect(userRow.signup_referrer).toBe("https://reddit.com/r/foo");
  });

  it("claims the visitor row even when the user already has attribution", () => {
    recordVisitorAttribution(db, "visitor-a", { utm_source: "reddit" });
    const userId = seedUser(db, "merger", "merger@example.com", "password1234");
    // Pre-populate the user with different UTM — merge should NOT overwrite.
    db.prepare(
      "UPDATE users SET utm_source = 'direct', utm_medium = 'pre' WHERE id = ?",
    ).run(userId);

    const merged = mergeVisitorAttributionIntoUser(db, userId, "visitor-a");
    // storeSignupAttribution's `utm_source IS NULL` guard stops the write.
    expect(merged).toBe(false);

    const userRow = db
      .prepare("SELECT utm_source FROM users WHERE id = ?")
      .get(userId) as { utm_source: string };
    expect(userRow.utm_source).toBe("direct"); // preserved

    // But the visitor row is still claimed so it stops counting as unclaimed.
    const visitor = getVisitorAttribution(db, "visitor-a")!;
    expect(visitor.claimedUserId).toBe(userId);
  });

  it("returns false when visitorId is missing", () => {
    const userId = seedUser(db, "u", "u@example.com", "password1234");
    expect(mergeVisitorAttributionIntoUser(db, userId, null)).toBe(false);
    expect(mergeVisitorAttributionIntoUser(db, userId, undefined)).toBe(false);
  });

  it("returns false when no visitor row exists", () => {
    const userId = seedUser(db, "u", "u@example.com", "password1234");
    expect(mergeVisitorAttributionIntoUser(db, userId, "visitor-ghost")).toBe(false);
  });
});

// ── W/L cache + claim merge ───────────────────────────────────────────────

describe("recordVisitorGamePlay W/L cache", () => {
  beforeEach(() => {
    recordVisitorAttribution(db, "v1", { utm_source: "reddit" });
  });

  it("creates a 'direct' row and bumps W/L for visitors who never hit a UTM URL", () => {
    // Regression test: previously the cache update was guarded on
    // existing-row UPDATE.changes > 0, which silently dropped W/L
    // updates for the majority of anonymous players (no UTM = no row).
    recordVisitorGamePlay(db, "v-no-utm", "single", "classic", true);
    const row = getVisitorAttribution(db, "v-no-utm")!;
    expect(row.utmSource).toBe("direct");
    expect(row.lifetimeWins).toBe(1);
    expect(row.currentStreak).toBe(1);
  });

  it("bumps lifetime_wins and current_streak on a win outcome", () => {
    recordVisitorGamePlay(db, "v1", "single", "classic", true);
    const row = getVisitorAttribution(db, "v1")!;
    expect(row.lifetimeWins).toBe(1);
    expect(row.lifetimeLosses).toBe(0);
    expect(row.currentStreak).toBe(1);
    expect(row.bestWinStreak).toBe(1);
  });

  it("bumps lifetime_losses and decrements streak on a loss outcome", () => {
    recordVisitorGamePlay(db, "v1", "single", "classic", false);
    const row = getVisitorAttribution(db, "v1")!;
    expect(row.lifetimeLosses).toBe(1);
    expect(row.currentStreak).toBe(-1);
  });

  it("leaves W/L untouched when outcome is null (default)", () => {
    recordVisitorGamePlay(db, "v1", "single", "classic"); // no outcome
    const row = getVisitorAttribution(db, "v1")!;
    expect(row.lifetimeWins).toBe(0);
    expect(row.lifetimeLosses).toBe(0);
    expect(row.currentStreak).toBe(0);
  });
});

describe("claimVisitorAttribution W/L merge", () => {
  it("folds visitor W/L into a fresh user row on first claim, adopting the streak", () => {
    // Typical signup flow: brand-new user with zero stats claims their
    // guest visitor row. Streak is adopted verbatim from the visitor.
    const userId = seedUser(db, "claimer", "claimer@example.com", "password1234");
    recordVisitorAttribution(db, "v-claim", { utm_source: "twitter" });
    // Build up some visitor stats: 4 wins, 1 loss, ending on a +3 streak.
    recordVisitorGamePlay(db, "v-claim", "single", "classic", true);
    recordVisitorGamePlay(db, "v-claim", "single", "classic", false);
    recordVisitorGamePlay(db, "v-claim", "single", "classic", true);
    recordVisitorGamePlay(db, "v-claim", "single", "classic", true);
    recordVisitorGamePlay(db, "v-claim", "single", "classic", true);

    const claimed = claimVisitorAttribution(db, "v-claim", userId);
    expect(claimed).not.toBeNull();

    const u = db
      .prepare(
        "SELECT lifetime_wins, lifetime_losses, current_streak, best_win_streak FROM users WHERE id = ?",
      )
      .get(userId) as {
      lifetime_wins: number;
      lifetime_losses: number;
      current_streak: number;
      best_win_streak: number;
    };
    expect(u.lifetime_wins).toBe(4);
    expect(u.lifetime_losses).toBe(1);
    expect(u.current_streak).toBe(3); // adopted verbatim from visitor (user was fresh)
    expect(u.best_win_streak).toBe(3); // MAX(0, 3)
  });

  it("preserves the user's existing streak when claiming onto a non-fresh account", () => {
    // W3 guard: a logged-in user with established stats who later
    // claims an unrelated visitor cookie should keep their own streak.
    // W/L sums still compose, best_win_streak still takes MAX, but the
    // current_streak is the user's own (not the visitor's).
    const userId = seedUser(db, "established", "est@example.com", "password1234");
    db.prepare(
      "UPDATE users SET lifetime_wins = ?, lifetime_losses = ?, current_streak = ?, best_win_streak = ? WHERE id = ?",
    ).run(20, 5, 7, 7, userId);

    recordVisitorAttribution(db, "v-late", { utm_source: "reddit" });
    recordVisitorGamePlay(db, "v-late", "single", "classic", false);
    recordVisitorGamePlay(db, "v-late", "single", "classic", false);
    recordVisitorGamePlay(db, "v-late", "single", "classic", false);

    claimVisitorAttribution(db, "v-late", userId);

    const u = db
      .prepare("SELECT lifetime_wins, lifetime_losses, current_streak, best_win_streak FROM users WHERE id = ?")
      .get(userId) as { lifetime_wins: number; lifetime_losses: number; current_streak: number; best_win_streak: number };
    expect(u.lifetime_wins).toBe(20); // +0 from visitor (visitor had 0 wins)
    expect(u.lifetime_losses).toBe(8); // 5 + 3
    expect(u.current_streak).toBe(7); // user's own streak preserved (NOT -3)
    expect(u.best_win_streak).toBe(7); // MAX
  });

  it("does NOT re-fold W/L on a re-claim by the same user (idempotent)", () => {
    const userId = seedUser(db, "rclaimer", "rclaimer@example.com", "password1234");
    recordVisitorAttribution(db, "v-rclaim", { utm_source: "reddit" });
    recordVisitorGamePlay(db, "v-rclaim", "single", "classic", true);
    recordVisitorGamePlay(db, "v-rclaim", "single", "classic", true);

    claimVisitorAttribution(db, "v-rclaim", userId); // first claim
    claimVisitorAttribution(db, "v-rclaim", userId); // re-claim
    claimVisitorAttribution(db, "v-rclaim", userId); // and again

    const u = db
      .prepare("SELECT lifetime_wins FROM users WHERE id = ?")
      .get(userId) as { lifetime_wins: number };
    expect(u.lifetime_wins).toBe(2); // not 6
  });
});
