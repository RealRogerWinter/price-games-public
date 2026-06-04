import { useEffect, useState } from "react";
import type { ThoughtEntry } from "../state/overlayBus";

interface ThoughtFeedProps {
  /** Newest-first list of recent thoughts. Empty when bot is silent. */
  thoughts: ThoughtEntry[];
}

/**
 * Time after a thought's `at` timestamp when it dims to alpha 0.55.
 * Keeps the most recent thought legible while the bot acts but lets
 * older entries fade so the eye knows where to look. Matches the
 * legacy ThoughtBubble's dim cadence so the visual rhythm of the
 * panel stays familiar to viewers of the prior layout.
 */
const DIM_AFTER_MS = 3000;
/**
 * Hard auto-hide after this many ms. The bus FIFO already drops
 * old thoughts when the limit is exceeded, but on a long quiet
 * gap (no new thoughts arriving to push older ones off) we still
 * want stale entries to disappear rather than loiter on the
 * 24/7 stream.
 */
const HIDE_AFTER_MS = 30_000;

/**
 * Stacked thought feed — replaces the legacy single-slot
 * ThoughtBubble. Renders the most recent thoughts as a vertical
 * stack with the newest at the top, each fading out independently
 * over its own lifetime.
 *
 * Why a stack vs a single bubble:
 *  - The new Thinker module emits ambient NN-flavored thoughts at
 *    a slower cadence than TTS (~1-2 per round), AND the existing
 *    strategy rationale flows through the same channel as
 *    `intent="strategy_rationale"`. Stacking lets viewers see the
 *    rationale + the most recent ambient thought simultaneously
 *    rather than having one stomp the other.
 *  - The bot's NN data fluctuates per round; thoughts carry it
 *    inline (e.g., "Network says $9.99, σ $2.40"). Showing the
 *    last few in sequence gives viewers a sense of how the model
 *    reads each round.
 *
 * Visual treatment per entry mirrors the legacy ThoughtBubble's
 * glass + teal accents so the panel still reads as "Pricey thinks"
 * without redesign overhead. Each entry has the same enter
 * animation, dim-at-3s, hide-at-30s cadence; the parent just stacks
 * them vertically.
 *
 * Anchor: same fixed viewport position as the legacy bubble (above-
 * right of the streamer-bot avatar in the left rail). The stack
 * grows downward as new entries arrive.
 *
 * @param props.thoughts Newest-first list of thoughts, capped by the
 *                       bus's THOUGHT_FEED_LIMIT.
 */
export default function ThoughtFeed({ thoughts }: ThoughtFeedProps) {
  const [now, setNow] = useState(() => Date.now());

  // Light tick so per-thought dim/exit transitions fire without
  // requiring the bot to send hide events. Stops once every visible
  // thought has crossed its hide threshold so an idle gap doesn't
  // leave a 4Hz interval running forever on a 24/7 stream.
  useEffect(() => {
    if (thoughts.length === 0) return;
    const newestAt = Math.max(...thoughts.map((t) => t.at));
    const stopAt = newestAt + HIDE_AFTER_MS + 100;
    const id = setInterval(() => {
      const t = Date.now();
      setNow(t);
      if (t > stopAt) clearInterval(id);
    }, 250);
    return () => clearInterval(id);
  }, [thoughts]);

  if (thoughts.length === 0) return null;

  // Filter out entries past the hide threshold so a stale stack
  // doesn't loiter on long quiet stretches. Keep the newest few
  // even if they all just hit hide simultaneously — the bus FIFO
  // already capped the count.
  const visible = thoughts.filter((t) => now - t.at <= HIDE_AFTER_MS);
  if (visible.length === 0) return null;

  return (
    <div className="broadcast-thought-feed" data-testid="broadcast-thought-feed">
      {visible.map((entry) => {
        const elapsed = now - entry.at;
        const dimmed = elapsed > DIM_AFTER_MS;
        return (
          <div
            key={entry.id}
            className={`broadcast-thought-bubble ${dimmed ? "dimmed" : ""}`}
            data-testid="broadcast-thought-bubble"
            data-intent={entry.intent}
          >
            <span
              className="broadcast-thought-bubble-trail broadcast-thought-bubble-trail-large"
              aria-hidden="true"
            />
            <span
              className="broadcast-thought-bubble-trail broadcast-thought-bubble-trail-small"
              aria-hidden="true"
            />
            <svg
              className="broadcast-thought-bubble-icon"
              viewBox="0 0 24 24"
              fill="none"
              stroke="#0fbfa4"
              strokeWidth="1.8"
              strokeLinejoin="round"
              strokeLinecap="round"
              aria-hidden="true"
            >
              <path
                d="M12 3a6 6 0 0 0-4 10.5c.7.7 1.2 1.5 1.4 2.5h5.2c.2-1 .7-1.8 1.4-2.5A6 6 0 0 0 12 3z"
                fill="rgba(15, 191, 164, 0.18)"
              />
              <path d="M9 18h6" />
              <path d="M10.5 21h3" />
            </svg>
            <span className="broadcast-thought-bubble-prefix">Pricey thinks</span>
            <span className="broadcast-thought-bubble-text">{entry.text}</span>
          </div>
        );
      })}
    </div>
  );
}
