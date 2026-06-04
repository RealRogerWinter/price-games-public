/**
 * Tests for `softNavigate` — the plan-boundary navigation helper that
 * prefers an in-page React Router push over a full document load when
 * the broadcast helper (`window.__pgBroadcastNav`) is registered.
 *
 * The fake `Page` here simulates only the surface `softNavigate`
 * touches: `goto`, `evaluate`, `url`. Each test wires the fake to
 * model a particular runtime condition (helper present/absent, URL
 * settles or stalls, evaluate throws) and asserts the right path
 * (soft vs. hard) was taken.
 */
import { describe, it, expect, vi } from "vitest";
import type { Page } from "playwright";
import { softNavigate, BROADCAST_NAV_GLOBAL } from "../src/runner/softNavigate";

interface FakePageState {
  currentUrl: string;
  helperRegistered: boolean;
  /** Simulate the helper updating the URL after a delay (ms). */
  helperLatencyMs: number;
  /** When true, evaluate() rejects (used to test fallback). */
  evaluateThrows: boolean;
  /** Counts to assert how many times each path was taken. */
  gotoCalls: number;
  evaluateCalls: number;
}

function makeFakePage(initial: Partial<FakePageState> = {}): {
  page: Page;
  state: FakePageState;
} {
  const state: FakePageState = {
    currentUrl: "about:blank",
    helperRegistered: false,
    helperLatencyMs: 0,
    evaluateThrows: false,
    gotoCalls: 0,
    evaluateCalls: 0,
    ...initial,
  };
  const page = {
    goto: vi.fn(async (url: string) => {
      state.gotoCalls += 1;
      state.currentUrl = url;
      // page.goto loads a fresh document, which would re-register the
      // helper on a real broadcast page — but our test units exercise
      // the fallback path, not what the page does after the fallback.
      return null;
    }),
    evaluate: vi.fn(async (fn: unknown, arg?: unknown) => {
      state.evaluateCalls += 1;
      if (state.evaluateThrows) throw new Error("evaluate failed");
      // Branch on whether this is the helper-presence probe or the
      // helper-invocation. The probe receives the global name as a
      // single string arg; the invocation passes `{ g, u }`.
      if (typeof arg === "string" && arg === BROADCAST_NAV_GLOBAL) {
        return state.helperRegistered;
      }
      if (
        arg
        && typeof arg === "object"
        && (arg as { u?: string }).u
        && state.helperRegistered
      ) {
        const target = (arg as { u: string }).u;
        if (state.helperLatencyMs > 0) {
          setTimeout(() => {
            state.currentUrl = target;
          }, state.helperLatencyMs);
        } else {
          state.currentUrl = target;
        }
        return undefined;
      }
      return undefined;
    }),
    url: vi.fn(() => state.currentUrl),
  } as unknown as Page;
  return { page, state };
}

