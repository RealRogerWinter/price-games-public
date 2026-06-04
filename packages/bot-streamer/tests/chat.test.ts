import { describe, it, expect, vi } from "vitest";
import { createCommandRouter, parseCommand } from "../src/chat/router";
import { createChatAggregator } from "../src/chat/aggregator";
import { createMockChatSource } from "../src/chat/sources/mock";
import type { IncomingChatMessage } from "../src/chat/types";

function msg(partial: Partial<IncomingChatMessage> & { text: string }): IncomingChatMessage {
  return {
    id: partial.id ?? "1",
    platform: partial.platform ?? "twitch",
    user: partial.user ?? "alice",
    text: partial.text,
    badges: partial.badges,
    color: partial.color,
    at: partial.at ?? 1000,
  };
}

describe("parseCommand", () => {
  it("returns null for non-command messages", () => {
    expect(parseCommand(msg({ text: "hello" }))).toBeNull();
    expect(parseCommand(msg({ text: "!" }))).toBeNull();
    expect(parseCommand(msg({ text: "" }))).toBeNull();
  });

  it("extracts name and args from a leading-bang message", () => {
    const cmd = parseCommand(msg({ text: "!mode bidding now" }));
    expect(cmd).not.toBeNull();
    expect(cmd!.name).toBe("mode");
    expect(cmd!.args).toEqual(["bidding", "now"]);
  });

  it("lowercases the command name but preserves arg case", () => {
    const cmd = parseCommand(msg({ text: "!MODE Bidding" }));
    expect(cmd!.name).toBe("mode");
    expect(cmd!.args).toEqual(["Bidding"]);
  });

  it("ignores leading whitespace before the bang", () => {
    const cmd = parseCommand(msg({ text: "   !hint" }));
    expect(cmd!.name).toBe("hint");
  });
});

describe("createCommandRouter", () => {
  it("returns 'not_a_command' for non-command messages", async () => {
    const r = createCommandRouter();
    const out = await r.dispatch(msg({ text: "hello world" }));
    expect(out.kind).toBe("not_a_command");
  });

  it("returns 'unknown_command' when no handler is registered", async () => {
    const r = createCommandRouter();
    const out = await r.dispatch(msg({ text: "!unknown" }));
    expect(out).toMatchObject({ kind: "rejected", reason: "unknown_command" });
  });

  it("dispatches to the registered handler", async () => {
    const handler = vi.fn(async () => {});
    const r = createCommandRouter();
    r.register({ name: "hint", handler, rateLimit: { perUserSeconds: 0, globalSeconds: 0 } });
    const out = await r.dispatch(msg({ text: "!hint" }));
    expect(out.kind).toBe("dispatched");
    expect(handler).toHaveBeenCalledOnce();
  });

  it("enforces global cooldown across users", async () => {
    let now = 0;
    const r = createCommandRouter({ now: () => now });
    r.register({ name: "song", handler: vi.fn(), rateLimit: { perUserSeconds: 0, globalSeconds: 5 } });
    expect((await r.dispatch(msg({ text: "!song", user: "alice" }))).kind).toBe("dispatched");
    now += 1000;
    expect((await r.dispatch(msg({ text: "!song", user: "bob" }))).kind).toBe("rejected");
    now += 5000;
    expect((await r.dispatch(msg({ text: "!song", user: "bob" }))).kind).toBe("dispatched");
  });

  it("enforces per-user cooldown but allows other users", async () => {
    let now = 0;
    const r = createCommandRouter({ now: () => now });
    r.register({ name: "stats", handler: vi.fn(), rateLimit: { perUserSeconds: 30, globalSeconds: 0 } });
    expect((await r.dispatch(msg({ text: "!stats", user: "alice" }))).kind).toBe("dispatched");
    now += 1000;
    // Same user: rejected.
    expect((await r.dispatch(msg({ text: "!stats", user: "alice" }))).kind).toBe("rejected");
    // Different user: dispatched.
    expect((await r.dispatch(msg({ text: "!stats", user: "bob" }))).kind).toBe("dispatched");
  });

  it("blocks mod-only commands for non-moderators", async () => {
    const r = createCommandRouter();
    const handler = vi.fn();
    r.register({
      name: "skill",
      handler,
      rateLimit: { perUserSeconds: 0, globalSeconds: 0, modOnly: true },
    });
    const reject = await r.dispatch(msg({ text: "!skill easy", user: "alice" }));
    expect(reject).toMatchObject({ kind: "rejected", reason: "mod_only" });
    expect(handler).not.toHaveBeenCalled();
  });

  it("allows mod-only commands for users with moderator badges", async () => {
    const r = createCommandRouter();
    const handler = vi.fn();
    r.register({
      name: "skill",
      handler,
      rateLimit: { perUserSeconds: 0, globalSeconds: 0, modOnly: true },
    });
    const out = await r.dispatch(msg({ text: "!skill hard", user: "mod-user", badges: ["moderator"] }));
    expect(out.kind).toBe("dispatched");
    expect(handler).toHaveBeenCalledOnce();
  });

  it("allows broadcaster badge for mod-only commands", async () => {
    const r = createCommandRouter();
    const handler = vi.fn();
    r.register({
      name: "skill",
      handler,
      rateLimit: { perUserSeconds: 0, globalSeconds: 0, modOnly: true },
    });
    expect((await r.dispatch(msg({ text: "!skill", badges: ["broadcaster"] }))).kind).toBe("dispatched");
    expect(handler).toHaveBeenCalledOnce();
  });

  it("does not propagate handler errors but surfaces them via onHandlerError", async () => {
    const onHandlerError = vi.fn();
    const r = createCommandRouter({ onHandlerError });
    r.register({
      name: "hint",
      handler: () => {
        throw new Error("boom");
      },
      rateLimit: { perUserSeconds: 0, globalSeconds: 0 },
    });
    // Must not throw.
    const out = await r.dispatch(msg({ text: "!hint" }));
    expect(out.kind).toBe("dispatched");
    expect(onHandlerError).toHaveBeenCalledOnce();
    const [err, cmd] = onHandlerError.mock.calls[0];
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("boom");
    expect(cmd.name).toBe("hint");
  });

  it("unregister removes the handler", async () => {
    const r = createCommandRouter();
    r.register({ name: "hint", handler: vi.fn() });
    expect(r.has("hint")).toBe(true);
    r.unregister("hint");
    expect(r.has("hint")).toBe(false);
    const out = await r.dispatch(msg({ text: "!hint" }));
    expect(out).toMatchObject({ kind: "rejected", reason: "unknown_command" });
  });
});

