import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestDb, seedUser, seedAdminUser } from "../test/dbHelper";
import type { Database as DatabaseType } from "better-sqlite3";

vi.mock("./email", () => ({
  sendRewardAwardedEmail: vi.fn().mockResolvedValue(undefined),
  sendClaimReminderEmail: vi.fn().mockResolvedValue(undefined),
  sendRewardExpiredEmail: vi.fn().mockResolvedValue(undefined),
  buildGiveawayLossEmail: vi.fn(
    (_db: unknown, { username }: { username: string }) => ({
      subject: `Better luck next time — ${username}`,
      html: `<p>Hey ${username}</p>`,
      text: `Hey ${username}`,
    }),
  ),
}));

vi.mock("./emailNotification", () => ({
  sendMarketingEmail: vi.fn().mockResolvedValue({ sent: 1 }),
  // The notifier reads trigger config + per-user prefs before sending.
  // Stub both as enabled/opted-in so the fire-and-forget batch in
  // executeRandomRoll runs without touching the mocked DB schema.
  getTriggerConfig: vi.fn().mockReturnValue({
    type: "giveaway_loss",
    isEnabled: true,
    cooldownHours: 0,
    thresholdJson: null,
    templateId: null,
    updatedAt: "",
  }),
  getEmailPreferences: vi.fn().mockReturnValue({
    emailEnabled: true,
    streakRisk: false,
    streakSave: false,
    inactivityReminder: false,
    weeklyDigest: false,
    leaderboardPlacement: false,
    promotional: false,
    giveawayLoss: true,
    preferredHour: 10,
    timezone: "UTC",
  }),
}));

import {
  addReward,
  listRewards,
  getReward,
  deleteReward,
  awardRewardToUser,
  previewRandomRoll,
  confirmPendingAward,
  discardPendingAward,
  getUserRewards,
  claimReward,
  claimRewardByToken,
  expireOverdueRewards,
  sendClaimReminders,
  searchUsers,
  getQualifyingPlayers,
} from "./rewards";
import {
  sendRewardAwardedEmail,
  sendClaimReminderEmail,
  sendRewardExpiredEmail,
} from "./email";
import { sendMarketingEmail } from "./emailNotification";

let db: DatabaseType;
let adminId: string;

beforeEach(() => {
  db = createTestDb();
  adminId = seedAdminUser(db);
});

function createReward(
  overrides: Partial<{ rewardType: string; amountCents: number; code: string; description: string }> = {}
) {
  return addReward(
    db,
    {
      amountCents: 2500,
      code: "GIFT-" + Math.random().toString(36).slice(2, 10).toUpperCase(),
      ...overrides,
    },
    adminId
  );
}

describe("addReward", () => {
  it("creates a reward with defaults", () => {
    const reward = createReward({ code: "ABC-123", amountCents: 5000, description: "Test gift" });
    expect(reward).toMatchObject({
      rewardType: "amazon_gift_card",
      amountCents: 5000,
      code: "ABC-123",
      description: "Test gift",
      status: "available",
      createdBy: adminId,
      award: null,
    });
    expect(reward.id).toBeTruthy();
    expect(reward.createdAt).toBeTruthy();
  });

  it("trims code and description whitespace", () => {
    const reward = createReward({ code: "  TRIMMED  ", description: "  desc  " });
    expect(reward.code).toBe("TRIMMED");
    expect(reward.description).toBe("desc");
  });

  it("rejects missing code", () => {
    expect(() => addReward(db, { amountCents: 1000, code: "" }, adminId)).toThrow(
      "Gift card code is required"
    );
  });

  it("rejects whitespace-only code", () => {
    expect(() => addReward(db, { amountCents: 1000, code: "   " }, adminId)).toThrow(
      "Gift card code is required"
    );
  });

  it("rejects invalid reward type", () => {
    expect(() => createReward({ rewardType: "paypal" })).toThrow("Invalid reward type");
  });

  it("rejects amount exceeding max", () => {
    expect(() => createReward({ amountCents: 100_000_01 })).toThrow(
      "Amount exceeds maximum allowed value"
    );
  });

  it("rejects non-integer amount", () => {
    expect(() => createReward({ amountCents: 10.5 })).toThrow(
      "Amount must be a positive integer (in cents)"
    );
  });

  it("rejects zero amount", () => {
    expect(() => createReward({ amountCents: 0 })).toThrow(
      "Amount must be a positive integer (in cents)"
    );
  });

  it("rejects negative amount", () => {
    expect(() => createReward({ amountCents: -100 })).toThrow(
      "Amount must be a positive integer (in cents)"
    );
  });

  it("rejects description exceeding 500 chars", () => {
    expect(() => createReward({ description: "x".repeat(501) })).toThrow(
      "Description exceeds maximum length"
    );
  });

  it("rejects code exceeding 200 chars", () => {
    expect(() => createReward({ code: "A".repeat(201) })).toThrow(
      "Code exceeds maximum length"
    );
  });

  it("rejects duplicate code", () => {
    createReward({ code: "DUPE-001" });
    expect(() => createReward({ code: "DUPE-001" })).toThrow(
      "A reward with this code already exists"
    );
  });
});

describe("listRewards", () => {
  it("returns empty list when no rewards exist", () => {
    const result = listRewards(db, {});
    expect(result).toMatchObject({ rewards: [], total: 0, page: 1, totalPages: 0 });
  });

  it("paginates results", () => {
    for (let i = 0; i < 5; i++) createReward({ code: `LIST-${i}` });

    const page1 = listRewards(db, { page: 1, pageSize: 2 });
    expect(page1.rewards).toHaveLength(2);
    expect(page1.total).toBe(5);
    expect(page1.totalPages).toBe(3);
    expect(page1.page).toBe(1);
    expect(page1.pageSize).toBe(2);

    const page3 = listRewards(db, { page: 3, pageSize: 2 });
    expect(page3.rewards).toHaveLength(1);
  });

  it("filters by status", () => {
    const r1 = createReward({ code: "AVAIL-1" });
    createReward({ code: "AVAIL-2" });

    const userId = seedUser(db, "lister", "lister@test.com");
    awardRewardToUser(db, r1.id, userId, adminId);

    const available = listRewards(db, { status: "available" });
    expect(available.total).toBe(1);
    expect(available.rewards[0].code).toBe("AVAIL-2");

    const awarded = listRewards(db, { status: "awarded" });
    expect(awarded.total).toBe(1);
    expect(awarded.rewards[0].status).toBe("awarded");
  });

  it("returns all when status is 'all'", () => {
    createReward({ code: "ALL-1" });
    const r2 = createReward({ code: "ALL-2" });
    const userId = seedUser(db, "alluser", "all@test.com");
    awardRewardToUser(db, r2.id, userId, adminId);

    const result = listRewards(db, { status: "all" });
    expect(result.total).toBe(2);
  });

  it("includes award details for awarded rewards", () => {
    const reward = createReward({ code: "AWARD-JOIN" });
    const userId = seedUser(db, "joiner", "joiner@test.com");
    awardRewardToUser(db, reward.id, userId, adminId);

    const result = listRewards(db, {});
    const found = result.rewards.find((r) => r.id === reward.id);
    expect(found!.award).not.toBeNull();
    expect(found!.award!.username).toBe("joiner");
    expect(found!.award!.awardMethod).toBe("manual");
  });
});

describe("getReward", () => {
  it("returns reward by id", () => {
    const reward = createReward({ code: "GET-1" });
    const fetched = getReward(db, reward.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.code).toBe("GET-1");
    expect(fetched!.award).toBeNull();
  });

  it("returns null for nonexistent id", () => {
    expect(getReward(db, "nonexistent-id")).toBeNull();
  });

  it("includes award details when awarded", () => {
    const reward = createReward({ code: "GET-AWARD" });
    const userId = seedUser(db, "getter", "getter@test.com");
    awardRewardToUser(db, reward.id, userId, adminId);

    const fetched = getReward(db, reward.id);
    expect(fetched!.status).toBe("awarded");
    expect(fetched!.award).not.toBeNull();
    expect(fetched!.award!.userId).toBe(userId);
  });
});

