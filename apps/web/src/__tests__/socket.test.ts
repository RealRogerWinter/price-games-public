import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { MP_SESSION_TTL_MS } from "@price-game/shared";
import { savePlayerSession, getPlayerSession, clearPlayerSession } from "../api/socket";

describe("socket session helpers (localStorage + TTL)", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  describe("savePlayerSession", () => {
    it("stores room code, player ID, and token in localStorage as a single blob", () => {
      savePlayerSession("ABCD", "player-1", "token-xyz");
      const raw = localStorage.getItem("mp_session_v2");
      expect(raw).not.toBeNull();
      const parsed = JSON.parse(raw!);
      expect(parsed.roomCode).toBe("ABCD");
      expect(parsed.playerId).toBe("player-1");
      expect(parsed.playerToken).toBe("token-xyz");
      expect(typeof parsed.savedAt).toBe("number");
    });

    it("overwrites previous session data", () => {
      savePlayerSession("ABCD", "player-1", "token-1");
      savePlayerSession("WXYZ", "player-2", "token-2");
      const parsed = JSON.parse(localStorage.getItem("mp_session_v2")!);
      expect(parsed.roomCode).toBe("WXYZ");
      expect(parsed.playerId).toBe("player-2");
      expect(parsed.playerToken).toBe("token-2");
    });

    it("sweeps legacy sessionStorage keys on write", () => {
      sessionStorage.setItem("mp_room_code", "legacy");
      sessionStorage.setItem("mp_player_id", "legacy");
      sessionStorage.setItem("mp_player_token", "legacy");
      savePlayerSession("ABCD", "player-1", "token-xyz");
      expect(sessionStorage.getItem("mp_room_code")).toBeNull();
      expect(sessionStorage.getItem("mp_player_id")).toBeNull();
      expect(sessionStorage.getItem("mp_player_token")).toBeNull();
    });
  });

  describe("getPlayerSession", () => {
    it("returns session data when all fields are present and fresh", () => {
      savePlayerSession("ABCD", "player-1", "token-xyz");
      expect(getPlayerSession()).toEqual({
        roomCode: "ABCD",
        playerId: "player-1",
        playerToken: "token-xyz",
      });
    });

    it("returns null when no session data exists", () => {
      expect(getPlayerSession()).toBeNull();
    });

    it("returns null and clears the blob when the session is past TTL", () => {
      // Persist with a savedAt older than the TTL window.
      const stale = {
        roomCode: "ABCD",
        playerId: "player-1",
        playerToken: "token-xyz",
        savedAt: Date.now() - MP_SESSION_TTL_MS - 1000,
      };
      localStorage.setItem("mp_session_v2", JSON.stringify(stale));

      expect(getPlayerSession()).toBeNull();
      // Stale entry should have been evicted by the read.
      expect(localStorage.getItem("mp_session_v2")).toBeNull();
    });

    it("returns null and clears the blob when the stored JSON is malformed", () => {
      localStorage.setItem("mp_session_v2", "{not valid json");
      expect(getPlayerSession()).toBeNull();
      expect(localStorage.getItem("mp_session_v2")).toBeNull();
    });

    it("migrates a legacy sessionStorage session into the new blob on first read", () => {
      sessionStorage.setItem("mp_room_code", "LEGACY");
      sessionStorage.setItem("mp_player_id", "legacy-player");
      sessionStorage.setItem("mp_player_token", "legacy-token");

      expect(getPlayerSession()).toEqual({
        roomCode: "LEGACY",
        playerId: "legacy-player",
        playerToken: "legacy-token",
      });
      // Legacy keys swept on migration.
      expect(sessionStorage.getItem("mp_room_code")).toBeNull();
      // New blob populated.
      const parsed = JSON.parse(localStorage.getItem("mp_session_v2")!);
      expect(parsed.roomCode).toBe("LEGACY");
    });
  });

  describe("clearPlayerSession", () => {
    it("removes the localStorage blob and any legacy sessionStorage keys", () => {
      savePlayerSession("ABCD", "player-1", "token-xyz");
      sessionStorage.setItem("mp_room_code", "legacy");
      clearPlayerSession();
      expect(localStorage.getItem("mp_session_v2")).toBeNull();
      expect(sessionStorage.getItem("mp_room_code")).toBeNull();
    });

    it("does not throw when no session data exists", () => {
      expect(() => clearPlayerSession()).not.toThrow();
    });
  });

  describe("TTL boundary", () => {
    afterEach(() => { vi.useRealTimers(); });

    it("returns the session when savedAt is exactly inside the TTL window", () => {
      const now = 1_700_000_000_000;
      vi.useFakeTimers();
      vi.setSystemTime(new Date(now));
      savePlayerSession("ABCD", "player-1", "token-xyz");

      // Jump to the edge: one ms before TTL expiry.
      vi.setSystemTime(new Date(now + MP_SESSION_TTL_MS - 1));
      expect(getPlayerSession()).not.toBeNull();

      // One ms past expiry → evicted.
      vi.setSystemTime(new Date(now + MP_SESSION_TTL_MS + 1));
      expect(getPlayerSession()).toBeNull();
    });
  });
});
