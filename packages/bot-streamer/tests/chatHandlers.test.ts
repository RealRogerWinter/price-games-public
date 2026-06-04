import { describe, it, expect, vi } from "vitest";
import { createCommandRouter } from "../src/chat/router";
import { createInitialCommandState, registerChatCommands } from "../src/runner/chatHandlers";
import type { IncomingChatMessage } from "../src/chat/types";
import type { Narrator } from "../src/runner/narrator";

function fakeNarrator(): Narrator & { spoken: string[]; events: string[] } {
  const spoken: string[] = [];
  const events: string[] = [];
  return {
    spoken,
    events,
    async speak(event) {
      events.push(event);
    },
    async say(line) {
      spoken.push(line);
    },
    async dispose() {},
  };
}

function msg(text: string, badges?: string[]): IncomingChatMessage {
  return {
    id: String(Math.random()),
    platform: "twitch",
    user: "alice",
    text,
    badges,
    at: 1000,
  };
}

describe("registerChatCommands", () => {
  it("!mode <valid solo-eligible> sets nextModeOverride and acks via narrator", async () => {
    const router = createCommandRouter();
    const narrator = fakeNarrator();
    const state = createInitialCommandState(0.35);
    registerChatCommands({ router, state, narrator });
    const out = await router.dispatch(msg("!mode classic"));
    expect(out.kind).toBe("dispatched");
    expect(state.nextModeOverride).toBe("classic");
    expect(narrator.events).toContain("ack_mode");
  });

  it("!mode <invalid> is silently ignored — no override, no ack", async () => {
    const router = createCommandRouter();
    const narrator = fakeNarrator();
    const state = createInitialCommandState(0.35);
    registerChatCommands({ router, state, narrator });
    await router.dispatch(msg("!mode banana"));
    expect(state.nextModeOverride).toBeNull();
    expect(narrator.events).toHaveLength(0);
  });

  it("!mode bidding is rejected because the web app's solo route can't play MP-only modes", async () => {
    // bidding is in MULTIPLAYER_ONLY_MODES; routing the solo plan
    // to /play/bidding would 404. Override must not land.
    const router = createCommandRouter();
    const state = createInitialCommandState(0.35);
    registerChatCommands({ router, state });
    const out = await router.dispatch(msg("!mode bidding"));
    // The handler runs (dispatch returns dispatched) but no-ops.
    expect(out.kind).toBe("dispatched");
    expect(state.nextModeOverride).toBeNull();
  });

  it("!hint speaks the lastRationale via narrator", async () => {
    const router = createCommandRouter();
    const narrator = fakeNarrator();
    const state = createInitialCommandState(0.35);
    state.lastRationale = "Estimate × 0.85 — safe-bid pattern.";
    registerChatCommands({ router, state, narrator });
    await router.dispatch(msg("!hint"));
    expect(narrator.spoken).toEqual([state.lastRationale]);
  });

  it("!hint with no rationale set is a no-op", async () => {
    const router = createCommandRouter();
    const narrator = fakeNarrator();
    const state = createInitialCommandState(0.35);
    registerChatCommands({ router, state, narrator });
    await router.dispatch(msg("!hint"));
    expect(narrator.spoken).toEqual([]);
  });

  it("!skill is moderator-gated and accepts known tiers", async () => {
    const router = createCommandRouter();
    const narrator = fakeNarrator();
    const state = createInitialCommandState(0.35);
    registerChatCommands({ router, state, narrator });
    // Non-mod attempt rejected.
    const denied = await router.dispatch(msg("!skill hard"));
    expect(denied).toMatchObject({ kind: "rejected", reason: "mod_only" });
    expect(state.skillTemperature).toBe(0.35);
    // Mod attempt succeeds.
    const ok = await router.dispatch(msg("!skill hard", ["moderator"]));
    expect(ok.kind).toBe("dispatched");
    expect(state.skillTemperature).toBeLessThan(0.35); // hard => lower T
  });

  it("!skill with unknown tier is silently ignored", async () => {
    const router = createCommandRouter();
    const narrator = fakeNarrator();
    const state = createInitialCommandState(0.35);
    registerChatCommands({ router, state, narrator });
    const out = await router.dispatch(msg("!skill astronaut", ["broadcaster"]));
    expect(out.kind).toBe("dispatched");
    expect(state.skillTemperature).toBe(0.35);
  });

  it("!stats narrates the running W/L/streak", async () => {
    const router = createCommandRouter();
    const narrator = fakeNarrator();
    const state = createInitialCommandState(0.35);
    state.wins = 12;
    state.losses = 8;
    state.streak = 3;
    registerChatCommands({ router, state, narrator });
    await router.dispatch(msg("!stats"));
    const line = narrator.spoken[0];
    expect(line).toContain("12 wins");
    expect(line).toContain("8 losses");
    expect(line).toContain("60% win rate");
    expect(line).toContain("streak 3");
  });

  it("!join echoes the hosted room code or signals solo", async () => {
    let now = 1000;
    const router = createCommandRouter({ now: () => now });
    const narrator = fakeNarrator();
    const state = createInitialCommandState(0.35);
    registerChatCommands({ router, state, narrator });
    await router.dispatch(msg("!join"));
    expect(narrator.spoken[0]).toContain("solo");
    state.hostedRoomCode = "ABCDEF";
    // Advance past the global cooldown then dispatch as a different
    // user (per-user cooldown also applies).
    now += 60_000;
    await router.dispatch({ ...msg("!join"), user: "bob" });
    expect(narrator.spoken[1]).toContain("ABCDEF");
  });

  it("!song surfaces the now-playing track or a fallback line", async () => {
    let now = 1000;
    const router = createCommandRouter({ now: () => now });
    const narrator = fakeNarrator();
    const state = createInitialCommandState(0.35);
    registerChatCommands({ router, state, narrator });
    await router.dispatch(msg("!song"));
    expect(narrator.spoken[0]).toContain("not sure");
    state.nowPlaying = "Coffee Shop — Lofi Girl";
    now += 60_000;
    await router.dispatch({ ...msg("!song"), user: "carol" });
    expect(narrator.spoken[1]).toContain("Coffee Shop");
  });

  it("commands run safely without a narrator", async () => {
    const router = createCommandRouter();
    const state = createInitialCommandState(0.35);
    registerChatCommands({ router, state });
    state.lastRationale = "x";
    await router.dispatch(msg("!hint"));
    await router.dispatch(msg("!stats"));
    // No throw, no narrator side-effects to assert.
    expect(true).toBe(true);
  });
});
