/**
 * Tests for the PlaywrightDriver — exercises the orchestration logic
 * without spinning up real Chromium. A fake Browser/Context/Page
 * passes through the same code paths a real session would, and a
 * scripted observer surfaces round_start payloads on cue.
 */

import { describe, it, expect, vi } from "vitest";
import { createPlaywrightDriver, decideMpGameWin, isRateLimitConsoleMessage, SINGLE_ACTION_MODES } from "../src/runner/playwrightDriver";
import { createOverlayForwarder, type OverlayEnvelope } from "../src/runner/overlay";
import { createInitialCommandState } from "../src/runner/chatHandlers";
import type { Browser, BrowserContext, Page } from "playwright";
import type { PersonaProfile } from "../src/persona/profile";

interface BindingMap {
  __pgBotForwardSocketEvent?: (source: unknown, kind: string, payload: unknown) => void;
}

interface FakeContext {
  bindings: BindingMap;
  /** Simulate the page-side script forwarding a server event. */
  emit(kind: string, payload: unknown): void;
  /** Track addInitScript calls for assertions. */
  initScripts: string[];
}

function createFakeBrowserBundle() {
  const bindings: BindingMap = {};
  const initScripts: string[] = [];
  const events: Array<{ kind: string; selector?: string; url?: string; key?: string; value?: string }> = [];
  // Hook fires when the driver awaits the round-result modal. In
  // production the modal only appears after the server emits
  // `game:round_end`; the test emits round_end from this hook so the
  // observer's `lastResult` is populated by the time the driver's
  // outcome derivation runs.
  let onWaitForResultModal: (() => void) | null = null;

  // Capture every page event handler the driver registers via
  // `page.on(eventName, handler)`. Tests synthesise events by
  // looking the handlers up by name and invoking them — covers
  // the `console` listener (rate-limit short-circuit test) and
  // the `response` listener (solo outcome path: the score lands
  // in the HTTP body of the /guess POST, not in any Socket.IO
  // event).
  const pageHandlers: Record<string, Array<(...args: unknown[]) => unknown>> = {};

  // Predicates added by tests that want a specific selector's
  // waitForSelector to block instead of returning null instantly.
  // Required by the rate-limit short-circuit test (Phase 4 needs
  // time to observe the 429 signal before the modal "appears").
  const blockingSelectorPredicates: Array<(sel: string) => boolean> = [];

  const page: Page = {
    async exposeBinding(name: string, fn: (source: unknown, ...args: unknown[]) => unknown) {
      bindings[name as keyof BindingMap] = fn as unknown as BindingMap["__pgBotForwardSocketEvent"];
    },
    on(eventName: string, handler: (...args: unknown[]) => unknown) {
      (pageHandlers[eventName] ??= []).push(handler);
    },
    async goto(url: string) {
      events.push({ kind: "goto", url });
      return null as unknown as Awaited<ReturnType<Page["goto"]>>;
    },
    async reload() {
      events.push({ kind: "reload" });
      return null as unknown as Awaited<ReturnType<Page["reload"]>>;
    },
    async waitForSelector(selector: string, opts?: { timeout?: number }) {
      events.push({ kind: "waitForSelector", selector });
      if (selector.includes("round-result-next") && onWaitForResultModal) {
        onWaitForResultModal();
      }
      // When a selector is on the "block" list, simulate a real
      // waitForSelector that waits the configured timeout (or 30s
      // default) — used by the rate-limit short-circuit test to
      // prove Phase 4 abandons before the modal "appears".
      if (blockingSelectorPredicates.some((p) => p(selector))) {
        const t = opts?.timeout ?? 30_000;
        await new Promise<void>((r) => {
          const id = setTimeout(r, t);
          id.unref?.();
        });
      }
      return null;
    },
    locator(selector: string) {
      const obj = {
        async click() {
          events.push({ kind: "click", selector });
        },
        async fill(text: string) {
          events.push({ kind: "fill", selector, value: text });
        },
        async getAttribute() {
          return null;
        },
        async count() {
          return 0;
        },
        nth() {
          return obj;
        },
        locator() {
          return obj;
        },
      };
      return obj as unknown as ReturnType<Page["locator"]>;
    },
    // The Driver doesn't call any other Page methods.
  } as unknown as Page;

  const context: BrowserContext = {
    async addInitScript(arg: { content?: string } | string) {
      const content = typeof arg === "string" ? arg : (arg.content ?? "");
      initScripts.push(content);
    },
    async newPage() {
      return page;
    },
    async close() { /* noop */ },
  } as unknown as BrowserContext;

  const browser: Browser = {
    async newContext() {
      return context;
    },
    async close() { /* noop */ },
  } as unknown as Browser;

  const fakeCtx: FakeContext & {
    setOnWaitForResultModal(fn: (() => void) | null): void;
    /**
     * Fire a synthetic console event at every handler the driver
     * registered via `page.on("console", ...)`. The msg arg shapes
     * what the driver's listener sees: type() and text() are the
     * fields it reads.
     */
    emitConsole(type: string, text: string): void;
    /**
     * Make `page.waitForSelector` block (until its `timeout`) for any
     * selector matching the predicate, instead of resolving instantly.
     * Used by the rate-limit short-circuit test so Phase 4 has time
     * to observe the 429 before the modal "appears".
     */
    addBlockingSelector(predicate: (sel: string) => boolean): void;
    /**
     * Synthesize a minimal Playwright Response and dispatch it to every
     * `response` listener the driver registered. Used by the solo-mode
     * outcome path tests where the score lands in the HTTP body of the
     * /guess POST, not on any Socket.IO event.
     */
    emitResponse(opts: {
      url: string;
      method?: string;
      status?: number;
      body?: unknown;
      bodyError?: Error;
    }): void;
  } = {
    bindings,
    initScripts,
    emit(kind, payload) {
      bindings.__pgBotForwardSocketEvent?.(undefined, kind, payload);
    },
    setOnWaitForResultModal(fn) {
      onWaitForResultModal = fn;
    },
    emitConsole(type, text) {
      const msg = { type: () => type, text: () => text };
      for (const h of pageHandlers["console"] ?? []) h(msg);
    },
    addBlockingSelector(predicate) {
      blockingSelectorPredicates.push(predicate);
    },
    emitResponse({ url, method = "POST", status = 200, body = null, bodyError }) {
      // Synthesize a minimal Playwright Response. The driver only
      // calls `.url()`, `.status()`, `.request().method()`, and
      // `.json()` on the response, so a partial mock is enough.
      const response = {
        url: () => url,
        status: () => status,
        request: () => ({ method: () => method }),
        async json() {
          if (bodyError) throw bodyError;
          return body;
        },
      };
      for (const handler of pageHandlers["response"] ?? []) {
        try { handler(response); } catch { /* ignored — handler should swallow */ }
      }
    },
  };

  return { browser, context, page, fakeCtx, events };
}

const DEFAULT_PERSONA: PersonaProfile = {
  name: "Pricey",
  avatar: "wizard",
  skillTemperature: 0.0, // deterministic best
};

