import { useEffect, useRef } from "react";
import type { GameMode, RejoinErrorCode } from "@price-game/shared";
import { BOT_DIFFICULTIES, type BotDifficulty } from "@price-game/shared";
import { useMultiplayerGame } from "../hooks/useMultiplayerGame";
import { useMultiplayerSocket } from "../hooks/useMultiplayerSocket";
import { useUserAuth } from "../context/UserAuthContext";
import { getEffectiveAnonDisplayName, getMultiplayerDisplayNameOverride } from "../utils/guestIdentity";

/**
 * User-facing copy for each typed rejoin failure reason. Keeps the
 * render-side dumb; server is the single source of truth for the code.
 */
const REJOIN_ERROR_MESSAGES: Record<RejoinErrorCode | "timeout", { title: string; detail: string; canRetry: boolean }> = {
  room_expired: {
    title: "Game ended",
    detail: "This multiplayer room is no longer available.",
    canRetry: false,
  },
  kicked: {
    title: "You were removed",
    detail: "The host removed you from this room.",
    canRetry: false,
  },
  invalid_token: {
    title: "Session expired",
    detail: "Your session is no longer valid. Rejoin with the room code.",
    canRetry: false,
  },
  timeout: {
    title: "Server not responding",
    detail: "Couldn't restore the game. Try again?",
    canRetry: true,
  },
  unknown: {
    title: "Couldn't rejoin",
    detail: "Something went wrong while restoring the game.",
    canRetry: true,
  },
};
import JoinScreen from "../components/multiplayer/JoinScreen";
import LobbyScreen from "../components/multiplayer/LobbyScreen";
import MPGameScreen from "../components/multiplayer/MPGameScreen";
import MPRoundResultOverlay from "../components/multiplayer/MPRoundResultOverlay";
import MPResultsScreen from "../components/multiplayer/MPResultsScreen";

interface MultiplayerPageProps {
  roomCode?: string;
  quickplayMode?: GameMode;
  /**
   * When set, enrolls this quickplay attempt in the daily-challenge flow:
   * `/api/mp/quickplay` is called with `isDailyGame: true` + `dailyDate` so
   * matchmaking is scoped to same-date daily rooms, and the resulting
   * `createRoom` carries `dailyDate` so the server pulls the daily puzzle's
   * preset products.
   */
  dailyDate?: string;
  onLeave: () => void;
  /** Opens the register/auth modal. Forwarded to MPResultsScreen for the logged-out CTA. */
  onOpenAuth?: () => void;
}

/**
 * Thin orchestrator component for multiplayer games.
 * All game state lives in useMultiplayerGame; all socket I/O lives in useMultiplayerSocket.
 * This component is responsible only for rendering the correct screen.
 */
