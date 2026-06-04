import { useState, useEffect, useRef } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { useUserAuth } from "../context/UserAuthContext";
import AuthModal from "../components/auth/AuthModal";
import { userClaimRewardByToken, type ClaimByTokenResponse } from "../api/userClient";

type ViewState =
  | { kind: "loading" }
  | { kind: "needs_login" }
  | { kind: "success"; code: string; amountCents: number; rewardType: string }
  | {
      kind: "error";
      reason: "invalid" | "wrong_user" | "expired" | "voided" | "already_claimed";
    };

function formatPrice(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function rewardLabel(type: string): string {
  return type === "amazon_gift_card" ? "Amazon Gift Card" : "Reward";
}

const ERROR_COPY: Record<
  Extract<ViewState, { kind: "error" }>["reason"],
  { title: string; body: string }
> = {
  invalid: {
    title: "This reward link is invalid",
    body:
      "We couldn't find a reward matching this link. Double-check that you copied the URL from your reward email.",
  },
  wrong_user: {
    title: "This reward isn't for your account",
    body:
      "You're signed in as a different account than the one this reward was awarded to. Sign out and sign in with the account that received the reward email.",
  },
  expired: {
    title: "This reward has expired",
    body:
      "Rewards must be claimed within 30 days of being awarded. This one has been returned to the pool.",
  },
  voided: {
    title: "This reward has been returned to the pool",
    body:
      "It went unclaimed for 30 days and has been removed. Keep playing — you'll have another chance in the next giveaway.",
  },
  already_claimed: {
    title: "This reward has already been claimed",
    body:
      "Looks like this reward was already claimed. Check your reward history under Settings to retrieve the code.",
  },
};

/**
 * Claim landing page reached via the per-award token in the winner email.
 * Handles: not-signed-in (shows login modal, retries on sign-in), success
 * (reveals the gift card code), and the error variants surfaced by the
 * server's claim endpoint.
 */
export default function ClaimRewardPage() {
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const { isAuthenticated, loading: authLoading } = useUserAuth();
  const [view, setView] = useState<ViewState>({ kind: "loading" });
  const [showAuthModal, setShowAuthModal] = useState(false);
  const attemptedRef = useRef(false);

  useEffect(() => {
    if (!token) {
      setView({ kind: "error", reason: "invalid" });
      return;
    }
    if (authLoading) return;
    if (!isAuthenticated) {
      setView({ kind: "needs_login" });
      setShowAuthModal(true);
      return;
    }

    // Guard against React StrictMode double-mount + against re-running
    // after a successful claim re-renders the component.
    if (attemptedRef.current) return;
    attemptedRef.current = true;

    setView({ kind: "loading" });
    userClaimRewardByToken(token)
      .then((result: ClaimByTokenResponse) => {
        if (result.ok) {
          setView({
            kind: "success",
            code: result.code,
            amountCents: result.amountCents,
            rewardType: result.rewardType,
          });
        } else {
          setView({ kind: "error", reason: result.reason });
        }
      })
      .catch(() => {
        setView({ kind: "error", reason: "invalid" });
      });
  }, [token, isAuthenticated, authLoading]);

  function handleAuthModalClose() {
    setShowAuthModal(false);
    // If they closed without logging in, leave the page in needs_login;
    // the effect will re-run on next isAuthenticated change.
    if (!isAuthenticated) {
      setView({ kind: "needs_login" });
    }
  }

  return (
    <div className="app">
      <div className="auth-page">
        <div className="auth-page-card">
          <h1 className="auth-form-title">Claim Your Reward</h1>

          {view.kind === "loading" && (
            <p className="auth-page-text">Checking your reward...</p>
          )}

          {view.kind === "needs_login" && (
            <>
              <p className="auth-page-text">
                Sign in with the account that received the reward email to claim it.
              </p>
              <button
                className="btn btn-primary auth-submit"
                onClick={() => setShowAuthModal(true)}
                data-testid="claim-signin-btn"
              >
                Sign In
              </button>
            </>
          )}

          {view.kind === "success" && (
            <>
              <p className="auth-page-text auth-page-success">
                Congratulations! You've claimed your{" "}
                <strong>
                  {formatPrice(view.amountCents)} {rewardLabel(view.rewardType)}
                </strong>
                .
              </p>
              <p className="auth-page-text">Your gift card code:</p>
              <code className="reward-code-reveal" data-testid="claim-code">
                {view.code}
              </code>
              <p className="auth-page-text auth-page-muted" style={{ marginTop: 16 }}>
                Save this code somewhere safe — you can also find it later under{" "}
                <Link to="/settings">Settings → Rewards</Link>.
              </p>
              <button
                className="btn btn-primary auth-submit"
                onClick={() => navigate("/settings")}
              >
                Go to Settings
              </button>
            </>
          )}

          {view.kind === "error" && (
            <>
              <p className="auth-error" data-testid="claim-error-title">
                {ERROR_COPY[view.reason].title}
              </p>
              <p className="auth-page-text" data-testid="claim-error-body">
                {ERROR_COPY[view.reason].body}
              </p>
              <button
                className="btn btn-primary auth-submit"
                onClick={() => navigate("/")}
              >
                Back to Home
              </button>
            </>
          )}
        </div>
      </div>

      {showAuthModal && <AuthModal onClose={handleAuthModalClose} />}
    </div>
  );
}
