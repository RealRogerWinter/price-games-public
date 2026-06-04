/**
 * LipsyncDebugHud — operator-only diagnostic overlay gated behind
 * `?lipsyncDebug=1`. Renders a fixed bottom-right card showing the live
 * state of the TTS / lipsync / subtitle pipeline so an operator can
 * confirm at a glance whether each stage of the chain is alive without
 * SSHing into the streamer container and curl-ing /diag/page.
 *
 * What the HUD reports (polled every 250ms — slow enough to be cheap,
 * fast enough that staleness is below human perception):
 *
 *   Subtitle   text + how long it has been visible
 *   TTS        speaking flag from the React state
 *   PCM        received / decoded / dispatched counters from the bus
 *              + lastDecodeError tag if the decoder rejected anything
 *   Viseme     processed / lastRms / lastAperture from Avatar's
 *              window-global counters — proves the chunk listener is
 *              consuming chunks and the envelope is moving
 *   Ready      window.__pgBroadcastReady — confirms Avatar has mounted
 *              and the runner-side waitForFunction can succeed
 *
 * Mounted by BroadcastShell only when `useLipsyncDebugMode()` returns
 * true. Outside the flag the HUD is never imported (its source bytes
 * never ship to public viewers). Gated by the broadcast-access
 * middleware on public hostnames as belt-and-braces.
 *
 * Why this exists: the TTS pipeline crosses three processes and four
 * serialization boundaries. When something breaks (mouth doesn't move,
 * subtitle drifts from audio, speaking flag stuck), the operator
 * shouldn't have to read source code to find the failure point — the
 * HUD names the stage that has stopped incrementing.
 */

import { useEffect, useState } from "react";
import { isSpeaking, type CurrentUtterance } from "../state/overlayBus";

const POLL_INTERVAL_MS = 250;

interface PcmStatsSnapshot {
  received: number;
  decoded: number;
  dispatched: number;
  lastDecodeError: string | null;
  firstReceivedAt: number | null;
  lastReceivedAt: number | null;
  synthesizedAudioStartedCount: number;
}

interface VisemeStatsSnapshot {
  processed: number;
  lastRms: number | null;
  lastAperture: number | null;
  apertureEvents: number;
  lastSampleCount: number | null;
}

interface LipsyncDebugHudProps {
  /**
   * Active utterance from the bus's `currentUtterance` slot. PR 3
   * swap: replaces the legacy `subtitle` + `tts` props with the
   * single source of truth. The HUD now reports per-utterance
   * lifecycle progress (start → audio_started → audio_ended) instead
   * of two independent stale slots.
   */
  currentUtterance: CurrentUtterance | null;
}

interface DiagSnapshot {
  pcm: PcmStatsSnapshot | null;
  viseme: VisemeStatsSnapshot | null;
  ready: boolean;
}

function readDiagSnapshot(): DiagSnapshot {
  if (typeof window === "undefined") {
    return { pcm: null, viseme: null, ready: false };
  }
  const w = window as unknown as {
    __pgPcmStats?: PcmStatsSnapshot;
    __pgVisemeStats?: VisemeStatsSnapshot;
    __pgBroadcastReady?: boolean;
  };
  return {
    pcm: w.__pgPcmStats ?? null,
    viseme: w.__pgVisemeStats ?? null,
    ready: w.__pgBroadcastReady === true,
  };
}

/**
 * Hook that reads `?lipsyncDebug=1` from the current URL. Mirrors the
 * shape of `useMoodDebugMode` so the gating pattern is consistent
 * across operator-only HUDs.
 *
 * Read once on first render — operators don't toggle the flag mid-
 * session, and re-reading on every render would invite churn from
 * unrelated `history.replaceState` calls scattered through App.tsx.
 *
 * @returns true when the URL contains `lipsyncDebug=1`.
 */
export function useLipsyncDebugMode(): boolean {
  const [enabled] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    try {
      return new URLSearchParams(window.location.search).get("lipsyncDebug") === "1";
    } catch {
      return false;
    }
  });
  return enabled;
}

/**
 * Render label for the HUD's "audio" row — collapses the four
 * lifecycle states (no utterance / pending audio / playing / ended)
 * into a single readable string. Extracted from the HUD's render so
 * the conditional logic can be unit-tested in isolation.
 */
export function audioRowValue(cu: CurrentUtterance | null, audioAge: number | null): string {
  if (cu == null) return "—";
  if (cu.audioEndedAt != null) {
    const startedAt = cu.audioStartedAt ?? cu.audioEndedAt;
    return `ended (${cu.audioEndedAt - startedAt}ms)`;
  }
  if (cu.audioStartedAt != null) return `playing (${audioAge ?? 0}ms)`;
  return "pending";
}

/** One key/value row in the HUD; keeps the shape compact. */
function Row({ label, value, tone }: { label: string; value: string; tone?: "ok" | "warn" | "err" }) {
  const colour = tone === "err" ? "#f87171" : tone === "warn" ? "#facc15" : tone === "ok" ? "#86efac" : "#e2e8f0";
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
      <span style={{ opacity: 0.6 }}>{label}</span>
      <span style={{ color: colour, fontVariantNumeric: "tabular-nums" }}>{value}</span>
    </div>
  );
}