describe("deleteReward", () => {
  it("deletes an available reward", () => {
    const reward = createReward({ code: "DEL-1" });
    expect(deleteReward(db, reward.id)).toBe(true);
    expect(getReward(db, reward.id)).toBeNull();
  });

  it("cannot delete an awarded reward", () => {
    const reward = createReward({ code: "DEL-AWARDED" });
    const userId = seedUser(db, "deluser", "deluser@test.com");
    awardRewardToUser(db, reward.id, userId, adminId);

    expect(deleteReward(db, reward.id)).toBe(false);
    expect(getReward(db, reward.id)).not.toBeNull();
  });

  it("returns false for nonexistent reward", () => {
    expect(deleteReward(db, "no-such-id")).toBe(false);
  });
});

describe("awardRewardToUser", () => {
  it("awards reward to user", () => {
    const reward = createReward({ code: "MANUAL-1" });
    const userId = seedUser(db, "winner", "winner@test.com");

    const result = awardRewardToUser(db, reward.id, userId, adminId);
    expect(result.status).toBe("awarded");
    expect(result.award).not.toBeNull();
    expect(result.award!.userId).toBe(userId);
    expect(result.award!.awardMethod).toBe("manual");
    expect(result.award!.awardCriteria).toBeNull();
    expect(result.award!.awardedBy).toBe(adminId);
  });

  it("throws when reward not found", () => {
    const userId = seedUser(db, "u1", "u1@test.com");
    expect(() => awardRewardToUser(db, "fake-id", userId, adminId)).toThrow("Reward not found");
  });

  it("throws when reward already awarded", () => {
    const reward = createReward({ code: "DOUBLE-AWARD" });
    const u1 = seedUser(db, "ua", "ua@test.com");
    const u2 = seedUser(db, "ub", "ub@test.com");
    awardRewardToUser(db, reward.id, u1, adminId);

    expect(() => awardRewardToUser(db, reward.id, u2, adminId)).toThrow("Reward is not available");
  });

  it("throws when user not found", () => {
    const reward = createReward({ code: "NO-USER" });
    expect(() => awardRewardToUser(db, reward.id, "fake-user", adminId)).toThrow("User not found");
  });
});

describe("previewRandomRoll", () => {
  beforeEach(() => {
    vi.mocked(sendRewardAwardedEmail).mockClear();
  });

  it("creates a pending-review award without sending the winner email", () => {
    const reward = createReward({ code: "ROLL-1" });
    const userId = seedUser(db, "roller", "roller@test.com");
    db.prepare("UPDATE users SET lifetime_score = ? WHERE id = ?").run(500, userId);

    const criteria = { minPoints: 100, period: "all_time" as const, useLifetimePoints: true };
    const result = previewRandomRoll(db, reward.id, criteria, adminId);

    expect(result.candidateAward.userId).toBe(userId);
    expect(result.reward.status).toBe("awarded");
    expect(result.reward.award!.awardMethod).toBe("random_roll");
    expect(result.reward.award!.pendingReviewAt).not.toBeNull();
    expect(result.totalQualifying).toBe(1);
    expect(sendRewardAwardedEmail).not.toHaveBeenCalled();
  });

  it("throws when no qualifying players", () => {
    const reward = createReward({ code: "ROLL-EMPTY" });
    const criteria = { minPoints: 99999, period: "all_time" as const, useLifetimePoints: true };

    expect(() => previewRandomRoll(db, reward.id, criteria, adminId)).toThrow(
      "No qualifying players found"
    );
  });

  it("throws when reward not available", () => {
    const reward = createReward({ code: "ROLL-TAKEN" });
    const userId = seedUser(db, "ru", "ru@test.com");
    awardRewardToUser(db, reward.id, userId, adminId);

    const criteria = { minPoints: 0, period: "all_time" as const, useLifetimePoints: true };
    expect(() => previewRandomRoll(db, reward.id, criteria, adminId)).toThrow(
      "Reward is not available"
    );
  });

  it("throws when reward not found", () => {
    const criteria = { minPoints: 0, period: "all_time" as const, useLifetimePoints: true };
    expect(() => previewRandomRoll(db, "missing", criteria, adminId)).toThrow("Reward not found");
  });

  it("stores referral bonus + qualifying-pool snapshot in award_criteria JSON", () => {
    const reward = createReward({ code: "ROLL-REF" });
    const userId = seedUser(db, "refroller", "refroller@test.com");
    db.prepare("UPDATE users SET lifetime_score = ?, referral_code = ? WHERE id = ?").run(500, "TESTCODE", userId);

    const ref1 = seedUser(db, "ref1", "ref1@test.com");
    const ref2 = seedUser(db, "ref2", "ref2@test.com");
    const { v4: uuidv4 } = require("uuid");
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO referrals (id, referrer_id, referred_id, referral_code, status, created_at) VALUES (?, ?, ?, ?, 'credited', ?)"
    ).run(uuidv4(), userId, ref1, "TESTCODE", now);
    db.prepare(
      "INSERT INTO referrals (id, referrer_id, referred_id, referral_code, status, created_at) VALUES (?, ?, ?, ?, 'credited', ?)"
    ).run(uuidv4(), userId, ref2, "TESTCODE", now);

    const criteria = { minPoints: 100, period: "all_time" as const, useLifetimePoints: true };
    const result = previewRandomRoll(db, reward.id, criteria, adminId);

    expect(result.candidateAward.userId).toBe(userId);
    const awardCriteria = JSON.parse(result.reward.award!.awardCriteria!);
    expect(awardCriteria.totalEntries).toBe(3);
    expect(awardCriteria.winnerReferralBonus).toBe(2);
    expect(Array.isArray(awardCriteria.qualifyingUserIds)).toBe(true);
  });

  it("gives equal weight to players with no referrals", () => {
    const reward = createReward({ code: "ROLL-EQ" });
    const u1 = seedUser(db, "eq1", "eq1@test.com");
    const u2 = seedUser(db, "eq2", "eq2@test.com");
    db.prepare("UPDATE users SET lifetime_score = ? WHERE id = ?").run(500, u1);
    db.prepare("UPDATE users SET lifetime_score = ? WHERE id = ?").run(500, u2);

    const criteria = { minPoints: 100, period: "all_time" as const, useLifetimePoints: true };
    const result = previewRandomRoll(db, reward.id, criteria, adminId);

    const awardCriteria = JSON.parse(result.reward.award!.awardCriteria!);
    expect(awardCriteria.totalEntries).toBe(2);
    expect(awardCriteria.winnerReferralBonus).toBe(0);
  });

  it("returns the qualifying-but-not-winning players in nonWinners", () => {
    const reward = createReward({ code: "ROLL-LOSERS" });
    const u1 = seedUser(db, "loser1", "loser1@test.com");
    const u2 = seedUser(db, "loser2", "loser2@test.com");
    const u3 = seedUser(db, "loser3", "loser3@test.com");
    for (const u of [u1, u2, u3]) {
      db.prepare("UPDATE users SET lifetime_score = ? WHERE id = ?").run(500, u);
    }

    const criteria = { minPoints: 100, period: "all_time" as const, useLifetimePoints: true };
    const result = previewRandomRoll(db, reward.id, criteria, adminId);

    expect(result.totalQualifying).toBe(3);
    expect(result.nonWinners).toHaveLength(2);
    expect(result.nonWinners.map((p) => p.id)).not.toContain(result.candidateAward.userId);
    // Every non-winner must have an email — that's what the consolation
    // sender depends on at confirm time.
    expect(result.nonWinners.every((p) => p.email)).toBe(true);
  });

});