describe("createChatAggregator", () => {
  it("fans messages from every source to every subscriber", () => {
    const tw = createMockChatSource("twitch");
    const yt = createMockChatSource("youtube");
    const agg = createChatAggregator([tw, yt]);
    const sub = vi.fn();
    agg.subscribe(sub);
    agg.start();
    tw.send({ user: "alice", text: "hi" });
    yt.send({ user: "bob", text: "hello" });
    expect(sub).toHaveBeenCalledTimes(2);
  });

  it("dedupes messages with the same platform+id", () => {
    const tw = createMockChatSource("twitch");
    const agg = createChatAggregator([tw]);
    const sub = vi.fn();
    agg.subscribe(sub);
    agg.start();
    tw.send({ id: "1", user: "alice", text: "hi" });
    tw.send({ id: "1", user: "alice", text: "hi" });
    expect(sub).toHaveBeenCalledTimes(1);
  });

  it("does not dedupe across platforms when ids collide", () => {
    const tw = createMockChatSource("twitch");
    const yt = createMockChatSource("youtube");
    const agg = createChatAggregator([tw, yt]);
    const sub = vi.fn();
    agg.subscribe(sub);
    agg.start();
    tw.send({ id: "1", user: "alice", text: "hi" });
    yt.send({ id: "1", user: "alice", text: "hi" });
    expect(sub).toHaveBeenCalledTimes(2);
  });

  it("preserves a legitimate at: 0 timestamp instead of stamping it with now()", () => {
    const tw = createMockChatSource("twitch");
    const agg = createChatAggregator([tw], { now: () => 9999 });
    const received: IncomingChatMessage[] = [];
    agg.subscribe((m) => { received.push(m); });
    agg.start();
    tw.send({ user: "alice", text: "hi", at: 0 });
    expect(received).toHaveLength(1);
    expect(received[0].at).toBe(0);
  });

  it("stop() detaches every source", () => {
    const tw = createMockChatSource("twitch");
    const agg = createChatAggregator([tw]);
    const sub = vi.fn();
    agg.subscribe(sub);
    agg.start();
    agg.stop();
    tw.send({ user: "alice", text: "after stop" });
    expect(sub).not.toHaveBeenCalled();
  });
});
