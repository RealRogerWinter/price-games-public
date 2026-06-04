import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb } from "../test/dbHelper";
import type { Database as DatabaseType } from "better-sqlite3";
import {
  getSetting,
  setSetting,
  getPromoBanner,
  updatePromoBanner,
  getDisabledGameModes,
  setDisabledGameModes,
  isGameModeEnabled,
  getDisabledAvatars,
  setDisabledAvatars,
  isAvatarEnabled,
  isDailyEnabled,
  setDailyEnabled,
  getDailySchedule,
  setDailySchedule,
  getEnabledPages,
  setEnabledPages,
  isPageEnabled,
  PAGE_KEYS,
} from "./siteSettings";
import { DEFAULT_DAILY_SCHEDULE, type GameMode } from "@price-game/shared";

let db: DatabaseType;

beforeEach(() => {
  db = createTestDb();
});

describe("getSetting", () => {
  it("returns null for missing key", () => {
    expect(getSetting(db, "nonexistent")).toBeNull();
  });

  it("returns parsed value", () => {
    db.prepare(
      "INSERT INTO site_settings (key, value, updated_at) VALUES (?, ?, ?)"
    ).run("test_key", JSON.stringify({ foo: "bar" }), new Date().toISOString());

    expect(getSetting(db, "test_key")).toEqual({ foo: "bar" });
  });

  it("returns null for invalid JSON", () => {
    db.prepare(
      "INSERT INTO site_settings (key, value, updated_at) VALUES (?, ?, ?)"
    ).run("bad_json", "not{valid json", new Date().toISOString());

    expect(getSetting(db, "bad_json")).toBeNull();
  });
});

describe("setSetting", () => {
  it("stores value", () => {
    setSetting(db, "color", "blue");

    const row = db.prepare("SELECT value FROM site_settings WHERE key = ?").get("color") as { value: string };
    expect(JSON.parse(row.value)).toBe("blue");
  });

  it("upserts existing key", () => {
    setSetting(db, "count", 1);
    setSetting(db, "count", 2);

    expect(getSetting<number>(db, "count")).toBe(2);
    const rows = db.prepare("SELECT * FROM site_settings WHERE key = ?").all("count");
    expect(rows).toHaveLength(1);
  });
});

describe("getPromoBanner", () => {
  const DEFAULTS = {
    enabled: true,
    text: "Score 20,000+ points for a chance to win a $20 Amazon Gift Card!",
    linkText: "Learn More",
    linkUrl: "/settings",
    audienceMode: "logged_in",
    showLink: true,
    showGiveawayModal: true,
    giveawayMinPoints: 20000,
    giveawayMinStreak: 0,
    giveawayQualifyMode: "points_only",
    showTracker: true,
    qualifiedMessage: "You're entered in the {month} drawing! Increase your odds — refer a friend for bonus entries.",
  };

  it("returns defaults when no stored value", () => {
    expect(getPromoBanner(db)).toEqual(DEFAULTS);
  });

  it("merges stored partial with defaults", () => {
    setSetting(db, "promo_banner", { enabled: false, text: "Sale!" });

    expect(getPromoBanner(db)).toEqual({
      ...DEFAULTS,
      enabled: false,
      text: "Sale!",
    });
  });

  it("returns defaults for non-object stored value (array)", () => {
    setSetting(db, "promo_banner", [1, 2, 3]);
    expect(getPromoBanner(db)).toEqual(DEFAULTS);
  });

  it("returns defaults for non-object stored value (string)", () => {
    setSetting(db, "promo_banner", "oops");
    expect(getPromoBanner(db)).toEqual(DEFAULTS);
  });
});