describe("getQualifyingPlayers", () => {
  it("filters by lifetime points", () => {
    const u1 = seedUser(db, "high", "high@test.com");
    const u2 = seedUser(db, "low", "low@test.com");
    db.prepare("UPDATE users SET lifetime_score = ? WHERE id = ?").run(1000, u1);
    db.prepare("UPDATE users SET lifetime_score = ? WHERE id = ?").run(50, u2);

    const players = getQualifyingPlayers(db, {
      minPoints: 500,
      period: "all_time",
      useLifetimePoints: true,
    });

    expect(players).toHaveLength(1);
    expect(players[0].id).toBe(u1);
    expect(players[0].points).toBe(1000);
  });

  it("counts games played with lifetime mode", () => {
    const userId = seedUser(db, "gamer", "gamer@test.com");
    db.prepare("UPDATE users SET lifetime_score = ? WHERE id = ?").run(200, userId);
    db.prepare(
      "INSERT INTO user_game_history (user_id, game_type, game_mode, score, played_at) VALUES (?, 'singleplayer', 'classic', ?, ?)"
    ).run(userId, 100, new Date().toISOString());
    db.prepare(
      "INSERT INTO user_game_history (user_id, game_type, game_mode, score, played_at) VALUES (?, 'singleplayer', 'classic', ?, ?)"
    ).run(userId, 100, new Date().toISOString());

    const players = getQualifyingPlayers(db, {
      minPoints: 0,
      period: "all_time",
      useLifetimePoints: true,
    });

    expect(players[0].gamesPlayed).toBe(2);
  });

  it("qualifies by last_week period scores", () => {
    const userId = seedUser(db, "weekly", "weekly@test.com");
    const recent = new Date();
    const old = new Date();
    old.setDate(old.getDate() - 14);

    db.prepare(
      "INSERT INTO user_game_history (user_id, game_type, game_mode, score, played_at) VALUES (?, 'singleplayer', 'classic', ?, ?)"
    ).run(userId, 300, recent.toISOString());
    db.prepare(
      "INSERT INTO user_game_history (user_id, game_type, game_mode, score, played_at) VALUES (?, 'singleplayer', 'classic', ?, ?)"
    ).run(userId, 5000, old.toISOString());

    const players = getQualifyingPlayers(db, {
      minPoints: 100,
      period: "last_week",
      useLifetimePoints: false,
    });

    expect(players).toHaveLength(1);
    expect(players[0].points).toBe(300);
  });

  it("qualifies by last_month period scores", () => {
    const userId = seedUser(db, "monthly", "monthly@test.com");
    const recent = new Date();
    recent.setDate(recent.getDate() - 15);
    const old = new Date();
    old.setMonth(old.getMonth() - 2);

    db.prepare(
      "INSERT INTO user_game_history (user_id, game_type, game_mode, score, played_at) VALUES (?, 'singleplayer', 'classic', ?, ?)"
    ).run(userId, 400, recent.toISOString());
    db.prepare(
      "INSERT INTO user_game_history (user_id, game_type, game_mode, score, played_at) VALUES (?, 'singleplayer', 'classic', ?, ?)"
    ).run(userId, 9000, old.toISOString());

    const players = getQualifyingPlayers(db, {
      minPoints: 200,
      period: "last_month",
      useLifetimePoints: false,
    });

    expect(players).toHaveLength(1);
    expect(players[0].points).toBe(400);
  });

  it("qualifies by last_3_months period scores", () => {
    const userId = seedUser(db, "quarterly", "quarterly@test.com");
    const recent = new Date();
    recent.setMonth(recent.getMonth() - 2);
    const old = new Date();
    old.setMonth(old.getMonth() - 6);

    db.prepare(
      "INSERT INTO user_game_history (user_id, game_type, game_mode, score, played_at) VALUES (?, 'singleplayer', 'classic', ?, ?)"
    ).run(userId, 700, recent.toISOString());
    db.prepare(
      "INSERT INTO user_game_history (user_id, game_type, game_mode, score, played_at) VALUES (?, 'singleplayer', 'classic', ?, ?)"
    ).run(userId, 8000, old.toISOString());

    const players = getQualifyingPlayers(db, {
      minPoints: 500,
      period: "last_3_months",
      useLifetimePoints: false,
    });

    expect(players).toHaveLength(1);
    expect(players[0].points).toBe(700);
  });

  it("qualifies by all_time period scores (sum of history)", () => {
    const userId = seedUser(db, "alltime", "alltime@test.com");
    db.prepare(
      "INSERT INTO user_game_history (user_id, game_type, game_mode, score, played_at) VALUES (?, 'singleplayer', 'classic', ?, ?)"
    ).run(userId, 200, "2020-01-01T00:00:00Z");
    db.prepare(
      "INSERT INTO user_game_history (user_id, game_type, game_mode, score, played_at) VALUES (?, 'singleplayer', 'classic', ?, ?)"
    ).run(userId, 300, "2024-06-01T00:00:00Z");

    const players = getQualifyingPlayers(db, {
      minPoints: 400,
      period: "all_time",
      useLifetimePoints: false,
    });

    expect(players).toHaveLength(1);
    expect(players[0].points).toBe(500);
  });

  it("excludes inactive users", () => {
    const userId = seedUser(db, "inactive", "inactive@test.com");
    db.prepare("UPDATE users SET is_active = 0, lifetime_score = 9999 WHERE id = ?").run(userId);

    const players = getQualifyingPlayers(db, {
      minPoints: 0,
      period: "all_time",
      useLifetimePoints: true,
    });

    const found = players.find((p) => p.id === userId);
    expect(found).toBeUndefined();
  });

  it("returns players sorted by points descending", () => {
    const u1 = seedUser(db, "mid", "mid@test.com");
    const u2 = seedUser(db, "top", "top@test.com");
    const u3 = seedUser(db, "bot", "bot@test.com");
    db.prepare("UPDATE users SET lifetime_score = ? WHERE id = ?").run(500, u1);
    db.prepare("UPDATE users SET lifetime_score = ? WHERE id = ?").run(1000, u2);
    db.prepare("UPDATE users SET lifetime_score = ? WHERE id = ?").run(100, u3);

    const players = getQualifyingPlayers(db, {
      minPoints: 50,
      period: "all_time",
      useLifetimePoints: true,
    });

    expect(players[0].id).toBe(u2);
    expect(players[1].id).toBe(u1);
    expect(players[2].id).toBe(u3);
  });

  it("returns streak for each qualifying player (alive streak)", () => {
    const userId = seedUser(db, "streaker", "streaker@test.com");
    db.prepare("UPDATE users SET lifetime_score = ? WHERE id = ?").run(500, userId);
    // Alive streak: last completion is today
    db.prepare(
      "UPDATE users SET daily_streak_current = 5, daily_streak_best = 10, daily_streak_last_date = ? WHERE id = ?"
    ).run("2026-04-17", userId);

    const players = getQualifyingPlayers(
      db,
      { minPoints: 100, period: "all_time", useLifetimePoints: true },
      "2026-04-17",
    );

    expect(players).toHaveLength(1);
    expect(players[0].streak).toBe(5);
  });

  it("decays stale streak to 0 in QualifyingPlayer.streak", () => {
    const userId = seedUser(db, "staleuser", "stale@test.com");
    db.prepare("UPDATE users SET lifetime_score = ? WHERE id = ?").run(500, userId);
    // Last completion three days ago relative to "today"
    db.prepare(
      "UPDATE users SET daily_streak_current = 5, daily_streak_best = 10, daily_streak_last_date = ? WHERE id = ?"
    ).run("2026-04-14", userId);

    const players = getQualifyingPlayers(
      db,
      { minPoints: 100, period: "all_time", useLifetimePoints: true },
      "2026-04-17",
    );

    expect(players).toHaveLength(1);
    expect(players[0].streak).toBe(0);
  });
});