export default function MultiplayerPage({ roomCode: urlRoomCode, quickplayMode, dailyDate, onLeave, onOpenAuth }: MultiplayerPageProps) {
  const { state, handlers } = useMultiplayerGame();
  // Active-round screens are the only ones that need the proactive
  // visibility-hidden disconnect (see `useConnectionLifecycle`). Lobby /
  // results / join all stay connected across long backgrounds so the
  // user can glance at another app without triggering a "Reconnecting…"
  // flash on return.
  const isInActiveRound = state.screen === "playing" || state.screen === "round_result";
  const { connectionStatus, reconnectAttempt, rejoinErrorCode, actions } = useMultiplayerSocket(
    handlers,
    onLeave,
    urlRoomCode,
    isInActiveRound
  );
  const { user } = useUserAuth();
  // For anon players, the IdentityCard in MPTopBar / JoinScreen shows their
  // custom MP display name if they set one, otherwise falls back to the
  // guest handle. Logged-in users pass `null` so the card renders
  // `user.username` via its own branch.
  const displayNameOverride = user ? null : getMultiplayerDisplayNameOverride();

  // Auto-trigger quick play when quickplayMode is set (e.g., from home page Bidding War card)
  const quickplayTriggered = useRef(false);
  useEffect(() => {
    if (!quickplayMode || quickplayTriggered.current) return;
    quickplayTriggered.current = true;

    // Unified identity: logged-in users send their username; anon users send
    // their MP display-name override if they set one, otherwise the stable
    // guest handle. Avoids a third "Player####" random name that drifts from
    // the guest identity shown in the IdentityCard.
    const name = user?.username ?? getEffectiveAnonDisplayName();
    const botCount = 2 + Math.floor(Math.random() * 3); // 2-4 bots
    const diff = BOT_DIFFICULTIES[Math.floor(Math.random() * BOT_DIFFICULTIES.length)];

    // Record quick play origin so a later Play Again tap knows to
    // instant-requeue instead of resetting the same room. This covers
    // both the join-existing-lobby and create-new branches below
    // (createRoom's autoStart branch also sets this, but joinRoom
    // doesn't — so we set it pre-emptively here).
    handlers.setQuickPlayContext({
      gameMode: quickplayMode,
      botCount,
      botDifficulty: diff,
      displayName: name,
      ...(dailyDate ? { dailyDate } : {}),
    });

    // Try to find a public room first, otherwise create one. Daily requests
    // carry `isDailyGame` + `dailyDate` so the server filters matchmaking to
    // same-date daily rooms and, on create, the new room uses the daily
    // puzzle's preset products.
    const quickplayBody = dailyDate
      ? { gameMode: quickplayMode, isDailyGame: true, dailyDate }
      : { gameMode: quickplayMode };
    fetch("/api/mp/quickplay", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(quickplayBody),
    })
      .then(async (res) => {
        if (res.status === 409) {
          // Already played today's daily — bounce back home. The daily card
          // will re-read state on mount via useDaily and show the completed
          // tile.
          onLeave();
          return null;
        }
        return res.json();
      })
      .then((data) => {
        if (!data) return;
        if (data.action === "join" && data.roomCode) {
          actions.joinRoom(data.roomCode, name, undefined, "quickplay");
        } else {
          actions.createRoom(name, quickplayMode, {
            isPublic: true,
            autoStart: { botCount, botDifficulty: diff },
            ...(dailyDate ? { dailyDate } : {}),
          });
        }
      })
      .catch(() => {
        // Fallback: just create a room
        actions.createRoom(name, quickplayMode, {
          isPublic: true,
          autoStart: { botCount, botDifficulty: diff },
          ...(dailyDate ? { dailyDate } : {}),
        });
      });
  }, [quickplayMode, dailyDate, actions, handlers, user]);

  // Phase 3d.2: window-scoped hook for the 24/7 streamer-bot. The bot
  // explicitly asked to NEVER play in real multiplayer, so it can't go
  // through the standard `?quickplay=bidding` matchmaking flow (that
  // can return `action: "join"` for an existing public lobby populated
  // by humans). Instead it calls this hook directly which always takes
  // the create-with-autoStart branch — the room is brand new with 3
  // NPC bots and zero humans. Bypasses /api/mp/quickplay entirely.
  // Mounted only when ?broadcast=1 so the production game is unaffected.
  const isBroadcast = typeof window !== "undefined"
    && new URLSearchParams(window.location.search).get("broadcast") === "1";
  useEffect(() => {
    if (!isBroadcast) return;
    type CreateOpts = { displayName: string; botCount?: number; botDifficulty?: BotDifficulty };
    const fn = (opts: CreateOpts) => {
      const { displayName, botCount = 3, botDifficulty = "medium" } = opts;
      handlers.setQuickPlayContext({
        gameMode: "bidding",
        botCount,
        botDifficulty,
        displayName,
      });
      actions.createRoom(displayName, "bidding", {
        isPublic: true,
        autoStart: { botCount, botDifficulty },
      });
    };
    (window as unknown as Record<string, unknown>).__pgBotCreateBiddingRoom = fn;
    return () => {
      delete (window as unknown as Record<string, unknown>).__pgBotCreateBiddingRoom;
    };
  }, [isBroadcast, actions, handlers]);

  // Stable reference to onLeave for the popstate handler
  const onLeaveRef = useRef(onLeave);
  onLeaveRef.current = onLeave;

  // Intercept browser back button: confirm before leaving multiplayer
  useEffect(() => {
    // Push a dummy state so back button triggers popstate instead of navigating away
    window.history.pushState({ mp: true }, "");

    function handlePopState(event: PopStateEvent) {
      if (state.screen === "join") {
        // On join screen, just leave without confirmation
        onLeaveRef.current();
        return;
      }
      // If the pop lands us back on our own dummy mp entry, the user is
      // just closing a child overlay (e.g. ShareModal via useModalHistory,
      // which calls history.back()). They're still on multiplayer —
      // don't prompt about leaving.
      if (event.state && (event.state as { mp?: boolean }).mp === true) {
        return;
      }
      const leave = window.confirm("Leave multiplayer? Your game progress will be lost.");
      if (leave) {
        onLeaveRef.current();
      } else {
        // Re-push the dummy state to stay on the page
        window.history.pushState({ mp: true }, "");
      }
    }

    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [state.screen]);

  // Guard: prevent double-submission of guesses
  function handleSubmitGuess(guessData: any) {
    if (state.hasGuessed) return;
    actions.submitGuess(guessData);
  }

  // --- Reconnection Overlay ---
  function renderConnectionOverlay() {
    if (connectionStatus === "connected") return null;

    if (connectionStatus === "reconnecting") {
      return (
        <div className="reconnect-overlay">
          <div className="reconnect-content">
            <div className="reconnect-spinner" />
            <p className="reconnect-title">Reconnecting...</p>
            <p className="reconnect-detail">Attempt {reconnectAttempt} of 15</p>
          </div>
        </div>
      );
    }

    if (connectionStatus === "resyncing") {
      return (
        <div className="reconnect-overlay">
          <div className="reconnect-content">
            <div className="reconnect-spinner" />
            <p className="reconnect-title">Restoring your game...</p>
            <p className="reconnect-detail">Just a moment.</p>
          </div>
        </div>
      );
    }

    if (connectionStatus === "rejoin_failed") {
      const msg = REJOIN_ERROR_MESSAGES[rejoinErrorCode ?? "unknown"] ?? REJOIN_ERROR_MESSAGES.unknown;
      return (
        <div className="reconnect-overlay">
          <div className="reconnect-content">
            <p className="reconnect-title">{msg.title}</p>
            <p className="reconnect-detail">{msg.detail}</p>
            {msg.canRetry && (
              <button className="btn btn-primary reconnect-retry-btn" onClick={actions.manualReconnect}>
                Try Again
              </button>
            )}
            <button className="btn btn-secondary reconnect-leave-btn" onClick={actions.leave}>
              Back to Home
            </button>
          </div>
        </div>
      );
    }

    // disconnected — socket-level reconnect exhausted
    return (
      <div className="reconnect-overlay">
        <div className="reconnect-content">
          <p className="reconnect-title">Connection Lost</p>
          <p className="reconnect-detail">Unable to reach the server.</p>
          <button className="btn btn-primary reconnect-retry-btn" onClick={actions.manualReconnect}>
            Try Again
          </button>
          <button className="btn btn-secondary reconnect-leave-btn" onClick={actions.leave}>
            Leave Game
          </button>
        </div>
      </div>
    );
  }

  // --- Render ---

  if (state.screen === "join") {
    return (
      <JoinScreen
        roomCode={urlRoomCode}
        existingRoom={state.room}
        onCreateRoom={actions.createRoom}
        onJoinRoom={actions.joinRoom}
        error={state.error}
        loading={state.loading}
        onLeave={onLeave}
        onOpenAuth={onOpenAuth}
      />
    );
  }

  if (state.screen === "lobby" && state.room && state.playerId) {
    return (
      <>
        <LobbyScreen
          room={state.room}
          playerId={state.playerId}
          onStartRound={actions.startRound}
          onKickPlayer={actions.kickPlayer}
          onChangeSettings={actions.changeSettings}
          onConfigureBots={actions.configureBots}
          onLeave={actions.leave}
          loading={state.loading}
          onOpenAuth={onOpenAuth}
          displayNameOverride={displayNameOverride}
        />
        {renderConnectionOverlay()}
      </>
    );
  }

  if (state.screen === "playing" && state.room && state.playerId) {
    // If we don't have round data yet (rejoined mid-round without data), show waiting
    if (!state.roundData) {
      return (
        <>
          <div className="app">
            <div className="loading-screen">
              <h1 className="loading-title">price.games</h1>
              <p className="loading-text">Waiting for round to finish...</p>
            </div>
          </div>
          {renderConnectionOverlay()}
        </>
      );
    }

    const myPlayer = state.room.players.find((p) => p.id === state.playerId);
    return (
      <>
        <MPGameScreen
          roundData={state.roundData}
          players={state.room.players}
          currentPlayerId={state.playerId}
          lockedPlayerIds={state.lockedPlayerIds}
          currentRound={state.room.currentRound}
          totalRounds={state.room.totalRounds}
          totalScore={myPlayer?.totalScore || 0}
          hasGuessed={state.hasGuessed}
          onSubmitGuess={handleSubmitGuess}
          biddingTurn={state.biddingTurn}
          placedBids={state.placedBids}
          onSubmitBid={actions.submitBid}
          onLeave={actions.leave}
          onOpenAuth={onOpenAuth}
          displayNameOverride={displayNameOverride}
        />
        {renderConnectionOverlay()}
      </>
    );
  }

  if (state.screen === "round_result" && state.roundResults && state.playerId) {
    return (
      <>
        <MPRoundResultOverlay
          results={state.roundResults}
          currentPlayerId={state.playerId}
          onContinue={actions.continueFromResults}
          isGameOver={state.isGameOver}
          hasContinued={state.hasContinued}
          continuedPlayerIds={state.continuedPlayerIds}
          players={state.room?.players}
        />
        {renderConnectionOverlay()}
      </>
    );
  }

  if (state.screen === "game_over" && state.playerId && state.allRoundResults.length > 0) {
    const finalResults = state.allRoundResults[state.allRoundResults.length - 1];
    // If the current game was spun up via Quick Play (autoStart + bots),
    // the Play Again button should instantly re-queue the player into a
    // new match — match-make with real humans if possible, otherwise
    // drop them straight into a fresh bot-filled room. Non-quick-play
    // games fall back to the legacy behaviour of resetting the same
    // room to lobby status.
    const isQuickPlay = state.quickPlayContext !== null;
    return (
      <>
        <MPResultsScreen
          finalResults={finalResults}
          allRoundResults={state.allRoundResults}
          currentPlayerId={state.playerId}
          players={state.room?.players}
          roomCode={state.room?.code}
          onPlayAgain={isQuickPlay ? actions.playQuickPlayAgain : actions.playAgain}
          onLeave={actions.leave}
          onOpenAuth={onOpenAuth}
          displayNameOverride={displayNameOverride}
        />
        {renderConnectionOverlay()}
      </>
    );
  }

  return (
    <div className="app">
      <div className="loading-screen">
        <h1 className="loading-title">price.games</h1>
        <p className="loading-text">{state.loading ? "Connecting..." : state.error || "Loading..."}</p>
        {state.error && (
          <button className="btn btn-secondary" onClick={actions.leave}>
            Back to Home
          </button>
        )}
      </div>
    </div>
  );
}
