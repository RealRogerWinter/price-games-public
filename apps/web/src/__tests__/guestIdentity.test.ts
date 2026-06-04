import { describe, it, expect, beforeEach, vi } from "vitest";
import { RANDOMIZABLE_AVATARS } from "@price-game/shared";
import {
  getOrCreateGuestIdentity,
  getMultiplayerDisplayNameOverride,
  getEffectiveAnonDisplayName,
  MP_DISPLAY_NAME_KEY,
} from "../utils/guestIdentity";

const STORAGE_KEY = "guest_identity_v1";

describe("getOrCreateGuestIdentity", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("generates and persists a new identity on first call", () => {
    const id = getOrCreateGuestIdentity();
    expect(id.handle).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/);
    expect((RANDOMIZABLE_AVATARS as readonly string[])).toContain(id.avatar);
    const persisted = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
    expect(persisted.handle).toBe(id.handle);
    expect(persisted.avatar).toBe(id.avatar);
  });

  it("returns the persisted identity on subsequent calls", () => {
    const first = getOrCreateGuestIdentity();
    const second = getOrCreateGuestIdentity();
    expect(second).toEqual(first);
  });

  it("regenerates when localStorage holds a malformed payload", () => {
    localStorage.setItem(STORAGE_KEY, "not json");
    const id = getOrCreateGuestIdentity();
    expect((RANDOMIZABLE_AVATARS as readonly string[])).toContain(id.avatar);
  });

  it("rejects an unknown avatar id and regenerates", () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ handle: "Foo Bar", avatar: "nonexistent-avatar" }),
    );
    const id = getOrCreateGuestIdentity();
    expect((RANDOMIZABLE_AVATARS as readonly string[])).toContain(id.avatar);
    expect(id.handle).not.toBe("Foo Bar");
  });

  it("clamps an oversized handle to 64 chars", () => {
    const long = "a".repeat(500);
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ handle: long, avatar: "wizard" }),
    );
    const id = getOrCreateGuestIdentity();
    expect(id.handle.length).toBe(64);
  });

  it("does not throw when localStorage is unavailable", () => {
    const setSpy = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("storage disabled");
      });
    const getSpy = vi
      .spyOn(Storage.prototype, "getItem")
      .mockImplementation(() => {
        throw new Error("storage disabled");
      });
    expect(() => getOrCreateGuestIdentity()).not.toThrow();
    setSpy.mockRestore();
    getSpy.mockRestore();
  });
});

describe("getMultiplayerDisplayNameOverride", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("returns null when no MP display name is set", () => {
    expect(getMultiplayerDisplayNameOverride()).toBeNull();
  });

  it("returns the trimmed MP display name when set", () => {
    localStorage.setItem(MP_DISPLAY_NAME_KEY, "  Neon Falcon  ");
    expect(getMultiplayerDisplayNameOverride()).toBe("Neon Falcon");
  });

  it("returns null when the stored value is only whitespace", () => {
    localStorage.setItem(MP_DISPLAY_NAME_KEY, "   ");
    expect(getMultiplayerDisplayNameOverride()).toBeNull();
  });

  it("returns null when localStorage throws", () => {
    const spy = vi
      .spyOn(Storage.prototype, "getItem")
      .mockImplementation(() => {
        throw new Error("storage disabled");
      });
    expect(getMultiplayerDisplayNameOverride()).toBeNull();
    spy.mockRestore();
  });
});

describe("getEffectiveAnonDisplayName", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("returns the guest handle when no MP override is set", () => {
    const id = getOrCreateGuestIdentity();
    expect(getEffectiveAnonDisplayName()).toBe(id.handle);
  });

  it("prefers the MP display-name override when present", () => {
    getOrCreateGuestIdentity();
    localStorage.setItem(MP_DISPLAY_NAME_KEY, "Custom Player");
    expect(getEffectiveAnonDisplayName()).toBe("Custom Player");
  });
});