describe("createPlaywrightDriver", () => {
  it("returns no_match for an aborted signal without launching the browser", async () => {
    const launch = vi.fn();
    const driver = createPlaywrightDriver({
      targetUrl: "https://test.invalid",
      persona: DEFAULT_PERSONA,
      launch: launch as never,
    });
    const ac = new AbortController();
    ac.abort();
    const outcome = await driver.execute({ kind: "solo", mode: "classic", rounds: 1 }, ac.signal);
    expect(outcome.status).toBe("no_match");
    expect(launch).not.toHaveBeenCalled();
  });

  it("returns no_match for public_join when no lobbies are available", async () => {
    const { browser } = createFakeBrowserBundle();
    const driver = createPlaywrightDriver({
      targetUrl: "https://test.invalid",
      persona: DEFAULT_PERSONA,
      launch: (async () => browser) as never,
      sleep: async () => {},
      fetchImpl: (async () => ({
        ok: true,
        json: async () => ({ lobbies: [] }),
      })) as unknown as typeof fetch,
    });
    const ac = new AbortController();
    const outcome = await driver.execute(
      { kind: "public_join", fallbackToHost: true },
      ac.signal,
    );
    expect(outcome.status).toBe("no_match");
    await driver.shutdown();
  });

  it("public_join filters out lobbies whose mode is not in modeWhitelist", async () => {
    const { browser, events } = createFakeBrowserBundle();
    const lobbies = [
      // Out-of-whitelist — must be skipped.
      { code: "AAAA", hostName: "h", hostAvatar: null, gameMode: "riser", playerCount: 1, humanCount: 1, botCount: 0, maxPlayers: 4, totalRounds: 5, hasPassword: false },
      { code: "BBBB", hostName: "h", hostAvatar: null, gameMode: "market-basket", playerCount: 1, humanCount: 1, botCount: 0, maxPlayers: 4, totalRounds: 5, hasPassword: false },
      // In-whitelist — must be picked.
      { code: "CCCC", hostName: "h", hostAvatar: null, gameMode: "comparison", playerCount: 1, humanCount: 1, botCount: 0, maxPlayers: 4, totalRounds: 5, hasPassword: false },
    ];
    const driver = createPlaywrightDriver({
      targetUrl: "https://test.invalid",
      persona: DEFAULT_PERSONA,
      launch: (async () => browser) as never,
      sleep: async () => {},
      modeWhitelist: new Set<string>(["classic", "higher-lower", "comparison"]),
      fetchImpl: (async () => ({
        ok: true,
        json: async () => ({ lobbies }),
      })) as unknown as typeof fetch,
    });
    const ac = new AbortController();
    // We don't emit a room snapshot, so the driver's internal
    // waitForRoom (10s) will time out and the plan resolves no_match
    // — but the test only cares that the right lobby was navigated
    // to. Test budget set to 15s to cover the 10s waitForRoom.
    const outcome = await driver.execute({ kind: "public_join", fallbackToHost: true }, ac.signal);
    expect(outcome.status).toBe("no_match");
    const navUrl = events.find((e) => e.kind === "goto")?.url ?? "";
    expect(navUrl).toContain("CCCC");
    expect(navUrl).not.toContain("AAAA");
    expect(navUrl).not.toContain("BBBB");
    await driver.shutdown();
  }, 15_000);

  it("public_join returns no_match when every open lobby is filtered out by modeWhitelist", async () => {
    const { browser, events } = createFakeBrowserBundle();
    const lobbies = [
      { code: "AAAA", hostName: "h", hostAvatar: null, gameMode: "riser", playerCount: 1, humanCount: 1, botCount: 0, maxPlayers: 4, totalRounds: 5, hasPassword: false },
      { code: "BBBB", hostName: "h", hostAvatar: null, gameMode: "market-basket", playerCount: 1, humanCount: 1, botCount: 0, maxPlayers: 4, totalRounds: 5, hasPassword: false },
    ];
    const driver = createPlaywrightDriver({
      targetUrl: "https://test.invalid",
      persona: DEFAULT_PERSONA,
      launch: (async () => browser) as never,
      sleep: async () => {},
      modeWhitelist: new Set<string>(["classic", "higher-lower", "comparison"]),
      fetchImpl: (async () => ({
        ok: true,
        json: async () => ({ lobbies }),
      })) as unknown as typeof fetch,
    });
    const ac = new AbortController();
    const outcome = await driver.execute(
      { kind: "public_join", fallbackToHost: true },
      ac.signal,
    );
    expect(outcome.status).toBe("no_match");
    // No navigation happened — the bot bailed before page.goto.
    expect(events.find((e) => e.kind === "goto")).toBeUndefined();
    await driver.shutdown();
  });

  it("plays a solo classic round end-to-end via the page bridge", async () => {
    const { browser, fakeCtx, events } = createFakeBrowserBundle();
    const driver = createPlaywrightDriver({
      targetUrl: "https://test.invalid",
      persona: DEFAULT_PERSONA,
      launch: (async () => browser) as never,
      // Skip real waits.
      sleep: async () => {},
    });

    // Schedule a round_start event 5ms after each goto so the driver
    // observer sees a payload to act on.
    let roundsEmitted = 0;
    const origGotoIdx = events.length;
    void origGotoIdx;
    const interval = setInterval(() => {
      const lastEvent = events[events.length - 1];
      if (!lastEvent || lastEvent.kind !== "goto") return;
      if (roundsEmitted >= 1) return;
      roundsEmitted++;
      fakeCtx.emit("game:round_start", {
        roundNumber: 1,
        gameMode: "classic",
        timerSeconds: 30,
        product: {
          id: 1,
          title: "USB cable",
          description: "",
          imageUrl: "",
          category: "Electronics",
        },
      });
    }, 5);

    const ac = new AbortController();
    const outcome = await driver.execute(
      { kind: "solo", mode: "classic", rounds: 1 },
      ac.signal,
    );
    clearInterval(interval);

    // Driver navigated to the per-mode URL.
    expect(events.find((e) => e.kind === "goto")?.url).toBe("https://test.invalid/play/classic?broadcast=1");
    // Identity + bridge init scripts attached.
    // Identity + page-bridge + fake-cursor init scripts (the cursor
     // overlay is required for the bot's mouse to be visible on stream).
    expect(fakeCtx.initScripts).toHaveLength(3);
    expect(fakeCtx.initScripts.some((s) => s.includes("guest_identity_v1"))).toBe(true);
    expect(fakeCtx.initScripts.some((s) => s.includes("__pgBotForwardSocketEvent"))).toBe(true);
    expect(fakeCtx.initScripts.some((s) => s.includes("__pg-bot-cursor"))).toBe(true);
    // Enactor fired (price input fill + submit click).
    expect(events.some((e) => e.kind === "fill" && e.selector?.includes("price-input-text"))).toBe(true);
    expect(events.some((e) => e.kind === "click" && e.selector?.includes("price-input-submit"))).toBe(true);
    // Outcome is completed (single round, single emission).
    expect(outcome.status).toBe("completed");

    await driver.shutdown();
  }, 20_000);

  it("emits round.start, round.result and stats.update via the overlay", async () => {
    const { browser, fakeCtx, events } = createFakeBrowserBundle();
    const sent: OverlayEnvelope[] = [];
    const overlay = createOverlayForwarder(async (env) => {
      sent.push(env);
    });
    const commandState = createInitialCommandState(0);
    const driver = createPlaywrightDriver({
      targetUrl: "https://test.invalid",
      persona: DEFAULT_PERSONA,
      overlay,
      commandState,
      launch: (async () => browser) as never,
      sleep: async () => {},
    });

    // Wire the result-modal hook to emit round_end at the moment the
    // driver waits for the modal — mirrors production where the modal
    // only appears after the server's round_end event.
    fakeCtx.setOnWaitForResultModal(() => {
      fakeCtx.emit("game:round_end", {
        roundNumber: 1,
        gameMode: "classic",
        revealData: { mode: "classic", product: { id: 1, title: "USB cable", priceCents: 1000 } },
        playerResults: [{ playerId: "p1", displayName: "Pricey", avatar: "wizard", score: 750, guessData: null }],
        standings: [{ playerId: "p1", displayName: "Pricey", avatar: "wizard", totalScore: 750 }],
      });
    });

    // Schedule round_start once goto has fired.
    let scheduled = false;
    const interval = setInterval(() => {
      const lastEvent = events[events.length - 1];
      if (!lastEvent || lastEvent.kind !== "goto" || scheduled) return;
      scheduled = true;
      fakeCtx.emit("game:round_start", {
        roundNumber: 1,
        gameMode: "classic",
        timerSeconds: 30,
        product: { id: 1, title: "USB cable", description: "", imageUrl: "", category: "Electronics" },
      });
    }, 5);

    const ac = new AbortController();
    await driver.execute({ kind: "solo", mode: "classic", rounds: 1 }, ac.signal);
    clearInterval(interval);

    // round.start emitted with mode + roundIndex + totalRounds.
    const roundStart = sent.find((e) => e.kind === "round.start");
    expect(roundStart).toBeDefined();
    expect(roundStart?.payload).toMatchObject({
      mode: "classic",
      roundIndex: 0,
      totalRounds: 1,
      productSummary: "USB cable",
    });

    // round.result reflects the derived outcome (score 750 → "correct"
    // in solo where the bot is the only player).
    const roundResult = sent.find((e) => e.kind === "round.result");
    expect(roundResult?.payload).toMatchObject({ outcome: "correct", points: 750 });

    // stats.update mirrors commandState after the win. `executeSolo`
    // also re-emits cumulative stats right after `page.goto` (so the
    // BotCard panel doesn't reset to 0 when React re-mounts), so the
    // post-round event is the *last* stats.update, not the first.
    const statsUpdate = sent.findLast((e) => e.kind === "stats.update");
    expect(statsUpdate?.payload).toMatchObject({
      wins: 1,
      losses: 0,
      streak: 1,
    });
    expect(commandState.wins).toBe(1);
    expect(commandState.streak).toBe(1);
    expect(commandState.moodState.streak).toBe(1);

    await driver.shutdown();
  }, 20_000);

  it("publishStats POSTs to /api/streamer/stats when STREAMER_BOT_SECRET is set", async () => {
    // Rationale: the same-window postMessage path only reaches the
    // bot's own Chromium. The server-mediated path is what makes
    // wins/losses/streak visible to *other* `?broadcast=1` viewers
    // (operator preview, co-streamer overlay, deployment where the
    // runner and the rendered page sit on different machines). This
    // test asserts the runner takes that path when the shared secret
    // is configured.
    const prev = process.env.STREAMER_BOT_SECRET;
    process.env.STREAMER_BOT_SECRET = "test-secret-abcdef";
    try {
      const { browser, fakeCtx, events } = createFakeBrowserBundle();
      const overlay = createOverlayForwarder(async () => { /* drop */ });
      const commandState = createInitialCommandState(0);
      const fetchCalls: Array<{ url: string; init: RequestInit }> = [];
      const fetchImpl = (async (url: string, init: RequestInit = {}) => {
        fetchCalls.push({ url, init });
        return { ok: true, json: async () => ({ ok: true }) } as unknown as Response;
      }) as unknown as typeof fetch;

      const driver = createPlaywrightDriver({
        targetUrl: "https://test.invalid",
        persona: DEFAULT_PERSONA,
        overlay,
        commandState,
        launch: (async () => browser) as never,
        sleep: async () => {},
        fetchImpl,
      });

      fakeCtx.setOnWaitForResultModal(() => {
        fakeCtx.emit("game:round_end", {
          roundNumber: 1,
          gameMode: "classic",
          revealData: { mode: "classic", product: { id: 1, title: "USB cable", priceCents: 1000 } },
          playerResults: [{ playerId: "p1", displayName: "Pricey", avatar: "wizard", score: 750, guessData: null }],
          standings: [{ playerId: "p1", displayName: "Pricey", avatar: "wizard", totalScore: 750 }],
        });
      });
      let scheduled = false;
      const interval = setInterval(() => {
        const lastEvent = events[events.length - 1];
        if (!lastEvent || lastEvent.kind !== "goto" || scheduled) return;
        scheduled = true;
        fakeCtx.emit("game:round_start", {
          roundNumber: 1,
          gameMode: "classic",
          timerSeconds: 30,
          product: { id: 1, title: "USB cable", description: "", imageUrl: "", category: "Electronics" },
        });
      }, 5);

      const ac = new AbortController();
      await driver.execute({ kind: "solo", mode: "classic", rounds: 1 }, ac.signal);
      clearInterval(interval);

      const statsPosts = fetchCalls.filter((c) => c.url.endsWith("/api/streamer/stats"));
      expect(statsPosts.length).toBeGreaterThan(0);
      const lastPost = statsPosts[statsPosts.length - 1];
      expect(lastPost.init.method).toBe("POST");
      const headers = lastPost.init.headers as Record<string, string>;
      expect(headers["x-streamer-bot"]).toBe("test-secret-abcdef");
      expect(headers["content-type"]).toBe("application/json");
      const body = JSON.parse(lastPost.init.body as string);
      expect(body).toMatchObject({ wins: 1, losses: 0, streak: 1 });

      await driver.shutdown();
    } finally {
      if (prev === undefined) delete process.env.STREAMER_BOT_SECRET;
      else process.env.STREAMER_BOT_SECRET = prev;
    }
  }, 20_000);

  it("counts solo round results from the HTTP response when no socket round_end arrives", async () => {
    // Why this test: solo plays don't emit Socket.IO `round_end` —
    // the score lands in the HTTP body of `POST /api/game/:sessionId/guess`.
    // Without a response listener (which this PR adds) the bot's
    // commandState.wins / losses never increment for solo, even
    // though the bot is playing successfully. Asserts the page-level
    // `response` listener captures the score and feeds it through
    // `deriveSoloOutcome` so wins reflect reality on the broadcast
    // panel.
    const { browser, fakeCtx, events } = createFakeBrowserBundle();
    const sent: OverlayEnvelope[] = [];
    const overlay = createOverlayForwarder(async (env) => {
      sent.push(env);
    });
    const commandState = createInitialCommandState(0);
    const driver = createPlaywrightDriver({
      targetUrl: "https://test.invalid",
      persona: DEFAULT_PERSONA,
      overlay,
      commandState,
      launch: (async () => browser) as never,
      sleep: async () => {},
    });
    // Crucially: do NOT emit `game:round_end`. Solo doesn't emit
    // it. Instead, on the wait-for-result-modal hook, fire a
    // synthetic `response` event with a positive score.
    fakeCtx.setOnWaitForResultModal(() => {
      fakeCtx.emitResponse({
        url: "https://test.invalid/api/game/sess-abc/guess",
        method: "POST",
        status: 200,
        body: { result: { score: 850, pctOff: 0.03 }, session: { currentRound: 1 } },
      });
    });
    let scheduled = false;
    const interval = setInterval(() => {
      const lastEvent = events[events.length - 1];
      if (!lastEvent || lastEvent.kind !== "goto" || scheduled) return;
      scheduled = true;
      fakeCtx.emit("game:round_start", {
        roundNumber: 1,
        gameMode: "classic",
        timerSeconds: 30,
        product: { id: 1, title: "USB cable", description: "", imageUrl: "", category: "Electronics" },
      });
    }, 5);

    const ac = new AbortController();
    await driver.execute({ kind: "solo", mode: "classic", rounds: 1 }, ac.signal);
    clearInterval(interval);

    expect(commandState.wins).toBe(1);
    expect(commandState.losses).toBe(0);
    expect(commandState.streak).toBe(1);
    const roundResult = sent.find((e) => e.kind === "round.result");
    expect(roundResult?.payload).toMatchObject({ outcome: "correct", points: 850 });
    await driver.shutdown();
  }, 20_000);

  it("counts a solo zero-score response as a loss", async () => {
    const { browser, fakeCtx, events } = createFakeBrowserBundle();
    const overlay = createOverlayForwarder(async () => { /* drop */ });
    const commandState = createInitialCommandState(0);
    const driver = createPlaywrightDriver({
      targetUrl: "https://test.invalid",
      persona: DEFAULT_PERSONA,
      overlay,
      commandState,
      launch: (async () => browser) as never,
      sleep: async () => {},
    });
    fakeCtx.setOnWaitForResultModal(() => {
      fakeCtx.emitResponse({
        url: "https://test.invalid/api/game/sess-abc/guess",
        body: { result: { score: 0, pctOff: 0.95 }, session: { currentRound: 1 } },
      });
    });
    let scheduled = false;
    const interval = setInterval(() => {
      const lastEvent = events[events.length - 1];
      if (!lastEvent || lastEvent.kind !== "goto" || scheduled) return;
      scheduled = true;
      fakeCtx.emit("game:round_start", {
        roundNumber: 1, gameMode: "classic", timerSeconds: 30,
        product: { id: 1, title: "x", description: "", imageUrl: "", category: "x" },
      });
    }, 5);
    const ac = new AbortController();
    await driver.execute({ kind: "solo", mode: "classic", rounds: 1 }, ac.signal);
    clearInterval(interval);
    expect(commandState.wins).toBe(0);
    expect(commandState.losses).toBe(1);
    expect(commandState.streak).toBeLessThanOrEqual(0);
    await driver.shutdown();
  }, 20_000);

  it("ignores response payloads with non-numeric / missing score", async () => {
    // Defensive: a malformed body shouldn't crash the listener or
    // poison commandState. Without a usable score, the round falls
    // through to the placeholder (no increment) — same as the
    // pre-listener behaviour.
    const { browser, fakeCtx, events } = createFakeBrowserBundle();
    const overlay = createOverlayForwarder(async () => { /* drop */ });
    const commandState = createInitialCommandState(0);
    const driver = createPlaywrightDriver({
      targetUrl: "https://test.invalid",
      persona: DEFAULT_PERSONA,
      overlay,
      commandState,
      launch: (async () => browser) as never,
      sleep: async () => {},
    });
    fakeCtx.setOnWaitForResultModal(() => {
      // Bad shapes the listener should reject without throwing.
      fakeCtx.emitResponse({
        url: "https://test.invalid/api/game/sess/guess",
        body: { result: { score: "lots" } },
      });
      fakeCtx.emitResponse({
        url: "https://test.invalid/api/game/sess/guess",
        body: null,
      });
      fakeCtx.emitResponse({
        url: "https://test.invalid/api/game/sess/guess",
        bodyError: new Error("body already consumed"),
      });
      // Off-target URL — must not even attempt to parse.
      fakeCtx.emitResponse({
        url: "https://test.invalid/api/mp/lobbies",
        body: { result: { score: 999 } },
      });
      // GET requests don't carry submissions; ignore.
      fakeCtx.emitResponse({
        url: "https://test.invalid/api/game/sess/guess",
        method: "GET",
        body: { result: { score: 999 } },
      });
      // Non-2xx — server-side validation failure; ignore.
      fakeCtx.emitResponse({
        url: "https://test.invalid/api/game/sess/guess",
        status: 400,
        body: { result: { score: 999 } },
      });
    });
    let scheduled = false;
    const interval = setInterval(() => {
      const lastEvent = events[events.length - 1];
      if (!lastEvent || lastEvent.kind !== "goto" || scheduled) return;
      scheduled = true;
      fakeCtx.emit("game:round_start", {
        roundNumber: 1, gameMode: "classic", timerSeconds: 30,
        product: { id: 1, title: "x", description: "", imageUrl: "", category: "x" },
      });
    }, 5);
    const ac = new AbortController();
    await driver.execute({ kind: "solo", mode: "classic", rounds: 1 }, ac.signal);
    clearInterval(interval);
    // No rounds were credited — placeholder outcome path, neither
    // wins nor losses bumped (unchanged from pre-listener).
    expect(commandState.wins).toBe(0);
    expect(commandState.losses).toBe(0);
    await driver.shutdown();
  }, 20_000);

  it("falls back to a placeholder round.result when the round_end event is dropped", async () => {
    const { browser, fakeCtx, events } = createFakeBrowserBundle();
    const sent: OverlayEnvelope[] = [];
    const overlay = createOverlayForwarder(async (env) => {
      sent.push(env);
    });
    const driver = createPlaywrightDriver({
      targetUrl: "https://test.invalid",
      persona: DEFAULT_PERSONA,
      overlay,
      commandState: createInitialCommandState(0),
      launch: (async () => browser) as never,
      sleep: async () => {},
    });
    // Schedule only the round_start — no round_end ever arrives.
    let scheduled = false;
    const interval = setInterval(() => {
      const lastEvent = events[events.length - 1];
      if (!lastEvent || lastEvent.kind !== "goto" || scheduled) return;
      scheduled = true;
      fakeCtx.emit("game:round_start", {
        roundNumber: 1,
        gameMode: "classic",
        timerSeconds: 30,
        product: { id: 1, title: "USB cable", description: "", imageUrl: "", category: "Electronics" },
      });
    }, 5);
    const ac = new AbortController();
    await driver.execute({ kind: "solo", mode: "classic", rounds: 1 }, ac.signal);
    clearInterval(interval);

    const roundResult = sent.find((e) => e.kind === "round.result");
    expect(roundResult?.payload).toMatchObject({ outcome: "incorrect", points: 0 });

    await driver.shutdown();
  }, 20_000);

  it("times out gracefully if no round_start arrives", async () => {
    const { browser, events } = createFakeBrowserBundle();
    const driver = createPlaywrightDriver({
      targetUrl: "https://test.invalid",
      persona: DEFAULT_PERSONA,
      launch: (async () => browser) as never,
      sleep: async () => {},
      // Short timeouts so the test doesn't pay the full 10s × retry budget.
      timeouts: { roundStart: 50, resultModalPrimary: 50, resultModalExtension: 50 },
    });
    // No interval — no round_start ever fires. Driver should retry
    // once (with a page.reload), then bail out of the per-round loop.
    const ac = new AbortController();
    const outcome = await driver.execute(
      { kind: "solo", mode: "classic", rounds: 1 },
      ac.signal,
    );
    expect(outcome.status).toBe("no_match");
    // Round-start retry path: at least one reload was issued before
    // the round was marked unhealthy.
    expect(events.some((e) => e.kind === "reload")).toBe(true);
    await driver.shutdown();
  }, 5_000);

  it("treats a 4-of-5 plan as completed (≥50% threshold)", async () => {
    const { browser, fakeCtx, events } = createFakeBrowserBundle();
    const driver = createPlaywrightDriver({
      targetUrl: "https://test.invalid",
      persona: DEFAULT_PERSONA,
      launch: (async () => browser) as never,
      sleep: async () => {},
      // Tight timeouts; round 4 will time out by design (no
      // round_start emitted) — we want that to be a "skipped"-or-
      // "page_unhealthy" round, not a 10s wall delay.
      timeouts: { roundStart: 50, resultModalPrimary: 50, resultModalExtension: 50 },
      maxUnhealthyRounds: 5, // permit all unhealthy rounds for this test
    });

    // Schedule 4 round_start emissions out of a 5-round plan; the
    // 5th round_start never arrives. The retry logic produces 4
    // successes + 1 unhealthy.
    let emittedCount = 0;
    fakeCtx.setOnWaitForResultModal(() => {
      // Each result-modal wait emits a round_end so the outcome
      // path completes with a real payload.
      fakeCtx.emit("game:round_end", {
        roundNumber: emittedCount,
        gameMode: "classic",
        revealData: { mode: "classic", product: { id: 1, title: "USB cable", priceCents: 1000 } },
        playerResults: [{ playerId: "p1", displayName: "Pricey", avatar: "wizard", score: 500, guessData: null }],
        standings: [{ playerId: "p1", displayName: "Pricey", avatar: "wizard", totalScore: 500 }],
      });
    });
    const interval = setInterval(() => {
      const lastEvent = events[events.length - 1];
      if (!lastEvent) return;
      // Emit the next round_start whenever the page navigates or we
      // see a result-modal click — both signal the start of a new
      // round.
      if (lastEvent.kind === "goto" && emittedCount === 0) {
        emittedCount++;
        fakeCtx.emit("game:round_start", {
          roundNumber: emittedCount,
          gameMode: "classic",
          timerSeconds: 30,
          product: { id: 1, title: "USB cable", description: "", imageUrl: "", category: "Electronics" },
        });
      } else if (
        lastEvent.kind === "click" &&
        lastEvent.selector.includes("round-result-next") &&
        emittedCount < 4
      ) {
        emittedCount++;
        fakeCtx.emit("game:round_start", {
          roundNumber: emittedCount,
          gameMode: "classic",
          timerSeconds: 30,
          product: { id: 1, title: "USB cable", description: "", imageUrl: "", category: "Electronics" },
        });
      }
    }, 5);

    const ac = new AbortController();
    const outcome = await driver.execute(
      { kind: "solo", mode: "classic", rounds: 5 },
      ac.signal,
    );
    clearInterval(interval);

    // 4/5 succeeded — that's ≥ ceil(5/2)=3, so the plan reports completed.
    // Pre-A2 this would have been "no_match" because completed !== plan.rounds.
    expect(outcome.status).toBe("completed");
    await driver.shutdown();
  }, 10_000);

  it("retries the enactor once on throw before marking the round skipped", async () => {
    // Patches the fake page so the FIRST click on the price-input-
    // submit selector throws, the second succeeds. This actually
    // exercises the retry contract — without the retry the test
    // would observe a "skipped" round.
    const { browser, fakeCtx, page, events } = createFakeBrowserBundle();
    const origLocator = page.locator;
    let submitClickAttempts = 0;
    page.locator = ((selector: string) => {
      const handle = origLocator.call(page, selector);
      if (selector === '[data-testid="price-input-submit"]') {
        const wrappedClick = handle.click.bind(handle);
        handle.click = async (...args: Parameters<typeof handle.click>) => {
          submitClickAttempts++;
          if (submitClickAttempts === 1) {
            throw new Error("simulated stale-selector flake");
          }
          return wrappedClick(...args);
        };
      }
      return handle;
    }) as typeof page.locator;

    const driver = createPlaywrightDriver({
      targetUrl: "https://test.invalid",
      persona: DEFAULT_PERSONA,
      launch: (async () => browser) as never,
      sleep: async () => {},
      timeouts: { roundStart: 50, resultModalPrimary: 50, resultModalExtension: 50 },
    });

    fakeCtx.setOnWaitForResultModal(() => {
      fakeCtx.emit("game:round_end", {
        roundNumber: 1,
        gameMode: "classic",
        revealData: { mode: "classic", product: { id: 1, title: "USB cable", priceCents: 1000 } },
        playerResults: [{ playerId: "p1", displayName: "Pricey", avatar: "wizard", score: 500, guessData: null }],
        standings: [{ playerId: "p1", displayName: "Pricey", avatar: "wizard", totalScore: 500 }],
      });
    });

    let scheduled = false;
    const interval = setInterval(() => {
      const lastEvent = events[events.length - 1];
      if (!lastEvent || lastEvent.kind !== "goto" || scheduled) return;
      scheduled = true;
      fakeCtx.emit("game:round_start", {
        roundNumber: 1,
        gameMode: "classic",
        timerSeconds: 30,
        product: { id: 1, title: "USB cable", description: "", imageUrl: "", category: "Electronics" },
      });
    }, 5);

    const ac = new AbortController();
    const outcome = await driver.execute(
      { kind: "solo", mode: "classic", rounds: 1 },
      ac.signal,
    );
    clearInterval(interval);
    // The enactor's first attempt threw; the second attempt succeeded
    // and the round completed. Exactly two click attempts were made
    // on the submit button.
    expect(submitClickAttempts).toBe(2);
    expect(outcome.status).toBe("completed");
    await driver.shutdown();
  }, 10_000);

  it("does not replay a previous plan's round_start payload on the next plan", async () => {
    // Regression: solo modes never emit `game:round_end`, so the last
    // round's payload sits in observer.state.round across plan
    // boundaries. Without playRounds clearing the gameplay state,
    // waitForRoundStart on the next plan would consume that stale
    // payload immediately (gameMode matches, no minRoundNumber gate on
    // the first attempt) — the strategy then computes on the previous
    // plan's product IDs that aren't in the new DOM, and the enactor
    // hangs every round of the new plan.
    //
    // Setup: plan 1 emits round_start and completes. Plan 2 emits NO
    // round_start. With the reset, plan 2 must time out (no_match);
    // without it, plan 2 would inherit plan 1's payload and "succeed"
    // instantly against an empty DOM.
    const { browser, fakeCtx, events } = createFakeBrowserBundle();
    const driver = createPlaywrightDriver({
      targetUrl: "https://test.invalid",
      persona: DEFAULT_PERSONA,
      launch: (async () => browser) as never,
      sleep: async () => {},
      timeouts: { roundStart: 50, resultModalPrimary: 50, resultModalExtension: 50 },
    });
    fakeCtx.setOnWaitForResultModal(() => {
      fakeCtx.emit("game:round_end", {
        roundNumber: 1,
        gameMode: "classic",
        revealData: { mode: "classic", product: { id: 1, title: "USB cable", priceCents: 1000 } },
        playerResults: [{ playerId: "p1", displayName: "Pricey", avatar: "wizard", score: 500, guessData: null }],
        standings: [{ playerId: "p1", displayName: "Pricey", avatar: "wizard", totalScore: 500 }],
      });
    });

    // Plan 1: schedule a single round_start once the page navigates.
    let plan1Scheduled = false;
    const interval = setInterval(() => {
      const lastEvent = events[events.length - 1];
      if (!lastEvent || lastEvent.kind !== "goto" || plan1Scheduled) return;
      plan1Scheduled = true;
      fakeCtx.emit("game:round_start", {
        roundNumber: 1,
        gameMode: "classic",
        timerSeconds: 30,
        product: { id: 1, title: "USB cable", description: "", imageUrl: "", category: "Electronics" },
      });
    }, 5);

    const ac = new AbortController();
    const plan1 = await driver.execute(
      { kind: "solo", mode: "classic", rounds: 1 },
      ac.signal,
    );
    expect(plan1.status).toBe("completed");

    // Plan 2: same mode, but never emit a fresh round_start. With the
    // reset in playRounds, attemptRound must block on waitForRoundStart
    // (no stale payload to consume) and ultimately surface no_match.
    clearInterval(interval);
    // Detach plan 1's result-modal hook so it can't fire round_end into
    // plan 2 if some unrelated waitForSelector path matches the modal
    // selector — keeps the second plan's failure mode unambiguously
    // "no fresh round_start arrived."
    fakeCtx.setOnWaitForResultModal(null);
    const fillsBeforePlan2 = events.filter((e) => e.kind === "fill").length;
    const plan2 = await driver.execute(
      { kind: "solo", mode: "classic", rounds: 1 },
      ac.signal,
    );
    expect(plan2.status).toBe("no_match");
    // No new enactor fill happened — the strategy never ran with stale data.
    expect(events.filter((e) => e.kind === "fill").length).toBe(fillsBeforePlan2);
    await driver.shutdown();
  }, 10_000);

  // -------------------------------------------------------------------
  // Game-level W/L/streak semantics. Pre-fix the runner bumped wins/
  // losses on every *round* outcome and mirrored mood.streak directly,
  // so multi-round plans inflated counters by 5× and a single bad round
  // mid-game yanked the displayed streak. The fix tracks wins/losses
  // per *game* (one plan = one game), and the streak counts consecutive
  // game wins (positive) / consecutive game losses (negative), reset to
  // ±1 on direction flip — independent of per-round mood.
  // -------------------------------------------------------------------

  /**
   * Drive a single-round solo plan with the given score, returning when
   * `driver.execute()` resolves. Used by the streak/game-level tests
   * below to chain consecutive games against the same commandState.
   */
  async function runSoloRound(
    driver: ReturnType<typeof createPlaywrightDriver>,
    fakeCtx: ReturnType<typeof createFakeBrowserBundle>["fakeCtx"],
    events: ReturnType<typeof createFakeBrowserBundle>["events"],
    score: number,
  ): Promise<void> {
    fakeCtx.setOnWaitForResultModal(() => {
      fakeCtx.emit("game:round_end", {
        roundNumber: 1,
        gameMode: "classic",
        revealData: { mode: "classic", product: { id: 1, title: "x", priceCents: 1000 } },
        playerResults: [{ playerId: "p1", displayName: "Pricey", avatar: "wizard", score, guessData: null }],
        standings: [{ playerId: "p1", displayName: "Pricey", avatar: "wizard", totalScore: score }],
      });
    });
    const startEventCount = events.length;
    let scheduled = false;
    const interval = setInterval(() => {
      // Look only at events emitted during *this* round's execute()
      // call; old `goto` entries from previous runs would otherwise
      // re-fire round_start before this round was set up.
      const recent = events.slice(startEventCount);
      const lastEvent = recent[recent.length - 1];
      if (!lastEvent || lastEvent.kind !== "goto" || scheduled) return;
      scheduled = true;
      fakeCtx.emit("game:round_start", {
        roundNumber: 1,
        gameMode: "classic",
        timerSeconds: 30,
        product: { id: 1, title: "x", description: "", imageUrl: "", category: "Electronics" },
      });
    }, 5);
    try {
      const ac = new AbortController();
      await driver.execute({ kind: "solo", mode: "classic", rounds: 1 }, ac.signal);
    } finally {
      clearInterval(interval);
    }
  }

  it("counts wins/losses per game (not per round) and accumulates streak across games", async () => {
    // Five consecutive solo plans: W, W, L, W, W. Per-round wiring is
    // identical, but the test exercises distinct *games* — so the bot
    // must end with 4 wins, 1 loss, and a streak of +2 (two wins after
    // the loss reset, not 5 wins in a row).
    const { browser, fakeCtx, events } = createFakeBrowserBundle();
    const overlay = createOverlayForwarder(async () => { /* drop */ });
    const commandState = createInitialCommandState(0);
    const driver = createPlaywrightDriver({
      targetUrl: "https://test.invalid",
      persona: DEFAULT_PERSONA,
      overlay,
      commandState,
      launch: (async () => browser) as never,
      sleep: async () => {},
    });

    // Game 1 — win.
    await runSoloRound(driver, fakeCtx, events, 800);
    expect(commandState.wins).toBe(1);
    expect(commandState.losses).toBe(0);
    expect(commandState.streak).toBe(1);

    // Game 2 — win → streak grows to +2.
    await runSoloRound(driver, fakeCtx, events, 700);
    expect(commandState.wins).toBe(2);
    expect(commandState.streak).toBe(2);

    // Game 3 — loss → streak flips to -1, not -2.
    await runSoloRound(driver, fakeCtx, events, 0);
    expect(commandState.wins).toBe(2);
    expect(commandState.losses).toBe(1);
    expect(commandState.streak).toBe(-1);

    // Game 4 — win → streak flips back to +1.
    await runSoloRound(driver, fakeCtx, events, 600);
    expect(commandState.wins).toBe(3);
    expect(commandState.streak).toBe(1);

    // Game 5 — win → streak grows to +2.
    await runSoloRound(driver, fakeCtx, events, 900);
    expect(commandState.wins).toBe(4);
    expect(commandState.losses).toBe(1);
    expect(commandState.streak).toBe(2);

    await driver.shutdown();
  }, 30_000);

  it("counts a multi-round plan as a single game (not one win per round)", async () => {
    // Pre-fix: a 3-round plan with all winning rounds bumped wins by 3.
    // Post-fix: it bumps wins by 1 (one game won), and the streak after
    // the plan is exactly +1 — proving the per-round increments are
    // gone.
    const { browser, fakeCtx, events } = createFakeBrowserBundle();
    const overlay = createOverlayForwarder(async () => { /* drop */ });
    const commandState = createInitialCommandState(0);
    const driver = createPlaywrightDriver({
      targetUrl: "https://test.invalid",
      persona: DEFAULT_PERSONA,
      overlay,
      commandState,
      launch: (async () => browser) as never,
      sleep: async () => {},
    });

    // Mirrors the "treats a 4-of-5 plan as completed" pattern: the
    // wait-for-modal hook emits a round_end every time, and an interval
    // chains round_start emissions off the round-result-next click.
    let emittedCount = 0;
    fakeCtx.setOnWaitForResultModal(() => {
      fakeCtx.emit("game:round_end", {
        roundNumber: emittedCount,
        gameMode: "classic",
        revealData: { mode: "classic", product: { id: 1, title: "x", priceCents: 1000 } },
        playerResults: [{ playerId: "p1", displayName: "Pricey", avatar: "wizard", score: 500, guessData: null }],
        standings: [{ playerId: "p1", displayName: "Pricey", avatar: "wizard", totalScore: 500 * emittedCount }],
      });
    });
    const interval = setInterval(() => {
      const lastEvent = events[events.length - 1];
      if (!lastEvent) return;
      if (lastEvent.kind === "goto" && emittedCount === 0) {
        emittedCount++;
        fakeCtx.emit("game:round_start", {
          roundNumber: emittedCount, gameMode: "classic", timerSeconds: 30,
          product: { id: 1, title: "x", description: "", imageUrl: "", category: "x" },
        });
      } else if (
        lastEvent.kind === "click"
        && lastEvent.selector.includes("round-result-next")
        && emittedCount < 3
      ) {
        emittedCount++;
        fakeCtx.emit("game:round_start", {
          roundNumber: emittedCount, gameMode: "classic", timerSeconds: 30,
          product: { id: 1, title: "x", description: "", imageUrl: "", category: "x" },
        });
      }
    }, 5);
    const ac = new AbortController();
    await driver.execute({ kind: "solo", mode: "classic", rounds: 3 }, ac.signal);
    clearInterval(interval);

    expect(commandState.wins).toBe(1);
    expect(commandState.losses).toBe(0);
    expect(commandState.streak).toBe(1);
    // Per-round mood streak still tracks rounds — three winning rounds
    // bumped it to 3. Decoupled from the game-level streak (1).
    expect(commandState.moodState.streak).toBe(3);
    await driver.shutdown();
  }, 30_000);

  it("does not credit a W/L when the plan bails early (state_divergent / unhealthy)", async () => {
    // Plan asks for 5 rounds; only 1 round_start fires, so the
    // remaining rounds time out as unhealthy and the plan returns
    // no_match. Pre-fix this would have credited the partial game's
    // standings as a W/L; post-fix, finalizeGameOutcome bails on the
    // `planCompleted=false` gate and accumulators reset cleanly.
    const { browser, fakeCtx, events } = createFakeBrowserBundle();
    const overlay = createOverlayForwarder(async () => { /* drop */ });
    const commandState = createInitialCommandState(0);
    const driver = createPlaywrightDriver({
      targetUrl: "https://test.invalid",
      persona: DEFAULT_PERSONA,
      overlay,
      commandState,
      launch: (async () => browser) as never,
      sleep: async () => {},
      // Tight timeouts so the 4 missing rounds don't drag the test
      // out for 30s+. maxUnhealthyRounds=1 means the plan bails after
      // 2 unhealthy rounds — round 2 fails, plan exits early.
      timeouts: { roundStart: 30, resultModalPrimary: 30, resultModalExtension: 30 },
      maxUnhealthyRounds: 1,
    });
    // Emit a round_end with a positive score for round 1 so
    // currentGameRoundsObserved=1 (so the zero-rounds gate isn't
    // what's suppressing the credit — the planCompleted gate is).
    fakeCtx.setOnWaitForResultModal(() => {
      fakeCtx.emit("game:round_end", {
        roundNumber: 1,
        gameMode: "classic",
        revealData: { mode: "classic", product: { id: 1, title: "x", priceCents: 1000 } },
        playerResults: [{ playerId: "p1", displayName: "Pricey", avatar: "wizard", score: 900, guessData: null }],
        standings: [{ playerId: "p1", displayName: "Pricey", avatar: "wizard", totalScore: 900 }],
      });
    });
    // Schedule only round 1; rounds 2-5 will time out as unhealthy.
    let scheduled = false;
    const interval = setInterval(() => {
      const lastEvent = events[events.length - 1];
      if (!lastEvent || lastEvent.kind !== "goto" || scheduled) return;
      scheduled = true;
      fakeCtx.emit("game:round_start", {
        roundNumber: 1, gameMode: "classic", timerSeconds: 30,
        product: { id: 1, title: "x", description: "", imageUrl: "", category: "x" },
      });
    }, 5);
    const ac = new AbortController();
    const outcome = await driver.execute({ kind: "solo", mode: "classic", rounds: 5 }, ac.signal);
    clearInterval(interval);

    // Plan bailed early (1 success out of 5 < ceil(5/2)=3) — no_match.
    expect(outcome.status).toBe("no_match");
    // No W/L credited because the plan didn't actually complete.
    expect(commandState.wins).toBe(0);
    expect(commandState.losses).toBe(0);
    expect(commandState.streak).toBe(0);
    // Accumulators reset so the next game starts clean.
    expect(commandState.currentGameScore).toBe(0);
    expect(commandState.currentGameRoundsObserved).toBe(0);
    await driver.shutdown();
  }, 5_000);

  it("does not credit a W/L when zero rounds were observed", async () => {
    // round_start fires but no round_end arrives — view stays null
    // throughout. Plan reports completed (the round was attempted)
    // but currentGameRoundsObserved=0 so finalizeGameOutcome skips
    // the credit. Defensive: a transport-failed round shouldn't
    // count as a loss.
    const { browser, fakeCtx, events } = createFakeBrowserBundle();
    const overlay = createOverlayForwarder(async () => { /* drop */ });
    const commandState = createInitialCommandState(0);
    const driver = createPlaywrightDriver({
      targetUrl: "https://test.invalid",
      persona: DEFAULT_PERSONA,
      overlay,
      commandState,
      launch: (async () => browser) as never,
      sleep: async () => {},
    });
    let scheduled = false;
    const interval = setInterval(() => {
      const lastEvent = events[events.length - 1];
      if (!lastEvent || lastEvent.kind !== "goto" || scheduled) return;
      scheduled = true;
      fakeCtx.emit("game:round_start", {
        roundNumber: 1, gameMode: "classic", timerSeconds: 30,
        product: { id: 1, title: "x", description: "", imageUrl: "", category: "x" },
      });
    }, 5);
    const ac = new AbortController();
    await driver.execute({ kind: "solo", mode: "classic", rounds: 1 }, ac.signal);
    clearInterval(interval);

    expect(commandState.wins).toBe(0);
    expect(commandState.losses).toBe(0);
    expect(commandState.streak).toBe(0);
    expect(commandState.currentGameScore).toBe(0);
    expect(commandState.currentGameRoundsObserved).toBe(0);
    await driver.shutdown();
  }, 20_000);

  it("solo: credits a loss when total score is below WIN_RATIO_THRESHOLD of perRoundMax", async () => {
    // Regression for the streak-never-resets bug: pre-fix, any
    // non-zero solo score was a "win" (`currentGameScore > 0`) so the
    // bot's per-game streak grew monotonically positive in solo and
    // morale never tipped negative. Post-fix, the bot grades against
    // the canonical `WIN_RATIO_THRESHOLD = 0.5` of `perRoundMax * roundsObserved`,
    // matching what `winRecord.ts:computeIsWin` records for non-bot
    // players. A 250/1000 round (25%) is a loss; classic mode threshold
    // is 500.
    const { browser, fakeCtx, events } = createFakeBrowserBundle();
    const overlay = createOverlayForwarder(async () => { /* drop */ });
    const commandState = createInitialCommandState(0);
    const driver = createPlaywrightDriver({
      targetUrl: "https://test.invalid",
      persona: DEFAULT_PERSONA,
      overlay,
      commandState,
      launch: (async () => browser) as never,
      sleep: async () => {},
    });

    // Score=250 in classic (max=1000) — non-zero, but below the 0.5
    // ratio. Pre-fix this was credited as a win.
    await runSoloRound(driver, fakeCtx, events, 250);
    expect(commandState.wins).toBe(0);
    expect(commandState.losses).toBe(1);
    expect(commandState.streak).toBe(-1);

    // Then a high-scoring game flips the streak back positive — confirms
    // the new rule is symmetric (high scores still win).
    await runSoloRound(driver, fakeCtx, events, 800);
    expect(commandState.wins).toBe(1);
    expect(commandState.losses).toBe(1);
    expect(commandState.streak).toBe(1);

    await driver.shutdown();
  }, 20_000);
});

