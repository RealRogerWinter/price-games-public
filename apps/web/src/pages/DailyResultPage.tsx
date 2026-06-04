/**
 * Daily challenge results page.
 *
 * Rendered after the player completes all 5 daily rounds. Distinct from
 * the regular ResultPage because it:
 *   - Shows an animated score count-up (via requestAnimationFrame)
 *   - Hides the leaderboard CTA (daily doesn't feed the global leaderboard)
 *   - Shows streak block (current + best, "+1!" badge, "Streak started!")
 *   - Shows a countdown to the next UTC midnight
 *   - Uses "Try another mode" as the primary CTA instead of "Play Again"
 *   - Softens bad scores ("Streak maintained" instead of punishment language)
 *   - Shows round-by-round item recap with product tooltips
 */

import { useEffect, useRef, useState } from "react";
import type {
  DailyCompletionPayload,
  DailyTodayResponse,
  GameSession,
} from "@price-game/shared";
import { msUntilNextUtcMidnight, getPerRoundMaxScore, DAILY_TOTAL_ROUNDS, scoreToTier, normalizeRoundScores } from "@price-game/shared";
import { useCurrency } from "../context/CurrencyContext";
import { useUserAuth } from "../context/UserAuthContext";
import { useShareData, buildSharedRoundSnapshots } from "../hooks/useShareData";
import { useModalHistory } from "../hooks/useModalHistory";
import SharedRoundCard from "../components/share/SharedRoundCard";
import ShareModal from "../components/share/ShareModal";
import SignupCtaCard from "../components/SignupCtaCard";
import LeaderboardLink from "../components/results/LeaderboardLink";

interface Props {
  session: GameSession;
  roundResults: any[];
  today: DailyTodayResponse;
  dailyPayload: DailyCompletionPayload | null;
  onBackToModes: () => void;
  /** Open the registration modal — passed only for anonymous users. */
  onOpenRegister?: () => void;
}

/**
 * Daily challenge results page.
 *
 * @param session - The completed daily session
 * @param roundResults - Per-round result objects from the game pages
 * @param today - Today's daily metadata
 * @param dailyPayload - Streak payload from the final-round response; null for anonymous
 * @param onBackToModes - Navigate back to the home page
 */
