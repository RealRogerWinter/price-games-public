import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { scheduleBotGuesses, scheduleBotContinues, cancelBotTimers } from "./botScheduler";
import type { DbPlayer } from "./dbTypes";
import type { BotDifficulty, RoundStartPayload } from "@price-game/shared";

// Use fake timers for deterministic scheduling
beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cancelBotTimers("test-room");
  vi.useRealTimers();
});

function makeBotPlayer(id: string): DbPlayer {
  return {
    id,
    room_code: "test-room",
    display_name: `Bot ${id}`,
    avatar: "wizard",
    token: `bot-${id}`,
    is_host: 0,
    is_kicked: 0,
    total_score: 0,
    connected: 1,
    joined_at: new Date().toISOString(),
    user_id: null,
    visitor_id: null,
    is_bot: 1,
  };
}

function makePayload(): RoundStartPayload {
  return {
    roundNumber: 1,
    gameMode: "classic",
    timerSeconds: 30,
    product: { id: 1, title: "Widget", imageUrl: "", description: "", category: "Electronics" },
  };
}

describe("scheduleBotGuesses", () => {
  it("calls onBotGuess for each bot after delays", () => {
    const bots = [makeBotPlayer("bot-1"), makeBotPlayer("bot-2")];
    const onBotGuess = vi.fn();

    scheduleBotGuesses(
      "test-room",
      makePayload(),
      new Map([[1, 5000]]),
      bots,
      "medium",
      onBotGuess,
    );

    // No immediate calls
    expect(onBotGuess).not.toHaveBeenCalled();

    // Advance past max delay (6000ms)
    vi.advanceTimersByTime(7000);

    // Both bots should have submitted
    expect(onBotGuess).toHaveBeenCalledTimes(2);
    expect(onBotGuess).toHaveBeenCalledWith(expect.objectContaining({
      playerId: "bot-1",
    }));
    expect(onBotGuess).toHaveBeenCalledWith(expect.objectContaining({
      playerId: "bot-2",
    }));
  });

  it("does not call onBotGuess if cancelled before timers fire", () => {
    const bots = [makeBotPlayer("bot-1")];
    const onBotGuess = vi.fn();

    scheduleBotGuesses("test-room", makePayload(), new Map([[1, 5000]]), bots, "medium", onBotGuess);
    cancelBotTimers("test-room");
    vi.advanceTimersByTime(10000);

    expect(onBotGuess).not.toHaveBeenCalled();
  });

  it("handles empty bot list", () => {
    const onBotGuess = vi.fn();
    scheduleBotGuesses("test-room", makePayload(), new Map([[1, 5000]]), [], "medium", onBotGuess);
    vi.advanceTimersByTime(10000);
    expect(onBotGuess).not.toHaveBeenCalled();
  });
});

describe("scheduleBotContinues", () => {
  it("calls onBotContinue for each bot after delays", () => {
    const bots = [makeBotPlayer("bot-1"), makeBotPlayer("bot-2")];
    const onBotContinue = vi.fn();

    scheduleBotContinues("test-room", bots, onBotContinue);

    expect(onBotContinue).not.toHaveBeenCalled();
    vi.advanceTimersByTime(9000);
    expect(onBotContinue).toHaveBeenCalledTimes(2);
  });

  it("does not call onBotContinue if cancelled", () => {
    const bots = [makeBotPlayer("bot-1")];
    const onBotContinue = vi.fn();

    scheduleBotContinues("test-room", bots, onBotContinue);
    cancelBotTimers("test-room");
    vi.advanceTimersByTime(15000);

    expect(onBotContinue).not.toHaveBeenCalled();
  });
});

describe("scheduleBotGuesses — riser mode", () => {
  function makeRiserPayload(opts: { speedPattern: string; durationMs: number; maxPriceCents: number }): RoundStartPayload {
    return {
      roundNumber: 1,
      gameMode: "riser",
      timerSeconds: Math.ceil(opts.durationMs / 1000) + 5,
      product: { id: 99, title: "Rocket", imageUrl: "", description: "", category: "Toys" },
      maxPriceCents: opts.maxPriceCents,
      speedPattern: opts.speedPattern,
      durationMs: opts.durationMs,
    };
  }

  it("schedules riser bot stops within the round duration", () => {
    const bots = [makeBotPlayer("bot-r1"), makeBotPlayer("bot-r2"), makeBotPlayer("bot-r3")];
    const onBotGuess = vi.fn();
    const durationMs = 12_000;
    scheduleBotGuesses(
      "test-room",
      makeRiserPayload({ speedPattern: "linear", durationMs, maxPriceCents: 10_000 }),
      new Map([[99, 5000]]),
      bots,
      "medium",
      onBotGuess,
    );

    // Advance past max possible delay (durationMs + jitter buffer).
    vi.advanceTimersByTime(durationMs + 1000);
    expect(onBotGuess).toHaveBeenCalledTimes(3);
    // Every guess includes a stoppedPriceCents.
    for (const call of onBotGuess.mock.calls) {
      expect(call[0].guessData).toHaveProperty("stoppedPriceCents");
    }
  });

  it("falls back to legacy 2-6s window when riser meta is missing", () => {
    // Payload missing maxPriceCents/durationMs/speedPattern → riserStopDelayMs
    // returns the legacy 2-6s window. The bot should still fire.
    const payload: RoundStartPayload = {
      roundNumber: 1,
      gameMode: "riser",
      timerSeconds: 30,
      product: { id: 99, title: "Rocket", imageUrl: "", description: "", category: "Toys" },
    };
    const bots = [makeBotPlayer("bot-r-fallback")];
    const onBotGuess = vi.fn();
    scheduleBotGuesses(
      "test-room",
      payload,
      new Map([[99, 5000]]),
      bots,
      "medium",
      onBotGuess,
    );
    vi.advanceTimersByTime(7000);
    expect(onBotGuess).toHaveBeenCalledTimes(1);
  });

  it("respects cancelBotTimers for riser bots too", () => {
    const bots = [makeBotPlayer("bot-r-cancel")];
    const onBotGuess = vi.fn();
    scheduleBotGuesses(
      "test-room",
      makeRiserPayload({ speedPattern: "accelerating", durationMs: 10_000, maxPriceCents: 8000 }),
      new Map([[99, 4000]]),
      bots,
      "easy",
      onBotGuess,
    );
    cancelBotTimers("test-room");
    vi.advanceTimersByTime(15_000);
    expect(onBotGuess).not.toHaveBeenCalled();
  });
});

describe("cancelBotTimers", () => {
  it("clears all pending timers for a room", () => {
    const bots = [makeBotPlayer("bot-1"), makeBotPlayer("bot-2"), makeBotPlayer("bot-3")];
    const onBotGuess = vi.fn();

    scheduleBotGuesses("test-room", makePayload(), new Map([[1, 5000]]), bots, "medium", onBotGuess);
    cancelBotTimers("test-room");
    vi.advanceTimersByTime(10000);

    expect(onBotGuess).not.toHaveBeenCalled();
  });

  it("is safe to call when no timers exist", () => {
    expect(() => cancelBotTimers("nonexistent-room")).not.toThrow();
  });
});