describe("getQualifyingPlayers — streak modes", () => {
  const TODAY = "2026-04-17";
  const YESTERDAY = "2026-04-16";
  const TWO_DAYS_AGO = "2026-04-15";

  function setStreak(userId: string, current: number, best: number, lastDate: string | null) {
    db.prepare(
      `UPDATE users
         SET daily_streak_current = ?,
             daily_streak_best = ?,
             daily_streak_last_date = ?
       WHERE id = ?`
    ).run(current, best, lastDate, userId);
  }

  it("streak_only: qualifies users whose active streak meets threshold", () => {
    const u1 = seedUser(db, "u1", "u1@test.com");
    const u2 = seedUser(db, "u2", "u2@test.com");
    const u3 = seedUser(db, "u3", "u3@test.com");
    setStreak(u1, 7, 7, TODAY);      // alive, qualifies
    setStreak(u2, 3, 3, YESTERDAY);  // alive but below threshold
    setStreak(u3, 10, 10, TODAY);    // alive, qualifies

    const players = getQualifyingPlayers(
      db,
      { mode: "streak_only", minPoints: 0, period: "all_time", useLifetimePoints: true, minStreak: 5 },
      TODAY,
    );

    const ids = players.map((p) => p.id).sort();
    expect(ids).toEqual([u1, u3].sort());
  });

  it("streak_only: excludes decayed streaks (lastDate older than yesterday)", () => {
    const u1 = seedUser(db, "alive", "alive@test.com");
    const u2 = seedUser(db, "dead", "dead@test.com");
    setStreak(u1, 7, 7, YESTERDAY);       // alive — completed yesterday
    setStreak(u2, 20, 20, TWO_DAYS_AGO);  // decayed — last completion 2 days ago

    const players = getQualifyingPlayers(
      db,
      { mode: "streak_only", minPoints: 0, period: "all_time", useLifetimePoints: true, minStreak: 5 },
      TODAY,
    );

    expect(players.map((p) => p.id)).toEqual([u1]);
    expect(players[0].streak).toBe(7);
  });

  it("streak_only: treats null lastDate as streak 0", () => {
    const u1 = seedUser(db, "nulluser", "null@test.com");
    setStreak(u1, 0, 0, null);

    const players = getQualifyingPlayers(
      db,
      { mode: "streak_only", minPoints: 0, period: "all_time", useLifetimePoints: true, minStreak: 1 },
      TODAY,
    );
    expect(players).toHaveLength(0);
  });

  it("points_and_streak: requires BOTH thresholds", () => {
    const both = seedUser(db, "both", "both@test.com");
    const pointsOnly = seedUser(db, "ponly", "ponly@test.com");
    const streakOnly = seedUser(db, "sonly", "sonly@test.com");
    const neither = seedUser(db, "neither", "neither@test.com");

    db.prepare("UPDATE users SET lifetime_score = ? WHERE id = ?").run(1000, both);
    db.prepare("UPDATE users SET lifetime_score = ? WHERE id = ?").run(1000, pointsOnly);
    db.prepare("UPDATE users SET lifetime_score = ? WHERE id = ?").run(50, streakOnly);
    db.prepare("UPDATE users SET lifetime_score = ? WHERE id = ?").run(50, neither);

    setStreak(both, 10, 10, TODAY);
    setStreak(pointsOnly, 1, 1, TODAY);
    setStreak(streakOnly, 10, 10, TODAY);
    setStreak(neither, 1, 1, TODAY);

    const players = getQualifyingPlayers(
      db,
      {
        mode: "points_and_streak",
        minPoints: 500,
        period: "all_time",
        useLifetimePoints: true,
        minStreak: 5,
      },
      TODAY,
    );

    expect(players.map((p) => p.id)).toEqual([both]);
  });

  it("points_or_streak: EITHER threshold qualifies", () => {
    const both = seedUser(db, "both", "both@test.com");
    const pointsOnly = seedUser(db, "ponly", "ponly@test.com");
    const streakOnly = seedUser(db, "sonly", "sonly@test.com");
    const neither = seedUser(db, "neither", "neither@test.com");

    db.prepare("UPDATE users SET lifetime_score = ? WHERE id = ?").run(1000, both);
    db.prepare("UPDATE users SET lifetime_score = ? WHERE id = ?").run(1000, pointsOnly);
    db.prepare("UPDATE users SET lifetime_score = ? WHERE id = ?").run(50, streakOnly);
    db.prepare("UPDATE users SET lifetime_score = ? WHERE id = ?").run(50, neither);

    setStreak(both, 10, 10, TODAY);
    setStreak(pointsOnly, 1, 1, TODAY);
    setStreak(streakOnly, 10, 10, TODAY);
    setStreak(neither, 1, 1, TODAY);

    const players = getQualifyingPlayers(
      db,
      {
        mode: "points_or_streak",
        minPoints: 500,
        period: "all_time",
        useLifetimePoints: true,
        minStreak: 5,
      },
      TODAY,
    );

    const ids = players.map((p) => p.id).sort();
    expect(ids).toEqual([both, pointsOnly, streakOnly].sort());
  });

  it("points_only: unchanged behavior when mode field is omitted (backwards compat)", () => {
    const userId = seedUser(db, "legacy", "legacy@test.com");
    db.prepare("UPDATE users SET lifetime_score = ? WHERE id = ?").run(1000, userId);
    setStreak(userId, 0, 0, null); // no streak at all

    const players = getQualifyingPlayers(
      db,
      { minPoints: 500, period: "all_time", useLifetimePoints: true },
      TODAY,
    );

    expect(players).toHaveLength(1);
    expect(players[0].id).toBe(userId);
    expect(players[0].streak).toBe(0);
  });

  it("streak_only with period-based (non-lifetime) query still filters correctly", () => {
    const userId = seedUser(db, "period-streak", "ps@test.com");
    db.prepare(
      "INSERT INTO user_game_history (user_id, game_type, game_mode, score, played_at) VALUES (?, 'singleplayer', 'classic', 50, ?)"
    ).run(userId, new Date().toISOString());
    setStreak(userId, 6, 6, TODAY);

    const players = getQualifyingPlayers(
      db,
      { mode: "streak_only", minPoints: 0, period: "last_week", useLifetimePoints: false, minStreak: 5 },
      TODAY,
    );

    expect(players).toHaveLength(1);
    expect(players[0].streak).toBe(6);
  });

  it("streak_only: sorts players by streak descending in the preview", () => {
    const low = seedUser(db, "low", "low@test.com");
    const mid = seedUser(db, "mid", "mid@test.com");
    const high = seedUser(db, "high", "high@test.com");
    setStreak(low, 5, 5, TODAY);
    setStreak(mid, 12, 12, TODAY);
    setStreak(high, 20, 20, TODAY);

    const players = getQualifyingPlayers(
      db,
      { mode: "streak_only", minPoints: 0, period: "all_time", useLifetimePoints: true, minStreak: 1 },
      TODAY,
    );

    expect(players.map((p) => p.id)).toEqual([high, mid, low]);
  });

  it("excludes inactive users across all modes", () => {
    const userId = seedUser(db, "gone", "gone@test.com");
    db.prepare("UPDATE users SET is_active = 0, lifetime_score = 9999 WHERE id = ?").run(userId);
    setStreak(userId, 50, 50, TODAY);

    const streakPlayers = getQualifyingPlayers(
      db,
      { mode: "streak_only", minPoints: 0, period: "all_time", useLifetimePoints: true, minStreak: 1 },
      TODAY,
    );
    const orPlayers = getQualifyingPlayers(
      db,
      { mode: "points_or_streak", minPoints: 100, period: "all_time", useLifetimePoints: true, minStreak: 1 },
      TODAY,
    );
    expect(streakPlayers.find((p) => p.id === userId)).toBeUndefined();
    expect(orPlayers.find((p) => p.id === userId)).toBeUndefined();
  });
});

