import type { RecentRound } from "../state/overlayBus";

interface RecentRoundsProps {
  rounds: RecentRound[];
}

const OUTCOME_GLYPH: Record<RecentRound["outcome"], string> = {
  correct: "✓",
  incorrect: "✗",
  partial: "·",
};

function formatMode(mode: string): string {
  return mode
    .split("-")
    .map((part) => (part.length === 0 ? part : part[0].toUpperCase() + part.slice(1)))
    .join(" ");
}

/**
 * List of recent round outcomes, newest first. Empty placeholder until
 * the bot has played its first round.
 */
export default function RecentRounds({ rounds }: RecentRoundsProps) {
  return (
    <section
      className="broadcast-recent-rounds"
      data-testid="broadcast-recent-rounds"
      aria-label="Recent rounds"
    >
      <h3 className="broadcast-recent-rounds-title">Recent rounds</h3>
      {rounds.length === 0 ? (
        <p className="broadcast-recent-rounds-empty">No rounds played yet.</p>
      ) : (
        <ol className="broadcast-recent-rounds-list">
          {rounds.map((r) => (
            <li
              key={`${r.at}-${r.mode}`}
              className={`broadcast-recent-round outcome-${r.outcome}`}
              data-testid="recent-round-item"
              data-outcome={r.outcome}
            >
              <span className="broadcast-recent-round-glyph" aria-hidden="true">
                {OUTCOME_GLYPH[r.outcome]}
              </span>
              <span className="broadcast-recent-round-mode">{formatMode(r.mode)}</span>
              <span className="broadcast-recent-round-points">{r.points > 0 ? `+${r.points}` : r.points}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
