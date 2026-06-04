import { useLivePlayerCount } from "../../hooks/useLivePlayerCount";
import "../../styles/multiplayer.css";
import friendsHero from "../../assets/multiplayer/friends-hero.webp";

/**
 * Home-page hero replacing the legacy lone "Multiplayer" button. Single,
 * full-width card that drives users to the well-designed /multiplayer hub.
 *
 * Shows live "{N} games active" social proof, a kawaii hero illustration
 * of three friends huddled around a glowing phone, and a call-out for the
 * headline multiplayer modes (Bidding War + invite-friends).
 *
 * @param onClick Triggered when the user wants to enter the multiplayer hub.
 */
export default function PlayWithFriendsCard({ onClick }: { onClick: () => void }) {
  const { count, status } = useLivePlayerCount();

  return (
    <button type="button" className="pwf-card" onClick={onClick} aria-label="Play with Friends — open multiplayer hub">
      <div className="pwf-card-text">
        <h2 className="pwf-card-title">Play with Friends</h2>
        <p className="pwf-card-subtitle" data-testid="pwf-subtitle">
          Share your room link — earn <strong>+25% score</strong> on your next 3 matches when a friend joins.
        </p>
        {status === "live" && (
          <div className="pwf-card-live" data-testid="pwf-live-count">
            <span className="pwf-card-live-dot" aria-hidden="true" />
            <span className="pwf-card-live-text">
              {count} {count === 1 ? "game" : "games"} active
            </span>
          </div>
        )}
      </div>
      {/* Bespoke illustration of three chibi characters around a glowing
          phone — single image instead of an avatar stack so the artwork
          composition isn't broken into pieces. data-testid kept on the
          wrapper for back-compat with the existing test that asserts the
          "stack" element renders. */}
      <div className="pwf-card-stack" data-testid="pwf-avatar-stack" aria-hidden="true">
        <img src={friendsHero} alt="" className="pwf-card-hero-img" draggable={false} />
      </div>
      <span className="pwf-card-chevron" aria-hidden="true">›</span>
    </button>
  );
}
