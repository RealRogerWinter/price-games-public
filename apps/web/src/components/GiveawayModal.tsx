import { useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { useUserAuth } from "../context/UserAuthContext";
import type { PromoBanner } from "@price-game/shared";
import treasureChestImg from "../assets/banner/giveaway-treasure-chest.webp";

interface GiveawayModalProps {
  /**
   * The active promo banner config (drives qualification rule copy).
   * Optional: when omitted (or while the banner fetch is still pending)
   * the modal falls back to the legacy points-only copy.
   */
  banner?: PromoBanner | null;
  onClose: () => void;
  onOpenRegister: () => void;
}

/**
 * Render the qualification rule + fine-print bullet based on banner config.
 * Returned as separate strings so the caller can place them in different
 * slots of the modal (headline rule vs. fine-print list).
 *
 * @param banner - The active promo banner (qualification mode + thresholds).
 * @returns `{ ruleHeading, ruleBody, finePrint }` — human-readable copy.
 */
function describeQualification(banner: PromoBanner | null | undefined): {
  ruleHeading: string;
  ruleBody: string;
  finePrint: string;
} {
  // Defensive defaults: banner could be null (still fetching) or arrive
  // partially-populated during rollout before the new fields ship. Treat
  // missing thresholds as 0 and missing mode as the legacy points-only.
  const minPoints = banner?.giveawayMinPoints ?? 0;
  const points = minPoints.toLocaleString();
  const streak = banner?.giveawayMinStreak ?? 0;
  const streakText = `${streak} day${streak === 1 ? "" : "s"}`;
  const mode = banner?.giveawayQualifyMode ?? "points_only";

  switch (mode) {
    case "streak_only":
      return {
        ruleHeading: "Keep a daily streak",
        ruleBody: `Complete the daily challenge on ${streakText} in a row to qualify for that month's drawing. Miss a day and your streak resets — so play every day.`,
        finePrint: `You must maintain a current daily-challenge streak of at least ${streakText} to qualify.`,
      };
    case "points_and_streak":
      return {
        ruleHeading: "Earn points AND keep a daily streak",
        ruleBody: `Score at least ${points} points in the current calendar month AND maintain a daily-challenge streak of at least ${streakText}.`,
        finePrint: `Both thresholds must be met: ${points}+ monthly points AND a current streak of ${streakText} or longer.`,
      };
    case "points_or_streak":
      return {
        ruleHeading: "Earn points OR keep a daily streak",
        ruleBody: `Either score ${points} points in the current calendar month, OR maintain a daily-challenge streak of at least ${streakText}. Either one gets you entered.`,
        finePrint: `Meeting either criterion qualifies: ${points}+ monthly points, OR a current streak of ${streakText} or longer.`,
      };
    case "points_only":
    default:
      return {
        ruleHeading: "Earn points",
        ruleBody: "Play any game mode and score points. Points earned within the current calendar month count toward that month's drawing.",
        finePrint: "Points must be earned within the current calendar month to count toward that month's drawing.",
      };
  }
}

/**
 * Modal displaying giveaway rules and registration encouragement.
 * Shows different CTAs based on the user's auth/verification state, and
 * adapts the qualification-rule copy to the banner's configured mode
 * (points only, streak only, or a combination).
 *
 * @param banner - Active promo banner config (drives qualification copy).
 * @param onClose - Callback to close the modal.
 * @param onOpenRegister - Callback to open the registration form.
 */
export default function GiveawayModal({ banner, onClose, onOpenRegister }: GiveawayModalProps) {
  const { ruleHeading, ruleBody, finePrint } = describeQualification(banner);
  const { isAuthenticated, user } = useUserAuth();
  const navigate = useNavigate();
  const emailVerified = user?.emailVerified ?? false;

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === "Escape") onClose();
  }, [onClose]);

  useEffect(() => {
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  function handleSignUp() {
    onClose();
    onOpenRegister();
  }

  function handleGoToSettings() {
    onClose();
    navigate("/settings");
  }

  function handleGoToReferrals() {
    // If already on settings, close modal and scroll directly
    if (window.location.pathname === "/settings") {
      onClose();
      const el = document.getElementById("referrals");
      if (el) el.scrollIntoView({ behavior: "smooth" });
    } else {
      // Navigate first, then close — avoids parent unmount swallowing the navigate
      navigate({ pathname: "/settings", hash: "#referrals" });
      onClose();
    }
  }

  return (
    <div className="giveaway-modal-overlay" onClick={onClose} data-testid="giveaway-modal">
      <div className="giveaway-modal-content" onClick={(e) => e.stopPropagation()}>
        <button
          className="giveaway-modal-close"
          onClick={onClose}
          aria-label="Close"
          type="button"
        >
          &times;
        </button>
        <img
          className="giveaway-modal-chest"
          src={treasureChestImg}
          alt=""
          aria-hidden="true"
          draggable={false}
        />

        <h2 className="giveaway-modal-title">Monthly Giveaway</h2>
        <p className="giveaway-modal-subtitle">
          Win prizes just by playing! Here&apos;s how it works:
        </p>

        <div className="giveaway-rules">
          <div className="giveaway-rule">
            <span className="giveaway-rule-number">1</span>
            <div>
              <strong>Create an account</strong>
              <p>Sign up for a free account to start tracking your scores and qualify for rewards.</p>
            </div>
          </div>
          <div className="giveaway-rule">
            <span className="giveaway-rule-number">2</span>
            <div>
              <strong>Verify your email</strong>
              <p>
                Confirm your email address to become eligible. Check your inbox for
                the verification link after signing up.
              </p>
            </div>
          </div>
          <div className="giveaway-rule" data-testid="giveaway-rule-qualify">
            <span className="giveaway-rule-number">3</span>
            <div>
              <strong>{ruleHeading}</strong>
              <p>{ruleBody}</p>
            </div>
          </div>
          <div className="giveaway-rule">
            <span className="giveaway-rule-number">4</span>
            <div>
              <strong>Get entered into the drawing</strong>
              <p>
                Players who earn enough points during the month are automatically
                entered into a random drawing for a chance to win a prize
                (e.g. Amazon Gift Card).
              </p>
            </div>
          </div>
        </div>

        <div className="giveaway-referral-note">
          <strong>Boost your chances!</strong> Refer friends to price.games and earn
          an extra entry in the monthly drawing for each person who signs up and
          verifies their email through your referral link. Check your{" "}
          <button className="giveaway-inline-link" onClick={handleGoToReferrals}>
            settings page
          </button>{" "}
          for your unique referral link.
        </div>

        <div className="giveaway-fine-print">
          <h4>Rules</h4>
          <ul>
            <li>You must be logged in with a <strong>verified email address</strong> to qualify.</li>
            <li data-testid="giveaway-fine-print-qualify">{finePrint}</li>
            <li>Winners are selected via random drawing from all qualifying players once per month.</li>
            <li>One base entry per player per month, plus one bonus entry for each credited referral.</li>
            <li>Winners will be notified by email. Prizes must be claimed within 30 days.</li>
          </ul>
        </div>

        {/* Contextual CTA based on auth state */}
        {!isAuthenticated && (
          <div className="giveaway-cta">
            <p className="giveaway-cta-text">
              Ready to start earning rewards? Create your free account now!
            </p>
            <button
              className="giveaway-cta-btn"
              onClick={handleSignUp}
              data-testid="giveaway-signup-btn"
            >
              Sign Up
            </button>
          </div>
        )}

        {isAuthenticated && !emailVerified && (
          <div className="giveaway-cta giveaway-cta-verify">
            <p className="giveaway-cta-text">
              You&apos;re signed in but your email isn&apos;t verified yet.
              Check your inbox for the verification link to qualify for rewards.
            </p>
            <button
              className="giveaway-cta-btn giveaway-cta-btn-secondary"
              onClick={handleGoToSettings}
              data-testid="giveaway-verify-btn"
            >
              Go to Settings
            </button>
          </div>
        )}

        {isAuthenticated && emailVerified && (
          <div className="giveaway-cta giveaway-cta-eligible">
            <p className="giveaway-cta-text">
              You&apos;re all set! Keep playing to earn points and qualify for this month&apos;s drawing.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