describe("softNavigate", () => {
  it("uses page.goto on the very first navigation regardless of helper", async () => {
    const { page, state } = makeFakePage({ helperRegistered: true });
    const result = await softNavigate(page, "https://price.games/play/classic?broadcast=1", {
      pageLoaded: false,
    });
    expect(result.path).toBe("hard");
    expect(state.gotoCalls).toBe(1);
    expect(state.evaluateCalls).toBe(0);
    expect(state.currentUrl).toBe("https://price.games/play/classic?broadcast=1");
  });

  it("uses the in-page helper when pageLoaded and helper is registered", async () => {
    const { page, state } = makeFakePage({
      currentUrl: "https://price.games/play/classic?broadcast=1",
      helperRegistered: true,
    });
    const result = await softNavigate(
      page,
      "https://price.games/play/higher-lower?broadcast=1",
      { pageLoaded: true },
    );
    expect(result.path).toBe("soft");
    expect(state.gotoCalls).toBe(0);
    // 1 evaluate to probe presence + 1 evaluate to invoke = 2.
    expect(state.evaluateCalls).toBeGreaterThanOrEqual(2);
    expect(state.currentUrl).toBe("https://price.games/play/higher-lower?broadcast=1");
  });

  it("falls back to page.goto when the helper is absent", async () => {
    const { page, state } = makeFakePage({
      currentUrl: "https://price.games/play/classic?broadcast=1",
      helperRegistered: false,
    });
    const result = await softNavigate(page, "https://price.games/mp?broadcast=1", {
      pageLoaded: true,
    });
    expect(result.path).toBe("hard");
    expect(state.gotoCalls).toBe(1);
    expect(state.currentUrl).toBe("https://price.games/mp?broadcast=1");
  });

  it("falls back when the helper-presence probe throws", async () => {
    const { page, state } = makeFakePage({
      helperRegistered: true,
      evaluateThrows: true,
    });
    const result = await softNavigate(page, "https://price.games/mp?broadcast=1", {
      pageLoaded: true,
    });
    expect(result.path).toBe("hard");
    expect(state.gotoCalls).toBe(1);
  });

  it("falls back when page.evaluate isn't a function (legacy / fake page)", async () => {
    // The bot-streamer test suite uses fake Page objects that omit
    // many surface methods (only what the test under exercise needs).
    // softNavigate must degrade gracefully when `evaluate` isn't even
    // present, rather than throwing synchronously and aborting the
    // plan executor.
    const goto = vi.fn(async () => null);
    const fakePage = {
      goto,
      url: vi.fn(() => "about:blank"),
      // intentionally NO `evaluate` property
    } as unknown as Page;
    const result = await softNavigate(fakePage, "https://price.games/mp?broadcast=1", {
      pageLoaded: true,
    });
    expect(result.path).toBe("hard");
    expect(goto).toHaveBeenCalledTimes(1);
  });

  it("falls back when the helper is registered but never moves the URL", async () => {
    // Helper "present" but our fake won't update the URL because the
    // helperLatencyMs is huge — simulates a soft-nav that silently
    // no-ops (e.g. a malformed URL caught by the helper's try/catch).
    const { page, state } = makeFakePage({
      currentUrl: "https://price.games/play/classic?broadcast=1",
      helperRegistered: true,
      helperLatencyMs: 10_000_000,
    });
    let now = 0;
    const sleep = vi.fn(async (ms: number) => {
      now += ms;
    });
    const result = await softNavigate(
      page,
      "https://price.games/play/higher-lower?broadcast=1",
      {
        pageLoaded: true,
        urlSettleTimeoutMs: 200,
        urlPollIntervalMs: 50,
        sleep,
      },
    );
    expect(result.path).toBe("hard");
    expect(state.gotoCalls).toBe(1);
    expect(now).toBeGreaterThanOrEqual(200);
  });

  it("treats a hash-bearing target as soft-nav success when the URL settles with the hash", async () => {
    // The in-page helper navigates to pathname+search+hash via React
    // Router; the URL-settle poll must compare the same fields or a
    // hash-bearing route would silently force a hard reload after the
    // 1.5s timeout.
    const { page, state } = makeFakePage({
      currentUrl: "https://price.games/play/classic?broadcast=1",
      helperRegistered: true,
    });
    const result = await softNavigate(
      page,
      "https://price.games/play/higher-lower?broadcast=1#leaderboard",
      { pageLoaded: true },
    );
    expect(result.path).toBe("soft");
    expect(state.gotoCalls).toBe(0);
    expect(state.currentUrl).toBe(
      "https://price.games/play/higher-lower?broadcast=1#leaderboard",
    );
  });

  it("falls back on a malformed target URL", async () => {
    const { page, state } = makeFakePage({
      helperRegistered: true,
    });
    const result = await softNavigate(page, "not a url", { pageLoaded: true });
    expect(result.path).toBe("hard");
    expect(state.gotoCalls).toBe(1);
  });
});
