import { useState, useEffect, useCallback } from "react";
import { userGetReferralDashboard } from "../api/userClient";
import type { ReferralDashboard as ReferralDashboardType } from "@price-game/shared";
import AvatarIcon from "./multiplayer/AvatarIcon";

/**
 * Referral dashboard component for the profile page.
 * Shows referral link, stats, referral list, and multi-account warnings.
 */
export default function ReferralDashboard() {
  const [dashboard, setDashboard] = useState<ReferralDashboardType | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [copied, setCopied] = useState(false);

  const fetchDashboard = useCallback(async () => {
    setError(false);
    try {
      const data = await userGetReferralDashboard();
      setDashboard(data);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchDashboard();
  }, [fetchDashboard]);

  async function handleCopyLink() {
    if (!dashboard) return;
    try {
      await navigator.clipboard.writeText(dashboard.referralUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback: select the text
    }
  }

  async function handleShare() {
    if (!dashboard) return;
    if (navigator.share) {
      try {
        await navigator.share({
          title: "Join me on Price Games!",
          text: "Test your pricing instincts and compete with friends!",
          url: dashboard.referralUrl,
        });
      } catch {
        // User cancelled or share failed — fall back to copy
        handleCopyLink();
      }
    } else {
      handleCopyLink();
    }
  }

  if (loading) {
    return (
      <div className="profile-section referral-section">
        <h3 className="profile-section-title">Referrals</h3>
        <p className="loading-text">Loading referrals...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="profile-section referral-section">
        <h3 className="profile-section-title">Referrals</h3>
        <p className="profile-empty">Failed to load referral data. <button className="btn-link" onClick={fetchDashboard}>Retry</button></p>
      </div>
    );
  }

  if (!dashboard) return null;

  return (
    <div className="profile-section referral-section" data-testid="referral-dashboard">
      <h3 className="profile-section-title">Referrals</h3>

      <div className="referral-link-section">
        <p className="referral-link-label">Your referral link</p>
        <div className="referral-link-row">
          <input
            className="referral-link-input"
            type="text"
            value={dashboard.referralUrl}
            readOnly
            onClick={(e) => (e.target as HTMLInputElement).select()}
          />
          <div className="referral-link-actions">
            <button
              className="btn btn-primary referral-copy-btn"
              onClick={handleCopyLink}
              data-testid="copy-referral-link"
            >
              {copied ? "Copied!" : "Copy"}
            </button>
            <button
              className="btn btn-secondary referral-share-btn"
              onClick={handleShare}
            >
              Share
            </button>
          </div>
        </div>
        <p className="referral-link-hint">
          Each friend who signs up and verifies their email earns you an extra entry in the monthly giveaway.
        </p>
      </div>

      <div className="referral-stats">
        <div className="referral-stat">
          <span className="referral-stat-value">{dashboard.creditedReferrals}</span>
          <span className="referral-stat-label">Credited</span>
        </div>
        <div className="referral-stat">
          <span className="referral-stat-value">{dashboard.pendingReferrals}</span>
          <span className="referral-stat-label">Pending</span>
        </div>
        <div className="referral-stat">
          <span className="referral-stat-value">{dashboard.totalReferrals}</span>
          <span className="referral-stat-label">Total</span>
        </div>
      </div>

      {dashboard.referrals.length > 0 && (
        <table className="referral-table">
          <thead>
            <tr>
              <th>User</th>
              <th>Status</th>
              <th>Date</th>
            </tr>
          </thead>
          <tbody>
            {dashboard.referrals.map((ref) => (
              <tr key={ref.id}>
                <td>
                  <span className="referral-user">
                    {ref.referredAvatar && (
                      <AvatarIcon avatar={ref.referredAvatar} size={22} />
                    )}
                    <span>{ref.referredUsername}</span>
                  </span>
                </td>
                <td>
                  <span className={`referral-status referral-status-${ref.status}`}>
                    {ref.status}
                  </span>
                </td>
                <td>{new Date(ref.createdAt).toLocaleDateString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {dashboard.referrals.length === 0 && (
        <p className="profile-empty">No referrals yet. Share your link to invite friends!</p>
      )}
    </div>
  );
}