describe("updatePromoBanner", () => {
  it("partial update preserves existing fields", () => {
    const result = updatePromoBanner(db, { enabled: false });

    expect(result.enabled).toBe(false);
    expect(result.text).toBe("Score 20,000+ points for a chance to win a $20 Amazon Gift Card!");
    expect(result.showLink).toBe(true);
  });

  it("updates specific fields", () => {
    updatePromoBanner(db, { text: "First" });
    const result = updatePromoBanner(db, { linkText: "Click here" });

    expect(result.text).toBe("First");
    expect(result.linkText).toBe("Click here");
  });

  it("handles all fields", () => {
    const full = {
      enabled: false,
      text: "New banner",
      linkText: "Go",
      linkUrl: "/deals",
      audienceMode: "all" as const,
      showLink: false,
      showGiveawayModal: false,
      giveawayMinPoints: 5000,
      giveawayMinStreak: 7,
      giveawayQualifyMode: "points_or_streak" as const,
      showTracker: false,
      qualifiedMessage: "Custom qualified message for {month}!",
    };

    const result = updatePromoBanner(db, full);
    expect(result).toEqual(full);
    expect(getPromoBanner(db)).toEqual(full);
  });

  it("persists streak qualification fields independently", () => {
    const result = updatePromoBanner(db, {
      giveawayMinStreak: 5,
      giveawayQualifyMode: "streak_only",
    });

    expect(result.giveawayMinStreak).toBe(5);
    expect(result.giveawayQualifyMode).toBe("streak_only");
    // Points threshold should keep its default value
    expect(result.giveawayMinPoints).toBe(20000);
  });
});

describe("getDisabledGameModes", () => {
  it("returns empty array when no stored value", () => {
    expect(getDisabledGameModes(db)).toEqual([]);
  });

  it("returns stored disabled modes", () => {
    setSetting(db, "disabled_game_modes", ["classic", "riser"]);
    expect(getDisabledGameModes(db)).toEqual(["classic", "riser"]);
  });

  it("filters out invalid mode strings", () => {
    setSetting(db, "disabled_game_modes", ["classic", "fake-mode", "riser"]);
    expect(getDisabledGameModes(db)).toEqual(["classic", "riser"]);
  });

  it("returns empty array for non-array stored value", () => {
    setSetting(db, "disabled_game_modes", "classic");
    expect(getDisabledGameModes(db)).toEqual([]);
  });
});

describe("setDisabledGameModes", () => {
  it("stores valid modes", () => {
    const result = setDisabledGameModes(db, ["classic", "riser"]);
    expect(result).toEqual(["classic", "riser"]);
    expect(getDisabledGameModes(db)).toEqual(["classic", "riser"]);
  });

  it("deduplicates modes", () => {
    const result = setDisabledGameModes(db, ["classic", "classic", "riser"]);
    expect(result).toEqual(["classic", "riser"]);
  });

  it("throws on invalid mode", () => {
    expect(() => setDisabledGameModes(db, ["classic", "invalid-mode"])).toThrow("Invalid game mode: invalid-mode");
  });

  it("stores empty array to re-enable all", () => {
    setDisabledGameModes(db, ["classic"]);
    const result = setDisabledGameModes(db, []);
    expect(result).toEqual([]);
    expect(getDisabledGameModes(db)).toEqual([]);
  });
});

describe("isGameModeEnabled", () => {
  it("returns true when no modes disabled", () => {
    expect(isGameModeEnabled(db, "classic")).toBe(true);
  });

  it("returns false for disabled mode", () => {
    setDisabledGameModes(db, ["classic", "riser"]);
    expect(isGameModeEnabled(db, "classic")).toBe(false);
    expect(isGameModeEnabled(db, "riser")).toBe(false);
  });

  it("returns true for enabled mode when others are disabled", () => {
    setDisabledGameModes(db, ["classic"]);
    expect(isGameModeEnabled(db, "higher-lower")).toBe(true);
  });
});

describe("getDisabledAvatars", () => {
  it("returns empty array when no stored value", () => {
    expect(getDisabledAvatars(db)).toEqual([]);
  });

  it("returns stored disabled avatars", () => {
    setSetting(db, "disabled_avatars", ["wizard", "pirate"]);
    expect(getDisabledAvatars(db)).toEqual(["wizard", "pirate"]);
  });

  it("filters out invalid avatar strings", () => {
    setSetting(db, "disabled_avatars", ["wizard", "fake-avatar", "pirate"]);
    expect(getDisabledAvatars(db)).toEqual(["wizard", "pirate"]);
  });

  it("returns empty array for non-array stored value", () => {
    setSetting(db, "disabled_avatars", "wizard");
    expect(getDisabledAvatars(db)).toEqual([]);
  });
});

