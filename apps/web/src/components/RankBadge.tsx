import lifetime1st from "../assets/ranks/rank-1st.webp";
import lifetime2nd from "../assets/ranks/rank-2nd.webp";
import lifetime3rd from "../assets/ranks/rank-3rd.webp";
import lifetimeTop10 from "../assets/ranks/rank-top10.webp";
import lifetimeStandard from "../assets/ranks/rank-standard.webp";
import streak1st from "../assets/ranks/streak-1st.webp";
import streak2nd from "../assets/ranks/streak-2nd.webp";
import streak3rd from "../assets/ranks/streak-3rd.webp";
import streakTop10 from "../assets/ranks/streak-top10.webp";
import streakStandard from "../assets/ranks/streak-standard.webp";

type RankVariant = "lifetime" | "streak";

interface RankBadgeProps {
  rank: number;
  /**
   * Which icon set to use. "lifetime" renders the price-tag/crown themed
   * icons used on the Lifetime Score tab; "streak" renders the flame
   * themed icons used on the Longest Streak tab so users can tell the
   * two boards apart at a glance.
   */
  variant?: RankVariant;
  size?: number;
}

const LIFETIME_ICONS = {
  first: lifetime1st,
  second: lifetime2nd,
  third: lifetime3rd,
  top10: lifetimeTop10,
  standard: lifetimeStandard,
} as const;

const STREAK_ICONS = {
  first: streak1st,
  second: streak2nd,
  third: streak3rd,
  top10: streakTop10,
  standard: streakStandard,
} as const;

/**
 * Renders a retail/pricing-themed rank badge for a leaderboard row.
 *
 * Ranks 1–3 each get a distinctive gold/silver/bronze icon, ranks 4–10
 * share a "top 10" icon, and all lower ranks fall back to a generic
 * standard icon. The numeric rank is always shown beside the icon so
 * the ordering is unambiguous.
 *
 * @param rank - 1-indexed rank position on the leaderboard.
 * @param variant - Which visual set to render (default "lifetime").
 * @param size - Icon diameter in pixels (default 44).
 */
export default function RankBadge({ rank, variant = "lifetime", size = 44 }: RankBadgeProps) {
  const icons = variant === "streak" ? STREAK_ICONS : LIFETIME_ICONS;

  let src: string;
  let label: string;
  if (rank === 1) {
    src = icons.first;
    label = "1st place";
  } else if (rank === 2) {
    src = icons.second;
    label = "2nd place";
  } else if (rank === 3) {
    src = icons.third;
    label = "3rd place";
  } else if (rank <= 10) {
    src = icons.top10;
    label = `Top 10 (rank ${rank})`;
  } else {
    src = icons.standard;
    label = `Rank ${rank}`;
  }

  return (
    <span className="rank-badge" aria-label={label}>
      <img
        src={src}
        alt=""
        width={size}
        height={size}
        draggable={false}
      />
      <span className="rank-badge-number">{rank}</span>
    </span>
  );
}