describe("previewRandomRoll — criteria persistence", () => {
  it("persists mode and minStreak in award_criteria JSON", () => {
    const reward = createReward({ code: "ROLL-STREAK" });
    const userId = seedUser(db, "sroller", "sroller@test.com");
    const today = new Date().toISOString().slice(0, 10);
    db.prepare(
      "UPDATE users SET daily_streak_current = 7, daily_streak_best = 7, daily_streak_last_date = ? WHERE id = ?"
    ).run(today, userId);

    const criteria = {
      mode: "streak_only" as const,
      minPoints: 0,
      period: "all_time" as const,
      useLifetimePoints: true,
      minStreak: 5,
    };
    const result = previewRandomRoll(db, reward.id, criteria, adminId);

    const awardCriteria = JSON.parse(result.reward.award!.awardCriteria!);
    expect(awardCriteria.mode).toBe("streak_only");
    expect(awardCriteria.minStreak).toBe(5);
  });
});

describe("getUserRewards", () => {
  it("returns rewards with masked codes", () => {
    const reward = createReward({ code: "ABCD-EFGH-1234", amountCents: 5000 });
    const userId = seedUser(db, "rewarder", "rewarder@test.com");
    awardRewardToUser(db, reward.id, userId, adminId);

    const userRewards = getUserRewards(db, userId);
    expect(userRewards).toHaveLength(1);
    expect(userRewards[0].code).toBe("****-1234");
    expect(userRewards[0].amountCents).toBe(5000);
    expect(userRewards[0].awardMethod).toBe("manual");
    expect(userRewards[0].claimedAt).toBeNull();
  });

  it("masks short codes", () => {
    const reward = createReward({ code: "AB" });
    const userId = seedUser(db, "shortcode", "shortcode@test.com");
    awardRewardToUser(db, reward.id, userId, adminId);

    const userRewards = getUserRewards(db, userId);
    expect(userRewards[0].code).toBe("****");
  });

  it("returns empty list for user with no rewards", () => {
    const userId = seedUser(db, "norewards", "norewards@test.com");
    expect(getUserRewards(db, userId)).toEqual([]);
  });
});

describe("claimReward", () => {
  it("reveals full code on claim", () => {
    const reward = createReward({ code: "CLAIM-SECRET-CODE" });
    const userId = seedUser(db, "claimer", "claimer@test.com");
    awardRewardToUser(db, reward.id, userId, adminId);

    const code = claimReward(db, reward.id, userId);
    expect(code).toBe("CLAIM-SECRET-CODE");

    const updated = getReward(db, reward.id);
    expect(updated!.status).toBe("claimed");
    expect(updated!.award!.claimedAt).not.toBeNull();
  });

  it("returns null for wrong user", () => {
    const reward = createReward({ code: "WRONG-USER-CODE" });
    const owner = seedUser(db, "owner", "owner@test.com");
    const other = seedUser(db, "other", "other@test.com");
    awardRewardToUser(db, reward.id, owner, adminId);

    expect(claimReward(db, reward.id, other)).toBeNull();
  });

  it("returns null when already claimed", () => {
    const reward = createReward({ code: "ALREADY-CLAIMED" });
    const userId = seedUser(db, "twoclaim", "twoclaim@test.com");
    awardRewardToUser(db, reward.id, userId, adminId);

    claimReward(db, reward.id, userId);
    expect(claimReward(db, reward.id, userId)).toBeNull();
  });

  it("returns null for nonexistent reward", () => {
    const userId = seedUser(db, "ghost", "ghost@test.com");
    expect(claimReward(db, "no-such-reward", userId)).toBeNull();
  });

  it("returns null for available (unawarded) reward", () => {
    const reward = createReward({ code: "NOT-AWARDED" });
    const userId = seedUser(db, "eager", "eager@test.com");
    expect(claimReward(db, reward.id, userId)).toBeNull();
  });
});

describe("claim window — awarding sets token + 30d expiry", () => {
  it("awardRewardToUser populates a unique claim_token and a 30-day claim_expires_at", () => {
    const reward = createReward();
    const userId = seedUser(db, "expiring1", "exp1@test.com");
    const before = Date.now();
    awardRewardToUser(db, reward.id, userId, adminId);
    const after = Date.now();

    const updated = getReward(db, reward.id)!;
    expect(updated.award).not.toBeNull();
    expect(updated.award!.claimExpiresAt).toBeTruthy();
    expect(updated.award!.voidedAt).toBeNull();

    const expiresMs = Date.parse(updated.award!.claimExpiresAt);
    // Awarded "now" + 30 days (allow 5s slack for the loop overhead)
    const expectedMin = before + 30 * 24 * 60 * 60 * 1000 - 5000;
    const expectedMax = after + 30 * 24 * 60 * 60 * 1000 + 5000;
    expect(expiresMs).toBeGreaterThanOrEqual(expectedMin);
    expect(expiresMs).toBeLessThanOrEqual(expectedMax);

    const tokenRow = db
      .prepare("SELECT claim_token FROM reward_awards WHERE reward_id = ?")
      .get(reward.id) as { claim_token: string };
    expect(tokenRow.claim_token).toMatch(/^[a-f0-9]{32,}$/);
  });

  it("two consecutive awards have distinct tokens", () => {
    const r1 = createReward({ code: "TOKEN-A" });
    const r2 = createReward({ code: "TOKEN-B" });
    const u1 = seedUser(db, "tokA", "tokA@test.com");
    const u2 = seedUser(db, "tokB", "tokB@test.com");
    awardRewardToUser(db, r1.id, u1, adminId);
    awardRewardToUser(db, r2.id, u2, adminId);
    const rows = db
      .prepare("SELECT claim_token FROM reward_awards")
      .all() as { claim_token: string }[];
    expect(new Set(rows.map((r) => r.claim_token)).size).toBe(2);
  });
});

describe("claimRewardByToken", () => {
  function getToken(rewardId: string): string {
    const row = db
      .prepare("SELECT claim_token FROM reward_awards WHERE reward_id = ?")
      .get(rewardId) as { claim_token: string };
    return row.claim_token;
  }

  it("reveals the full code and marks claimed", () => {
    const reward = createReward({ code: "TOKEN-CLAIM-OK" });
    const userId = seedUser(db, "tclaim", "tclaim@test.com");
    awardRewardToUser(db, reward.id, userId, adminId);

    const result = claimRewardByToken(db, getToken(reward.id), userId);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.code).toBe("TOKEN-CLAIM-OK");
      expect(result.amountCents).toBe(2500);
    }

    const updated = getReward(db, reward.id)!;
    expect(updated.status).toBe("claimed");
    expect(updated.award!.claimedAt).not.toBeNull();
  });

  it("rejects with 'invalid' for an unknown token", () => {
    const userId = seedUser(db, "noToken", "n@test.com");
    const result = claimRewardByToken(db, "deadbeef", userId);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("invalid");
  });

  it("rejects with 'wrong_user' when claimed by someone other than the recipient", () => {
    const reward = createReward({ code: "WRONG-USER-TOKEN" });
    const owner = seedUser(db, "ownerT", "ownerT@test.com");
    const other = seedUser(db, "otherT", "otherT@test.com");
    awardRewardToUser(db, reward.id, owner, adminId);

    const result = claimRewardByToken(db, getToken(reward.id), other);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("wrong_user");
  });

  it("rejects with 'already_claimed' on a second claim", () => {
    const reward = createReward({ code: "DBL-TOKEN" });
    const userId = seedUser(db, "dblTok", "dblTok@test.com");
    awardRewardToUser(db, reward.id, userId, adminId);
    const tok = getToken(reward.id);

    expect(claimRewardByToken(db, tok, userId).ok).toBe(true);
    const second = claimRewardByToken(db, tok, userId);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe("already_claimed");
  });

  it("rejects with 'expired' once claim_expires_at has passed", () => {
    const reward = createReward({ code: "EXPIRED-TOKEN" });
    const userId = seedUser(db, "expTok", "expTok@test.com");
    awardRewardToUser(db, reward.id, userId, adminId);

    // Force expiry into the past
    db.prepare(
      "UPDATE reward_awards SET claim_expires_at = ? WHERE reward_id = ?"
    ).run("2000-01-01T00:00:00.000Z", reward.id);

    const result = claimRewardByToken(db, getToken(reward.id), userId);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("expired");
  });

  it("rejects with 'voided' for an already-voided award", () => {
    const reward = createReward({ code: "VOIDED-TOKEN" });
    const userId = seedUser(db, "voidTok", "voidTok@test.com");
    awardRewardToUser(db, reward.id, userId, adminId);
    db.prepare(
      "UPDATE reward_awards SET voided_at = ? WHERE reward_id = ?"
    ).run("2030-01-01T00:00:00.000Z", reward.id);

    const result = claimRewardByToken(db, getToken(reward.id), userId);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("voided");
  });
});

