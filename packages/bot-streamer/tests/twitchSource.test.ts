import { describe, it, expect, vi } from "vitest";
import {
  createTwitchSource,
  __twitchInternals,
  type TmiClientLike,
  type TmiMessageHandler,
  type TmiUserstate,
} from "../src/chat/sources/twitch";
import type { IncomingChatMessage } from "../src/chat/types";

const { badgesFromUserstate } = __twitchInternals;

interface FakeClient extends TmiClientLike {
  emit(channel: string, userstate: TmiUserstate, text: string, self: boolean): void;
}

function fakeClient(): FakeClient {
  let handler: TmiMessageHandler | null = null;
  return {
    on(_event, h) {
      handler = h;
    },
    async connect() {
      return null;
    },
    async disconnect() {
      return null;
    },
    emit(channel, userstate, text, self) {
      handler?.(channel, userstate, text, self);
    },
  };
}

describe("badgesFromUserstate", () => {
  it("returns an empty array when no badges are set", () => {
    expect(badgesFromUserstate({})).toEqual([]);
  });

  it("flags moderator from the mod boolean", () => {
    expect(badgesFromUserstate({ mod: true })).toContain("moderator");
  });

  it("dedupes 'moderator' when both mod boolean and badges.moderator are set", () => {
    // The common case for an actual moderator is both flags set; the
    // result must contain a single "moderator" entry, not two.
    const got = badgesFromUserstate({
      mod: true,
      badges: { moderator: "1" },
    });
    expect(got.filter((b) => b === "moderator")).toHaveLength(1);
  });

  it("extracts broadcaster / moderator / vip / subscriber from the badges map", () => {
    const got = badgesFromUserstate({
      badges: { broadcaster: "1", moderator: "1", vip: "1", subscriber: "12" },
    });
    expect(got).toEqual(expect.arrayContaining(["broadcaster", "moderator", "vip", "subscriber"]));
  });
});

describe("createTwitchSource", () => {
  it("forwards incoming messages to the listener with the canonical shape", () => {
    const fake = fakeClient();
    const src = createTwitchSource({ channel: "test", clientFactory: () => fake });
    const seen: IncomingChatMessage[] = [];
    src.start((m) => seen.push(m));

    fake.emit("#test",
      {
        username: "alice",
        "display-name": "Alice",
        id: "abc",
        color: "#abcdef",
        badges: { vip: "1" },
        "tmi-sent-ts": "1700000000000",
      },
      "hello world",
      false);

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      id: "abc",
      platform: "twitch",
      user: "Alice",
      text: "hello world",
      color: "#abcdef",
      at: 1700000000000,
    });
    expect(seen[0].badges).toContain("vip");
  });

  it("ignores self-echo messages", () => {
    const fake = fakeClient();
    const src = createTwitchSource({ channel: "test", clientFactory: () => fake });
    const sub = vi.fn();
    src.start(sub);
    fake.emit("#test", { username: "bot" }, "hi from me", true);
    expect(sub).not.toHaveBeenCalled();
  });

  it("falls back to Date.now when tmi-sent-ts is missing", () => {
    const fake = fakeClient();
    const src = createTwitchSource({ channel: "test", clientFactory: () => fake });
    const seen: IncomingChatMessage[] = [];
    src.start((m) => seen.push(m));
    fake.emit("#test", { username: "alice", id: "x" }, "hi", false);
    expect(seen[0].at).toBeGreaterThan(0);
  });

  it("calls onError when the client factory throws", () => {
    const onError = vi.fn();
    const src = createTwitchSource({
      channel: "test",
      clientFactory: () => {
        throw new Error("connection refused");
      },
      onError,
    });
    const sub = vi.fn();
    src.start(sub);
    expect(onError).toHaveBeenCalled();
    expect(sub).not.toHaveBeenCalled();
  });
});
