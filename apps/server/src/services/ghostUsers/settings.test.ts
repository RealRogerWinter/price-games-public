import { describe, it, expect, beforeEach } from "vitest";
import type { Database as DatabaseType } from "better-sqlite3";
import { createTestDb } from "../../test/dbHelper";
import {
  getGhostSettings,
  setGhostSettings,
  isGhostSystemEnabled,
  GHOST_SETTINGS_DEFAULTS,
} from "./settings";

let db: DatabaseType;

beforeEach(() => {
  db = createTestDb();
});

describe("getGhostSettings", () => {
  it("returns defaults when nothing is stored", () => {
    expect(getGhostSettings(db)).toEqual(GHOST_SETTINGS_DEFAULTS);
  });

  it("ships disabled by default (dark launch)", () => {
    expect(GHOST_SETTINGS_DEFAULTS.enabled).toBe(false);
  });

  it("ships with show_on_leaderboard=false (PR-A invariant)", () => {
    expect(GHOST_SETTINGS_DEFAULTS.showOnLeaderboard).toBe(false);
  });

  it("ships with kill_switch=false", () => {
    expect(GHOST_SETTINGS_DEFAULTS.killSwitch).toBe(false);
  });

  it("default percentile cap is 70", () => {
    expect(GHOST_SETTINGS_DEFAULTS.percentileCap).toBe(70);
  });

  it("merges stored partial values onto defaults", () => {
    setGhostSettings(db, { enabled: true, percentileCap: 50 });
    const s = getGhostSettings(db);
    expect(s.enabled).toBe(true);
    expect(s.percentileCap).toBe(50);
    expect(s.showOnLeaderboard).toBe(GHOST_SETTINGS_DEFAULTS.showOnLeaderboard);
  });

  it("recovers gracefully when the stored row is malformed", () => {
    db.prepare(
      "INSERT INTO site_settings (key, value, updated_at) VALUES (?, ?, ?)"
    ).run("ghost_users", "not json", new Date().toISOString());
    expect(getGhostSettings(db)).toEqual(GHOST_SETTINGS_DEFAULTS);
  });
});

describe("setGhostSettings", () => {
  it("clamps percentileCap to [0, 100]", () => {
    setGhostSettings(db, { percentileCap: 999 });
    expect(getGhostSettings(db).percentileCap).toBe(100);
    setGhostSettings(db, { percentileCap: -5 });
    expect(getGhostSettings(db).percentileCap).toBe(0);
  });

  it("clamps targetCount to [0, 500]", () => {
    setGhostSettings(db, { targetCount: 99999 });
    expect(getGhostSettings(db).targetCount).toBe(500);
    setGhostSettings(db, { targetCount: -1 });
    expect(getGhostSettings(db).targetCount).toBe(0);
  });

  it("preserves other fields on partial update", () => {
    setGhostSettings(db, { enabled: true, percentileCap: 50 });
    setGhostSettings(db, { percentileCap: 80 });
    const s = getGhostSettings(db);
    expect(s.enabled).toBe(true);
    expect(s.percentileCap).toBe(80);
  });

  it("kill_switch and enabled are independent toggles", () => {
    setGhostSettings(db, { enabled: true, killSwitch: true });
    const s = getGhostSettings(db);
    expect(s.enabled).toBe(true);
    expect(s.killSwitch).toBe(true);
  });
});

describe("isGhostSystemEnabled", () => {
  it("returns false by default (master toggle off)", () => {
    expect(isGhostSystemEnabled(db)).toBe(false);
  });

  it("returns false when killSwitch is set, even if enabled=true", () => {
    setGhostSettings(db, { enabled: true, killSwitch: true });
    expect(isGhostSystemEnabled(db)).toBe(false);
  });

  it("returns true when enabled=true and killSwitch=false", () => {
    setGhostSettings(db, { enabled: true, killSwitch: false });
    expect(isGhostSystemEnabled(db)).toBe(true);
  });
});
