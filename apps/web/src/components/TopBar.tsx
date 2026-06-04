import type { RoundCountOption } from "@price-game/shared";
import logoImg from "../assets/logo.webp";
import GameOptionsMenu from "./GameOptionsMenu";
import UserDropdown from "./auth/UserDropdown";
import IdentityCard from "./IdentityCard";

interface TopBarProps {
  onGoHome: () => void;
  /** v2: apply a category selection. Mid-game the panel shows its own restart confirm. */
  onApplyCategories: (categories: string[]) => void;
  currentCategories?: string[];
  /** When true, Apply inside the inline panel routes through a restart confirmation. */
  requireRestartConfirm?: boolean;
  selectedRounds: RoundCountOption;
  onSelectRounds: (rounds: RoundCountOption) => void;
  /**
   * When true, render the compact IdentityCard strip beneath the navigation
   * row. Reserved for the active gameplay screen — results/leaderboard hide
   * it so the existing UserDropdown is the only identity surface there.
   */
  showIdentityCard?: boolean;
  /** Handler invoked when an anonymous player taps the IdentityCard's signup CTA. */
  onOpenRegister?: () => void;
}

/**
 * Top navigation bar displayed during gameplay, leaderboard, and results.
 * Row 1: logo + New Game + Options dropdown + UserDropdown (always present).
 * Row 2 (active gameplay only): the compact IdentityCard identity strip.
 */
export default function TopBar({
  onGoHome,
  onApplyCategories,
  currentCategories,
  requireRestartConfirm,
  selectedRounds,
  onSelectRounds,
  showIdentityCard = false,
  onOpenRegister,
}: TopBarProps) {
  return (
    <div className="top-bar-wrap">
      <div className="top-bar">
        <div className="top-bar-left">
          <button className="top-bar-logo-btn" onClick={onGoHome} aria-label="Home">
            <img className="top-bar-logo" src={logoImg} alt="price.games" draggable={false} />
          </button>
          <button className="btn-top" onClick={onGoHome}>
            New Game
          </button>
          <GameOptionsMenu
            variant="topbar"
            selectedRounds={selectedRounds}
            onSelectRounds={onSelectRounds}
            onApplyCategories={onApplyCategories}
            currentCategories={currentCategories}
            requireRestartConfirm={requireRestartConfirm}
          />
        </div>
        <UserDropdown />
      </div>
      {showIdentityCard && (
        <IdentityCard onOpenRegister={onOpenRegister ?? (() => {})} />
      )}
    </div>
  );
}
