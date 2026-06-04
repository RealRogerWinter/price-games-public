/**
 * Tests for the overlay bus reducer + useOverlayState hook.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import {
  reduceOverlayEvent,
  useOverlayState,
  dispatchOverlayEvent,
  decodePcmEnvelope,
  pcmEvents,
  sanitizeNnTick,
  sanitizeNnHealth,
  sanitizeThoughtBubble,
  sanitizeThoughtText,
  drainPcmReplayQueue,
  subtitleVisible,
  isSpeaking,
  SUBTITLE_MIN_VISIBLE_MS,
  __resetReplayBuffersForTests,
  type PcmChunkDetail,
  type CurrentUtterance,
  __overlayBusInternals,
} from "./overlayBus";

const { MESSAGE_SOURCE, INITIAL_STATE, CHAT_HISTORY_LIMIT, RECENT_ROUNDS_LIMIT, STORAGE_KEY, STORAGE_VERSION } =
  __overlayBusInternals;

function env(kind: string, payload?: unknown) {
  return { source: MESSAGE_SOURCE, kind, payload } as const;
}

describe("reduceOverlayEvent", () => {
  it("ignores unknown event kinds", () => {
    const next = reduceOverlayEvent(INITIAL_STATE, env("nope") as never);
    expect(next).toBe(INITIAL_STATE);
  });

  it("updates lifecycle phase", () => {
    const next = reduceOverlayEvent(INITIAL_STATE, env("lifecycle.phase", { phase: "in_round" }) as never);
    expect(next.phase).toBe("in_round");
  });

  it("ignores lifecycle.phase with missing phase field", () => {
    const next = reduceOverlayEvent(INITIAL_STATE, env("lifecycle.phase", {}) as never);
    expect(next).toBe(INITIAL_STATE);
  });

  it("round.decision translates the legacy rationale into a strategy_rationale thought", () => {
    // The bus migrated from a single-slot rationale to the unified
    // thoughts FIFO. round.decision is still emitted by the runner
    // for backward-compat, but the reducer turns it into a thought
    // entry rather than mutating a deprecated slot.
    const next = reduceOverlayEvent(
      INITIAL_STATE,
      env("round.decision", { rationale: "go higher than the median" }) as never,
    );
    expect(next.thoughts).toHaveLength(1);
    expect(next.thoughts[0].text).toBe("go higher than the median");
    expect(next.thoughts[0].intent).toBe("strategy_rationale");
  });

  it("round.decision is dropped when the rationale is missing or empty", () => {
    expect(reduceOverlayEvent(INITIAL_STATE, env("round.decision", {}) as never).thoughts).toHaveLength(0);
    expect(reduceOverlayEvent(INITIAL_STATE, env("round.decision", { rationale: "   " }) as never).thoughts).toHaveLength(0);
  });

  it("round.start does NOT clear thoughts (the FIFO carries across rounds)", () => {
    // Pre-migration, round.start cleared the single rationale slot.
    // The thought feed is meant to span rounds — the FIFO eviction
    // does the cleanup as new thoughts push old ones off the stack.
    const seeded = reduceOverlayEvent(
      INITIAL_STATE,
      env("round.decision", { rationale: "previous round read" }) as never,
    );
    const next = reduceOverlayEvent(
      seeded,
      env("round.start", { mode: "classic", roundIndex: 1, totalRounds: 5 }) as never,
    );
    expect(next.currentRound?.mode).toBe("classic");
    expect(next.thoughts).toHaveLength(1);
    expect(next.thoughts[0].text).toBe("previous round read");
  });

  it("ignores round.start without a mode", () => {
    const next = reduceOverlayEvent(INITIAL_STATE, env("round.start", { roundIndex: 1 }) as never);
    expect(next).toBe(INITIAL_STATE);
  });

  it("appends recent rounds in newest-first order, bounded by limit", () => {
    let state = reduceOverlayEvent(
      INITIAL_STATE,
      env("round.start", { mode: "higher-lower", roundIndex: 1, totalRounds: 5 }) as never,
    );
    for (let i = 0; i < RECENT_ROUNDS_LIMIT + 3; i++) {
      state = reduceOverlayEvent(
        state,
        env("round.result", { outcome: i % 2 ? "correct" : "incorrect", points: i * 10 }) as never,
      );
    }
    expect(state.recentRounds).toHaveLength(RECENT_ROUNDS_LIMIT);
    // newest first — the latest event has the highest points
    expect(state.recentRounds[0].points).toBe((RECENT_ROUNDS_LIMIT + 2) * 10);
  });

  it("merges stats updates partially", () => {
    const a = reduceOverlayEvent(
      INITIAL_STATE,
      env("stats.update", { wins: 10, mood: "happy" }) as never,
    );
    expect(a.stats.wins).toBe(10);
    expect(a.stats.losses).toBe(0);
    expect(a.stats.mood).toBe("happy");
    const b = reduceOverlayEvent(a, env("stats.update", { losses: 4 }) as never);
    expect(b.stats.wins).toBe(10);
    expect(b.stats.losses).toBe(4);
    expect(b.stats.mood).toBe("happy");
  });

  it("drops a stats.update mood that is not in the allowlist (preserves prior mood)", () => {
    // Defends Phase 1C, which will key dynamic class / sprite selection
    // off `data-mood`. A spoofed postMessage with a hostile mood string
    // must never reach the DOM as an arbitrary attribute value.
    const seeded = reduceOverlayEvent(
      INITIAL_STATE,
      env("stats.update", { mood: "happy" }) as never,
    );
    expect(seeded.stats.mood).toBe("happy");
    const after = reduceOverlayEvent(
      seeded,
      env("stats.update", { mood: "totally-not-real-mood" }) as never,
    );
    expect(after.stats.mood).toBe("happy");
  });

  it("accepts every documented mood through stats.update", () => {
    let state = INITIAL_STATE;
    for (const mood of ["neutral", "happy", "frustrated", "focused"] as const) {
      state = reduceOverlayEvent(state, env("stats.update", { mood }) as never);
      expect(state.stats.mood).toBe(mood);
    }
  });

  it("mood.snapshot writes the full snapshot AND mirrors mood into stats.mood", () => {
    const next = reduceOverlayEvent(
      INITIAL_STATE,
      env("mood.snapshot", { mood: "elated", vibe: 2.5, morale: 0.6, streak: 4, updatedAt: 1700000000000 }) as never,
    );
    expect(next.moodSnapshot).toEqual({
      mood: "elated",
      vibe: 2.5,
      morale: 0.6,
      streak: 4,
      updatedAt: 1700000000000,
    });
    // Mirror keeps the legacy stats.mood channel in sync without
    // waiting for the next /stats POST — Avatar's data-mood reads
    // off stats.mood today.
    expect(next.stats.mood).toBe("elated");
  });

  it("mood.snapshot clamps vibe / morale to engine bounds and floors fractional streak", () => {
    const next = reduceOverlayEvent(
      INITIAL_STATE,
      env("mood.snapshot", { mood: "frustrated", vibe: -99, morale: 5, streak: 1.7 }) as never,
    );
    expect(next.moodSnapshot).toMatchObject({
      mood: "frustrated",
      vibe: -3,
      morale: 1,
      streak: 1,
    });
  });

  it("stats.update with a fresh mood mirrors into moodSnapshot.mood when a snapshot exists", () => {
    // Parity bug fix: once a mood.snapshot has landed, a subsequent
    // stats.update arriving with a newer mood used to be invisible to
    // MoodWheel (which prefers snapshot.mood). Now stats.update writes
    // through to moodSnapshot.mood as well so wheel + avatar agree on
    // whichever channel was freshest.
    const seeded = reduceOverlayEvent(
      INITIAL_STATE,
      env("mood.snapshot", { mood: "neutral", vibe: 0, morale: 0, streak: 0 }) as never,
    );
    expect(seeded.moodSnapshot?.mood).toBe("neutral");
    const next = reduceOverlayEvent(
      seeded,
      env("stats.update", { mood: "happy", wins: 1 }) as never,
    );
    expect(next.stats.mood).toBe("happy");
    expect(next.moodSnapshot?.mood).toBe("happy");
    // Vibe / morale / streak on the snapshot are NOT touched — only
    // the label moves; the hidden axes only update via mood.snapshot.
    expect(next.moodSnapshot?.vibe).toBe(0);
    expect(next.moodSnapshot?.morale).toBe(0);
    expect(next.moodSnapshot?.streak).toBe(0);
  });

  it("stats.update mood mirror is a no-op when no moodSnapshot has landed yet", () => {
    // Cold-start path: the wheel's resolveMood() falls back to
    // stats.mood when snapshot is null. We only mirror once a snapshot
    // exists so we don't synthesise a half-formed snapshot from a
    // stats.update payload (which lacks vibe / morale).
    const next = reduceOverlayEvent(
      INITIAL_STATE,
      env("stats.update", { mood: "happy", wins: 1 }) as never,
    );
    expect(next.stats.mood).toBe("happy");
    expect(next.moodSnapshot).toBeNull();
  });

  it("stats.update mood mirror skips invalid moods (snapshot.mood preserved)", () => {
    const seeded = reduceOverlayEvent(
      INITIAL_STATE,
      env("mood.snapshot", { mood: "happy", vibe: 2, morale: 0.5, streak: 2 }) as never,
    );
    const next = reduceOverlayEvent(
      seeded,
      env("stats.update", { mood: "totally-not-real-mood", wins: 1 }) as never,
    );
    expect(next.stats.mood).toBe("happy");
    expect(next.moodSnapshot?.mood).toBe("happy");
  });

  it("mood.snapshot drops malformed payloads (unknown mood, non-finite vibe/morale/streak)", () => {
    const baseline = reduceOverlayEvent(
      INITIAL_STATE,
      env("mood.snapshot", { mood: "happy", vibe: 1, morale: 0, streak: 1 }) as never,
    );
    for (const bad of [
      { mood: "evil-laugh", vibe: 0, morale: 0, streak: 0 },   // unknown label
      { mood: "happy", vibe: NaN, morale: 0, streak: 0 },       // non-finite vibe
      { mood: "happy", vibe: 0, morale: Infinity, streak: 0 },  // non-finite morale
      { mood: "happy", vibe: 0, morale: 0, streak: NaN },       // non-finite streak
      { vibe: 0, morale: 0, streak: 0 },                        // missing mood
      undefined,
    ]) {
      const next = reduceOverlayEvent(baseline, env("mood.snapshot", bad) as never);
      // Snapshot stays at its previous value — the malformed event is a no-op.
      expect(next.moodSnapshot).toEqual(baseline.moodSnapshot);
    }
  });

  it("appends chat messages bounded by history limit", () => {
    let state = INITIAL_STATE;
    for (let i = 0; i < CHAT_HISTORY_LIMIT + 5; i++) {
      state = reduceOverlayEvent(
        state,
        env("chat.message", { user: `u${i}`, text: `msg${i}`, platform: "twitch" }) as never,
      );
    }
    expect(state.chat).toHaveLength(CHAT_HISTORY_LIMIT);
    // oldest dropped — the first remaining message should be msg5
    expect(state.chat[0].text).toBe("msg5");
    expect(state.chat[state.chat.length - 1].text).toBe(`msg${CHAT_HISTORY_LIMIT + 4}`);
  });

  it("ignores chat messages with no text", () => {
    const next = reduceOverlayEvent(
      INITIAL_STATE,
      env("chat.message", { user: "u", platform: "twitch" }) as never,
    );
    expect(next).toBe(INITIAL_STATE);
  });

  it("sets and clears music.now", () => {
    const a = reduceOverlayEvent(INITIAL_STATE, env("music.now", { title: "Coffee Shop" }) as never);
    expect(a.music?.title).toBe("Coffee Shop");
    const b = reduceOverlayEvent(a, env("music.now", null) as never);
    expect(b.music).toBeNull();
  });

  describe("Phase B reducers", () => {
    // Legacy tts.line / tts.state tests retired in PR 4 — both
    // envelope kinds were removed once the page consumes
    // tts.utterance.* exclusively. The currentUtterance reducer
    // tests below cover the replacement contract.

    it("cursor.aim stamps the bbox with arrival time", () => {
      const next = reduceOverlayEvent(
        INITIAL_STATE,
        env("cursor.aim", { x: 100, y: 200, width: 80, height: 40 }) as never,
      );
      expect(next.cursorAim).toMatchObject({ x: 100, y: 200, width: 80, height: 40 });
      expect(typeof next.cursorAim?.at).toBe("number");
    });

    it("cursor.aim ignores malformed payloads", () => {
      const noW = reduceOverlayEvent(INITIAL_STATE, env("cursor.aim", { x: 100, y: 200, height: 40 }) as never);
      expect(noW).toBe(INITIAL_STATE);
      const stringX = reduceOverlayEvent(INITIAL_STATE, env("cursor.aim", { x: "100", y: 200, width: 80, height: 40 }) as never);
      expect(stringX).toBe(INITIAL_STATE);
    });

    it("mp.lobby_countdown captures elapsed/remaining/playerCount/roomCode", () => {
      const next = reduceOverlayEvent(
        INITIAL_STATE,
        env("mp.lobby_countdown", { elapsedSec: 30, remainingSec: 30, playerCount: 2, roomCode: "ABC123" }) as never,
      );
      expect(next.lobbyCountdown).toMatchObject({
        elapsedSec: 30,
        remainingSec: 30,
        playerCount: 2,
        roomCode: "ABC123",
      });
    });

    it("lifecycle.phase transitioning out of queuing clears the lobby countdown", () => {
      const queuing = reduceOverlayEvent(INITIAL_STATE, env("lifecycle.phase", { phase: "queuing" }) as never);
      const withCountdown = reduceOverlayEvent(
        queuing,
        env("mp.lobby_countdown", { elapsedSec: 10, remainingSec: 50, playerCount: 1, roomCode: "X" }) as never,
      );
      expect(withCountdown.lobbyCountdown).not.toBeNull();
      // Transitioning to in_round clears the countdown — radar disappears.
      const inRound = reduceOverlayEvent(withCountdown, env("lifecycle.phase", { phase: "in_round" }) as never);
      expect(inRound.lobbyCountdown).toBeNull();
    });

    it("nn.tick stores well-formed payloads, ignores malformed ones", () => {
      const validTick = {
        roundId: "r-1",
        phase: "result" as const,
        network: { layers: [], weightSamples: [] },
        prediction: { cents: 1500, sigma: 200 },
        belief: {
          topCategory: { id: 0, name: "x", prob: 0.5 },
          brandTier: { tier: "mid" as const, prob: 0.5, gated: false },
          topFeatures: [],
        },
        embedding2d: { x: 0, y: 0 },
        recentLosses: [],
        recentAccuracy: [],
        teachingMoment: { triggered: false },
        ageMs: 1,
      };
      const stored = reduceOverlayEvent(INITIAL_STATE, env("nn.tick", validTick) as never);
      expect(stored.nnTick?.roundId).toBe("r-1");

      // Malformed: missing phase. The reducer keeps the prior tick.
      const next = reduceOverlayEvent(stored, env("nn.tick", { roundId: "x", network: { layers: [] } }) as never);
      expect(next.nnTick?.roundId).toBe("r-1");

      // Malformed: bad phase string.
      const next2 = reduceOverlayEvent(stored, env("nn.tick", { ...validTick, phase: "weird" }) as never);
      expect(next2.nnTick?.roundId).toBe("r-1");
    });

    it("nn.tick normalises missing scalar fields so panels can dot-into safely", () => {
      // Minimal valid envelope — every other field is absent. The
      // sanitizer must fill safe defaults so panels don't crash on
      // `tick.prediction.cents`, `tick.belief.topFeatures`, etc.
      const minimal = {
        roundId: "r-min",
        phase: "result" as const,
        network: { layers: [{ name: "L0" }] }, // weightSamples missing too
      };
      const next = reduceOverlayEvent(INITIAL_STATE, env("nn.tick", minimal) as never);
      const t = next.nnTick;
      expect(t).not.toBeNull();
      expect(t!.prediction.cents).toBe(0);
      expect(t!.prediction.sigma).toBe(0);
      // Post-PR-4: belief shape is { topFeatures, sentence? } only.
      expect(Array.isArray(t!.belief.topFeatures)).toBe(true);
      expect(t!.belief.topFeatures).toEqual([]);
      expect(Array.isArray(t!.recentLosses)).toBe(true);
      expect(Array.isArray(t!.recentAccuracy)).toBe(true);
      expect(t!.teachingMoment.triggered).toBe(false);
      expect(t!.embedding2d.x).toBe(0);
      expect(t!.network.layers[0].name).toBe("L0");
      expect(Array.isArray(t!.network.weightSamples)).toBe(true);
    });

    it("nn.tick filters out junk array entries", () => {
      const dirty = {
        roundId: "r-dirty",
        phase: "result" as const,
        network: {
          layers: [{ name: "ok" }, "garbage", null],
          weightSamples: [{ fromLayer: 0, fromIdx: 0, toLayer: 1, toIdx: 0, weight: 0.1 }, "junk"],
        },
        recentAccuracy: ["within10", "weird", null, "miss"],
        belief: {
          // PR-4 belief shape is just topFeatures + optional sentence.
          // Stale topCategory / brandTier fields on the wire should be
          // dropped by the sanitiser, not crash it.
          topFeatures: [{ name: "ok", contribution: 0.5 }, "junk", null],
        },
      };
      const next = reduceOverlayEvent(INITIAL_STATE, env("nn.tick", dirty) as never);
      const t = next.nnTick;
      expect(t!.network.layers.length).toBe(1);
      expect(t!.network.weightSamples.length).toBe(1);
      expect(t!.recentAccuracy).toEqual(["within10", "miss"]);
      expect(t!.belief.topFeatures.length).toBe(1);
      expect(t!.belief.topFeatures[0].name).toBe("ok");
    });
  });
});

/* ----- Health block — feeds the NeuralDebugHud ---------------------- */

