import { lazy, Suspense, useEffect, useMemo, type ReactNode } from "react";
import { useBroadcastMode } from "./useBroadcastMode";
import { useOverlayState } from "./state/overlayBus";
import { useStreamerStatsRelay } from "./useStreamerStatsRelay";
import { useStreamerMusicRelay } from "./useStreamerMusicRelay";
import { useStreamerNNRelay } from "./useStreamerNNRelay";
import { useStreamerMoodRelay } from "./useStreamerMoodRelay";
import { useStreamerTtsRelay } from "./useStreamerTtsRelay";
import HeaderBar from "./panels/HeaderBar";
import GiveawayBanner from "./panels/GiveawayBanner";
import ChatOverlay from "./panels/ChatOverlay";
import MusicTicker from "./panels/MusicTicker";
import ThoughtFeed from "./panels/ThoughtFeed";
import AimReticle from "./panels/AimReticle";
import Subtitles from "./panels/Subtitles";
import LobbyRadar from "./panels/LobbyRadar";
import MoodWheel from "./panels/MoodWheel";
import { NeuralNet } from "./panels/NeuralNet";
import { ConfidenceGauge } from "./panels/ConfidenceGauge";
import { RecentAccuracy } from "./panels/RecentAccuracy";
import NeuralDebugHud from "./panels/NeuralDebugHud";
import { parsePanelsQuery, type NnPanelKey } from "./panels/shared/types";
import MoodDebugHud, { useMoodDebugMode } from "./panels/MoodDebugHud";
import LipsyncDebugHud, { useLipsyncDebugMode } from "./panels/LipsyncDebugHud";
import "./styles/broadcast.css";

// Lazy-loaded so the avatar chunk (and, in 1B, the lipsync engine +
// PCM bridge) never ships to non-broadcast viewers. Vite splits the
// dynamic import into its own chunk; the gated mount below ensures
// the chunk is never even fetched outside `?broadcast=1`.
const Avatar = lazy(() => import("./panels/Avatar"));

const BROADCAST_BODY_CLASS = "broadcast";

function pcmButtonStyle(bg: string): React.CSSProperties {
  return {
    padding: "10px 16px",
    background: bg,
    color: "#0b1020",
    border: "none",
    borderRadius: 8,
    font: "600 14px system-ui, sans-serif",
    cursor: "pointer",
    boxShadow: "0 4px 12px rgba(0,0,0,0.4)",
  };
}

interface BroadcastShellProps {
  children: ReactNode;
}

/**
 * Top-level wrapper that opts the app into broadcast-mode rendering when
 * the URL has `?broadcast=1`. In normal mode it returns `children`
 * unchanged so non-broadcast users see no DOM difference.
 *
 * In broadcast mode it overlays a glass-shell on top of a full-bleed
 * 1920×1080 game canvas. The game pixels are NEVER scaled — panels
 * float on alpha glass over the letterbox margins game UI naturally
 * leaves on the sides. Layout:
 *
 *   y=16   ┌─ HeaderBar ─┐                            ┌─Giveaway─┐
 *          │ logo + 24/7 │                            │ chest +  │
 *          │ + price.gms │                            │ $50 CTA  │
 *          │             │       FULL GAME            ├──────────┤
 *   y=200  ├─────────────┤      (no scale, full       │  Chat    │
 *          │ Avatar       │      1920×1080 frame)     │ Overlay  │
 *          │ + MoodIndic. │                           │          │
 *          │ + brain stk  │                           │ (280px)  │
 *          │ (340px)      │                           │          │
 *   y=1036 ├─────────────┴─────────────────────────────┴─────────┤
 *   y=1080 │              MusicTicker strip (44px)               │
 *          └─────────────────────────────────────────────────────┘
 *
 * The full-width header bar from earlier versions has been replaced
 * with a top-left brand block + a top-right giveaway-banner block. A
 * horizontal bar across the screen stole vertical space from the
 * centred game canvas and added no information viewers needed.
 *
 * The shell wrapper has `pointer-events: none` so panels never
 * intercept clicks the game would otherwise receive — Phase B's
 * cursor + reticle work needs unmodified mouse routing into the
 * underlying game UI.
 */