/**
 * Operator-only diagnostic overlay. Render shape is fixed; the HUD is
 * intentionally unstyled beyond a bottom-right card so it never
 * conflicts with the production overlay layout. Uses tabular-nums so
 * counters don't jiggle as digits change.
 *
 * @param props.currentUtterance Active utterance lifecycle slot, or null.
 */
export default function LipsyncDebugHud({ currentUtterance }: LipsyncDebugHudProps) {
  const [snap, setSnap] = useState<DiagSnapshot>(() => readDiagSnapshot());

  useEffect(() => {
    const id = setInterval(() => setSnap(readDiagSnapshot()), POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, []);

  const cu = currentUtterance;
  const utteranceAge = cu ? Math.max(0, Date.now() - cu.startedAt) : null;
  const audioAge = cu?.audioStartedAt ? Math.max(0, Date.now() - cu.audioStartedAt) : null;
  const isSpeakingNow = isSpeaking({ currentUtterance: cu });
  const pcm = snap.pcm;
  const viseme = snap.viseme;
  const decodeFailing = pcm?.lastDecodeError !== null && pcm?.lastDecodeError !== undefined;
  const dispatchAlive = pcm ? pcm.dispatched > 0 : false;
  const visemeAlive = viseme ? viseme.processed > 0 : false;

  return (
    <div
      className="lipsync-debug-hud"
      data-testid="lipsync-debug-hud"
      aria-hidden="true"
      style={{
        position: "fixed",
        bottom: 80,
        right: 16,
        zIndex: 9999,
        padding: "10px 14px",
        minWidth: 240,
        maxWidth: 320,
        background: "rgba(15, 23, 42, 0.92)",
        color: "#e2e8f0",
        border: `2px solid ${snap.ready ? "#34d399" : "#f87171"}`,
        borderRadius: 8,
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        fontSize: 11,
        lineHeight: 1.4,
        pointerEvents: "none",
      }}
    >
      <div style={{ opacity: 0.6, letterSpacing: 1, fontSize: 10 }}>LIPSYNC DEBUG</div>
      <Row
        label="ready"
        value={snap.ready ? "yes" : "no"}
        tone={snap.ready ? "ok" : "err"}
      />
      <div style={{ marginTop: 8, opacity: 0.6, fontSize: 10 }}>UTTERANCE</div>
      <Row
        label="text"
        value={cu ? `"${cu.text.slice(0, 26)}${cu.text.length > 26 ? "…" : ""}"` : "(none)"}
      />
      <Row
        label="age"
        value={utteranceAge === null ? "—" : `${utteranceAge}ms / ${cu?.estimatedDurationMs ?? 0}ms`}
      />
      <Row
        label="audio"
        value={audioRowValue(cu, audioAge)}
        tone={isSpeakingNow ? "ok" : cu?.audioEndedAt != null ? "warn" : undefined}
      />
      <Row
        label="intent"
        value={cu?.intent ?? "—"}
      />
      <div style={{ marginTop: 8, opacity: 0.6, fontSize: 10 }}>PCM (bus)</div>
      <Row
        label="received"
        value={pcm ? String(pcm.received) : "—"}
      />
      <Row
        label="decoded"
        value={pcm ? String(pcm.decoded) : "—"}
        tone={decodeFailing ? "err" : undefined}
      />
      <Row
        label="dispatched"
        value={pcm ? String(pcm.dispatched) : "—"}
        tone={dispatchAlive ? "ok" : "warn"}
      />
      {decodeFailing && pcm?.lastDecodeError ? (
        <Row label="decode err" value={pcm.lastDecodeError} tone="err" />
      ) : null}
      {pcm && pcm.synthesizedAudioStartedCount > 0 ? (
        <Row
          label="synth audio_start"
          value={String(pcm.synthesizedAudioStartedCount)}
          tone="warn"
        />
      ) : null}
      <div style={{ marginTop: 8, opacity: 0.6, fontSize: 10 }}>VISEME (avatar)</div>
      <Row
        label="processed"
        value={viseme ? String(viseme.processed) : "—"}
        tone={visemeAlive ? "ok" : "warn"}
      />
      <Row
        label="lastRms"
        value={viseme?.lastRms !== null && viseme?.lastRms !== undefined ? viseme.lastRms.toFixed(3) : "—"}
      />
      <Row
        label="lastAperture"
        value={viseme?.lastAperture !== null && viseme?.lastAperture !== undefined ? viseme.lastAperture.toFixed(3) : "—"}
      />
      <Row
        label="apertureEvents"
        value={viseme ? String(viseme.apertureEvents) : "—"}
      />
    </div>
  );
}

export const __lipsyncDebugInternals = {
  readDiagSnapshot,
  POLL_INTERVAL_MS,
};