describe("claimReward (rewardId path) honors the claim window", () => {
  it("returns null when the deadline has passed", () => {
    const reward = createReward({ code: "EXP-RID" });
    const userId = seedUser(db, "expRid", "expRid@test.com");
    awardRewardToUser(db, reward.id, userId, adminId);
    db.prepare(
      "UPDATE reward_awards SET claim_expires_at = ? WHERE reward_id = ?"
    ).run("2000-01-01T00:00:00.000Z", reward.id);

    expect(claimReward(db, reward.id, userId)).toBeNull();
  });

  it("returns null when the award has been voided", () => {
    const reward = createReward({ code: "VOID-RID" });
    const userId = seedUser(db, "voidRid", "voidRid@test.com");
    awardRewardToUser(db, reward.id, userId, adminId);
    db.prepare(
      "UPDATE reward_awards SET voided_at = ? WHERE reward_id = ?"
    ).run("2030-01-01T00:00:00.000Z", reward.id);

    expect(claimReward(db, reward.id, userId)).toBeNull();
  });
});

describe("expireOverdueRewards", () => {
  beforeEach(() => {
    vi.mocked(sendRewardExpiredEmail).mockClear();
  });

  it("voids past-deadline pending awards and returns the reward to the pool", () => {
    const reward = createReward({ code: "TO-EXPIRE" });
    const userId = seedUser(db, "lateClaimer", "late@test.com");
    awardRewardToUser(db, reward.id, userId, adminId);
    db.prepare(
      "UPDATE reward_awards SET claim_expires_at = ? WHERE reward_id = ?"
    ).run("2000-01-01T00:00:00.000Z", reward.id);

    const result = expireOverdueRewards(db);
    expect(result.voidedCount).toBe(1);

    const updated = getReward(db, reward.id)!;
    expect(updated.status).toBe("available");
    // The award row is preserved with voided_at set; getReward returns
    // award:null because the canonical query filters voided rows.
    expect(updated.award).toBeNull();

    const audit = db
      .prepare("SELECT voided_at FROM reward_awards WHERE reward_id = ?")
      .get(reward.id) as { voided_at: string | null };
    expect(audit.voided_at).not.toBeNull();
  });

  it("does not touch awards still within the deadline", () => {
    const reward = createReward({ code: "STILL-OK" });
    const userId = seedUser(db, "onTime", "ontime@test.com");
    awardRewardToUser(db, reward.id, userId, adminId);

    const result = expireOverdueRewards(db);
    expect(result.voidedCount).toBe(0);
    expect(getReward(db, reward.id)!.status).toBe("awarded");
  });

  it("does not touch already-claimed awards even past the deadline", () => {
    const reward = createReward({ code: "CLAIMED-PAST-DEADLINE" });
    const userId = seedUser(db, "claimedPast", "cp@test.com");
    awardRewardToUser(db, reward.id, userId, adminId);
    claimReward(db, reward.id, userId);
    db.prepare(
      "UPDATE reward_awards SET claim_expires_at = ? WHERE reward_id = ?"
    ).run("2000-01-01T00:00:00.000Z", reward.id);

    const result = expireOverdueRewards(db);
    expect(result.voidedCount).toBe(0);
    expect(getReward(db, reward.id)!.status).toBe("claimed");
  });

  it("is idempotent — second sweep is a no-op", () => {
    const reward = createReward({ code: "IDEMPOTENT" });
    const userId = seedUser(db, "idem", "idem@test.com");
    awardRewardToUser(db, reward.id, userId, adminId);
    db.prepare(
      "UPDATE reward_awards SET claim_expires_at = ? WHERE reward_id = ?"
    ).run("2000-01-01T00:00:00.000Z", reward.id);

    expect(expireOverdueRewards(db).voidedCount).toBe(1);
    expect(expireOverdueRewards(db).voidedCount).toBe(0);
  });

  it("sends the final 'expired' email exactly once per voided award", () => {
    const reward = createReward({ code: "EMAIL-ON-EXPIRE" });
    const userId = seedUser(db, "emExp", "emExp@test.com");
    awardRewardToUser(db, reward.id, userId, adminId);
    db.prepare(
      "UPDATE reward_awards SET claim_expires_at = ? WHERE reward_id = ?"
    ).run("2000-01-01T00:00:00.000Z", reward.id);

    expireOverdueRewards(db);
    expect(sendRewardExpiredEmail).toHaveBeenCalledTimes(1);
    expect(sendRewardExpiredEmail).toHaveBeenCalledWith(
      db,
      "emexp@test.com",
      "emExp",
      2500,
      expect.any(String),
    );

    // Re-running the sweep doesn't re-send.
    expireOverdueRewards(db);
    expect(sendRewardExpiredEmail).toHaveBeenCalledTimes(1);
  });

  it("does NOT void or email pending-review awards even past their placeholder expiry", () => {
    const reward = createReward({ code: "PENDING-NEVER-EXPIRES" });
    seedUser(db, "candidate", "candidate@test.com");
    db.prepare("UPDATE users SET lifetime_score = 5000 WHERE username = 'candidate'").run();

    const preview = previewRandomRoll(
      db,
      reward.id,
      { mode: "points_only", minPoints: 100, period: "all_time", useLifetimePoints: true },
      adminId,
    );
    // Admin abandons the preview — the row sits with placeholder
    // claim_expires_at and pending_review_at set. Force the placeholder
    // deadline into the past to simulate "30 days later".
    db.prepare(
      "UPDATE reward_awards SET claim_expires_at = ? WHERE id = ?"
    ).run("2000-01-01T00:00:00.000Z", preview.candidateAward.id);

    const result = expireOverdueRewards(db);
    expect(result.voidedCount).toBe(0);
    expect(sendRewardExpiredEmail).not.toHaveBeenCalled();

    // Pending row is still present with pending_review_at set.
    const row = db
      .prepare("SELECT pending_review_at, voided_at FROM reward_awards WHERE id = ?")
      .get(preview.candidateAward.id) as { pending_review_at: string | null; voided_at: string | null };
    expect(row.pending_review_at).not.toBeNull();
    expect(row.voided_at).toBeNull();
  });

  it("re-awarding the pool row after expiry is allowed (partial unique index)", () => {
    const reward = createReward({ code: "REAWARD-OK" });
    const u1 = seedUser(db, "reaward1", "ra1@test.com");
    const u2 = seedUser(db, "reaward2", "ra2@test.com");
    awardRewardToUser(db, reward.id, u1, adminId);
    db.prepare(
      "UPDATE reward_awards SET claim_expires_at = ? WHERE reward_id = ?"
    ).run("2000-01-01T00:00:00.000Z", reward.id);
    expireOverdueRewards(db);

    expect(() => awardRewardToUser(db, reward.id, u2, adminId)).not.toThrow();
    const after = getReward(db, reward.id)!;
    expect(after.status).toBe("awarded");
    expect(after.award!.userId).toBe(u2);
  });
});