describe("setDisabledAvatars", () => {
  it("stores valid avatars", () => {
    const result = setDisabledAvatars(db, ["wizard", "pirate"]);
    expect(result).toEqual(["wizard", "pirate"]);
    expect(getDisabledAvatars(db)).toEqual(["wizard", "pirate"]);
  });

  it("deduplicates avatars", () => {
    const result = setDisabledAvatars(db, ["wizard", "wizard", "pirate"]);
    expect(result).toEqual(["wizard", "pirate"]);
  });

  it("throws on invalid avatar", () => {
    expect(() => setDisabledAvatars(db, ["wizard", "not-a-real-avatar"])).toThrow("Invalid avatar: not-a-real-avatar");
  });

  it("stores empty array to re-enable all", () => {
    setDisabledAvatars(db, ["wizard"]);
    const result = setDisabledAvatars(db, []);
    expect(result).toEqual([]);
    expect(getDisabledAvatars(db)).toEqual([]);
  });
});

describe("isAvatarEnabled", () => {
  it("returns true when no avatars disabled", () => {
    expect(isAvatarEnabled(db, "wizard")).toBe(true);
  });

  it("returns false for disabled avatar", () => {
    setDisabledAvatars(db, ["wizard", "pirate"]);
    expect(isAvatarEnabled(db, "wizard")).toBe(false);
    expect(isAvatarEnabled(db, "pirate")).toBe(false);
  });

  it("returns true for enabled avatar when others are disabled", () => {
    setDisabledAvatars(db, ["wizard"]);
    expect(isAvatarEnabled(db, "pirate")).toBe(true);
  });
});

describe("isDailyEnabled", () => {
  it("returns false when no setting has been stored (default-off)", () => {
    expect(isDailyEnabled(db)).toBe(false);
  });

  it("returns false when stored value is not strictly true", () => {
    setSetting(db, "daily_enabled", false);
    expect(isDailyEnabled(db)).toBe(false);

    setSetting(db, "daily_enabled", null);
    expect(isDailyEnabled(db)).toBe(false);

    setSetting(db, "daily_enabled", "true"); // string, not boolean
    expect(isDailyEnabled(db)).toBe(false);

    setSetting(db, "daily_enabled", 1);
    expect(isDailyEnabled(db)).toBe(false);
  });

  it("returns true after setDailyEnabled(true)", () => {
    setDailyEnabled(db, true);
    expect(isDailyEnabled(db)).toBe(true);
  });

  it("can be flipped on and off", () => {
    setDailyEnabled(db, true);
    expect(isDailyEnabled(db)).toBe(true);
    setDailyEnabled(db, false);
    expect(isDailyEnabled(db)).toBe(false);
    setDailyEnabled(db, true);
    expect(isDailyEnabled(db)).toBe(true);
  });
});

describe("setDailyEnabled", () => {
  it("coerces truthy values to true", () => {
    // Defensive: API layer should send a boolean, but service should not crash
    // if a caller passes 1 or "yes". We coerce so isDailyEnabled stays
    // boolean-strict.
    setDailyEnabled(db, 1 as unknown as boolean);
    expect(isDailyEnabled(db)).toBe(true);
  });

  it("coerces falsy values to false", () => {
    setDailyEnabled(db, 0 as unknown as boolean);
    expect(isDailyEnabled(db)).toBe(false);
  });
});

describe("getDailySchedule", () => {
  it("returns DEFAULT_DAILY_SCHEDULE when unset", () => {
    expect(getDailySchedule(db)).toEqual(DEFAULT_DAILY_SCHEDULE);
  });

  it("returns DEFAULT_DAILY_SCHEDULE when stored value is malformed (wrong length)", () => {
    setSetting(db, "daily_schedule", ["classic", "classic"]); // length 2
    expect(getDailySchedule(db)).toEqual(DEFAULT_DAILY_SCHEDULE);
  });

  it("returns DEFAULT_DAILY_SCHEDULE when stored value is null", () => {
    setSetting(db, "daily_schedule", null);
    expect(getDailySchedule(db)).toEqual(DEFAULT_DAILY_SCHEDULE);
  });

  it("returns DEFAULT_DAILY_SCHEDULE when stored value is not an array", () => {
    setSetting(db, "daily_schedule", { not: "an array" });
    expect(getDailySchedule(db)).toEqual(DEFAULT_DAILY_SCHEDULE);
  });

  it("returns DEFAULT_DAILY_SCHEDULE when stored array contains an invalid mode", () => {
    setSetting(db, "daily_schedule", [
      "classic", "classic", "classic", "bogus-mode", "classic", "classic", "classic",
    ]);
    expect(getDailySchedule(db)).toEqual(DEFAULT_DAILY_SCHEDULE);
  });

  it("returns the stored array when valid", () => {
    const custom: GameMode[] = [
      "classic", "higher-lower", "comparison",
      "classic", "higher-lower", "comparison", "classic",
    ];
    setDailySchedule(db, custom);
    expect(getDailySchedule(db)).toEqual(custom);
  });
});