export default function BroadcastShell({
  children,
}: BroadcastShellProps) {
  const broadcast = useBroadcastMode();
  const moodDebug = useMoodDebugMode();
  const lipsyncDebug = useLipsyncDebugMode();
  const overlay = useOverlayState();
  // Subscribe to the server-mediated streamer relays so any
  // `?broadcast=1` viewer (not just the bot's own Chromium) sees
  // wins / losses / streak and the current "now playing" track.
  // Both no-op when broadcast mode is off.
  useStreamerStatsRelay(broadcast);
  useStreamerMusicRelay(broadcast);
  useStreamerNNRelay(broadcast);
  useStreamerMoodRelay(broadcast);
  useStreamerTtsRelay(broadcast);
  // Parse `?panels=` once per mount. Default: all five NN panels on.
  const enabledPanels: Set<NnPanelKey> = useMemo(() => {
    if (typeof window === "undefined") return parsePanelsQuery(null);
    const q = new URLSearchParams(window.location.search).get("panels");
    return parsePanelsQuery(q);
  }, []);

  // Body-class management lives here (the single stage owner) rather than
  // in `useBroadcastMode` so transient consumers like AuthModal can read
  // the flag without their unmount cleanup stripping the class out from
  // under the still-mounted shell.
  useEffect(() => {
    if (!broadcast) return;
    document.body.classList.add(BROADCAST_BODY_CLASS);
    return () => {
      document.body.classList.remove(BROADCAST_BODY_CLASS);
    };
  }, [broadcast]);

  // Lipsync diagnostic — when `?broadcast=1&pcmtest=1` is set, render
  // a "Run lipsync test" button. The synthetic helper is dynamically
  // imported only after the operator clicks it; this also lets the
  // browser's AudioContext resume on the user gesture so the test
  // chunks are audible (autoplay policy blocks an auto-started
  // AudioContext from emitting sound until a user interaction).
  const pcmTestEnabled = broadcast
    && typeof window !== "undefined"
    && new URLSearchParams(window.location.search).has("pcmtest");

  function startPcmTest() {
    void import("./__debug__/pcmTest").then(({ runPcmTest }) => runPcmTest());
  }
  function startSpeechTest() {
    void import("./__debug__/pcmTest").then(({ runSpeechTest }) => runSpeechTest());
  }

  if (!broadcast) {
    return <>{children}</>;
  }

  return (
    <>
      {children}
      <div
        className="broadcast-shell"
        data-testid="broadcast-shell"
        aria-hidden="true"
      >
        <HeaderBar />
        <GiveawayBanner />
        <aside
          className="broadcast-panel broadcast-panel-left"
          data-testid="broadcast-panel-left"
        >
          {/* Avatar (animated lipsync mascot) sits at the top of the
              left rail. The static BotCard "ID card" was unslotted in
              PR #279 (and the file removed in PR #286) so the rail's
              role is to give the NN visualizer ("Pricey's brain")
              and the MoodWheel panel room to breathe. */}
          <Suspense fallback={null}>
            <Avatar currentUtterance={overlay.currentUtterance} mood={overlay.stats.mood} />
          </Suspense>
          {/* Mood wheel — circular indicator with banded mood
              colours, dominant central hub readout, and a glowing
              pointer that smoothly traverses the rim as Pricey's
              mood shifts. Reads `moodSnapshot` (rich axes — vibe,
              morale, streak, mood) for direction-of-travel; falls
              back to `stats.mood` on the legacy stats-only path. */}
          <MoodWheel moodSnapshot={overlay.moodSnapshot} stats={overlay.stats} />
          {/* Pricey's brain — NN visualisation panels gated by
              `?panels=` (default: all five on). Each panel is wrapped
              in a labeled card so viewers can read what each viz is
              showing. The MLP card carries `data-dominant="1"` so the
              CSS can give it `flex: 1 1 auto` and let the others fall
              to their intrinsic content height — produces a focal-
              point layout instead of five equal-height tiles. */}
          <section
            className="broadcast-brain"
            data-testid="broadcast-brain"
            aria-label="Pricey's brain"
          >
            <h2 className="broadcast-brain-title">Pricey's brain</h2>
            <div className="broadcast-nn-stack" data-testid="broadcast-nn-stack">
              {enabledPanels.has("mlp") && (
                <div className="broadcast-nn-card" data-testid="nn-card-mlp" data-dominant="1">
                  <h3 className="broadcast-nn-card-title">Neural Network</h3>
                  <NeuralNet tick={overlay.nnTick} />
                </div>
              )}
              {enabledPanels.has("gauge") && (
                <div className="broadcast-nn-card" data-testid="nn-card-gauge">
                  <h3 className="broadcast-nn-card-title">Price Guess</h3>
                  <ConfidenceGauge tick={overlay.nnTick} />
                </div>
              )}
              {enabledPanels.has("dots") && (
                <div className="broadcast-nn-card" data-testid="nn-card-dots">
                  <h3 className="broadcast-nn-card-title">Last 10 Guesses</h3>
                  <RecentAccuracy tick={overlay.nnTick} />
                </div>
              )}
            </div>
          </section>
        </aside>
        <aside
          className="broadcast-panel broadcast-panel-right"
          data-testid="broadcast-panel-right"
        >
          <ChatOverlay messages={overlay.chat} />
        </aside>
        <footer
          className="broadcast-panel broadcast-panel-bottom"
          data-testid="broadcast-panel-bottom"
        >
          <MusicTicker music={overlay.music} />
        </footer>
        {/* Lobby radar appears during the queuing phase. Hidden
            during in_round so it never occludes active play. */}
        <LobbyRadar countdown={overlay.lobbyCountdown} />
        {/* Floating cues that don't belong inside any panel — they
            anchor to the cursor / target rather than to the layout. */}
        <ThoughtFeed thoughts={overlay.thoughts} />
        <AimReticle aim={overlay.cursorAim} />
      </div>
      {/* Subtitles render OUTSIDE the aria-hidden shell so screen
          readers can announce them via their `role="status" +
          aria-live="polite"` contract. Visually they sit on the
          z-axis above the shell via their own `z-index` rule. */}
      <Subtitles currentUtterance={overlay.currentUtterance} />
      {/* Neural Debug HUD — bottom-right telemetry overlay anchored to
          the viewport (NOT the 1920×1080 stage), so it sits as a
          developer-style HUD over the broadcast. Defaults on; gate
          off via `?panels=` token list omitting `debug`. Mounted outside
          the aria-hidden shell so the fixed positioning resolves
          against the viewport. */}
      {enabledPanels.has("debug") && <NeuralDebugHud tick={overlay.nnTick} />}
      {pcmTestEnabled ? (
        <div
          style={{
            position: "fixed",
            top: 16,
            right: 16,
            zIndex: 9999,
            display: "flex",
            gap: 8,
          }}
        >
          <button
            type="button"
            onClick={startPcmTest}
            style={pcmButtonStyle("#22c55e")}
          >
            Real TTS — cycle moods
          </button>
          <button
            type="button"
            onClick={startSpeechTest}
            style={pcmButtonStyle("#60a5fa")}
          >
            Web Speech TTS
          </button>
        </div>
      ) : null}
      {/* Operator-only mood diagnostic — gated behind `?moodDebug=1`
          so production viewers never see it. Mounted outside the
          aria-hidden shell so the inline-styled HUD anchors to the
          viewport, not the 1920×1080 stage. The HUD positions itself
          at top:80,right:16 so it stacks below the pcmtest buttons
          if both flags are on. Removed once the v2 mood pipeline
          lands. */}
      {moodDebug && <MoodDebugHud stats={overlay.stats} currentUtterance={overlay.currentUtterance} />}
      {/* Operator-only lipsync diagnostic — gated behind
          `?lipsyncDebug=1`. Anchors at bottom:80,right:16 so it stacks
          ABOVE the music ticker but BELOW the giveaway banner; doesn't
          collide with the mood HUD (top:80) or the pcmtest buttons
          (top:16). Mounted outside the aria-hidden shell so the inline-
          styled card anchors to the viewport, not the 1920×1080 stage. */}
      {lipsyncDebug && <LipsyncDebugHud currentUtterance={overlay.currentUtterance} />}
    </>
  );
}
