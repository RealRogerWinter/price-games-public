interface LeaderboardLinkProps {
  /** When provided, called instead of letting the browser follow the
   *  default `/leaderboard` href. Lets pages that drive navigation
   *  through their parent (e.g. ResultPage / MPResultsScreen) keep
   *  their existing flow without forcing a router context. */
  onShowLeaderboard?: () => void;
}

/**
 * Footer link rendered at the bottom of every results page so any
 * player — anon or signed-in — can jump straight to the leaderboard
 * after seeing their score.
 *
 * Renders as a plain `<a href="/leaderboard">` so it works in any
 * render tree, including tests that don't wrap the component in a
 * router. When the parent passes `onShowLeaderboard`, the click is
 * intercepted and the parent's handler runs instead — typically to
 * keep an SPA route transition rather than a full document load.
 */
export default function LeaderboardLink({ onShowLeaderboard }: LeaderboardLinkProps) {
  function handleClick(e: React.MouseEvent<HTMLAnchorElement>) {
    if (!onShowLeaderboard) return; // let the browser follow the href
    // Honour modifier-clicks the way the browser would on a real <a>:
    // cmd/ctrl-click → new tab, shift-click → new window, middle-click
    // (button 1) → background tab. The SPA route transition only kicks
    // in for plain left-clicks.
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    onShowLeaderboard();
  }
  return (
    <div className="results-leaderboard-footer">
      <a
        href="/leaderboard"
        className="btn btn-link results-leaderboard-link"
        onClick={handleClick}
      >
        View Leaderboard →
      </a>
    </div>
  );
}
