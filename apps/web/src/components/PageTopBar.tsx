import { Link } from "react-router-dom";
import { getGameModeName } from "@price-game/shared";
import type { GameMode } from "@price-game/shared";
import logoImg from "../assets/logo.webp";
import UserDropdown from "./auth/UserDropdown";

interface ActiveGame {
  gameMode: GameMode;
  currentRound: number;
}

/**
 * Top navigation bar for route-level pages (Settings, My Scores).
 * Mirrors the in-game TopBar layout but uses React Router Links
 * instead of screen-state callbacks. Shows a "Resume Game" button
 * when an active game session exists in sessionStorage.
 */
export default function PageTopBar() {
  const activeGame = readActiveGame();

  return (
    <>
      <div className="top-bar">
        <div className="top-bar-left">
          <Link to="/" className="top-bar-logo-btn" aria-label="Home">
            <img className="top-bar-logo" src={logoImg} alt="price.games" draggable={false} />
          </Link>
          <Link to="/" className="btn-top">New Game</Link>
        </div>
        <UserDropdown />
      </div>
      {activeGame && (
        <Link to="/" className="btn btn-resume" style={{ textDecoration: "none" }}>
          Resume Game — {getGameModeName(activeGame.gameMode)} (Round {activeGame.currentRound})
        </Link>
      )}
    </>
  );
}

/**
 * Read active game info from sessionStorage. The stored shape is
 * `{ session, roundResults, gameMode, isPlayingDaily }` — written by
 * SinglePlayerApp's persistence effect. We only need gameMode and
 * session.currentRound.
 */
function readActiveGame(): ActiveGame | null {
  try {
    const raw = sessionStorage.getItem("active_game");
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed?.session && !parsed.session.completed && typeof parsed.gameMode === "string") {
      return { gameMode: parsed.gameMode, currentRound: parsed.session.currentRound ?? 1 };
    }
    // Fallback: lightweight format { gameMode, currentRound }
    if (parsed && typeof parsed.gameMode === "string" && typeof parsed.currentRound === "number") {
      return parsed as ActiveGame;
    }
    return null;
  } catch {
    return null;
  }
}