describe("sanitizeNnHealth", () => {
  function fixtureHealth(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      round: 142,
      loss: 0.83,
      gradNormP95: 0.42,
      learningRate: 8.5e-4,
      warmupStep: 142,
      warmupTotal: 200,
      bufferSize: 384,
      bufferCapacity: 512,
      batchSize: 16,
      stepsPerRound: 6,
      goldenMAE: 214,
      snapshotAgeMs: 42_000,
      teachingMomentsCount: 3,
      nanRollbacks: 0,
      frozen: false,
      ...overrides,
    };
  }

  it("returns undefined on null / non-object payloads", () => {
    expect(sanitizeNnHealth(null)).toBeUndefined();
    expect(sanitizeNnHealth(undefined)).toBeUndefined();
    expect(sanitizeNnHealth("string")).toBeUndefined();
    expect(sanitizeNnHealth(42)).toBeUndefined();
  });

  it("returns the normalized health block on a well-formed payload", () => {
    const out = sanitizeNnHealth(fixtureHealth());
    expect(out).toMatchObject({
      round: 142,
      loss: 0.83,
      gradNormP95: 0.42,
      learningRate: 8.5e-4,
      bufferSize: 384,
      bufferCapacity: 512,
      goldenMAE: 214,
      snapshotAgeMs: 42_000,
      teachingMomentsCount: 3,
      nanRollbacks: 0,
      frozen: false,
    });
  });

  it("preserves loss=null and goldenMAE=null on cold start", () => {
    const out = sanitizeNnHealth(fixtureHealth({ loss: null, goldenMAE: null }));
    expect(out?.loss).toBeNull();
    expect(out?.goldenMAE).toBeNull();
  });

  it.each([
    ["round", "x"],
    ["round", Number.NaN],
    ["gradNormP95", "0.42"],
    ["bufferSize", null],
    ["batchSize", undefined],
    ["snapshotAgeMs", Number.POSITIVE_INFINITY],
    ["learningRate", Number.NEGATIVE_INFINITY],
  ])("drops the entire block when %s is %p (no zero-substitution)", (field, badValue) => {
    expect(sanitizeNnHealth(fixtureHealth({ [field]: badValue }))).toBeUndefined();
  });

  it("clamps negative numeric fields to zero on the happy path", () => {
    const out = sanitizeNnHealth(fixtureHealth({ gradNormP95: -1, learningRate: -0.001, snapshotAgeMs: -5 }));
    expect(out?.gradNormP95).toBe(0);
    expect(out?.learningRate).toBe(0);
    expect(out?.snapshotAgeMs).toBe(0);
  });

  it("treats only frozen===true as frozen (no string/numeric coercion)", () => {
    expect(sanitizeNnHealth(fixtureHealth({ frozen: "true" }))?.frozen).toBe(false);
    expect(sanitizeNnHealth(fixtureHealth({ frozen: 1 }))?.frozen).toBe(false);
    expect(sanitizeNnHealth(fixtureHealth({ frozen: true }))?.frozen).toBe(true);
  });
});

