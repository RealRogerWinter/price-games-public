import { useState, type ReactNode } from "react";
import type { GameMode, RoundCountOption, DailyStreak, DailyTodayResponse } from "@price-game/shared";
import { GAME_MODES, getGameModeName, DEFAULT_TOTAL_ROUNDS, MULTIPLAYER_ONLY_MODES } from "@price-game/shared";
import GameOptionsMenu from "../components/GameOptionsMenu";
import HomeTopBar from "../components/HomeTopBar";
import UserDropdown from "../components/auth/UserDropdown";
import DailyHeroCard, { type DailyCardState } from "../components/home/DailyHeroCard";
import PlayWithFriendsCard from "../components/home/PlayWithFriendsCard";
import InviteRewardBadge from "../components/multiplayer/InviteRewardBadge";
import { MODE_ICONS, randomIcon } from "../assets/modeIcons";
import multiplayerIcon from "../assets/modes/multiplayer.webp";
const biddingIcon = MODE_ICONS.bidding;

// Logo is served from apps/web/public/ at a stable unhashed URL so
// index.html can preload it. That lets the browser start the request
// in parallel with the JS bundle instead of waiting for React to mount
// and discover the asset reference.
const LOGO_SRC = "/logo.webp";
const LOGO_W = 512;
const LOGO_H = 158;

interface HomePageProps {
  onSelectMode: (mode: GameMode) => void;
  onShowLeaderboard: () => void;
  onMultiplayer?: () => void;
  /** v2: apply a category selection (home just saves it — no restart needed). */
  onApplyCategories?: (categories: string[]) => void;
  currentCategories?: string[];
  selectedRounds?: RoundCountOption;
  onSelectRounds?: (rounds: RoundCountOption) => void;
  activeGameMode?: GameMode;
  activeGameRound?: number;
  activeGameScore?: number;
  onResumeGame?: () => void;
  disabledModes?: Set<string>;
  onQuickPlayBidding?: () => void;
  dailyToday?: DailyTodayResponse | null;
  dailyStreak?: DailyStreak | null;
  dailyState?: DailyCardState;
  onOpenDaily?: () => void;
  onOpenDailyRecap?: () => void;
  /**
   * Optional render slot for the site-wide promo banner. Rendered between
   * the hero subtitle and the daily-challenge card so the hero stays above
   * the fold on mobile. Pass `null`/`undefined` to hide.
   */
  promoBannerSlot?: ReactNode;
}

