import { describe, it, expect, beforeEach } from "vitest";
import type { Database as DatabaseType } from "better-sqlite3";
import { createTestDb } from "../../test/dbHelper";
import {
  getAutoLobbySettings,
  setAutoLobbySettings,
  isAutoLobbiesEnabled,
  AUTO_LOBBY_DEFAULTS,
} from "./settings";

let db: DatabaseType;

beforeEach(() => {
  db = createTestDb();
});

describe("getAutoLobbySettings", () => {
  it("returns defaults when nothing is stored", () => {
    expect(getAutoLobbySettings(db)).toEqual(AUTO_LOBBY_DEFAULTS);
  });

  it("ships disabled by default (dark launch)", () => {
    expect(AUTO_LOBBY_DEFAULTS.enabled).toBe(false);
  });

  it("merges stored partial values onto defaults", () => {
    setAutoLobbySettings(db, { enabled: true, targetCount: 4 });
    const s = getAutoLobbySettings(db);
    expect(s.enabled).toBe(true);
    expect(s.targetCount).toBe(4);
    expect(s.countdownMinSeconds).toBe(AUTO_LOBBY_DEFAULTS.countdownMinSeconds);
  });

  it("recovers gracefully when stored value is malformed", () => {
    db.prepare(
      "INSERT INTO site_settings (key, value, updated_at) VALUES (?, ?, ?)"
    ).run("auto_lobbies", "not json", new Date().toISOString());
    expect(getAutoLobbySettings(db)).toEqual(AUTO_LOBBY_DEFAULTS);
  });
});

describe("setAutoLobbySettings", () => {
  it("clamps targetCount to [0, 20]", () => {
    setAutoLobbySettings(db, { targetCount: 999 });
    expect(getAutoLobbySettings(db).targetCount).toBe(20);
    setAutoLobbySettings(db, { targetCount: -5 });
    expect(getAutoLobbySettings(db).targetCount).toBe(0);
  });

  it("clamps disguise ratio to [0, 100] and ensures min<=max", () => {
    setAutoLobbySettings(db, { disguiseRatioMin: 90, disguiseRatioMax: 30 });
    const s = getAutoLobbySettings(db);
    // After clamping the swap, min should be <= max.
    expect(s.disguiseRatioMin).toBeLessThanOrEqual(s.disguiseRatioMax);
  });

  it("clamps countdown bounds and ensures min<=max", () => {
    setAutoLobbySettings(db, { countdownMinSeconds: 60, countdownMaxSeconds: 10 });
    const s = getAutoLobbySettings(db);
    expect(s.countdownMinSeconds).toBeLessThanOrEqual(s.countdownMaxSeconds);
    expect(s.countdownMinSeconds).toBeGreaterThanOrEqual(1);
  });

  it("filters mode allowlist to known modes only", () => {
    setAutoLobbySettings(db, { modeAllowlist: ["classic", "not-a-mode", "bidding"] });
    const s = getAutoLobbySettings(db);
    expect(s.modeAllowlist).toEqual(["classic", "bidding"]);
  });

  it("preserves existing settings when partial update is applied", () => {
    setAutoLobbySettings(db, { enabled: true, targetCount: 7 });
    setAutoLobbySettings(db, { targetCount: 3 });
    const s = getAutoLobbySettings(db);
    expect(s.enabled).toBe(true);
    expect(s.targetCount).toBe(3);
  });
});

describe("isAutoLobbiesEnabled", () => {
  it("returns false by default", () => {
    expect(isAutoLobbiesEnabled(db)).toBe(false);
  });

  it("returns true after enable", () => {
    setAutoLobbySettings(db, { enabled: true });
    expect(isAutoLobbiesEnabled(db)).toBe(true);
  });
});
