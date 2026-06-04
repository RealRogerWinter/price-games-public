/**
 * MoodDebugHud — operator-only diagnostic overlay gated behind
 * `?moodDebug=1`. Renders a fixed top-right card showing:
 *
 *   - the current mood label (huge, color-coded);
 *   - the sprite id Avatar would currently select from the
 *     (speaking, mouth, mood) matrix — so an operator can see at a
 *     glance whether mood is being clobbered by the speaking branch;
 *   - the speaking flag derived from `currentUtterance` via the
 *     `isSpeaking` selector;
 *   - a small ring buffer of recent mood transitions (label + ts).
 *
 * Mounted by BroadcastShell only when `useMoodDebugMode()` returns
 * true. The HUD itself is purely presentational + a single useEffect
 * that pushes a log entry whenever the `mood` prop changes — no bus
 * subscriptions, no global state, no side effects beyond the local
 * ring buffer. Removing the `?moodDebug=1` flag unmounts it cleanly.
 *
 * Why this exists: the mood pipeline (bot → POST /api/streamer/stats
 * → Socket.IO → overlay reducer → Avatar) crosses three processes
 * and four serialization boundaries. Before refactoring the engine
 * we want a single visual confirmation that values are arriving and
 * that the sprite matrix is selecting what we expect. This HUD is
 * intended to be removed (or at least reworked) once mood v2 ships.
 */

import { useEffect, useRef, useState } from "react";
import { MOOD_REGISTRY, DEFAULT_MOOD, type Mood } from "@price-game/shared";
import { isSpeaking, type BotStats, type CurrentUtterance } from "../state/overlayBus";

const MAX_LOG = 12;

interface MoodLogEntry {
  mood: Mood;
  at: number;
}

interface MoodDebugHudProps {
  /** Latest stats from the overlay bus. The HUD only reads `mood`. */
  stats: BotStats;
  /**
   * Active utterance slot — used solely to derive the
   * "speaking: yes (mouth wins)" indicator via the `isSpeaking`
   * selector. PR 4 swap: replaces the legacy `tts: TtsState` prop now
   * that the legacy state slot is gone.
   */
  currentUtterance: CurrentUtterance | null;
}

/** Shorthand — the HUD only needs the color from each descriptor. */
function moodColor(mood: Mood): string {
  return MOOD_REGISTRY[mood].color;
}

/**
 * Compute the **resting** sprite the avatar would render right now.
 * The HUD has no live PCM signal so it deliberately does NOT try to
 * mirror Avatar's speaking-branch state (the PCM-driven mouth overlay);
 * the separate `speaking` line tells the operator when Avatar is in
 * the mouth-driven branch.
 *
 * Naming follows Avatar's mood-driven sprite convention
 * (`mood-<label>`) — Avatar's `BODY_BY_MOOD` lookup loads
 * `pricey-v2-mood-<descriptor.spriteFallback>.webp`. After PR 5 every
 * mood's spriteFallback is the identity, so the HUD line names the
 * actual asset on disk. The field stays in the descriptor so a future
 * mood added without dedicated artwork can fall back to an anchor
 * without an Avatar code change; the HUD would then correctly report
 * the anchor it falls back to.
 *
 * The default mood reuses the body's painted closed-mouth resting
 * smile (the original `pricey-v2-mouth-closed` body) rather than a
 * `mood-neutral` sprite — `mood-neutral.webp` doesn't exist on disk.
 */
function restingSpriteId(mood: Mood): string {
  if (mood === DEFAULT_MOOD) return "mouth-closed";
  return `mood-${MOOD_REGISTRY[mood].spriteFallback}`;
}

/**
 * Hook that reads `?moodDebug=1` from the current URL. Mirrors the
 * shape of `useBroadcastMode` so the gating pattern is consistent.
 *
 * Read once on first render — operators won't toggle the flag mid-
 * session, and re-reading on every render would invite churn from
 * unrelated `history.replaceState` calls scattered through App.tsx.
 *
 * @returns true when the URL contains `moodDebug=1`.
 */