describe("sanitizeNnTick — health block integration", () => {
  function validTick(extras: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      roundId: "r-1",
      phase: "result",
      network: { layers: [], weightSamples: [] },
      prediction: { cents: 100, sigma: 10 },
      belief: { topFeatures: [] },
      embedding2d: { x: 0, y: 0 },
      recentLosses: [],
      recentAccuracy: [],
      teachingMoment: { triggered: false },
      ageMs: 1,
      ...extras,
    };
  }

  it("includes the health block when valid", () => {
    const out = sanitizeNnTick(
      validTick({
        health: {
          round: 5, loss: 1.2, gradNormP95: 0.3, learningRate: 1e-3,
          warmupStep: 5, warmupTotal: 200,
          bufferSize: 5, bufferCapacity: 512, batchSize: 16, stepsPerRound: 6,
          goldenMAE: null, snapshotAgeMs: 1000, teachingMomentsCount: 0,
          nanRollbacks: 0, frozen: false,
        },
      }),
    );
    expect(out?.health).toMatchObject({ round: 5, loss: 1.2, bufferSize: 5 });
  });

  it("strips an invalid health block but keeps the rest of the tick", () => {
    const out = sanitizeNnTick(
      validTick({ health: { round: "garbage" } }),
    );
    expect(out).not.toBeNull();
    expect(out?.health).toBeUndefined();
    expect(out?.roundId).toBe("r-1");
  });
});

