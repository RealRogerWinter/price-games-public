import "../../styles/multiplayer.css";

export interface PostMatchInviteCTAProps {
  /** Renders the "earn more" framing when true (player just played a buffed match). */
  hadActiveBuff?: boolean;
  onShare: () => void;
}

/**
 * Inline card appended to the multiplayer results screen. Encourages the
 * player to invite friends to their next room — the post-match moment is
 * the highest-intent point in the loop. Copy switches between "earn"
 * (no current buff) and "extend" (already had a buff) framing.
 */
export default function PostMatchInviteCTA({
  hadActiveBuff = false,
  onShare,
}: PostMatchInviteCTAProps) {
  return (
    <div className="pm-invite-cta" data-testid="post-match-invite-cta">
      <div className="pm-invite-cta-text">
        {hadActiveBuff ? (
          <>
            Bring another friend next match for <strong>+25% more</strong>.
          </>
        ) : (
          <>
            Bring a friend next match for <strong>+25% score</strong>.
          </>
        )}
      </div>
      <button
        type="button"
        className="pm-invite-cta-btn"
        onClick={onShare}
        aria-label="Share an invite link"
      >
        Share invite
      </button>
    </div>
  );
}