describe("decideMpGameWin", () => {
  // Pure helper: the MP win-condition rule, factored out for direct
  // unit testing instead of building a full executePublicJoin /
  // executeHostPublic harness. Default 5-round classic (max 5000) for
  // the multi-player tests so opponent-comparison branches dominate.
  const MP_DEFAULTS = { mode: "classic" as const, roundsObserved: 5 };

  it("bot wins when its totalScore is the highest", () => {
    expect(decideMpGameWin({
      ...MP_DEFAULTS,
      standings: [
        { playerId: "p-bot", displayName: "Pricey", totalScore: 4500 },
        { playerId: "p-foe", displayName: "Foe", totalScore: 4000 },
      ],
      myPlayerId: "p-bot",
      personaName: "Pricey",
      fallbackScore: 4500,
    })).toBe(true);
  });

  it("bot loses when an opponent has a higher totalScore", () => {
    expect(decideMpGameWin({
      ...MP_DEFAULTS,
      standings: [
        { playerId: "p-bot", displayName: "Pricey", totalScore: 3000 },
        { playerId: "p-foe", displayName: "Foe", totalScore: 8000 },
      ],
      myPlayerId: "p-bot",
      personaName: "Pricey",
      fallbackScore: 3000,
    })).toBe(false);
  });

  it("treats a tie at the top as a win for the bot", () => {
    expect(decideMpGameWin({
      ...MP_DEFAULTS,
      standings: [
        { playerId: "p-bot", displayName: "Pricey", totalScore: 5000 },
        { playerId: "p-foe", displayName: "Foe", totalScore: 5000 },
      ],
      myPlayerId: "p-bot",
      personaName: "Pricey",
      fallbackScore: 5000,
    })).toBe(true);
  });

  it("treats a 0-0 tie as a loss (positive-score guard)", () => {
    // Defensive: a degenerate game where nobody scored shouldn't
    // count as a win for anyone.
    expect(decideMpGameWin({
      ...MP_DEFAULTS,
      standings: [
        { playerId: "p-bot", displayName: "Pricey", totalScore: 0 },
        { playerId: "p-foe", displayName: "Foe", totalScore: 0 },
      ],
      myPlayerId: "p-bot",
      personaName: "Pricey",
      fallbackScore: 0,
    })).toBe(false);
  });

  it("falls back to persona-name match when myPlayerId is null", () => {
    // Mirrors production: the runner doesn't currently bind
    // myPlayerId on the observer. The persona-name match must
    // still resolve the bot correctly.
    expect(decideMpGameWin({
      ...MP_DEFAULTS,
      standings: [
        { playerId: "p-foe", displayName: "Foe", totalScore: 8000 },
        { playerId: "p-bot", displayName: "Pricey", totalScore: 3000 },
      ],
      myPlayerId: null,
      personaName: "Pricey",
      fallbackScore: 3000,
    })).toBe(false);
  });

  it("partitions opponents by playerId, not reference equality", () => {
    // If standings.find returns a fresh object on the persona-name
    // path while reference equality is used to filter opponents, a
    // copy of `me` could mistakenly slip into the opponents list.
    // playerId comparison defends against that.
    const standings = [
      { playerId: "p-bot", displayName: "Pricey", totalScore: 6000 },
      { playerId: "p-bot-clone", displayName: "Pricey", totalScore: 9990 },
      { playerId: "p-foe", displayName: "Foe", totalScore: 1000 },
    ];
    // myPlayerId resolves the canonical bot; the duplicate displayName
    // entry must be classed as an opponent and beat the bot.
    expect(decideMpGameWin({
      ...MP_DEFAULTS,
      standings,
      myPlayerId: "p-bot",
      personaName: "Pricey",
      fallbackScore: 6000,
    })).toBe(false);
  });

  it("treats a single-entry standings (everyone disconnected) as solo: grades against threshold", () => {
    // Solo-collapse branch now uses the same `WIN_RATIO_THRESHOLD`
    // grading as `finalizeGameOutcome`'s solo branch, so a sub-50%
    // bot-only standings is a loss (pre-fix this was a win because
    // the branch only checked `totalScore > 0`). Symmetric with the
    // canonical price.game UI streak rule.
    // 1 round, classic (max 1000). 750/1000 = 75% → win.
    expect(decideMpGameWin({
      mode: "classic", roundsObserved: 1,
      standings: [{ playerId: "p-bot", displayName: "Pricey", totalScore: 750 }],
      myPlayerId: "p-bot",
      personaName: "Pricey",
      fallbackScore: 750,
    })).toBe(true);
    // 250/1000 = 25% → loss. Pre-fix this was true.
    expect(decideMpGameWin({
      mode: "classic", roundsObserved: 1,
      standings: [{ playerId: "p-bot", displayName: "Pricey", totalScore: 250 }],
      myPlayerId: "p-bot",
      personaName: "Pricey",
      fallbackScore: 250,
    })).toBe(false);
    // 0 → loss.
    expect(decideMpGameWin({
      mode: "classic", roundsObserved: 1,
      standings: [{ playerId: "p-bot", displayName: "Pricey", totalScore: 0 }],
      myPlayerId: "p-bot",
      personaName: "Pricey",
      fallbackScore: 0,
    })).toBe(false);
  });

  it("falls back to fallbackScore + threshold when standings are missing or empty", () => {
    // Standings-missing path now also uses the threshold rule (was
    // `fallbackScore > 0` pre-fix). Mirrors what the bot's per-round
    // accounting would have credited if the final round_end had
    // arrived intact.
    expect(decideMpGameWin({
      mode: "classic", roundsObserved: 1,
      standings: undefined,
      myPlayerId: null,
      personaName: "Pricey",
      fallbackScore: 1000,
    })).toBe(true);
    // 400/1000 = 40% → loss. Pre-fix this was true.
    expect(decideMpGameWin({
      mode: "classic", roundsObserved: 1,
      standings: [],
      myPlayerId: null,
      personaName: "Pricey",
      fallbackScore: 400,
    })).toBe(false);
    expect(decideMpGameWin({
      mode: "classic", roundsObserved: 1,
      standings: [],
      myPlayerId: null,
      personaName: "Pricey",
      fallbackScore: 0,
    })).toBe(false);
  });

  it("solo-collapse honours the chain-reaction per-round max (1313)", () => {
    // 657 * 5 = 3285 / (1313 * 5 = 6565) ≈ 50.04% → win.
    // 656 * 5 = 3280 / 6565 ≈ 49.96% → loss.
    expect(decideMpGameWin({
      mode: "chain-reaction", roundsObserved: 5,
      standings: [{ playerId: "p-bot", displayName: "Pricey", totalScore: 3285 }],
      myPlayerId: "p-bot",
      personaName: "Pricey",
      fallbackScore: 3285,
    })).toBe(true);
    expect(decideMpGameWin({
      mode: "chain-reaction", roundsObserved: 5,
      standings: [{ playerId: "p-bot", displayName: "Pricey", totalScore: 3280 }],
      myPlayerId: "p-bot",
      personaName: "Pricey",
      fallbackScore: 3280,
    })).toBe(false);
  });
});

