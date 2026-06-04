/**
 * RecentAccuracy — 10-dot streak indicator showing the bot's recent
 * win/partial/miss buckets, plus a numeric correctness % over the
 * filled portion of the row.
 *
 * Newest result on the right; oldest on the left. A thin connecting
 * line passes between the dots, gradient-coloured between adjacent
 * dots so a "streak" reads as a contiguous color band rather than
 * 10 separate marks.
 */

import type { NnPanelProps } from "./shared/types";
import { bucketColor, PALETTE } from "./shared/palette";

const DOT_DIAMETER = 12;
const DOT_GAP = 16;
const ROW_HEIGHT = DOT_DIAMETER + 12; // padding for the entrance scale animation

/**
 * Compute the correctness percentage over the filled buckets.
 * Each `within10` counts as a full win (100%), `within25` as a half
 * win (50%), and `miss` as zero. The sum is divided by the filled
 * count — empty slots are excluded so the figure tracks "of the
 * rounds we have data for, how many did Pricey land?"
 *
 * Returns null when there are no filled buckets — the panel hides
 * the figure rather than displaying "0% over 0 rounds" placeholder
 * noise on first mount.
 */
export function computeCorrectnessPct(
  buckets: Array<"within10" | "within25" | "miss">,
): number | null {
  if (buckets.length === 0) return null;
  let score = 0;
  for (const b of buckets) {
    if (b === "within10") score += 1;
    else if (b === "within25") score += 0.5;
  }
  return Math.round((score / buckets.length) * 100);
}

export function RecentAccuracy({ tick }: NnPanelProps): React.JSX.Element {
  const buckets = tick?.recentAccuracy ?? [];
  // Always render 10 slots — empty slots use the textSecondary color
  // at 25% alpha so the panel doesn't "bounce" wider as buckets fill.
  const padded: Array<{ kind: "filled"; bucket: "within10" | "within25" | "miss" } | { kind: "empty" }> = [];
  for (let i = 0; i < 10 - buckets.length; i++) padded.push({ kind: "empty" });
  for (const b of buckets) padded.push({ kind: "filled", bucket: b });

  const correctnessPct = computeCorrectnessPct(buckets);

  return (
    <div
      className="nn-panel-recent-accuracy"
      data-testid="nn-panel-recent-accuracy"
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 8,
        height: ROW_HEIGHT,
        padding: "6px 12px",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: DOT_GAP - DOT_DIAMETER,
        }}
      >
        {padded.map((slot, i) => {
          const color = slot.kind === "filled" ? bucketColor(slot.bucket) : PALETTE.textSecondary;
          const opacity = slot.kind === "filled" ? 1 : 0.25;
          // The newest filled slot is always the rightmost (i === 9) and
          // only when there's at least one bucket. The CSS keyframes in
          // broadcast.css attach to `[data-newest="1"]`. We bucket-key
          // ONLY the newest slot — keying older slots by bucket would
          // remount them every round (entries shift left as new buckets
          // arrive) and waste DOM work the animation never uses.
          const isNewest = slot.kind === "filled" && i === 9;
          const key = isNewest ? `newest-${slot.bucket}` : `slot-${i}`;
          return (
            <span
              key={key}
              data-testid={`nn-dot-${i}`}
              data-bucket={slot.kind === "filled" ? slot.bucket : "empty"}
              data-newest={isNewest ? "1" : undefined}
              style={{
                width: DOT_DIAMETER,
                height: DOT_DIAMETER,
                borderRadius: DOT_DIAMETER / 2,
                background: color,
                color, // currentColor used by the dotAmbient keyframes' box-shadow.
                opacity,
                transition: "background 250ms ease",
                boxShadow: slot.kind === "filled" ? `0 0 6px ${color}66` : "none",
              }}
            />
          );
        })}
      </div>
      {correctnessPct !== null && (
        <span
          data-testid="nn-panel-recent-accuracy-pct"
          style={{
            font: "700 13px/1 system-ui, sans-serif",
            color: PALETTE.textPrimary,
            fontVariantNumeric: "tabular-nums",
            letterSpacing: 0.02,
          }}
        >
          {correctnessPct}%
        </span>
      )}
    </div>
  );
}