describe("sendClaimReminders", () => {
  beforeEach(() => {
    vi.mocked(sendClaimReminderEmail).mockClear();
  });

  function setExpiry(rewardId: string, isoExpiry: string) {
    db.prepare(
      "UPDATE reward_awards SET claim_expires_at = ? WHERE reward_id = ?"
    ).run(isoExpiry, rewardId);
  }

  function daysFromNow(days: number, now: Date): string {
    return new Date(now.getTime() + days * 24 * 60 * 60 * 1000).toISOString();
  }

  it("sends the 15-day reminder when 15 days remain", () => {
    const reward = createReward({ code: "REM-15" });
    const userId = seedUser(db, "rem15", "rem15@test.com");
    awardRewardToUser(db, reward.id, userId, adminId);
    const now = new Date("2026-05-01T00:00:00.000Z");
    setExpiry(reward.id, daysFromNow(15, now));

    const result = sendClaimReminders(db, now);
    expect(result.sent.day15).toBe(1);
    expect(result.sent.day7).toBe(0);
    expect(result.sent.day1).toBe(0);
    expect(sendClaimReminderEmail).toHaveBeenCalledWith(
      "rem15@test.com",
      "rem15",
      2500,
      15,
      expect.any(String),
      expect.any(String),
    );
  });

  it("sends the 7-day reminder when 7 days remain", () => {
    const reward = createReward({ code: "REM-7" });
    const userId = seedUser(db, "rem7", "rem7@test.com");
    awardRewardToUser(db, reward.id, userId, adminId);
    const now = new Date("2026-05-01T00:00:00.000Z");
    setExpiry(reward.id, daysFromNow(7, now));

    const result = sendClaimReminders(db, now);
    expect(result.sent.day7).toBe(1);
    expect(result.sent.day15).toBe(0);
    expect(result.sent.day1).toBe(0);
  });

  it("sends the 1-day reminder when within the final 24h", () => {
    const reward = createReward({ code: "REM-1" });
    const userId = seedUser(db, "rem1", "rem1@test.com");
    awardRewardToUser(db, reward.id, userId, adminId);
    const now = new Date("2026-05-01T00:00:00.000Z");
    setExpiry(reward.id, daysFromNow(1, now));

    const result = sendClaimReminders(db, now);
    expect(result.sent.day1).toBe(1);
  });

  it("does not double-send the same cadence on a second run", () => {
    const reward = createReward({ code: "REM-DEDUP" });
    const userId = seedUser(db, "remD", "remD@test.com");
    awardRewardToUser(db, reward.id, userId, adminId);
    const now = new Date("2026-05-01T00:00:00.000Z");
    setExpiry(reward.id, daysFromNow(15, now));

    sendClaimReminders(db, now);
    sendClaimReminders(db, now);
    expect(sendClaimReminderEmail).toHaveBeenCalledTimes(1);
  });

  it("does not send reminders for already-claimed awards", () => {
    const reward = createReward({ code: "REM-CLAIMED" });
    const userId = seedUser(db, "remC", "remC@test.com");
    awardRewardToUser(db, reward.id, userId, adminId);
    claimReward(db, reward.id, userId);
    const now = new Date("2026-05-01T00:00:00.000Z");
    setExpiry(reward.id, daysFromNow(15, now));

    sendClaimReminders(db, now);
    expect(sendClaimReminderEmail).not.toHaveBeenCalled();
  });

  it("does not send reminders for pending-review awards", () => {
    const reward = createReward({ code: "REM-PENDING" });
    seedUser(db, "remP", "remP@test.com");
    db.prepare("UPDATE users SET lifetime_score = 5000 WHERE username = 'remP'").run();

    const preview = previewRandomRoll(
      db,
      reward.id,
      { mode: "points_only", minPoints: 100, period: "all_time", useLifetimePoints: true },
      adminId,
    );
    const now = new Date("2026-05-01T00:00:00.000Z");
    setExpiry(reward.id, daysFromNow(15, now));
    // Sanity: pending_review_at is non-null after preview.
    const before = db
      .prepare("SELECT pending_review_at FROM reward_awards WHERE id = ?")
      .get(preview.candidateAward.id) as { pending_review_at: string | null };
    expect(before.pending_review_at).not.toBeNull();

    sendClaimReminders(db, now);
    expect(sendClaimReminderEmail).not.toHaveBeenCalled();
  });

  it("does not send reminders for voided awards", () => {
    const reward = createReward({ code: "REM-VOIDED" });
    const userId = seedUser(db, "remV", "remV@test.com");
    awardRewardToUser(db, reward.id, userId, adminId);
    db.prepare("UPDATE reward_awards SET voided_at = ? WHERE reward_id = ?").run(
      "2030-01-01T00:00:00.000Z",
      reward.id,
    );
    const now = new Date("2026-05-01T00:00:00.000Z");
    setExpiry(reward.id, daysFromNow(15, now));

    sendClaimReminders(db, now);
    expect(sendClaimReminderEmail).not.toHaveBeenCalled();
  });

  it("escalates 15 → 7 → 1 over the lifetime of one award", () => {
    const reward = createReward({ code: "REM-ESCALATE" });
    const userId = seedUser(db, "remE", "remE@test.com");
    awardRewardToUser(db, reward.id, userId, adminId);

    // Pretend "now" advances. Set expiry once and move now forward.
    const expiry = new Date("2026-05-30T00:00:00.000Z");
    setExpiry(reward.id, expiry.toISOString());

    sendClaimReminders(db, new Date("2026-05-15T00:00:00.000Z")); // 15d out
    sendClaimReminders(db, new Date("2026-05-23T00:00:00.000Z")); // 7d out
    sendClaimReminders(db, new Date("2026-05-29T00:00:00.000Z")); // 1d out

    expect(sendClaimReminderEmail).toHaveBeenCalledTimes(3);
    const daysLeftArgs = vi.mocked(sendClaimReminderEmail).mock.calls.map(
      (c) => c[3],
    );
    expect(daysLeftArgs).toEqual([15, 7, 1]);
  });
});