export function useMoodDebugMode(): boolean {
  const [enabled] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    try {
      return new URLSearchParams(window.location.search).get("moodDebug") === "1";
    } catch {
      return false;
    }
  });
  return enabled;
}

/**
 * Operator-only diagnostic overlay. Render shape is fixed; the HUD
 * is intentionally unstyled beyond a top-right card so it never
 * conflicts with the production overlay layout.
 *
 * @param props.stats Latest bot stats from the overlay bus.
 * @param props.currentUtterance Active utterance lifecycle slot, or null.
 */
export default function MoodDebugHud({ stats, currentUtterance }: MoodDebugHudProps) {
  const mood: Mood = stats.mood ?? DEFAULT_MOOD;
  const speaking = isSpeaking({ currentUtterance });
  const sprite = restingSpriteId(mood);

  const [log, setLog] = useState<MoodLogEntry[]>(() => [{ mood, at: Date.now() }]);
  // Track the last logged mood in a ref so the effect below can
  // compare without re-firing on unrelated re-renders (e.g. wins
  // bumping while mood is unchanged).
  const lastLoggedMood = useRef<Mood>(mood);

  useEffect(() => {
    if (mood === lastLoggedMood.current) return;
    lastLoggedMood.current = mood;
    setLog((prev) => {
      const next = [...prev, { mood, at: Date.now() }];
      // Keep the buffer bounded — older entries fall off the end so a
      // long stream session can't grow the array indefinitely.
      return next.length > MAX_LOG ? next.slice(next.length - MAX_LOG) : next;
    });
  }, [mood]);

  return (
    <div
      className="mood-debug-hud"
      data-testid="mood-debug-hud"
      aria-hidden="true"
      style={{
        // Anchors at top:80 (not 16) so it stacks below the
        // `?pcmtest=1` lipsync-test buttons in BroadcastShell when
        // both operator flags are on at once. With only `?moodDebug=1`
        // the 64px gap is harmless whitespace at the corner.
        position: "fixed",
        top: 80,
        right: 16,
        zIndex: 9999,
        padding: "10px 14px",
        minWidth: 220,
        maxWidth: 280,
        background: "rgba(15, 23, 42, 0.92)",
        color: "#e2e8f0",
        border: `2px solid ${moodColor(mood)}`,
        borderRadius: 8,
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        fontSize: 12,
        lineHeight: 1.35,
        pointerEvents: "none",
      }}
    >
      <div style={{ opacity: 0.6, letterSpacing: 1, fontSize: 10 }}>MOOD DEBUG</div>
      <div
        data-testid="mood-debug-label"
        style={{
          fontSize: 22,
          fontWeight: 700,
          color: moodColor(mood),
          textTransform: "uppercase",
          marginTop: 2,
        }}
      >
        {mood}
      </div>
      <div style={{ marginTop: 6 }}>
        rest sprite: <span data-testid="mood-debug-sprite">{sprite}</span>
      </div>
      <div>
        speaking: <span data-testid="mood-debug-speaking">{speaking ? "yes (mouth wins)" : "no"}</span>
      </div>
      <div style={{ marginTop: 6, opacity: 0.6, fontSize: 10 }}>recent</div>
      <ol
        data-testid="mood-debug-log"
        style={{
          margin: "2px 0 0",
          padding: 0,
          listStyle: "none",
          maxHeight: 160,
          overflow: "hidden",
        }}
      >
        {log.slice().reverse().map((entry) => (
          <li
            key={`${entry.at}-${entry.mood}`}
            style={{ display: "flex", justifyContent: "space-between", gap: 6 }}
          >
            <span style={{ color: moodColor(entry.mood) }}>{entry.mood}</span>
            <span style={{ opacity: 0.5 }}>{new Date(entry.at).toLocaleTimeString()}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

export const __moodDebugInternals = {
  MAX_LOG,
  restingSpriteId,
};