describe("setDailySchedule", () => {
  it("persists a valid 7-element array", () => {
    const custom: GameMode[] = [
      "comparison", "classic", "higher-lower",
      "comparison", "classic", "higher-lower", "comparison",
    ];
    setDailySchedule(db, custom);
    expect(getDailySchedule(db)).toEqual(custom);
  });

  it("throws when array length is not 7", () => {
    expect(() => setDailySchedule(db, ["classic"] as GameMode[])).toThrow();
    expect(() => setDailySchedule(db, [] as GameMode[])).toThrow();
    expect(() =>
      setDailySchedule(db, [
        "classic", "classic", "classic", "classic", "classic", "classic",
        "classic", "classic",
      ] as GameMode[])
    ).toThrow();
  });

  it("throws when an entry is not a known game mode", () => {
    expect(() =>
      setDailySchedule(db, [
        "classic", "classic", "bogus", "classic", "classic", "classic", "classic",
      ] as unknown as GameMode[])
    ).toThrow();
  });

  it("throws when input is not an array", () => {
    expect(() =>
      setDailySchedule(db, "not an array" as unknown as GameMode[])
    ).toThrow();
  });

  it("does not modify the existing schedule when validation fails", () => {
    const valid: GameMode[] = [
      "classic", "classic", "classic", "classic", "classic", "classic", "classic",
    ];
    setDailySchedule(db, valid);

    expect(() =>
      setDailySchedule(db, ["bad"] as unknown as GameMode[])
    ).toThrow();

    // Schedule should still be the previously valid one.
    expect(getDailySchedule(db)).toEqual(valid);
  });
});

describe("enabled pages", () => {
  it("defaults every page to disabled when the setting is unset", () => {
    const pages = getEnabledPages(db);
    for (const key of PAGE_KEYS) {
      expect(pages[key]).toBe(false);
    }
  });

  it("persists all six flags independently", () => {
    setEnabledPages(db, {
      about: true,
      faq: false,
      contact: true,
      game_modes: false,
      privacy: true,
      terms: false,
    });
    const pages = getEnabledPages(db);
    expect(pages).toEqual({
      about: true,
      faq: false,
      contact: true,
      game_modes: false,
      privacy: true,
      terms: false,
    });
  });

  it("coerces non-true values to false and ignores unknown keys", () => {
    setEnabledPages(db, {
      about: "yes" as unknown as boolean,
      faq: 1 as unknown as boolean,
      contact: true,
      game_modes: null as unknown as boolean,
      privacy: undefined as unknown as boolean,
      terms: true,
      bogus: true,
    } as unknown as Record<string, boolean>);
    const pages = getEnabledPages(db);
    expect(pages).toEqual({
      about: false,
      faq: false,
      contact: true,
      game_modes: false,
      privacy: false,
      terms: true,
    });
    expect((pages as Record<string, unknown>).bogus).toBeUndefined();
  });

  it("throws when the payload is not an object", () => {
    expect(() => setEnabledPages(db, "nope" as unknown)).toThrow();
    expect(() => setEnabledPages(db, [] as unknown)).toThrow();
    expect(() => setEnabledPages(db, null as unknown)).toThrow();
  });

  it("falls back to all-disabled when the stored row is malformed", () => {
    setSetting(db, "enabled_pages", "not-an-object" as unknown);
    const pages = getEnabledPages(db);
    for (const key of PAGE_KEYS) {
      expect(pages[key]).toBe(false);
    }
  });

  it("isPageEnabled returns false for unknown keys", () => {
    setEnabledPages(db, {
      about: true,
      faq: true,
      contact: true,
      game_modes: true,
      privacy: true,
      terms: true,
    });
    expect(isPageEnabled(db, "about")).toBe(true);
    expect(isPageEnabled(db, "not-a-page")).toBe(false);
  });
});