describe("getQualifyingPlayers — calendar_month + exclusions", () => {
  function seedActiveUserWithScore(
    username: string,
    email: string,
    playedAtIso: string,
    score: number,
    opts: { isTestAccount?: boolean } = {},
  ): string {
    const id = seedUser(db, username, email);
    if (opts.isTestAccount) {
      db.prepare("UPDATE users SET is_test_account = 1 WHERE id = ?").run(id);
    }
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO user_game_history (user_id, game_type, game_mode, score, played_at)
       VALUES (?, 'sp', 'classic', ?, ?)`
    ).run(id, score, playedAtIso);
    return id;
  }

  it("qualifies only plays inside the calendar month range", () => {
    seedActiveUserWithScore("apr1", "apr1@test.com", "2026-04-15T10:00:00.000Z", 25000);
    seedActiveUserWithScore("apr2", "apr2@test.com", "2026-03-31T23:59:59.000Z", 25000);
    seedActiveUserWithScore("apr3", "apr3@test.com", "2026-05-01T00:00:00.000Z", 25000);

    const players = getQualifyingPlayers(db, {
      mode: "points_only",
      minPoints: 20000,
      period: "calendar_month",
      month: { year: 2026, monthIndex: 3 },
      useLifetimePoints: false,
    });
    expect(players.map((p) => p.username)).toEqual(["apr1"]);
  });

  it("throws when calendar_month is missing month field", () => {
    expect(() =>
      getQualifyingPlayers(db, {
        mode: "points_only",
        minPoints: 20000,
        period: "calendar_month",
        useLifetimePoints: false,
      }),
    ).toThrow(/criteria\.month is required/);
  });

  it("excludes specified users", () => {
    const u1 = seedActiveUserWithScore("ex1", "ex1@test.com", "2026-04-10T00:00:00.000Z", 25000);
    seedActiveUserWithScore("ex2", "ex2@test.com", "2026-04-11T00:00:00.000Z", 25000);

    const players = getQualifyingPlayers(db, {
      mode: "points_only",
      minPoints: 20000,
      period: "calendar_month",
      month: { year: 2026, monthIndex: 3 },
      useLifetimePoints: false,
      excludedUserIds: [u1],
    });
    expect(players.map((p) => p.username)).toEqual(["ex2"]);
  });

  it("excludes test accounts by default", () => {
    seedActiveUserWithScore("realPlayer", "real@test.com", "2026-04-10T00:00:00.000Z", 25000);
    seedActiveUserWithScore("testBot", "test@test.com", "2026-04-11T00:00:00.000Z", 25000, {
      isTestAccount: true,
    });

    const players = getQualifyingPlayers(db, {
      mode: "points_only",
      minPoints: 20000,
      period: "calendar_month",
      month: { year: 2026, monthIndex: 3 },
      useLifetimePoints: false,
    });
    expect(players.map((p) => p.username)).toEqual(["realPlayer"]);
  });

  it("includes test accounts when excludeTestAccounts is false", () => {
    seedActiveUserWithScore("realPlayer", "real@test.com", "2026-04-10T00:00:00.000Z", 25000);
    seedActiveUserWithScore("testBot", "test@test.com", "2026-04-11T00:00:00.000Z", 25000, {
      isTestAccount: true,
    });

    const players = getQualifyingPlayers(db, {
      mode: "points_only",
      minPoints: 20000,
      period: "calendar_month",
      month: { year: 2026, monthIndex: 3 },
      useLifetimePoints: false,
      excludeTestAccounts: false,
    });
    expect(players.map((p) => p.username).sort()).toEqual(["realPlayer", "testBot"]);
  });
});

describe("two-phase roll: previewRandomRoll → confirm/discard", () => {
  beforeEach(() => {
    vi.mocked(sendRewardAwardedEmail).mockClear();
    vi.mocked(sendMarketingEmail).mockClear();
  });

  function seedQualifying(username: string, email: string, score: number, dateIso: string): string {
    const id = seedUser(db, username, email);
    db.prepare(
      `INSERT INTO user_game_history (user_id, game_type, game_mode, score, played_at)
       VALUES (?, 'sp', 'classic', ?, ?)`
    ).run(id, score, dateIso);
    return id;
  }

  it("previewRandomRoll creates a pending award without sending emails", () => {
    const reward = createReward({ code: "PREVIEW-1" });
    seedQualifying("p1", "p1@test.com", 25000, "2026-04-10T00:00:00.000Z");

    const preview = previewRandomRoll(
      db,
      reward.id,
      {
        mode: "points_only",
        minPoints: 20000,
        period: "calendar_month",
        month: { year: 2026, monthIndex: 3 },
        useLifetimePoints: false,
      },
      adminId,
    );

    expect(preview.candidateAward.id).toBeTruthy();
    expect(preview.candidateAward.userId).toBeTruthy();
    expect(preview.candidateAward.username).toBe("p1");

    const updated = getReward(db, reward.id)!;
    expect(updated.status).toBe("awarded");
    expect(updated.award).not.toBeNull();
    expect(updated.award!.pendingReviewAt).not.toBeNull();

    expect(sendRewardAwardedEmail).not.toHaveBeenCalled();
  });

  it("confirmPendingAward fires the winner email and clears the pending flag", () => {
    const reward = createReward({ code: "CONFIRM-1" });
    seedQualifying("c1", "c1@test.com", 25000, "2026-04-10T00:00:00.000Z");

    const preview = previewRandomRoll(
      db,
      reward.id,
      {
        mode: "points_only",
        minPoints: 20000,
        period: "calendar_month",
        month: { year: 2026, monthIndex: 3 },
        useLifetimePoints: false,
      },
      adminId,
    );

    confirmPendingAward(db, preview.candidateAward.id, adminId);

    const updated = getReward(db, reward.id)!;
    expect(updated.award!.pendingReviewAt).toBeNull();
    expect(sendRewardAwardedEmail).toHaveBeenCalledTimes(1);
  });

  it("confirmPendingAward refuses a non-pending award", () => {
    const reward = createReward({ code: "CONFIRM-2" });
    const userId = seedQualifying("c2", "c2@test.com", 25000, "2026-04-10T00:00:00.000Z");
    awardRewardToUser(db, reward.id, userId, adminId); // creates a non-pending award

    const awardRow = db
      .prepare("SELECT id FROM reward_awards WHERE reward_id = ?")
      .get(reward.id) as { id: string };

    expect(() => confirmPendingAward(db, awardRow.id, adminId)).toThrow(/not pending review/i);
  });

  it("discardPendingAward returns the reward to the pool with no winner email", () => {
    const reward = createReward({ code: "DISCARD-1" });
    seedQualifying("d1", "d1@test.com", 25000, "2026-04-10T00:00:00.000Z");

    const preview = previewRandomRoll(
      db,
      reward.id,
      {
        mode: "points_only",
        minPoints: 20000,
        period: "calendar_month",
        month: { year: 2026, monthIndex: 3 },
        useLifetimePoints: false,
      },
      adminId,
    );

    discardPendingAward(db, preview.candidateAward.id, adminId);

    const updated = getReward(db, reward.id)!;
    expect(updated.status).toBe("available");
    expect(updated.award).toBeNull();
    expect(sendRewardAwardedEmail).not.toHaveBeenCalled();
  });

  it("after discard, the reward can be re-rolled to a different winner", () => {
    const reward = createReward({ code: "REROLL-1" });
    seedQualifying("r1", "r1@test.com", 25000, "2026-04-10T00:00:00.000Z");
    seedQualifying("r2", "r2@test.com", 25000, "2026-04-11T00:00:00.000Z");

    const criteria = {
      mode: "points_only" as const,
      minPoints: 20000,
      period: "calendar_month" as const,
      month: { year: 2026, monthIndex: 3 },
      useLifetimePoints: false,
    };

    const first = previewRandomRoll(db, reward.id, criteria, adminId);
    discardPendingAward(db, first.candidateAward.id, adminId);

    const second = previewRandomRoll(db, reward.id, criteria, adminId);
    expect(second.candidateAward.id).not.toBe(first.candidateAward.id);

    const updated = getReward(db, reward.id)!;
    expect(updated.status).toBe("awarded");
    expect(updated.award!.pendingReviewAt).not.toBeNull();
  });
});

describe("searchUsers", () => {
  beforeEach(() => {
    seedUser(db, "alice", "alice@test.com");
    seedUser(db, "ALICE_UPPER", "alice2@test.com");
    seedUser(db, "bob", "bob@test.com");
    seedUser(db, "charlie", "charlie@test.com");
  });

  it("finds users by prefix", () => {
    const results = searchUsers(db, "ali");
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.username.toLowerCase().startsWith("ali"))).toBe(true);
  });

  it("is case-insensitive", () => {
    const lower = searchUsers(db, "bob");
    const upper = searchUsers(db, "BOB");
    expect(lower).toHaveLength(1);
    expect(upper).toHaveLength(1);
    expect(lower[0].id).toBe(upper[0].id);
  });

  it("respects limit", () => {
    const results = searchUsers(db, "a", 1);
    expect(results).toHaveLength(1);
  });

  it("escapes SQL wildcards in query", () => {
    seedUser(db, "test_percent%user", "wild@test.com");
    const results = searchUsers(db, "test_percent%");
    expect(results).toHaveLength(1);
    expect(results[0].username).toBe("test_percent%user");
  });

  it("returns lifetimeScore field", () => {
    const uid = seedUser(db, "scored", "scored@test.com");
    db.prepare("UPDATE users SET lifetime_score = 42 WHERE id = ?").run(uid);

    const results = searchUsers(db, "scored");
    expect(results[0].lifetimeScore).toBe(42);
  });

  it("excludes inactive users", () => {
    const uid = seedUser(db, "deactivated", "deact@test.com");
    db.prepare("UPDATE users SET is_active = 0 WHERE id = ?").run(uid);

    const results = searchUsers(db, "deactivated");
    expect(results).toHaveLength(0);
  });

  it("returns empty for no match", () => {
    expect(searchUsers(db, "zzzznoone")).toEqual([]);
  });
});
