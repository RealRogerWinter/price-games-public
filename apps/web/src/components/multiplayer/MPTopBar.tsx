import { useState } from "react";
import logoImg from "../../assets/logo.webp";
import IdentityCard from "../IdentityCard";

interface MPTopBarProps {
  onLeave: () => void;
  /** When true, skip confirmation dialog and call onLeave directly. */
  skipConfirm?: boolean;
  /**
   * When true, render the shared IdentityCard strip beneath the nav row —
   * mirrors the single-player TopBar so the anonymous "Playing as guest"
   * CTA is visible on every multiplayer screen. Defaults to true.
   */
  showIdentityCard?: boolean;
  /**
   * Handler invoked when an anonymous player taps the IdentityCard's signup
   * CTA. If omitted, the card is still rendered but the CTA is inert —
   * required when used from flows that don't plumb the auth modal.
   */
  onOpenAuth?: () => void;
  /**
   * Optional MP-specific display name (the explicit value an anon player
   * typed into the join screen). When set, the IdentityCard shows this
   * instead of the generated guest handle. Avatar stays the guest avatar.
   */
  displayNameOverride?: string | null;
}

/**
 * Top navigation bar for multiplayer screens, matching the single-player TopBar layout.
 * Row 1: clickable logo (goes home) + "Leave" text button + spacer.
 * Row 2 (optional): the shared IdentityCard strip so the anonymous signup
 * CTA and the current player's identity are visible across all MP screens.
 * Displays a confirmation dialog before leaving unless skipConfirm is set.
 */
export default function MPTopBar({
  onLeave,
  skipConfirm,
  showIdentityCard = true,
  onOpenAuth,
  displayNameOverride,
}: MPTopBarProps) {
  const [showConfirm, setShowConfirm] = useState(false);

  function handleLeaveClick() {
    if (skipConfirm) {
      onLeave();
    } else {
      setShowConfirm(true);
    }
  }

  function handleLogoClick() {
    if (skipConfirm) {
      onLeave();
    } else {
      setShowConfirm(true);
    }
  }

  return (
    <>
      <div className="top-bar-wrap">
        <div className="top-bar">
          <div className="top-bar-left">
            <button className="top-bar-logo-btn" onClick={handleLogoClick} aria-label="Home">
              <img className="top-bar-logo" src={logoImg} alt="price.games" draggable={false} />
            </button>
            <button className="btn-top" onClick={handleLeaveClick}>
              Leave
            </button>
          </div>
          {/* Spacer for layout balance with single-player TopBar */}
          <div />
        </div>
        {showIdentityCard && (
          <IdentityCard
            onOpenRegister={onOpenAuth ?? (() => {})}
            displayNameOverride={displayNameOverride}
          />
        )}
      </div>

      {showConfirm && (
        <div className="modal-overlay" onClick={() => setShowConfirm(false)}>
          <div className="modal confirm-modal" onClick={(e) => e.stopPropagation()}>
            <h3 className="confirm-modal-title">Leave Game?</h3>
            <p className="confirm-modal-text">
              Are you sure? Your game progress will be lost.
            </p>
            <div className="confirm-modal-actions">
              <button
                className="confirm-btn-resume"
                onClick={() => setShowConfirm(false)}
              >
                Stay
              </button>
              <button
                className="confirm-btn-new"
                onClick={() => { setShowConfirm(false); onLeave(); }}
              >
                Leave Game
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