describe("Phase 4 rate-limit short-circuit", () => {
  it("abandons the round when a 429 console error arrives after the enactor finishes", async () => {
    const { browser, fakeCtx, events } = createFakeBrowserBundle();
    const telemetry: Array<{ evt: string; reason?: string; mode?: string }> = [];
    const driver = createPlaywrightDriver({
      targetUrl: "https://test.invalid",
      persona: DEFAULT_PERSONA,
      launch: (async () => browser) as never,
      sleep: async () => {},
      // Tight Phase 1 (round_start) timeout to keep the test fast;
      // generous resultModalPrimary so any quick-resolution is
      // unambiguously the short-circuit path, not the timeout path.
      // Probe interval shortened so the 429 is observed within ~150ms.
      timeouts: {
        roundStart: 200,
        resultModalPrimary: 30_000,
        resultModalExtension: 45_000,
        probeIntervalMs: 100,
      },
      maxUnhealthyRounds: 1,
      telemetry: { log: (e) => telemetry.push(e as { evt: string; reason?: string; mode?: string }) },
    });

    // The result-modal wait must actually block — without this the
    // fake's instant-resolving waitForSelector returns "ok" before
    // the rate-limit signal can fire, and the bot proceeds as if
    // the modal mounted normally.
    fakeCtx.addBlockingSelector((sel) => sel.includes("round-result-next"));

    // Drive the round: emit round_start once the page navigates,
    // then fire a 429 the moment the bot starts waiting for the
    // result modal (= moment the enactor finished its submit).
    let scenarioFired = false;
    const interval = setInterval(() => {
      const last = events[events.length - 1];
      if (!last) return;
      if (last.kind === "goto" && !scenarioFired) {
        fakeCtx.emit("game:round_start", {
          roundNumber: 1,
          gameMode: "classic",
          timerSeconds: 30,
          product: { id: 1, title: "USB cable", description: "", imageUrl: "", category: "Electronics" },
        });
      }
      if (
        last.kind === "waitForSelector" &&
        last.selector.includes("round-result-next") &&
        !scenarioFired
      ) {
        scenarioFired = true;
        // The page just submitted (enactor done) and is now waiting
        // for the result modal. Synthesise the 429 the production
        // server would have surfaced via window.console.error.
        fakeCtx.emitConsole("error", "Failed to submit guess: Error: API error 429: Too many requests");
      }
    }, 5);

    const ac = new AbortController();
    const t0 = Date.now();
    const outcome = await driver.execute({ kind: "solo", mode: "classic", rounds: 1 }, ac.signal);
    const elapsed = Date.now() - t0;
    clearInterval(interval);

    // The plan abandoned (1 round / 1 unhealthy → maxUnhealthyRounds=1
    // boundary → no_match). The relevant assertion is that we did NOT
    // burn the full 30s+ primary modal timeout.
    expect(outcome.status).toBe("no_match");
    // Generous bound — probe interval is 100ms, but the test setup
    // (driver init, navigation, Phase 1, Phase 2 reading delays) adds
    // overhead. Anything well under 30s proves the short-circuit fired.
    expect(elapsed).toBeLessThan(15_000);
    // Telemetry surface — operators rely on this event to spot when
    // the server-side bypass isn't taking effect.
    expect(telemetry.some((e) => e.evt === "rate_limited")).toBe(true);
    await driver.shutdown();
  }, 30_000);
});

