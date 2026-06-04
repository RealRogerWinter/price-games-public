import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useGame } from "../hooks/useGame";
import * as api from "../api/client";
import { makeSession, makeProduct, makeProductWithPrice, flushMicrotasks } from "./testUtils";

vi.mock("../api/client");

const mockedApi = vi.mocked(api);

describe("useGame", () => {
  const session = makeSession();
  let onRoundComplete: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    onRoundComplete = vi.fn();
    mockedApi.getProduct.mockResolvedValue(makeProduct());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function renderGameHook(overrides?: Partial<Parameters<typeof useGame>[0]>) {
    return renderHook(() =>
      useGame({ session, onRoundComplete, ...overrides })
    );
  }

  it("fetches product on mount", async () => {
    const { result } = renderGameHook();
    await flushMicrotasks();

    expect(mockedApi.getProduct).toHaveBeenCalledWith("session-1");
    expect(result.current.product).not.toBeNull();
    expect(result.current.loading).toBe(false);
  });

  it("starts with loading true during fetch", () => {
    mockedApi.getProduct.mockReturnValue(new Promise(() => {}));
    const { result } = renderGameHook();

    expect(result.current.loading).toBe(true);
    expect(result.current.product).toBeNull();
  });

  it("does not auto-start timer on round 1", async () => {
    const { result } = renderGameHook();
    await flushMicrotasks();

    expect(result.current.timerStarted).toBe(false);
    expect(result.current.timer.isRunning).toBe(false);
  });

  it("auto-starts timer on rounds after the first", async () => {
    const s = makeSession({ currentRound: 2 });
    const { result } = renderHook(() =>
      useGame({ session: s, onRoundComplete })
    );
    await flushMicrotasks();

    expect(result.current.timerStarted).toBe(true);
    expect(result.current.timer.isRunning).toBe(true);
  });

  it("activateTimer starts the timer", async () => {
    const { result } = renderGameHook();
    await flushMicrotasks();

    act(() => result.current.activateTimer());

    expect(result.current.timerStarted).toBe(true);
    expect(result.current.timer.isRunning).toBe(true);
  });

  it("activateTimer does nothing if already guessed", async () => {
    mockedApi.submitGuess.mockResolvedValue({
      result: {
        product: makeProductWithPrice(),
        guessedPriceCents: 2000,
        score: 1000,
        pctOff: 0,
      },
      session: makeSession({ totalScore: 1000 }),
    });

    const { result } = renderGameHook();
    await flushMicrotasks();

    await act(async () => {
      await result.current.submitGuess(2000);
    });

    act(() => result.current.activateTimer());
    expect(result.current.timer.isRunning).toBe(false);
  });

  it("submitGuess calls API and sets roundResult", async () => {
    const roundResult = {
      product: makeProductWithPrice(),
      guessedPriceCents: 2200,
      score: 500,
      pctOff: 0.1,
    };
    const updatedSession = makeSession({ totalScore: 500 });
    mockedApi.submitGuess.mockResolvedValue({
      result: roundResult,
      session: updatedSession,
    });

    const { result } = renderGameHook();
    await flushMicrotasks();

    await act(async () => {
      await result.current.submitGuess(2200);
    });

    expect(mockedApi.submitGuess).toHaveBeenCalledWith("session-1", 2200, undefined);
    expect(result.current.roundResult).toEqual(roundResult);
    expect(result.current.hasGuessed).toBe(true);
    expect(onRoundComplete).toHaveBeenCalledWith(roundResult, updatedSession, undefined);
  });

  it("prevents double submission", async () => {
    mockedApi.submitGuess.mockResolvedValue({
      result: {
        product: makeProductWithPrice(),
        guessedPriceCents: 2200,
        score: 500,
        pctOff: 0.1,
      },
      session: makeSession({ totalScore: 500 }),
    });

    const { result } = renderGameHook();
    await flushMicrotasks();

    // First guess
    await act(async () => {
      result.current.submitGuess(2200);
    });
    await flushMicrotasks();

    const callCountAfterFirst = mockedApi.submitGuess.mock.calls.length;

    // Second guess — should be ignored by the ref guard
    await act(async () => {
      result.current.submitGuess(3000);
    });
    await flushMicrotasks();

    // No additional calls after the first
    expect(mockedApi.submitGuess.mock.calls.length).toBe(callCountAfterFirst);
  });

  it("resets hasGuessed on submit error", async () => {
    mockedApi.submitGuess.mockRejectedValue(new Error("Network error"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    const { result } = renderGameHook();
    await flushMicrotasks();

    await act(async () => {
      await result.current.submitGuess(2200);
    });

    expect(result.current.hasGuessed).toBe(false);
    expect(result.current.roundResult).toBeNull();
  });

  it("timer expiration submits with timedOut flag", async () => {
    mockedApi.submitGuess.mockResolvedValue({
      result: {
        product: makeProductWithPrice(),
        guessedPriceCents: 0,
        score: 0,
        pctOff: 1,
      },
      session: makeSession(),
    });

    const s = makeSession({ currentRound: 2 });
    const { result } = renderHook(() =>
      useGame({ session: s, onRoundComplete })
    );
    await flushMicrotasks();

    // Timer is auto-started on round 2. Advance to expiration (30s)
    act(() => { vi.advanceTimersByTime(30000); });
    await flushMicrotasks();

    expect(mockedApi.submitGuess).toHaveBeenCalledWith("session-1", 0, true);
  });

  it("nextRound increments the current round", async () => {
    const { result } = renderGameHook();
    await flushMicrotasks();

    expect(result.current.currentRound).toBe(1);

    act(() => result.current.nextRound());

    expect(result.current.currentRound).toBe(2);
  });

  it("useHint fetches and sets hint range", async () => {
    mockedApi.getHint.mockResolvedValue({
      hintRange: { min: 1500, max: 2500 },
    });

    const { result } = renderGameHook();
    await flushMicrotasks();

    await act(async () => {
      await result.current.useHint();
    });

    expect(mockedApi.getHint).toHaveBeenCalledWith("session-1");
    expect(result.current.hintRange).toEqual({ min: 1500, max: 2500 });
    expect(result.current.hintUsed).toBe(true);
  });

  it("useHint does nothing if already used", async () => {
    mockedApi.getHint.mockResolvedValue({
      hintRange: { min: 1500, max: 2500 },
    });

    const { result } = renderGameHook();
    await flushMicrotasks();

    await act(async () => {
      await result.current.useHint();
    });
    await flushMicrotasks();

    // Clear call history so we only track the second attempt
    mockedApi.getHint.mockClear();

    await act(async () => {
      await result.current.useHint();
    });
    await flushMicrotasks();

    expect(mockedApi.getHint).not.toHaveBeenCalled();
  });

  it("useHint does nothing if already guessed", async () => {
    mockedApi.submitGuess.mockResolvedValue({
      result: {
        product: makeProductWithPrice(),
        guessedPriceCents: 2000,
        score: 1000,
        pctOff: 0,
      },
      session: makeSession({ totalScore: 1000 }),
    });

    const { result } = renderGameHook();
    await flushMicrotasks();

    await act(async () => {
      await result.current.submitGuess(2000);
    });
    // Extra flush needed because submitGuess fires doSubmitGuess without awaiting
    await flushMicrotasks();

    // Clear any stray calls, then verify useHint is blocked by hasGuessed
    mockedApi.getHint.mockClear();

    await act(async () => {
      await result.current.useHint();
    });
    await flushMicrotasks();

    expect(mockedApi.getHint).not.toHaveBeenCalled();
  });

  it("useHint activates the timer", async () => {
    mockedApi.getHint.mockResolvedValue({
      hintRange: { min: 1500, max: 2500 },
    });

    const { result } = renderGameHook();
    await flushMicrotasks();

    expect(result.current.timerStarted).toBe(false);

    await act(async () => {
      await result.current.useHint();
    });

    expect(result.current.timerStarted).toBe(true);
  });

  it("handles product fetch error", async () => {
    mockedApi.getProduct.mockRejectedValue(new Error("Network error"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    const { result } = renderGameHook();
    await flushMicrotasks();

    expect(result.current.loading).toBe(false);
    expect(result.current.product).toBeNull();
  });
});