export default function HomePage({
  onSelectMode,
  onShowLeaderboard,
  onMultiplayer,
  onApplyCategories,
  currentCategories,
  selectedRounds = DEFAULT_TOTAL_ROUNDS,
  onSelectRounds,
  activeGameMode,
  activeGameRound,
  activeGameScore,
  onResumeGame,
  disabledModes,
  dailyToday,
  dailyStreak,
  dailyState,
  onOpenDaily,
  onOpenDailyRecap,
  onQuickPlayBidding,
  promoBannerSlot,
}: HomePageProps) {
  // Custom display order for mode cards on the home page
  const MODE_DISPLAY_ORDER = [
    "higher-lower", "bidding", "comparison", "riser", "price-match",
    "chain-reaction", "market-basket", "sort-it-out", "budget-builder",
  ];

  // Filter out admin-disabled modes (but allow multiplayer-only "bidding" since it's
  // rendered inline) and sort by the custom display order.
  const enabledModes = GAME_MODES.filter(({ mode }) => {
    if (mode === "bidding") return false; // handled separately inline
    if (MULTIPLAYER_ONLY_MODES.has(mode)) return false;
    if (disabledModes?.has(mode)) return false;
    return true;
  }).sort((a, b) => {
    const ai = MODE_DISPLAY_ORDER.indexOf(a.mode);
    const bi = MODE_DISPLAY_ORDER.indexOf(b.mode);
    return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
  });

  // Confirmation dialog state when clicking a new game mode with an active game
  const [confirmMode, setConfirmMode] = useState<GameMode | null>(null);
  const [confirmDaily, setConfirmDaily] = useState(false);
  const hasActiveGame = !!activeGameMode && !!onResumeGame;

  function handleModeClick(mode: GameMode) {
    if (hasActiveGame) {
      setConfirmMode(mode);
    } else {
      onSelectMode(mode);
    }
  }

  /** Pick a random game mode (including bidding) and start it. */
  function handleRandomClick() {
    // Include bidding in the random pool if quickplay is available
    const pool: GameMode[] = enabledModes.map(({ mode }) => mode);
    if (onQuickPlayBidding) pool.push("bidding");
    if (pool.length === 0) return;
    const pick = pool[Math.floor(Math.random() * pool.length)];
    if (pick === "bidding" && onQuickPlayBidding) {
      onQuickPlayBidding();
    } else {
      handleModeClick(pick);
    }
  }

  function handleDailyClick() {
    if (dailyState === "completed" && onOpenDailyRecap) {
      onOpenDailyRecap();
    } else if (hasActiveGame) {
      setConfirmDaily(true);
    } else if (onOpenDaily) {
      onOpenDaily();
    }
  }

  return (
    <div className="page home-page">
      <HomeTopBar />
      <div className="home-title">
        <img
          className="home-logo-img"
          src={LOGO_SRC}
          width={LOGO_W}
          height={LOGO_H}
          alt="price.games"
          draggable={false}
        />
      </div>
      <h1 className="home-tagline">Play the free price guessing game. Guess real product prices.</h1>

      {promoBannerSlot}

      {activeGameMode && onResumeGame && (
        <button className="btn btn-resume" onClick={onResumeGame}>
          Resume Game — {getGameModeName(activeGameMode)} (Round {activeGameRound})
        </button>
      )}

      {dailyState && dailyState !== "unavailable" && (
        <div className="daily-hero-wrapper">
          <DailyHeroCard
            today={dailyToday ?? null}
            streak={dailyStreak ?? null}
            state={dailyState}
            onClick={handleDailyClick}
          />
        </div>
      )}

<h2 className="sr-only">Game Modes</h2>
      <div className="mode-grid">
        {/* Multiplayer entry tile — first in the grid. Routes to /multiplayer
            so the user picks a mode + creates/joins a room from the hub. Not
            a real GameMode value, so it lives outside the enabledModes loop. */}
        {onMultiplayer && (
          <button
            key="multiplayer-entry"
            className="mode-card mode-multiplayer mode-card-mp-highlight"
            onClick={onMultiplayer}
          >
            <span className="mode-pill mode-pill-vs">VS</span>
            <span className="mode-card-bonus-bubble">up to +25% bonus</span>
            <span className="mode-icon">
              <img
                className="mode-icon-img" width={48} height={48}
                src={multiplayerIcon}
                alt=""
                draggable={false}
              />
            </span>
            <h3 className="mode-name">Multiplayer</h3>
            <p className="mode-description">Create or join a multiplayer lobby for any game mode</p>
          </button>
        )}
        {/* Bidding War — multiplayer-only mode rendered as a regular tile
            because it bot-fills when alone. Sits second after the
            Multiplayer entry. */}
        {onQuickPlayBidding && (
          <button
            key="bidding"
            className="mode-card mode-bidding"
            onClick={onQuickPlayBidding}
          >
            <span className="mode-pill mode-pill-vs">VS</span>
            <span className="mode-icon">
              <img
                className="mode-icon-img" width={48} height={48}
                src={biddingIcon}
                alt=""
                draggable={false}
              />
            </span>
            <h3 className="mode-name">Bidding War</h3>
            <p className="mode-description">Bid in turns — closest without going over wins!</p>
          </button>
        )}
        {enabledModes.map(({ mode, name, description }) => (
          <button
            key={mode}
            className={`mode-card mode-${mode}`}
            onClick={() => handleModeClick(mode)}
          >
            <span className="mode-icon">
              <img
                className="mode-icon-img" width={48} height={48}
                src={MODE_ICONS[mode]}
                alt=""
                draggable={false}
              />
            </span>
            <h3 className="mode-name">{name}</h3>
            <p className="mode-description">{description}</p>
          </button>
        ))}
      </div>

      <div className="random-hero-wrapper">
        <button className="mode-card mode-random random-hero-card" onClick={handleRandomClick}>
          <span className="mode-icon">
            <img
              className="mode-icon-img" width={48} height={48}
              src={randomIcon}
              alt=""
              draggable={false}
            />
          </span>
          <h3 className="mode-name">Random</h3>
          <p className="mode-description">Feeling lucky? Play a random game mode!</p>
        </button>
      </div>

      {/* Play-with-Friends hero — sits below the mode grid, in the slot
          the legacy lone "Multiplayer" button used to occupy. Drives the
          richer share/invite flow that the in-grid Multiplayer tile alone
          can't expose. */}
      {onMultiplayer && <PlayWithFriendsCard onClick={onMultiplayer} />}
      {/* Show the active-bonus chip when the user has an outstanding buff
          from an invite reward. Compact mode hides the full invite prompt
          (which would compete with the PWF hero) — the chip only appears
          when there's something to surface. */}
      {onMultiplayer && (
        <div className="home-buff-strip">
          <InviteRewardBadge compact />
        </div>
      )}

      <button className="btn btn-secondary" onClick={onShowLeaderboard}>
        Leaderboard
      </button>

      <div className="home-toolbar">
        <GameOptionsMenu
          variant="home"
          selectedRounds={selectedRounds}
          onSelectRounds={onSelectRounds ?? (() => {})}
          onApplyCategories={onApplyCategories}
          currentCategories={currentCategories}
        />
        <UserDropdown variant="home" />
      </div>

      {confirmDaily && activeGameMode && onResumeGame && onOpenDaily && (
        <div className="modal-overlay" onClick={() => setConfirmDaily(false)}>
          <div className="modal confirm-modal" onClick={(e) => e.stopPropagation()}>
            <h3 className="confirm-modal-title">Game in Progress</h3>
            <p className="confirm-modal-text">
              You have an active <strong>{getGameModeName(activeGameMode)}</strong> game
              {activeGameRound != null ? ` (Round ${activeGameRound}` : ""}
              {activeGameScore !== undefined ? `, ${activeGameScore.toLocaleString()} pts` : ""}
              {activeGameRound != null ? ")" : ""}.
            </p>
            <p className="confirm-modal-warning">
              Starting the Daily Challenge will lose your current progress.
            </p>
            <div className="confirm-modal-actions">
              <button
                className="confirm-btn-resume"
                onClick={() => { setConfirmDaily(false); onResumeGame(); }}
              >
                Resume Game
              </button>
              <button
                className="confirm-btn-new"
                onClick={() => { setConfirmDaily(false); onOpenDaily(); }}
              >
                Start Daily
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmMode && activeGameMode && onResumeGame && (
        <div className="modal-overlay" onClick={() => setConfirmMode(null)}>
          <div className="modal confirm-modal" onClick={(e) => e.stopPropagation()}>
            <h3 className="confirm-modal-title">Game in Progress</h3>
            <p className="confirm-modal-text">
              You have an active <strong>{getGameModeName(activeGameMode)}</strong> game
              {activeGameRound != null ? ` (Round ${activeGameRound}` : ""}
              {activeGameScore !== undefined ? `, ${activeGameScore.toLocaleString()} pts` : ""}
              {activeGameRound != null ? ")" : ""}.
            </p>
            <p className="confirm-modal-warning">
              Starting a new game will lose your current progress.
            </p>
            <div className="confirm-modal-actions">
              <button
                className="confirm-btn-resume"
                onClick={() => { setConfirmMode(null); onResumeGame(); }}
              >
                Resume Game
              </button>
              <button
                className="confirm-btn-new"
                onClick={() => { setConfirmMode(null); onSelectMode(confirmMode); }}
              >
                Start New Game
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