describe("isRateLimitConsoleMessage", () => {
  // The Phase 4 short-circuit relies on this predicate to detect when
  // the page surfaced a 429 from the API. Each case below is a
  // representative log line we either DO or DON'T want to fire on.

  it("matches the canonical in-page submit-failure envelope", () => {
    expect(
      isRateLimitConsoleMessage(
        "error",
        "Failed to submit guess: Error: API error 429: {\"error\":\"Too many requests, please try again later\"}",
      ),
    ).toBe(true);
  });

  it("ignores non-error console levels even when the text matches", () => {
    // Without this gate the page's own status-bar warnings could
    // false-positive as rate limits and abandon healthy rounds.
    expect(isRateLimitConsoleMessage("warn", "API error 429")).toBe(false);
    expect(isRateLimitConsoleMessage("log", "API error 429")).toBe(false);
    expect(isRateLimitConsoleMessage("info", "API error 429")).toBe(false);
  });

  it("ignores 429s from non-API sources (third-party widgets, telemetry, asset 429s)", () => {
    // Pattern is narrowed to the canonical "API error 429" envelope so
    // unrelated 429 chatter on the page can't abandon healthy rounds.
    expect(
      isRateLimitConsoleMessage(
        "error",
        "[browser:error] Failed to load resource: the server responded with a status of 429 ()",
      ),
    ).toBe(false);
    expect(isRateLimitConsoleMessage("error", "telemetry beacon got 429")).toBe(false);
    expect(isRateLimitConsoleMessage("error", "Too many requests, please try again later")).toBe(false);
  });

  it("does not match unrelated error chatter", () => {
    expect(isRateLimitConsoleMessage("error", "Uncaught TypeError: foo is undefined")).toBe(false);
    expect(isRateLimitConsoleMessage("error", "")).toBe(false);
  });
});

describe("SINGLE_ACTION_MODES", () => {
  it("excludes 'bidding' so MP rounds do not trigger the verify-and-reattempt path", () => {
    // Regression guard: in MP bidding, the round-result modal only
    // appears after ALL 4 players have bid (up to 4×20s = 80s). The
    // 3s actionVerifyMs window times out for any non-last bidder and
    // reattempts the enactor — which then blocks the round path
    // waiting for an input that has already submitted. The reattempt
    // would burn ~100s per round and strand the bot through game:over.
    //
    // Phase 4's primary + extension wait already handles the result-
    // modal latency for bidding without the reattempt cost.
    expect(SINGLE_ACTION_MODES.has("bidding")).toBe(false);
  });

  it("still includes single-product modes that benefit from the verify path", () => {
    // The verify-and-reattempt mechanism remains valuable for solo
    // modes where a missed click manifests as no result modal. Guard
    // against accidentally emptying the set entirely.
    expect(SINGLE_ACTION_MODES.has("classic")).toBe(true);
    expect(SINGLE_ACTION_MODES.has("higher-lower")).toBe(true);
    expect(SINGLE_ACTION_MODES.has("comparison")).toBe(true);
  });
});
