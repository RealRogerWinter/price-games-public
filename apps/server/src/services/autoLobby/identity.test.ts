import { describe, it, expect } from "vitest";
import { wirePayloadIsBot, isServerSideBot } from "./identity";
import type { DbPlayer } from "../dbTypes";

function row(overrides: Partial<DbPlayer> = {}): DbPlayer {
  return {
    id: "p1",
    room_code: "abc",
    display_name: "x",
    avatar: "silhouette",
    token: "t",
    is_host: 0,
    is_kicked: 0,
    total_score: 0,
    connected: 1,
    joined_at: "",
    user_id: null,
    visitor_id: null,
    is_bot: 0,
    is_disguised: 0,
    ...overrides,
  };
}

describe("wirePayloadIsBot", () => {
  it("returns false for real humans", () => {
    expect(wirePayloadIsBot(row())).toBe(false);
  });

  it("returns true for labeled bots", () => {
    expect(wirePayloadIsBot(row({ is_bot: 1, is_disguised: 0 }))).toBe(true);
  });

  it("returns false for disguised bots — they look human to the client", () => {
    expect(wirePayloadIsBot(row({ is_bot: 1, is_disguised: 1 }))).toBe(false);
  });
});

describe("isServerSideBot", () => {
  it("treats both labeled and disguised bots as bots for server-side logic", () => {
    expect(isServerSideBot(row({ is_bot: 1, is_disguised: 0 }))).toBe(true);
    expect(isServerSideBot(row({ is_bot: 1, is_disguised: 1 }))).toBe(true);
  });

  it("returns false for real humans", () => {
    expect(isServerSideBot(row())).toBe(false);
  });

  it("ignores is_disguised when is_bot is 0 (defensive)", () => {
    // is_disguised should never be 1 with is_bot=0, but if it ever happens
    // (corrupted row, hand-edited DB), the player still counts as human —
    // we never want is_disguised alone to alter behavior.
    expect(isServerSideBot(row({ is_bot: 0, is_disguised: 1 }))).toBe(false);
  });
});
