import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useUserAuth } from "../context/UserAuthContext";
import { userGetMonthlyPoints } from "../api/userClient";
import type { PromoBanner } from "@price-game/shared";

interface RewardTrackerProps {
  banner: PromoBanner;
  /** Incremented externally (e.g. after game completion) to trigger a data refresh. */
  refreshKey?: number;
}

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/**
 * Inline progress tracker rendered inside the promo banner.
 *
 * Renders one or two progress indicators depending on the banner's
 * qualification mode: points bar (points_only / AND / OR), streak counter
 * (streak_only / AND / OR), or both. Qualification is evaluated against
 * the mode — AND requires both thresholds, OR requires either.
 *
 * Only renders for authenticated users with verified email.
 *
 * @param banner - The promo banner config (drives mode + thresholds).
 * @param refreshKey - Bumped after game completion to re-fetch data.
 */
export default function RewardTracker({ banner, refreshKey = 0 }: RewardTrackerProps) {
  const { isAuthenticated, user } = useUserAuth();
  const navigate = useNavigate();
  const [points, setPoints] = useState<number | null>(null);
  const [streak, setStreak] = useState<number>(0);
  const [gamesPlayed, setGamesPlayed] = useState(0);
  const [fetchError, setFetchError] = useState(false);

  // Defensive defaults: a banner fetched before the streak fields ship
  // (or a partial fixture in tests) should still render the legacy
  // points-only experience rather than crash on undefined access.
  const pointsGoal = banner.giveawayMinPoints ?? 0;
  const streakGoal = banner.giveawayMinStreak ?? 0;
  const mode = banner.giveawayQualifyMode ?? "points_only";
  const showPoints = mode !== "streak_only";
  const showStreak = mode !== "points_only";
  const emailVerified = user?.emailVerified ?? false;

  useEffect(() => {
    if (!isAuthenticated || !emailVerified) return;
    setFetchError(false);
    userGetMonthlyPoints()
      .then((data) => {
        setPoints(data.points);
        setGamesPlayed(data.gamesPlayed);
        setStreak(data.streak ?? 0);
      })
      .catch(() => setFetchError(true));
  }, [isAuthenticated, emailVerified, refreshKey]);

  const monthName = MONTH_NAMES[new Date().getMonth()];

  if (!isAuthenticated || !emailVerified || fetchError) return null;

  // Loading skeleton
  if (points === null) {
    return (
      <div className="promo-tracker" data-testid="reward-tracker">
        <div className="promo-tracker-bar-bg">
          <div className="promo-tracker-bar-fill" style={{ width: 0 }} />
        </div>
      </div>
    );
  }

  // pointsGoal / streakGoal of 0 means that criterion isn't gating; treat as
  // "met" so a misconfigured banner (e.g. streak_only but pointsGoal=0) still
  // qualifies correctly rather than trapping everyone at 0%.
  const pointsMet = pointsGoal > 0 ? points >= pointsGoal : true;
  const streakMet = streakGoal > 0 ? streak >= streakGoal : true;
  const qualified =
    mode === "points_and_streak" ? (pointsMet && streakMet)
    : mode === "points_or_streak" ? (pointsMet || streakMet)
    : mode === "streak_only" ? streakMet
    : pointsMet;

  if (qualified) {
    const qualifiedMsg = (banner.qualifiedMessage || "You're entered in the {month} drawing! Increase your odds — refer a friend for bonus entries.")
      .replace(/\{month\}/g, monthName);

    return (
      <div className="promo-tracker promo-tracker-qualified" data-testid="reward-tracker">
        <span className="promo-tracker-qualified-check">&#10003;</span>
        <span className="promo-tracker-qualified-text">
          {qualifiedMsg}
          {" "}
          <button
            className="promo-tracker-link"
            onClick={() => navigate("/settings#referrals")}
          >
            Share your link
          </button>
        </span>
      </div>
    );
  }

  const pointsPct = pointsGoal > 0 ? Math.min((points / pointsGoal) * 100, 100) : 0;
  const streakPct = streakGoal > 0 ? Math.min((streak / streakGoal) * 100, 100) : 0;

  return (
    <div className="promo-tracker" data-testid="reward-tracker">
      {showPoints && (
        <div className="promo-tracker-criterion" data-testid="reward-tracker-points">
          <div className="promo-tracker-bar-bg">
            <div className="promo-tracker-bar-fill" style={{ width: `${pointsPct}%` }} />
          </div>
          <div className="promo-tracker-stats">
            <span className="promo-tracker-points">
              {points.toLocaleString()} / {pointsGoal.toLocaleString()} pts
            </span>
            <span className="promo-tracker-meta">
              {gamesPlayed} game{gamesPlayed !== 1 ? "s" : ""} this month
            </span>
          </div>
        </div>
      )}
      {showStreak && streakGoal > 0 && (
        <div className="promo-tracker-criterion" data-testid="reward-tracker-streak">
          <div className="promo-tracker-bar-bg">
            <div className="promo-tracker-bar-fill" style={{ width: `${streakPct}%` }} />
          </div>
          <div className="promo-tracker-stats">
            <span className="promo-tracker-streak">
              🔥 {streak} / {streakGoal} day{streakGoal !== 1 ? "s" : ""}
            </span>
            <span className="promo-tracker-meta">
              {mode === "points_or_streak" ? "daily streak (OR points)" : "daily streak"}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