describe("useOverlayState", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  it("returns initial state with no events", () => {
    const { result } = renderHook(() => useOverlayState());
    expect(result.current.phase).toBe("idle");
    expect(result.current.currentRound).toBeNull();
    expect(result.current.chat).toEqual([]);
  });

  it("updates state when bus events are dispatched", async () => {
    const { result } = renderHook(() => useOverlayState());
    await act(async () => {
      dispatchOverlayEvent("lifecycle.phase", { phase: "in_round" });
      // postMessage is async; flush.
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(result.current.phase).toBe("in_round");
  });

  it("ignores foreign messages without the pg-bot source", async () => {
    const { result } = renderHook(() => useOverlayState());
    await act(async () => {
      window.postMessage({ source: "other-extension", kind: "lifecycle.phase", payload: { phase: "in_round" } }, "*");
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(result.current.phase).toBe("idle");
  });

  it("end-to-end mood parity: a stats.update mood landing after a snapshot mirrors into moodSnapshot.mood", async () => {
    // Integration regression for the wheel/avatar desync. The bot
    // delivers `stats.update` via instant same-tab postMessage but
    // `mood.snapshot` via a slower socket round-trip. Without the
    // mirror, MoodWheel (snapshot.mood) lags the Avatar (stats.mood)
    // by an entire round. This asserts the parity guarantee at the
    // hook level — the slot the wheel reads tracks the slot the
    // avatar reads on every envelope ordering.
    const { result } = renderHook(() => useOverlayState());
    await act(async () => {
      dispatchOverlayEvent("mood.snapshot", { mood: "neutral", vibe: 0, morale: 0, streak: 0 });
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(result.current.moodSnapshot?.mood).toBe("neutral");
    expect(result.current.stats.mood).toBe("neutral");
    // Stats.update arrives with the new label first (postMessage path
    // is synchronous; the matching mood.snapshot still in-flight on
    // the socket leg).
    await act(async () => {
      dispatchOverlayEvent("stats.update", { mood: "happy", wins: 1 });
      await new Promise((r) => setTimeout(r, 0));
    });
    // PARITY: both slots now read "happy" — the wheel and avatar
    // render the same mood on the very next paint.
    expect(result.current.stats.mood).toBe("happy");
    expect(result.current.moodSnapshot?.mood).toBe("happy");
    // Vibe / morale / streak on the snapshot are untouched — those
    // hidden axes only update via the mood.snapshot channel.
    expect(result.current.moodSnapshot?.vibe).toBe(0);
    expect(result.current.moodSnapshot?.morale).toBe(0);
  });
});

describe("replay buffers — pre-mount cold-start race fix", () => {
  // The runner can dispatch tts.line / tts.state / tts.audio_chunk
  // envelopes before the page-side React tree has even mounted (the
  // bot navigates and immediately starts speaking). useOverlayState's
  // message listener attaches in a useEffect; pcmEvents subscribers
  // (Avatar) attach even later (lazy chunk). Without buffering, the
  // very first utterance of a session has no mouth animation.
  //
  // Two buffers cover the gap:
  //   1. pendingEnvelopes — module-load-time listener captures all
  //      envelopes; useOverlayState drains them on mount.
  //   2. pcmReplayQueue — every decoded PCM chunk is also pushed to
  //      a small ring; Avatar drains on its own mount even if it
  //      mounted after the bus did.

  beforeEach(() => {
    window.sessionStorage.clear();
    __resetReplayBuffersForTests();
  });

  it("drains envelopes that were posted before useOverlayState mounted", async () => {
    // Post BEFORE mount — the module-load-time listener captures them.
    window.postMessage(
      { source: __overlayBusInternals.MESSAGE_SOURCE, kind: "lifecycle.phase", payload: { phase: "in_round" } },
      "*",
    );
    window.postMessage(
      { source: __overlayBusInternals.MESSAGE_SOURCE, kind: "stats.update", payload: { wins: 7 } },
      "*",
    );
    // Yield so the module-load listener actually receives them.
    await new Promise((r) => setTimeout(r, 0));
    // Now mount — should drain both envelopes through the reducer.
    let result: { current: ReturnType<typeof useOverlayState> } | null = null;
    await act(async () => {
      ({ result } = renderHook(() => useOverlayState()));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(result!.current.phase).toBe("in_round");
    expect(result!.current.stats.wins).toBe(7);
  });

  it("preserves drain order so newer events overwrite older ones in the same slot", async () => {
    window.postMessage(
      { source: __overlayBusInternals.MESSAGE_SOURCE, kind: "lifecycle.phase", payload: { phase: "queuing" } },
      "*",
    );
    window.postMessage(
      { source: __overlayBusInternals.MESSAGE_SOURCE, kind: "lifecycle.phase", payload: { phase: "in_round" } },
      "*",
    );
    await new Promise((r) => setTimeout(r, 0));
    let result: { current: ReturnType<typeof useOverlayState> } | null = null;
    await act(async () => {
      ({ result } = renderHook(() => useOverlayState()));
      await new Promise((r) => setTimeout(r, 0));
    });
    // Newer wins — "in_round" was dispatched second, so it must be
    // the final phase after the drain completes.
    expect(result!.current.phase).toBe("in_round");
  });

  it("buffers tts.utterance.audio_batch envelopes and dispatches the per-chunk events on pcmEvents during drain", async () => {
    const i16 = Int16Array.from([100, -100, 200, -200, 300, -300]);
    const u8 = new Uint8Array(i16.buffer);
    let bin = "";
    for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
    const b64 = btoa(bin);
    // Pre-mount post — a single batch carrying two chunks. The bus
    // iterates the array, decodes each, dispatches per-chunk events.
    window.postMessage(
      {
        source: __overlayBusInternals.MESSAGE_SOURCE,
        kind: "tts.utterance.audio_batch",
        payload: {
          id: "u-batch",
          sampleRate: 22050,
          chunks: [
            { samples: b64, ts: 1 },
            { samples: b64, ts: 2 },
          ],
        },
      },
      "*",
    );
    await new Promise((r) => setTimeout(r, 0));
    const received: PcmChunkDetail[] = [];
    const handler = (ev: Event) => received.push((ev as CustomEvent<PcmChunkDetail>).detail);
    pcmEvents.addEventListener("chunk", handler);
    await act(async () => {
      renderHook(() => useOverlayState());
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(received.length).toBe(2);
    expect(Array.from(received[0].samples)).toEqual([100, -100, 200, -200, 300, -300]);
    pcmEvents.removeEventListener("chunk", handler);
  });

  it("drainPcmReplayQueue returns chunks that were processed before any subscriber attached", async () => {
    const i16 = Int16Array.from([1000, 2000, 3000, 4000]);
    const u8 = new Uint8Array(i16.buffer);
    let bin = "";
    for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
    const b64 = btoa(bin);
    // Mount the bus FIRST so the batch is decoded and the chunks
    // are pushed to the pcm replay queue. No pcmEvents subscriber is
    // attached, so the dispatch-side does nothing — but the queue
    // captures every chunk in the batch.
    await act(async () => {
      renderHook(() => useOverlayState());
      await new Promise((r) => setTimeout(r, 0));
    });
    await act(async () => {
      dispatchOverlayEvent("tts.utterance.audio_batch", {
        id: "u-replay",
        sampleRate: 22050,
        chunks: [{ samples: b64, ts: 1 }],
      });
      await new Promise((r) => setTimeout(r, 0));
    });
    const drained = drainPcmReplayQueue();
    expect(drained.length).toBe(1);
    expect(Array.from(drained[0].samples)).toEqual([1000, 2000, 3000, 4000]);
    // Second call returns empty — drain consumed the queue.
    expect(drainPcmReplayQueue().length).toBe(0);
  });

  it("caps the pending-envelopes buffer so a misbehaving sender can't grow memory unbounded", async () => {
    // Push more than the documented cap; the bus must keep only the
    // most recent. We can't read the cap from outside, but a clear
    // overage (e.g. 1000 envelopes when cap is 500) should still
    // produce a finite final state with the most recent values.
    for (let i = 0; i < 1000; i++) {
      window.postMessage(
        { source: __overlayBusInternals.MESSAGE_SOURCE, kind: "stats.update", payload: { wins: i } },
        "*",
      );
    }
    await new Promise((r) => setTimeout(r, 0));
    let result: { current: ReturnType<typeof useOverlayState> } | null = null;
    await act(async () => {
      ({ result } = renderHook(() => useOverlayState()));
      await new Promise((r) => setTimeout(r, 0));
    });
    // The most recent value (999) must win since we drop oldest.
    expect(result!.current.stats.wins).toBe(999);
  });
});

describe("currentUtterance reducer (tts.utterance.*) — PR 3 single source of truth", () => {
  function startEnv(over: Partial<{ id: string; text: string; intent: string; mood: string; estimatedDurationMs: number; at: number }> = {}) {
    return env("tts.utterance.start", {
      id: over.id ?? "u-1",
      text: over.text ?? "hello viewers",
      intent: over.intent ?? "round_start",
      mood: over.mood ?? "happy",
      estimatedDurationMs: over.estimatedDurationMs ?? 1800,
      at: over.at ?? 1000,
    });
  }

  it("tts.utterance.start mints currentUtterance with audio* fields null", () => {
    const next = reduceOverlayEvent(INITIAL_STATE, startEnv() as never);
    expect(next.currentUtterance).toMatchObject({
      id: "u-1",
      text: "hello viewers",
      intent: "round_start",
      mood: "happy",
      estimatedDurationMs: 1800,
      startedAt: 1000,
      audioStartedAt: null,
      audioEndedAt: null,
    });
  });

  it("tts.utterance.start with a hostile mood string falls back to DEFAULT_MOOD (allowlist)", () => {
    // Mirrors the stats.update mood-spoofing defence — currentUtterance
    // feeds the same data-mood attribute Avatar reads.
    const next = reduceOverlayEvent(
      INITIAL_STATE,
      env("tts.utterance.start", {
        id: "u-1", text: "hi", intent: "x", mood: "hostile-mood", estimatedDurationMs: 1500, at: 1,
      }) as never,
    );
    expect(next.currentUtterance?.mood).toBe("neutral");
  });

  it("tts.utterance.start ignored when required fields are missing", () => {
    const noText = reduceOverlayEvent(INITIAL_STATE, env("tts.utterance.start", { id: "u-1", intent: "x", estimatedDurationMs: 1500 }) as never);
    expect(noText).toBe(INITIAL_STATE);
    const noId = reduceOverlayEvent(INITIAL_STATE, env("tts.utterance.start", { text: "x", intent: "x", estimatedDurationMs: 1500 }) as never);
    expect(noId).toBe(INITIAL_STATE);
  });

  it("tts.utterance.audio_started populates audioStartedAt for the matching id", () => {
    const started = reduceOverlayEvent(INITIAL_STATE, startEnv() as never);
    const next = reduceOverlayEvent(started, env("tts.utterance.audio_started", { id: "u-1", at: 1100 }) as never);
    expect(next.currentUtterance?.audioStartedAt).toBe(1100);
    expect(next.currentUtterance?.audioEndedAt).toBeNull();
  });

  it("tts.utterance.audio_started for a stale id is ignored (no-op, keeps current id intact)", () => {
    const started = reduceOverlayEvent(INITIAL_STATE, startEnv({ id: "u-1" }) as never);
    const next = reduceOverlayEvent(started, env("tts.utterance.audio_started", { id: "u-OTHER", at: 1100 }) as never);
    expect(next.currentUtterance?.id).toBe("u-1");
    expect(next.currentUtterance?.audioStartedAt).toBeNull();
  });

  it("tts.utterance.audio_started is idempotent — second arrival doesn't shift the timestamp", () => {
    let s = reduceOverlayEvent(INITIAL_STATE, startEnv() as never);
    s = reduceOverlayEvent(s, env("tts.utterance.audio_started", { id: "u-1", at: 1100 }) as never);
    s = reduceOverlayEvent(s, env("tts.utterance.audio_started", { id: "u-1", at: 9999 }) as never);
    expect(s.currentUtterance?.audioStartedAt).toBe(1100);
  });

  it("tts.utterance.audio_ended populates audioEndedAt and synthesizes audioStartedAt when missing", () => {
    // Crashed-Piper case: audio_ended arrives without an audio_started.
    // Selectors expect both to be set for coherent rendering, so the
    // reducer back-fills audioStartedAt with the same timestamp.
    let s = reduceOverlayEvent(INITIAL_STATE, startEnv() as never);
    s = reduceOverlayEvent(s, env("tts.utterance.audio_ended", { id: "u-1", at: 2500 }) as never);
    expect(s.currentUtterance?.audioStartedAt).toBe(2500);
    expect(s.currentUtterance?.audioEndedAt).toBe(2500);
  });

  it("tts.utterance.audio_ended preserves an earlier audioStartedAt", () => {
    let s = reduceOverlayEvent(INITIAL_STATE, startEnv() as never);
    s = reduceOverlayEvent(s, env("tts.utterance.audio_started", { id: "u-1", at: 1100 }) as never);
    s = reduceOverlayEvent(s, env("tts.utterance.audio_ended", { id: "u-1", at: 2500 }) as never);
    expect(s.currentUtterance?.audioStartedAt).toBe(1100);
    expect(s.currentUtterance?.audioEndedAt).toBe(2500);
  });

  it("tts.utterance.cancelled marks the utterance as ended NOW", () => {
    let s = reduceOverlayEvent(INITIAL_STATE, startEnv({ at: 100 }) as never);
    s = reduceOverlayEvent(s, env("tts.utterance.audio_started", { id: "u-1", at: 200 }) as never);
    s = reduceOverlayEvent(s, env("tts.utterance.cancelled", { id: "u-1" }) as never);
    expect(s.currentUtterance?.audioEndedAt).not.toBeNull();
    expect(s.currentUtterance?.audioStartedAt).toBe(200); // preserved
  });

  it("tts.utterance.audio_started arriving with no currentUtterance is a no-op (no crash, returns same state)", () => {
    // Reviewer warning: silent drop of an out-of-order envelope. The
    // reducer logs a console.warn but must not crash or mutate state.
    const next = reduceOverlayEvent(INITIAL_STATE, env("tts.utterance.audio_started", { id: "u-orphan", at: 1100 }) as never);
    expect(next).toBe(INITIAL_STATE);
  });

  it("tts.utterance.audio_ended arriving with no currentUtterance is a no-op", () => {
    const next = reduceOverlayEvent(INITIAL_STATE, env("tts.utterance.audio_ended", { id: "u-orphan", at: 1500 }) as never);
    expect(next).toBe(INITIAL_STATE);
  });

  it("tts.utterance.cancelled arriving with no currentUtterance is a no-op", () => {
    const next = reduceOverlayEvent(INITIAL_STATE, env("tts.utterance.cancelled", { id: "u-orphan" }) as never);
    expect(next).toBe(INITIAL_STATE);
  });

  it("tts.utterance.audio_ended back-fills audioStartedAt AND bumps the synthesizedAudioStartedCount diagnostic", () => {
    // The synthesized counter tells the operator HUD when the
    // back-fill kicked in — distinguishes a Piper crash (Piper exited
    // without producing PCM) from a wire-transport regression
    // (audio_started envelope was dropped).
    if (typeof window !== "undefined") {
      const w = window as unknown as { __pgPcmStats?: { synthesizedAudioStartedCount?: number } };
      if (w.__pgPcmStats) w.__pgPcmStats.synthesizedAudioStartedCount = 0;
    }
    let s = reduceOverlayEvent(INITIAL_STATE, startEnv() as never);
    s = reduceOverlayEvent(s, env("tts.utterance.audio_ended", { id: "u-1", at: 2500 }) as never);
    expect(s.currentUtterance?.audioStartedAt).toBe(2500);
    const stats = (window as unknown as { __pgPcmStats?: { synthesizedAudioStartedCount?: number } }).__pgPcmStats;
    expect(stats?.synthesizedAudioStartedCount).toBeGreaterThanOrEqual(1);
  });

  it("tts.utterance.audio_ended with a real audioStartedAt does NOT bump the synth counter", () => {
    if (typeof window !== "undefined") {
      const w = window as unknown as { __pgPcmStats?: { synthesizedAudioStartedCount?: number } };
      if (w.__pgPcmStats) w.__pgPcmStats.synthesizedAudioStartedCount = 0;
    }
    let s = reduceOverlayEvent(INITIAL_STATE, startEnv() as never);
    s = reduceOverlayEvent(s, env("tts.utterance.audio_started", { id: "u-1", at: 1100 }) as never);
    s = reduceOverlayEvent(s, env("tts.utterance.audio_ended", { id: "u-1", at: 2500 }) as never);
    const stats = (window as unknown as { __pgPcmStats?: { synthesizedAudioStartedCount?: number } }).__pgPcmStats;
    expect(stats?.synthesizedAudioStartedCount ?? 0).toBe(0);
  });

  it("tts.utterance.start drops payloads with oversized text / id / intent (postMessage spoofer cap)", () => {
    // Defence against an in-page postMessage spoofer writing megabyte-
    // length strings into currentUtterance (which would persist to
    // sessionStorage). Caps the legitimate runner never approaches:
    // narrator's longest line ≈ 130 chars, intent strings are
    // compile-time literals, ids are crypto.randomUUID() = 36 chars.
    const oversizeText = reduceOverlayEvent(INITIAL_STATE, env("tts.utterance.start", {
      id: "u-1", text: "A".repeat(2001), intent: "x", mood: "neutral", estimatedDurationMs: 1500, at: 1,
    }) as never);
    expect(oversizeText).toBe(INITIAL_STATE);

    const oversizeId = reduceOverlayEvent(INITIAL_STATE, env("tts.utterance.start", {
      id: "U".repeat(129), text: "x", intent: "x", mood: "neutral", estimatedDurationMs: 1500, at: 1,
    }) as never);
    expect(oversizeId).toBe(INITIAL_STATE);

    const oversizeIntent = reduceOverlayEvent(INITIAL_STATE, env("tts.utterance.start", {
      id: "u-1", text: "x", intent: "I".repeat(65), mood: "neutral", estimatedDurationMs: 1500, at: 1,
    }) as never);
    expect(oversizeIntent).toBe(INITIAL_STATE);
  });

  it("tts.utterance.audio_batch with > PCM_BATCH_MAX_CHUNKS chunks is dropped (postMessage spoofer cap)", async () => {
    // A spoofer posting { chunks: new Array(100_000) } would otherwise
    // run 100k synchronous main-thread iterations. Cap mirrors
    // PCM_REPLAY_MAX = 50 — a single batch can't outpace the queue.
    renderHook(() => useOverlayState());
    const received: PcmChunkDetail[] = [];
    const handler = (ev: Event) => received.push((ev as CustomEvent<PcmChunkDetail>).detail);
    pcmEvents.addEventListener("chunk", handler);
    const i16 = Int16Array.from([0]);
    const u8 = new Uint8Array(i16.buffer);
    let bin = "";
    for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
    const b64 = btoa(bin);
    await act(async () => {
      dispatchOverlayEvent("tts.utterance.audio_batch", {
        id: "u-flood",
        sampleRate: 22050,
        chunks: Array.from({ length: 51 }, (_, i) => ({ samples: b64, ts: i })),
      });
      await new Promise((r) => setTimeout(r, 0));
    });
    // Cap fired — none of the 51 chunks dispatched.
    expect(received.length).toBe(0);
    pcmEvents.removeEventListener("chunk", handler);
  });

  it("a fresh tts.utterance.start replaces the previous slot wholesale (new id, audio* nulls)", () => {
    let s = reduceOverlayEvent(INITIAL_STATE, startEnv({ id: "u-1" }) as never);
    s = reduceOverlayEvent(s, env("tts.utterance.audio_ended", { id: "u-1", at: 1500 }) as never);
    s = reduceOverlayEvent(s, startEnv({ id: "u-2", text: "next line" }) as never);
    expect(s.currentUtterance).toMatchObject({
      id: "u-2",
      text: "next line",
      audioStartedAt: null,
      audioEndedAt: null,
    });
  });
});

describe("subtitleVisible / isSpeaking — selectors that derive from currentUtterance", () => {
  function utt(over: Partial<CurrentUtterance> = {}): CurrentUtterance {
    return {
      id: "u-1",
      text: "x",
      intent: "manual",
      mood: "neutral",
      estimatedDurationMs: 1500,
      startedAt: 1000,
      audioStartedAt: null,
      audioEndedAt: null,
      ...over,
    };
  }

  it("subtitleVisible: false when currentUtterance is null", () => {
    expect(subtitleVisible({ currentUtterance: null }, 5000)).toBe(false);
  });

  it("subtitleVisible: true while audio has not yet ended", () => {
    expect(subtitleVisible({ currentUtterance: utt({ startedAt: 1000 }) }, 1100)).toBe(true);
    expect(subtitleVisible({ currentUtterance: utt({ startedAt: 1000, audioStartedAt: 1100 }) }, 1300)).toBe(true);
  });

  it("subtitleVisible: false once audio ended AND elapsed > MIN_VISIBLE_MS", () => {
    const cu = utt({ startedAt: 1000, audioEndedAt: 1200 });
    // elapsed = SUBTITLE_MIN_VISIBLE_MS + 1 → past the floor → hide.
    expect(subtitleVisible({ currentUtterance: cu }, 1000 + SUBTITLE_MIN_VISIBLE_MS + 1)).toBe(false);
  });

  it("subtitleVisible: true while inside the MIN_VISIBLE_MS floor even after audio ended (short-line readability)", () => {
    // Audio finished after 200ms (e.g. an ack); subtitle stays up
    // until startedAt + MIN_VISIBLE_MS so a viewer can actually read it.
    const cu = utt({ startedAt: 1000, audioStartedAt: 1100, audioEndedAt: 1200 });
    expect(subtitleVisible({ currentUtterance: cu }, 1500)).toBe(true);
  });

  it("isSpeaking: false when currentUtterance is null", () => {
    expect(isSpeaking({ currentUtterance: null })).toBe(false);
  });

  it("isSpeaking: false before audio_started fires", () => {
    expect(isSpeaking({ currentUtterance: utt({ audioStartedAt: null }) })).toBe(false);
  });

  it("isSpeaking: true between audio_started and audio_ended", () => {
    expect(isSpeaking({ currentUtterance: utt({ audioStartedAt: 1100 }) })).toBe(true);
  });

  it("isSpeaking: false once audio_ended is set", () => {
    expect(isSpeaking({ currentUtterance: utt({ audioStartedAt: 1100, audioEndedAt: 1500 }) })).toBe(false);
  });
});

describe("decodePcmEnvelope", () => {
  // Helper: encode an Int16Array to base64 the same way the runner does.
  function encode(samples: number[]): string {
    const i16 = Int16Array.from(samples);
    const u8 = new Uint8Array(i16.buffer);
    let bin = "";
    for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
    return btoa(bin);
  }

  it("round-trips Int16 samples through the base64 envelope", () => {
    const original = [0, 1, -1, 32767, -32768, 1234, -5678];
    const decoded = decodePcmEnvelope({ samples: encode(original) });
    expect(decoded).not.toBeNull();
    expect(Array.from(decoded!)).toEqual(original);
  });

  it("returns null for malformed payloads", () => {
    expect(decodePcmEnvelope(null)).toBeNull();
    expect(decodePcmEnvelope(undefined)).toBeNull();
    expect(decodePcmEnvelope({})).toBeNull();
    expect(decodePcmEnvelope({ samples: 42 })).toBeNull();
    // Non-base64 string still survives atob with bogus output, but if
    // odd byte length we reject (16-bit alignment violated).
    expect(decodePcmEnvelope({ samples: btoa("a") })).toBeNull();
  });

  it("rejects oversized payloads without allocating proportional memory", () => {
    // Build a 1MB base64 string. The cap is 8KB decoded; the function
    // must short-circuit on the string-length check before atob runs.
    const huge = "A".repeat(1024 * 1024);
    expect(decodePcmEnvelope({ samples: huge })).toBeNull();
  });
});

describe("pcmEvents bridge (tts.utterance.audio_batch → EventTarget, never React state)", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  it("dispatches one `chunk` CustomEvent per batch entry on pcmEvents when tts.utterance.audio_batch arrives", async () => {
    // PR 4 cutover: the batched envelope replaces the legacy per-
    // chunk envelope. The bus iterates the array, decodes each chunk,
    // and dispatches one `chunk` event per entry — Avatar's listener
    // sees no behavioural change.
    renderHook(() => useOverlayState());
    const received: PcmChunkDetail[] = [];
    const handler = (ev: Event) => {
      received.push((ev as CustomEvent<PcmChunkDetail>).detail);
    };
    pcmEvents.addEventListener("chunk", handler);

    const samples = [100, 200, 300, 400];
    const i16 = Int16Array.from(samples);
    const u8 = new Uint8Array(i16.buffer);
    let bin = "";
    for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
    const b64 = btoa(bin);

    await act(async () => {
      dispatchOverlayEvent("tts.utterance.audio_batch", {
        id: "u-1",
        sampleRate: 22050,
        chunks: [
          { samples: b64, ts: 1 },
          { samples: b64, ts: 2 },
          { samples: b64, ts: 3 },
        ],
      });
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(received.length).toBe(3);
    expect(Array.from(received[0].samples)).toEqual(samples);
    expect(typeof received[0].ts).toBe("number");
    pcmEvents.removeEventListener("chunk", handler);
  });

  it("does NOT mutate React state when tts.utterance.audio_batch fires (sidechannel only)", async () => {
    const { result } = renderHook(() => useOverlayState());
    const before = result.current;
    const i16 = Int16Array.from([0, 0, 0, 0]);
    const u8 = new Uint8Array(i16.buffer);
    let bin = "";
    for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
    await act(async () => {
      dispatchOverlayEvent("tts.utterance.audio_batch", {
        id: "u-1",
        sampleRate: 22050,
        chunks: [{ samples: btoa(bin), ts: 0 }],
      });
      await new Promise((r) => setTimeout(r, 0));
    });
    // Same reference — React state untouched, no re-render fired.
    expect(result.current).toBe(before);
  });

  it("silently drops malformed tts.utterance.audio_batch envelopes (no listener call)", async () => {
    renderHook(() => useOverlayState());
    const received: PcmChunkDetail[] = [];
    const handler = (ev: Event) => {
      received.push((ev as CustomEvent<PcmChunkDetail>).detail);
    };
    pcmEvents.addEventListener("chunk", handler);
    await act(async () => {
      dispatchOverlayEvent("tts.utterance.audio_batch", { chunks: 42 });
      dispatchOverlayEvent("tts.utterance.audio_batch", null);
      // Within a batch, individual malformed chunks are skipped but
      // the batch envelope itself is still consumed.
      dispatchOverlayEvent("tts.utterance.audio_batch", {
        id: "u-1", sampleRate: 22050, chunks: [{ samples: 42 }, null],
      });
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(received.length).toBe(0);
    pcmEvents.removeEventListener("chunk", handler);
  });
});

describe("singular tts.utterance.audio_chunk back-compat (PR #301-#304-era streamer)", () => {
  // PR #305 replaced the singular per-chunk envelope with the batched
  // `tts.utterance.audio_batch`. Streamer images are built+tagged out
  // of CI, so an operator can run a streamer image cut between PR #301
  // and PR #305 against an app build from main and end up with working
  // subtitles (start envelope unchanged) but silent mouth (singular
  // chunks fall through). The bus retains a singular-shape decoder so
  // that skew can't take lipsync down. Drop these tests once the
  // deployed streamer is known to be at PR #305 or later everywhere.

  beforeEach(() => {
    window.sessionStorage.clear();
    __resetReplayBuffersForTests();
  });

  it("dispatches one chunk on pcmEvents when a singular tts.utterance.audio_chunk arrives", async () => {
    renderHook(() => useOverlayState());
    const received: PcmChunkDetail[] = [];
    const handler = (ev: Event) => {
      received.push((ev as CustomEvent<PcmChunkDetail>).detail);
    };
    pcmEvents.addEventListener("chunk", handler);

    const samples = [100, 200, 300, 400];
    const i16 = Int16Array.from(samples);
    const u8 = new Uint8Array(i16.buffer);
    let bin = "";
    for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
    const b64 = btoa(bin);

    await act(async () => {
      dispatchOverlayEvent("tts.utterance.audio_chunk", {
        id: "u-1", samples: b64, sampleRate: 22050, ts: 1,
      });
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(received.length).toBe(1);
    expect(Array.from(received[0].samples)).toEqual(samples);
    pcmEvents.removeEventListener("chunk", handler);
  });

  it("singular envelopes increment received / decoded / dispatched stats", async () => {
    renderHook(() => useOverlayState());
    const i16 = Int16Array.from([0, 1, 2, 3]);
    const u8 = new Uint8Array(i16.buffer);
    let bin = "";
    for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
    const b64 = btoa(bin);
    await act(async () => {
      dispatchOverlayEvent("tts.utterance.audio_chunk", {
        id: "u-1", samples: b64, sampleRate: 22050, ts: 1,
      });
      dispatchOverlayEvent("tts.utterance.audio_chunk", {
        id: "u-1", samples: b64, sampleRate: 22050, ts: 2,
      });
      await new Promise((r) => setTimeout(r, 0));
    });
    const stats = (window as unknown as { __pgPcmStats?: { received: number; decoded: number; dispatched: number } }).__pgPcmStats;
    expect(stats?.received).toBe(2);
    expect(stats?.decoded).toBe(2);
    expect(stats?.dispatched).toBe(2);
  });

  it("singular envelopes get pushed to the replay queue so a late-mounting Avatar can backfill", async () => {
    // No useOverlayState mount yet — the module-load fallback listener
    // should buffer the envelope, then drain it when useOverlayState
    // mounts, dispatching on pcmEvents AND pushing to the replay queue.
    const i16 = Int16Array.from([5, 6, 7, 8]);
    const u8 = new Uint8Array(i16.buffer);
    let bin = "";
    for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
    const b64 = btoa(bin);

    // Post BEFORE any consumer mounts — captured by the pre-mount
    // pendingEnvelopes buffer.
    window.postMessage({
      source: MESSAGE_SOURCE,
      kind: "tts.utterance.audio_chunk",
      payload: { id: "u-late", samples: b64, sampleRate: 22050, ts: 1 },
    }, "*");
    await new Promise((r) => setTimeout(r, 0));

    // Mount the bus — drains pendingEnvelopes, processes the singular
    // envelope through the same handler the live-listener uses.
    renderHook(() => useOverlayState());
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });

    const replays = drainPcmReplayQueue();
    expect(replays.length).toBe(1);
    expect(Array.from(replays[0].samples)).toEqual([5, 6, 7, 8]);
  });

  it("malformed singular envelopes are silently dropped (no chunk dispatch, no crash)", async () => {
    renderHook(() => useOverlayState());
    const received: PcmChunkDetail[] = [];
    const handler = (ev: Event) => {
      received.push((ev as CustomEvent<PcmChunkDetail>).detail);
    };
    pcmEvents.addEventListener("chunk", handler);
    await act(async () => {
      // No payload at all
      dispatchOverlayEvent("tts.utterance.audio_chunk", null);
      // Payload missing samples
      dispatchOverlayEvent("tts.utterance.audio_chunk", { id: "u-1", sampleRate: 22050 });
      // Samples not a string (number)
      dispatchOverlayEvent("tts.utterance.audio_chunk", { id: "u-1", samples: 42, sampleRate: 22050 });
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(received.length).toBe(0);
    pcmEvents.removeEventListener("chunk", handler);
  });

  it("does NOT mutate React state when a singular envelope fires (sidechannel parity with audio_batch)", async () => {
    const { result } = renderHook(() => useOverlayState());
    const before = result.current;
    const i16 = Int16Array.from([0, 0, 0, 0]);
    const u8 = new Uint8Array(i16.buffer);
    let bin = "";
    for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
    await act(async () => {
      dispatchOverlayEvent("tts.utterance.audio_chunk", {
        id: "u-1", samples: btoa(bin), sampleRate: 22050, ts: 0,
      });
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(result.current).toBe(before);
  });

  it("a flood of singular envelopes drains through the queue without growing the replay buffer past PCM_REPLAY_MAX", async () => {
    // The batched path caps chunks-per-envelope at PCM_BATCH_MAX_CHUNKS;
    // the singular path has no analogous cap because each envelope IS
    // one chunk (per-envelope size is bounded by decodePcmEnvelope's
    // PCM_CHUNK_MAX_BYTES guard). Flooding singular envelopes is shape-
    // equivalent to flooding batched envelopes with chunks=1, and this
    // test pins the only invariant that matters under flood: the replay
    // queue stays bounded by PCM_REPLAY_MAX (50). Without this bound a
    // long backlog of dispatched-but-undrained chunks would grow page
    // memory unbounded between Avatar mounts.
    renderHook(() => useOverlayState());
    const i16 = Int16Array.from([1, 2, 3, 4]);
    const u8 = new Uint8Array(i16.buffer);
    let bin = "";
    for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
    const b64 = btoa(bin);
    // Drain any leftover replays first so we measure the flood's impact only.
    drainPcmReplayQueue();
    await act(async () => {
      for (let i = 0; i < 200; i++) {
        dispatchOverlayEvent("tts.utterance.audio_chunk", {
          id: "u-flood", samples: b64, sampleRate: 22050, ts: i,
        });
      }
      await new Promise((r) => setTimeout(r, 0));
    });
    const replays = drainPcmReplayQueue();
    // PCM_REPLAY_MAX is 50 — the queue drops oldest-first under overflow,
    // so 200 envelopes leave exactly 50 detail entries behind.
    expect(replays.length).toBe(50);
    const stats = (window as unknown as { __pgPcmStats?: { received: number; dispatched: number } }).__pgPcmStats;
    // Every envelope is still received + dispatched on pcmEvents — only
    // the replay-queue side bounds memory, the live listeners see them all.
    expect(stats?.received).toBe(200);
    expect(stats?.dispatched).toBe(200);
  });
});

describe("sessionStorage persistence", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  it("hydrates stats / recentRounds / chat from a seeded sessionStorage entry", () => {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify({
      v: STORAGE_VERSION,
      stats: { wins: 7, losses: 2, streak: 3, mood: "happy" },
      recentRounds: [{ mode: "classic", outcome: "correct", points: 100, at: 12345 }],
      chat: [{ id: "c1", platform: "twitch", user: "alice", text: "hi", at: 12000 }],
    }));
    const { result } = renderHook(() => useOverlayState());
    expect(result.current.stats).toMatchObject({ wins: 7, losses: 2, streak: 3, mood: "happy" });
    expect(result.current.recentRounds).toHaveLength(1);
    expect(result.current.recentRounds[0].mode).toBe("classic");
    expect(result.current.chat).toHaveLength(1);
    expect(result.current.chat[0].text).toBe("hi");
    // Transient slots stay at their initial values.
    expect(result.current.phase).toBe("idle");
    expect(result.current.music).toBeNull();
  });

  it("ignores a stored entry with a stale schema version", () => {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify({
      v: 999,
      stats: { wins: 99, losses: 0, streak: 0 },
    }));
    const { result } = renderHook(() => useOverlayState());
    expect(result.current.stats).toEqual(INITIAL_STATE.stats);
  });

  it("tolerates malformed JSON without throwing", () => {
    window.sessionStorage.setItem(STORAGE_KEY, "not-json");
    const { result } = renderHook(() => useOverlayState());
    expect(result.current.stats).toEqual(INITIAL_STATE.stats);
  });

  it("filters malformed recent-round / chat entries while keeping valid siblings", () => {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify({
      v: STORAGE_VERSION,
      stats: { wins: 1, losses: 0, streak: 1, mood: "neutral" },
      recentRounds: [
        { mode: "classic", outcome: "correct", points: 100, at: 1 },
        { /* missing mode */ outcome: "incorrect", points: 0, at: 2 },
      ],
      chat: [
        { id: "good", platform: "twitch", user: "u", text: "valid", at: 3 },
        { /* missing id */ platform: "twitch", user: "u", text: "no-id", at: 4 },
      ],
    }));
    const { result } = renderHook(() => useOverlayState());
    expect(result.current.recentRounds).toHaveLength(1);
    expect(result.current.chat).toHaveLength(1);
  });

  it("rejects recent-round entries with an outcome outside the enum", () => {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify({
      v: STORAGE_VERSION,
      stats: INITIAL_STATE.stats,
      recentRounds: [
        { mode: "classic", outcome: "correct", points: 1, at: 1 },
        { mode: "classic", outcome: "blorp", points: 0, at: 2 },
        { mode: "higher-lower", outcome: "partial", points: 50, at: 3 },
      ],
      chat: [],
    }));
    const { result } = renderHook(() => useOverlayState());
    expect(result.current.recentRounds.map((r) => r.outcome)).toEqual(["correct", "partial"]);
  });

  it("clamps oversized persisted slices to the in-memory limits", () => {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify({
      v: STORAGE_VERSION,
      stats: INITIAL_STATE.stats,
      // 200 valid rounds — well over RECENT_ROUNDS_LIMIT.
      recentRounds: Array.from({ length: 200 }, (_, i) => ({
        mode: "classic", outcome: "correct" as const, points: i, at: i,
      })),
      // 200 valid chat messages — well over CHAT_HISTORY_LIMIT.
      chat: Array.from({ length: 200 }, (_, i) => ({
        id: `c${i}`, platform: "twitch", user: "u", text: `m${i}`, at: i,
      })),
    }));
    const { result } = renderHook(() => useOverlayState());
    expect(result.current.recentRounds.length).toBeLessThanOrEqual(RECENT_ROUNDS_LIMIT);
    expect(result.current.chat.length).toBeLessThanOrEqual(CHAT_HISTORY_LIMIT);
  });

  it("persists stats / recentRounds / chat on every mutation", async () => {
    const { result } = renderHook(() => useOverlayState());
    await act(async () => {
      dispatchOverlayEvent("stats.update", { wins: 4, losses: 1, streak: 2 });
      await new Promise((r) => setTimeout(r, 0));
    });
    const persisted = JSON.parse(window.sessionStorage.getItem(STORAGE_KEY) ?? "{}");
    expect(persisted.v).toBe(STORAGE_VERSION);
    expect(persisted.stats).toMatchObject({ wins: 4, losses: 1, streak: 2 });
    // Sanity: same hook re-mount picks the persisted stats up.
    const { result: result2 } = renderHook(() => useOverlayState());
    expect(result2.current.stats.wins).toBe(4);
  });

  it("does not persist transient slots like phase or music", async () => {
    const { result: _ } = renderHook(() => useOverlayState());
    await act(async () => {
      dispatchOverlayEvent("lifecycle.phase", { phase: "in_round" });
      dispatchOverlayEvent("music.now", { title: "Carefree", artist: "Kevin MacLeod" });
      await new Promise((r) => setTimeout(r, 0));
    });
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (raw) {
      const persisted = JSON.parse(raw);
      // Persisted shape only contains the three persisted slices.
      expect(Object.keys(persisted).sort()).toEqual(["chat", "recentRounds", "stats", "v"]);
    }
    // Re-mount should NOT inherit the transient state.
    const { result: result2 } = renderHook(() => useOverlayState());
    expect(result2.current.phase).toBe("idle");
    expect(result2.current.music).toBeNull();
  });
});

describe("sanitizeThoughtText", () => {
  it("returns null for non-strings", () => {
    expect(sanitizeThoughtText(undefined)).toBeNull();
    expect(sanitizeThoughtText(null)).toBeNull();
    expect(sanitizeThoughtText(42)).toBeNull();
    expect(sanitizeThoughtText({})).toBeNull();
  });

  it("returns null for empty / whitespace strings", () => {
    expect(sanitizeThoughtText("")).toBeNull();
    expect(sanitizeThoughtText("   ")).toBeNull();
  });

  it("trims surrounding whitespace", () => {
    expect(sanitizeThoughtText("  hello  ")).toBe("hello");
  });

  it("caps over-long strings at THOUGHT_TEXT_MAX", () => {
    const max = __overlayBusInternals.THOUGHT_TEXT_MAX;
    const long = "x".repeat(max + 100);
    const result = sanitizeThoughtText(long);
    expect(result?.length).toBe(max);
  });
});

describe("sanitizeThoughtBubble", () => {
  it("returns null when payload is missing or non-object", () => {
    expect(sanitizeThoughtBubble(undefined, "neutral")).toBeNull();
    expect(sanitizeThoughtBubble("not an object", "neutral")).toBeNull();
  });

  it("returns null when text is missing or empty", () => {
    expect(sanitizeThoughtBubble({ text: "" }, "neutral")).toBeNull();
    expect(sanitizeThoughtBubble({ text: 42 }, "neutral")).toBeNull();
    expect(sanitizeThoughtBubble({}, "neutral")).toBeNull();
  });

  it("populates required fields with defaults when omitted", () => {
    const before = Date.now();
    const entry = sanitizeThoughtBubble({ text: "hi" }, "happy");
    expect(entry).not.toBeNull();
    expect(entry!.text).toBe("hi");
    expect(entry!.intent).toBe("ambient");
    expect(entry!.mood).toBe("happy");
    expect(entry!.at).toBeGreaterThanOrEqual(before);
    expect(entry!.id.startsWith("thought-")).toBe(true);
  });

  it("preserves valid id, intent, mood, at when supplied", () => {
    const entry = sanitizeThoughtBubble(
      { id: "abc", text: "hi", intent: "nn_top_feature", mood: "elated", at: 12345 },
      "neutral",
    );
    expect(entry).toEqual({ id: "abc", text: "hi", intent: "nn_top_feature", mood: "elated", at: 12345 });
  });

  it("falls back to currentMood when supplied mood is invalid", () => {
    const entry = sanitizeThoughtBubble(
      { text: "hi", mood: "nonsense" },
      "tilted",
    );
    expect(entry?.mood).toBe("tilted");
  });

  it("falls back to default intent when supplied intent is empty / non-string", () => {
    expect(sanitizeThoughtBubble({ text: "hi", intent: "" }, "neutral")?.intent).toBe("ambient");
    expect(sanitizeThoughtBubble({ text: "hi", intent: 42 }, "neutral")?.intent).toBe("ambient");
  });
});

describe("thought.bubble reducer", () => {
  it("appends a new thought, newest-first", () => {
    const first = reduceOverlayEvent(
      INITIAL_STATE,
      env("thought.bubble", { id: "a", text: "first", intent: "ambient", mood: "neutral", at: 100 }) as never,
    );
    expect(first.thoughts).toHaveLength(1);
    const second = reduceOverlayEvent(
      first,
      env("thought.bubble", { id: "b", text: "second", intent: "ambient", mood: "neutral", at: 200 }) as never,
    );
    expect(second.thoughts.map((t) => t.id)).toEqual(["b", "a"]);
  });

  it("evicts oldest entries past THOUGHT_FEED_LIMIT", () => {
    const limit = __overlayBusInternals.THOUGHT_FEED_LIMIT;
    let state = INITIAL_STATE;
    for (let i = 0; i < limit + 2; i++) {
      state = reduceOverlayEvent(
        state,
        env("thought.bubble", { id: `t${i}`, text: `t${i}`, mood: "neutral", at: i }) as never,
      );
    }
    expect(state.thoughts).toHaveLength(limit);
    // Most recent should be at the head; the two oldest fell off.
    expect(state.thoughts[0].id).toBe(`t${limit + 1}`);
  });

  it("drops malformed payloads silently (no thoughts mutation)", () => {
    const next = reduceOverlayEvent(
      INITIAL_STATE,
      env("thought.bubble", { text: "" }) as never,
    );
    expect(next.thoughts).toHaveLength(0);
  });
});
