import { useState, useEffect, useCallback } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { useUserAuth } from "../context/UserAuthContext";
import { userResendVerification, userGetRewards, userUpdateAvatar, getEnabledAvatars } from "../api/userClient";
import type { Avatar } from "@price-game/shared";
import AvatarPicker from "../components/AvatarPicker";
import AvatarIcon from "../components/multiplayer/AvatarIcon";
import ChangeEmailForm from "../components/auth/ChangeEmailForm";
import ChangePasswordForm from "../components/auth/ChangePasswordForm";
import ReferralDashboard from "../components/ReferralDashboard";
import { openCookieSettings } from "../components/CookieConsent";
import NotificationSettings from "../components/NotificationSettings";
import EmailSettings from "../components/EmailSettings";
import PageTopBar from "../components/PageTopBar";
import type { UserReward } from "@price-game/shared";

/**
 * Settings page displaying user info, rewards, referrals, notifications,
 * and account settings. Redirects to home if the user is not authenticated.
 */
export default function SettingsPage() {
  const { user, isAuthenticated, loading: authLoading, refreshUser, updateUser } = useUserAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const [rewards, setRewards] = useState<UserReward[]>([]);
  const [rewardsLoading, setRewardsLoading] = useState(false);

  const [showEmailForm, setShowEmailForm] = useState(false);
  const [showPasswordForm, setShowPasswordForm] = useState(false);
  const [avatarLoading, setAvatarLoading] = useState(false);
  const [avatarError, setAvatarError] = useState<string | null>(null);
  const [enabledAvatars, setEnabledAvatars] = useState<string[] | undefined>(undefined);

  const [verificationSent, setVerificationSent] = useState(false);
  const [verificationError, setVerificationError] = useState<string | null>(null);

  useEffect(() => {
    if (!authLoading && !isAuthenticated) {
      navigate("/");
    }
  }, [authLoading, isAuthenticated, navigate]);

  // Refresh user data on mount to get up-to-date verification status
  useEffect(() => {
    if (isAuthenticated) {
      refreshUser();
    }
  }, [isAuthenticated, refreshUser]);

  const fetchRewards = useCallback(async () => {
    setRewardsLoading(true);
    try {
      const res = await userGetRewards();
      setRewards(res.rewards);
    } catch {
      // Silently fail
    } finally {
      setRewardsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isAuthenticated) {
      fetchRewards();
    }
  }, [isAuthenticated, fetchRewards]);

  // Fetch which avatars are enabled so the picker only shows available options
  useEffect(() => {
    getEnabledAvatars()
      .then((res) => setEnabledAvatars(res.enabledAvatars))
      .catch(() => { /* Fall back to showing all avatars */ });
  }, []);

  // Scroll the page to the top whenever the settings page is opened without
  // a hash anchor. Without this, the window keeps whatever scroll offset the
  // previous page (home, multiplayer lobby, etc.) had, so users land
  // mid-page on settings — confusing since they clicked a navigation link
  // and expect to see the header first.
  useEffect(() => {
    if (location.hash) return;
    window.scrollTo(0, 0);
  }, [location.pathname, location.hash]);

  // Scroll to hash target (e.g. #referrals) after page content has rendered.
  // Uses polling to handle lazy-loaded page + async auth state.
  useEffect(() => {
    if (!location.hash || authLoading || !user) return;
    let cancelled = false;
    let attempts = 0;
    const maxAttempts = 10;
    const tryScroll = () => {
      if (cancelled) return;
      const el = document.getElementById(location.hash.slice(1));
      if (el) {
        el.scrollIntoView({ behavior: "smooth" });
      } else if (attempts < maxAttempts) {
        attempts++;
        timer = setTimeout(tryScroll, 100);
      }
    };
    let timer = setTimeout(tryScroll, 50);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [location.hash, authLoading, user]);

  async function handleResendVerification() {
    try {
      setVerificationError(null);
      await userResendVerification();
      setVerificationSent(true);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to resend verification";
      setVerificationError(message);
    }
  }

  // Codes that were revealed mid-session (e.g. just-claimed rewards on a
  // tab the user keeps open). Persisted client-side for the lifetime of
  // the SPA mount; the canonical reveal happens on /claim/:token.
  const [revealedCodes] = useState<Record<string, string>>({});

  async function handleAvatarSelect(avatar: Avatar) {
    try {
      setAvatarLoading(true);
      setAvatarError(null);
      const res = await userUpdateAvatar(avatar);
      updateUser(res.user);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to update avatar";
      setAvatarError(message);
    } finally {
      setAvatarLoading(false);
    }
  }

  if (authLoading) {
    return (
      <div className="profile-page">
        <p className="loading-text">Loading...</p>
      </div>
    );
  }

  if (!user) {
    return null;
  }

  return (
    <div className="profile-page">
      <PageTopBar />

      <div className="profile-header">
        <h1 className="profile-title">Settings</h1>
      </div>

      <div className="profile-info profile-info-with-avatar">
        <div className="profile-info-avatar">
          <AvatarIcon avatar={user.avatar ?? "silhouette"} size={88} />
        </div>
        <div className="profile-info-text">
          <h2 className="profile-username">{user.username}</h2>
          <p className="profile-email">
            {user.email}{" "}
            {user.emailVerified ? (
              <span className="email-badge email-badge-verified">Verified</span>
            ) : (
              <span className="email-badge email-badge-unverified">Unverified</span>
            )}
          </p>
          {!user.emailVerified && (
            <div className="profile-verify-section">
              {verificationSent ? (
                <p className="auth-success">Verification email sent!</p>
              ) : (
                <button className="btn-link" onClick={handleResendVerification}>
                  Resend verification email
                </button>
              )}
              {verificationError && <p className="auth-error">{verificationError}</p>}
            </div>
          )}
        </div>
      </div>

      <div className="profile-section profile-rewards">
        <h3 className="profile-section-title">Rewards</h3>
        {rewardsLoading ? (
          <p className="loading-text">Loading rewards...</p>
        ) : rewards.length === 0 ? (
          <p className="profile-empty">No rewards yet. Keep playing to earn rewards!</p>
        ) : (
          <div className="rewards-list">
            {rewards.map((reward) => (
              <div key={reward.id} className={`reward-card ${reward.claimedAt ? "reward-card-claimed" : ""}`}>
                <div className="reward-card-icon">$</div>
                <div className="reward-card-details">
                  <div className="reward-card-amount">
                    ${(reward.amountCents / 100).toFixed(2)} Amazon Gift Card
                  </div>
                  {reward.description && (
                    <div className="reward-card-desc">{reward.description}</div>
                  )}
                  <div className="reward-card-date">
                    Awarded {new Date(reward.awardedAt).toLocaleDateString()}
                    {reward.awardMethod === "random_roll" ? " via random drawing" : ""}
                  </div>
                </div>
                <div className="reward-card-actions">
                  {reward.claimedAt ? (
                    <>
                      {revealedCodes[reward.id] && (
                        <div className="reward-card-code">{revealedCodes[reward.id]}</div>
                      )}
                      <span className="reward-card-collected">Collected</span>
                    </>
                  ) : (
                    <>
                      <div className="reward-card-code">{reward.code}</div>
                      <div className="reward-card-deadline">
                        Claim by {new Date(reward.claimExpiresAt).toLocaleDateString()}
                      </div>
                      <button
                        className="btn btn-primary reward-claim-btn"
                        onClick={() => navigate(`/claim/${reward.claimToken}`)}
                        data-testid={`claim-link-btn-${reward.id}`}
                      >
                        Collect & Reveal Code
                      </button>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div id="referrals">
        {user.emailVerified ? (
          <ReferralDashboard />
        ) : (
          <div className="profile-section referral-section">
            <h3 className="profile-section-title">Referrals</h3>
            <p className="profile-empty">
              Verify your email to unlock referrals and earn extra entries in the monthly giveaway.
            </p>
          </div>
        )}
      </div>

      <AvatarPicker
        selected={user.avatar}
        onSelect={handleAvatarSelect}
        loading={avatarLoading}
        error={avatarError}
        enabledAvatars={enabledAvatars}
      />

      <NotificationSettings />

      <EmailSettings />

      <div className="profile-section">
        <h3 className="profile-section-title">Account Settings</h3>
        <div className="profile-settings-actions">
          <button
            className="btn btn-secondary"
            onClick={() => setShowEmailForm((v) => !v)}
          >
            {showEmailForm ? "Cancel" : "Change Email"}
          </button>
          <button
            className="btn btn-secondary"
            onClick={() => setShowPasswordForm((v) => !v)}
          >
            {showPasswordForm ? "Cancel" : "Change Password"}
          </button>
          <button
            className="btn btn-secondary"
            onClick={openCookieSettings}
          >
            Cookie Settings
          </button>
        </div>
        {showEmailForm && <ChangeEmailForm />}
        {showPasswordForm && <ChangePasswordForm />}
      </div>

    </div>
  );
}
