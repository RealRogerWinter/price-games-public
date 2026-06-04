/**
 * Tests for the MoodDebugHud — the diagnostic overlay gated behind
 * `?moodDebug=1`. The HUD is purely presentational + a tiny mood-
 * transition log; tests focus on render shape and the transition log
 * behaviour on prop changes.
 */

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import MoodDebugHud, { useMoodDebugMode, __moodDebugInternals } from "./MoodDebugHud";
import type { BotStats, CurrentUtterance } from "../state/overlayBus";

// PR 4 prop swap: MoodDebugHud takes `currentUtterance` instead of
// the now-deleted `tts: TtsState`. `idleTts` = no active utterance;
// `speakingTts` = an utterance whose audio_started has fired and
// audio_ended hasn't, which `isSpeaking` resolves to true.
const idleTts: CurrentUtterance | null = null;
const speakingTts: CurrentUtterance = {
  id: "u-test",
  text: "speaking",
  intent: "manual",
  mood: "neutral",
  estimatedDurationMs: 1500,
  startedAt: 1,
  audioStartedAt: 1,
  audioEndedAt: null,
};

const baseStats = (mood: BotStats["mood"]): BotStats => ({ wins: 0, losses: 0, streak: 0, mood });

describe("MoodDebugHud", () => {
  it("renders the wrapper, mood label, rest-sprite id, and speaking flag", () => {
    render(<MoodDebugHud stats={baseStats("happy")} currentUtterance={idleTts} />);
    const root = screen.getByTestId("mood-debug-hud");
    expect(root).toBeTruthy();
    // Wrapper itself is aria-hidden — operator-only diagnostic, never
    // announced to screen readers.
    expect(root.getAttribute("aria-hidden")).toBe("true");
    expect(screen.getByTestId("mood-debug-label").textContent).toMatch(/happy/i);
    expect(screen.getByTestId("mood-debug-sprite").textContent).toBe("mood-happy");
    expect(screen.getByTestId("mood-debug-speaking").textContent).toMatch(/^no$/i);
  });

  it("falls back to neutral when mood is missing", () => {
    render(<MoodDebugHud stats={{ wins: 0, losses: 0, streak: 0 }} currentUtterance={idleTts} />);
    expect(screen.getByTestId("mood-debug-label").textContent).toMatch(/neutral/i);
    // Neutral + idle → mouth-closed (matches Avatar's resting fallback).
    expect(screen.getByTestId("mood-debug-sprite").textContent).toBe("mouth-closed");
  });

  it("rest-sprite stays on the mood frame while speaking — Avatar's PCM-driven mouth path is opaque to the HUD by design", () => {
    render(<MoodDebugHud stats={baseStats("happy")} currentUtterance={speakingTts} />);
    // The HUD has no PCM signal so it reports the resting frame
    // (mood-happy) regardless of speaking state. The separate
    // `speaking` line surfaces the fact that Avatar's mouth branch
    // is active and that mood is structurally hidden during speech.
    expect(screen.getByTestId("mood-debug-sprite").textContent).toBe("mood-happy");
    expect(screen.getByTestId("mood-debug-speaking").textContent).toMatch(/yes \(mouth wins\)/i);
  });

  it("logs mood transitions in a small ring buffer that grows with prop changes", () => {
    const { rerender } = render(<MoodDebugHud stats={baseStats("neutral")} currentUtterance={idleTts} />);
    rerender(<MoodDebugHud stats={baseStats("happy")} currentUtterance={idleTts} />);
    rerender(<MoodDebugHud stats={baseStats("frustrated")} currentUtterance={idleTts} />);
    const log = screen.getByTestId("mood-debug-log");
    // Initial mood + two transitions → three entries.
    expect(log.querySelectorAll("li").length).toBe(3);
    expect(log.textContent).toMatch(/neutral/);
    expect(log.textContent).toMatch(/happy/);
    expect(log.textContent).toMatch(/frustrated/);
  });

  it("does NOT push a log entry when mood prop is unchanged", () => {
    const { rerender } = render(<MoodDebugHud stats={baseStats("happy")} currentUtterance={idleTts} />);
    rerender(<MoodDebugHud stats={{ ...baseStats("happy"), wins: 5 }} currentUtterance={idleTts} />);
    expect(screen.getByTestId("mood-debug-log").querySelectorAll("li").length).toBe(1);
  });

  it("ring buffer caps at __moodDebugInternals.MAX_LOG entries", () => {
    const { rerender } = render(<MoodDebugHud stats={baseStats("neutral")} currentUtterance={idleTts} />);
    const moods: NonNullable<BotStats["mood"]>[] = ["happy", "frustrated", "focused", "neutral"];
    for (let i = 0; i < __moodDebugInternals.MAX_LOG + 5; i++) {
      rerender(<MoodDebugHud stats={baseStats(moods[i % moods.length])} currentUtterance={idleTts} />);
    }
    const entries = screen.getByTestId("mood-debug-log").querySelectorAll("li");
    expect(entries.length).toBe(__moodDebugInternals.MAX_LOG);
  });

  it("restingSpriteId reports the resolved spriteFallback (now identity for all 8 moods after PR 5)", () => {
    // PR 5 generated dedicated body sprites for the four PR 4 moods;
    // spriteFallback is now the identity for every mood. The HUD's
    // rest-sprite line therefore names the actual asset Avatar
    // would render right now.
    expect(__moodDebugInternals.restingSpriteId("neutral")).toBe("mouth-closed");
    expect(__moodDebugInternals.restingSpriteId("happy")).toBe("mood-happy");
    expect(__moodDebugInternals.restingSpriteId("frustrated")).toBe("mood-frustrated");
    expect(__moodDebugInternals.restingSpriteId("focused")).toBe("mood-focused");
    expect(__moodDebugInternals.restingSpriteId("confident")).toBe("mood-confident");
    expect(__moodDebugInternals.restingSpriteId("elated")).toBe("mood-elated");
    expect(__moodDebugInternals.restingSpriteId("tilted")).toBe("mood-tilted");
    expect(__moodDebugInternals.restingSpriteId("despondent")).toBe("mood-despondent");
  });
});

describe("useMoodDebugMode", () => {
  it("returns true when ?moodDebug=1 is in the URL", () => {
    const original = window.location.search;
    Object.defineProperty(window, "location", {
      writable: true,
      value: { ...window.location, search: "?moodDebug=1" },
    });
    try {
      // Hook executes its read at call time — invoke via a throwaway
      // component to exercise the React contract without building the
      // full BroadcastShell.
      let observed: boolean | null = null;
      function Probe() {
        observed = useMoodDebugMode();
        return null;
      }
      render(<Probe />);
      expect(observed).toBe(true);
    } finally {
      Object.defineProperty(window, "location", {
        writable: true,
        value: { ...window.location, search: original },
      });
    }
  });

  it("returns false when the flag is missing or other", () => {
    Object.defineProperty(window, "location", {
      writable: true,
      value: { ...window.location, search: "?broadcast=1" },
    });
    let observed: boolean | null = null;
    function Probe() {
      observed = useMoodDebugMode();
      return null;
    }
    render(<Probe />);
    expect(observed).toBe(false);
  });
});
