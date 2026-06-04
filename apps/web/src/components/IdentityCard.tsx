import { useState } from "react";
import { useUserAuth } from "../context/UserAuthContext";
import { getOrCreateGuestIdentity } from "../utils/guestIdentity";
import AvatarIcon from "./multiplayer/AvatarIcon";

interface IdentityCardProps {
  /** Opens the registration modal — invoked when an anonymous user taps the card. */
  onOpenRegister: () => void;
  /**
   * Optional override for the displayed name on the anonymous branch. When
   * provided and non-empty, the card shows this name (usually a player's
   * custom multiplayer display name) instead of the generated guest handle.
   * The avatar and CTA are unchanged — the override only affects the label
   * so single-player surfaces can keep the stable guest handle while MP
   * surfaces reflect the player's explicit choice.
   */
  displayNameOverride?: string | null;
}

/**
 * Identity strip displayed beneath the gameplay top-bar. Shows who the
 * current player is during a round.
 *
 * - **Logged in**: a static, non-interactive nameplate with avatar + username.
 *   Menu actions live in the existing top-bar `UserDropdown` so this card
 *   stays purely about identity, not navigation.
 * - **Anonymous**: a glowing "Playing as guest" card showing a randomly
 *   assigned handle + avatar. Tapping it opens the registration modal so
 *   the player can claim a permanent name and avatar.
 */
export default function IdentityCard({ onOpenRegister, displayNameOverride }: IdentityCardProps) {
  const { user, isAuthenticated } = useUserAuth();
  // Lazy-init via useState so the localStorage read happens once per mount
  // and the same identity is reused across renders.
  const [guest] = useState(getOrCreateGuestIdentity);

  if (!isAuthenticated || !user) {
    const trimmedOverride = displayNameOverride?.trim();
    const nameToShow = trimmedOverride && trimmedOverride.length > 0 ? trimmedOverride : guest.handle;
    return (
      <button
        className="id-card id-card--anon"
        onClick={onOpenRegister}
        aria-label="Sign up to choose your name and avatar"
      >
        <span className="id-card-avatar id-card-avatar--anon">
          <AvatarIcon avatar={guest.avatar} size={64} />
        </span>
        <span className="id-card-body">
          <span className="id-card-supertitle">Playing as guest</span>
          <span className="id-card-name">{nameToShow}</span>
          <span className="id-card-cta">
            Make an account to select your name and avatar.
          </span>
        </span>
        <span className="id-card-action id-card-action--anon">Signup</span>
      </button>
    );
  }

  return (
    <div className="id-card id-card--player" aria-label={`Playing as ${user.username}`}>
      <span className="id-card-avatar">
        <AvatarIcon avatar={user.avatar ?? "silhouette"} size={64} />
      </span>
      <span className="id-card-body">
        <span className="id-card-supertitle">Playing as</span>
        <span className="id-card-name">{user.username}</span>
      </span>
    </div>
  );
}