export default function DailyResultPage({
  session,
  roundResults,
  today,
  dailyPayload,
  onBackToModes,
  onOpenRegister,
}: Props) {
  const maxScore = getPerRoundMaxScore(session.gameMode) * DAILY_TOTAL_ROUNDS;
  const perRoundMax = getPerRoundMaxScore(session.gameMode);
  const [displayScore, setDisplayScore] = useState(0);
  const scoreRef = useRef<HTMLSpanElement>(null);
  const { formatPrice } = useCurrency();
  const { user } = useUserAuth();
  const [shareOpen, setShareOpen] = useModalHistory("share-daily");

  const shareInput = useShareData({
    variant: "sp",
    gameMode: session.gameMode,
    roundResults,
    totalScore: session.totalScore,
  });

  const roundSnapshots = buildSharedRoundSnapshots({
    variant: "sp",
    gameMode: session.gameMode,
    roundResults,
    totalScore: session.totalScore,
  });

  const roundTiers = normalizeRoundScores(shareInput.roundScores).map((s) =>
    scoreToTier(s, shareInput.perRoundMax),
  );

  // Animated score count-up (1.5s); respects prefers-reduced-motion.
  useEffect(() => {
    const prefersReduced = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
    if (prefersReduced) {
      setDisplayScore(session.totalScore);
      return;
    }
    const target = session.totalScore;
    const duration = 1500;
    const start = performance.now();
    let raf: number;
    function tick(now: number) {
      const elapsed = now - start;
      const progress = Math.min(elapsed / duration, 1);
      setDisplayScore(Math.round(target * progress));
      if (progress < 1) {
        raf = requestAnimationFrame(tick);
      }
    }
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [session.totalScore]);

  const streak = dailyPayload?.streak;
  const isNewStreak = dailyPayload?.isNewStreak ?? false;
  const isNewBest = dailyPayload?.isNewBest ?? false;
  const isZeroScore = session.totalScore === 0;

  // Headline adapts to score
  let baseHeadline = "Daily complete!";
  if (session.totalScore >= maxScore * 0.9) baseHeadline = "Incredible run!";
  else if (session.totalScore >= maxScore * 0.7) baseHeadline = "Strong round!";
  else if (session.totalScore >= maxScore * 0.4) baseHeadline = "Nice effort!";
  else if (session.totalScore > 0) baseHeadline = "A tough board today.";
  else baseHeadline = "Tough one today.";
  // Personalize for signed-in players so the name lands at the emotional
  // peak. Strip trailing punctuation before appending so the result reads
  // "Incredible run, marcus!" rather than "Incredible run!, marcus!".
  const headline = user
    ? `${baseHeadline.replace(/[!.?]+$/, "")}, ${user.username}!`
    : baseHeadline;

  return (
    <div className="page daily-result-page">
      <p className="daily-result-label">DAILY CHALLENGE</p>
      <h1 className="daily-result-headline">{headline}</h1>

      <div className="daily-result-score">
        <span className="daily-result-score-value" ref={scoreRef}>
          {displayScore.toLocaleString("en-US")}
        </span>
        <span className="daily-result-score-max">
          / {maxScore.toLocaleString("en-US")}
        </span>
      </div>

      {/* Per-round pips */}
      <div className="daily-result-pips">
        {roundResults.map((r: any, i: number) => {
          const score = typeof r.score === "number" ? r.score : 0;
          const ratio = perRoundMax > 0 ? score / perRoundMax : 0;
          const tier =
            ratio >= 0.9 ? "great" : ratio >= 0.5 ? "good" : score > 0 ? "ok" : "miss";
          return (
            <span key={i} className={`daily-pip daily-pip-${tier}`} title={`Round ${i + 1}: ${score}`}>
              {tier === "great" ? "\u{1F7E9}" : tier === "good" ? "\u{1F7E8}" : tier === "ok" ? "\u{1F7E7}" : "\u2B1B"}
            </span>
          );
        })}
      </div>

      {/* Streak block */}
      {streak && (
        <div className="daily-result-streak">
          {isNewStreak && streak.current === 1 && isNewBest && (
            <p className="daily-result-streak-started">Streak started!</p>
          )}
          {isZeroScore && isNewStreak && streak.current > 1 && (
            <p className="daily-result-streak-maintained">Streak maintained</p>
          )}
          <p className="daily-result-streak-current">
            <span className="daily-streak-flame">{"\u{1F525}"}</span> {streak.current} day{streak.current !== 1 ? "s" : ""}
            {isNewStreak && streak.current > 1 && (
              <span className="daily-result-streak-plus"> +1!</span>
            )}
          </p>
          {streak.best > streak.current && (
            <p className="daily-result-streak-best">Best: {streak.best} days</p>
          )}
        </div>
      )}

      {!user && onOpenRegister && (
        <SignupCtaCard variant="streak" onSignup={onOpenRegister} />
      )}

      {/* Countdown to next daily */}
      <DailyCountdown />

      <div className="daily-result-actions">
        <button
          className="btn btn-primary"
          onClick={() => setShareOpen(true)}
          type="button"
        >
          Share Results
        </button>
        <button className="btn btn-secondary" onClick={onBackToModes}>
          Try another mode
        </button>
      </div>

      {/* Round-by-round item recap */}
      {roundSnapshots.length > 0 && (
        <div className="daily-result-recap">
          <h3 className="daily-result-recap-title">Round-by-Round</h3>
          {roundSnapshots.map((snap, i) => (
            <SharedRoundCard
              key={i}
              snap={snap}
              tier={roundTiers[i] ?? "miss"}
              perRoundMax={perRoundMax}
              formatPrice={formatPrice}
            />
          ))}
        </div>
      )}

      <LeaderboardLink />

      {shareOpen && (
        <ShareModal
          shareInput={shareInput}
          roundSnapshots={roundSnapshots}
          playerName={user ? user.username : null}
          onClose={() => setShareOpen(false)}
        />
      )}
    </div>
  );
}

function DailyCountdown() {
  const [ms, setMs] = useState(() => msUntilNextUtcMidnight(new Date()));

  useEffect(() => {
    const id = setInterval(() => setMs(msUntilNextUtcMidnight(new Date())), 1000);
    return () => clearInterval(id);
  }, []);

  const totalSeconds = Math.ceil(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  return (
    <p className="daily-result-countdown">
      Next daily in {hours}h {String(minutes).padStart(2, "0")}m {String(seconds).padStart(2, "0")}s
    </p>
  );
}
