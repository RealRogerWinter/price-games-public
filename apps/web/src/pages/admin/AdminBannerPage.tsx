import { useState, useEffect, useRef, useMemo } from "react";
import type { PromoBanner, QualificationMode } from "@price-game/shared";
import { getPromoBanner, updatePromoBanner } from "../../api/adminClient";

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/**
 * Admin page for managing the promo banner displayed on the home page.
 * Allows admins to configure banner text, audience, link, and giveaway modal settings.
 */
export default function AdminBannerPage() {
  const currentMonth = useMemo(() => MONTH_NAMES[new Date().getMonth()], []);
  const [banner, setBanner] = useState<PromoBanner | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const successTimerRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    getPromoBanner().then(setBanner).catch(() => {
      setError("Failed to load banner settings");
    });
  }, []);

  useEffect(() => {
    return () => {
      if (successTimerRef.current) clearTimeout(successTimerRef.current);
    };
  }, []);

  function clearSuccess() {
    if (successTimerRef.current) clearTimeout(successTimerRef.current);
    successTimerRef.current = setTimeout(() => setSuccess(null), 4000);
  }

  async function handleSave() {
    if (!banner) return;
    try {
      setSaving(true);
      setError(null);
      const updated = await updatePromoBanner(banner);
      setBanner(updated);
      setSuccess("Banner settings saved");
      clearSuccess();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to save banner");
    } finally {
      setSaving(false);
    }
  }

  if (!banner) {
    return (
      <div className="admin-page">
        <div className="admin-loading" style={{ minHeight: "200px" }}>
          <span className="admin-loading-spinner" />
          Loading banner settings...
        </div>
      </div>
    );
  }

  return (
    <div className="admin-page admin-banner-page" data-testid="admin-banner-page">
      <h2>Promo Banner</h2>
      <p style={{ fontSize: "0.85rem", color: "#999", marginBottom: 16 }}>
        Configure the promotional banner shown on the home page. All banners
        automatically include a note that users must be registered with a verified
        email to qualify for rewards.
      </p>

      {success && <div className="admin-success">{success}</div>}
      {error && <div className="admin-error" style={{ maxWidth: "100%", marginBottom: 16 }}>{error}</div>}

      <div className="admin-section admin-banner-settings" data-testid="banner-settings">
        <h3>General Settings</h3>
        <div className="banner-settings-form">
          <label className="reward-criteria-checkbox" style={{ marginBottom: 8 }}>
            <input
              type="checkbox"
              checked={banner.enabled}
              onChange={(e) => setBanner({ ...banner, enabled: e.target.checked })}
              data-testid="banner-enabled"
            />
            Banner enabled
          </label>
          <div className="banner-settings-row" style={{ marginBottom: 12 }}>
            <label>
              Audience
              <select
                value={banner.audienceMode}
                onChange={(e) => setBanner({ ...banner, audienceMode: e.target.value as "all" | "logged_in" })}
                data-testid="banner-audience"
              >
                <option value="all">All users (recommended for signup encouragement)</option>
                <option value="logged_in">Logged-in users only</option>
              </select>
            </label>
          </div>
          <label>
            Banner text
            <input
              type="text"
              value={banner.text}
              onChange={(e) => setBanner({ ...banner, text: e.target.value })}
              maxLength={500}
              placeholder="Score 20,000+ points for a chance to win..."
              data-testid="banner-text"
            />
          </label>
        </div>

        <h3 style={{ marginTop: 24 }}>Link Button</h3>
        <div className="banner-settings-form">
          <label className="reward-criteria-checkbox" style={{ marginBottom: 4 }}>
            <input
              type="checkbox"
              checked={banner.showLink}
              onChange={(e) => setBanner({ ...banner, showLink: e.target.checked })}
              data-testid="banner-show-link"
            />
            Show custom link button
          </label>
          <div className="banner-settings-row" style={{ opacity: banner.showLink ? 1 : 0.4 }}>
            <label>
              Link text
              <input
                type="text"
                value={banner.linkText}
                disabled={!banner.showLink}
                onChange={(e) => setBanner({ ...banner, linkText: e.target.value })}
                maxLength={100}
                placeholder="Learn More"
                data-testid="banner-link-text"
              />
            </label>
            <label>
              Link URL
              <input
                type="text"
                value={banner.linkUrl}
                disabled={!banner.showLink}
                onChange={(e) => setBanner({ ...banner, linkUrl: e.target.value })}
                maxLength={500}
                placeholder="/settings"
                data-testid="banner-link-url"
              />
            </label>
          </div>
        </div>

        <h3 style={{ marginTop: 24 }}>Giveaway Settings</h3>
        <p style={{ fontSize: "0.8rem", color: "#999", marginBottom: 8 }}>
          Configure the monthly giveaway drawing. Qualification can be based on
          calendar-month points, a maintained daily-challenge streak, or a
          combination (AND / OR). The banner can show a &quot;Giveaway Details&quot;
          button and an inline progress tracker.
        </p>
        <div className="banner-settings-form">
          <label className="reward-criteria-checkbox" style={{ marginBottom: 4 }}>
            <input
              type="checkbox"
              checked={banner.showGiveawayModal}
              onChange={(e) => setBanner({ ...banner, showGiveawayModal: e.target.checked })}
              data-testid="banner-show-giveaway-modal"
            />
            Show &quot;Giveaway Details&quot; button in banner
          </label>
          <label className="reward-criteria-checkbox" style={{ marginBottom: 4 }}>
            <input
              type="checkbox"
              checked={banner.showTracker}
              onChange={(e) => setBanner({ ...banner, showTracker: e.target.checked })}
              data-testid="banner-show-tracker"
            />
            Show progress tracker in banner (for verified users)
          </label>
          <label style={{ marginTop: 8 }}>
            Qualification mode
            <select
              value={banner.giveawayQualifyMode}
              onChange={(e) =>
                setBanner({ ...banner, giveawayQualifyMode: e.target.value as QualificationMode })
              }
              data-testid="banner-giveaway-mode"
            >
              <option value="points_only">Points only</option>
              <option value="streak_only">Streak only</option>
              <option value="points_and_streak">Points AND streak</option>
              <option value="points_or_streak">Points OR streak</option>
            </select>
            <span style={{ fontSize: "0.75rem", color: "#777" }}>
              Controls how the points and streak thresholds combine to qualify a player.
            </span>
          </label>
          {banner.giveawayQualifyMode !== "streak_only" && (
            <label style={{ marginTop: 8 }}>
              Qualifying points threshold
              <input
                type="number"
                min="0"
                step="1000"
                value={banner.giveawayMinPoints}
                onChange={(e) => setBanner({ ...banner, giveawayMinPoints: Math.max(0, parseInt(e.target.value, 10) || 0) })}
                placeholder="20000"
                data-testid="banner-giveaway-min-points"
              />
              <span style={{ fontSize: "0.75rem", color: "#777" }}>
                Users must earn this many points in a calendar month to qualify for the drawing.
              </span>
            </label>
          )}
          {banner.giveawayQualifyMode !== "points_only" && (
            <label style={{ marginTop: 8 }}>
              Qualifying streak threshold (days)
              <input
                type="number"
                min="1"
                step="1"
                value={banner.giveawayMinStreak}
                onChange={(e) => setBanner({ ...banner, giveawayMinStreak: Math.max(0, parseInt(e.target.value, 10) || 0) })}
                placeholder="7"
                data-testid="banner-giveaway-min-streak"
              />
              <span style={{ fontSize: "0.75rem", color: "#777" }}>
                Minimum current consecutive daily-challenge streak required to qualify.
              </span>
            </label>
          )}
          <label style={{ marginTop: 12 }}>
            Qualified user message
            <textarea
              value={banner.qualifiedMessage}
              onChange={(e) => setBanner({ ...banner, qualifiedMessage: e.target.value })}
              maxLength={500}
              rows={2}
              placeholder="You're entered in the {month} drawing! Increase your odds — refer a friend for bonus entries."
              data-testid="banner-qualified-message"
              style={{ width: "100%", resize: "vertical" }}
            />
            <span style={{ fontSize: "0.75rem", color: "#777" }}>
              Shown in the progress tracker when a user has qualified. Use <code>{"{month}"}</code> for the current month name.
            </span>
          </label>
        </div>

        <div style={{ marginTop: 20 }}>
          <button
            className="admin-btn-primary"
            onClick={handleSave}
            disabled={saving}
            data-testid="banner-save"
          >
            {saving ? "Saving..." : "Save Banner Settings"}
          </button>
        </div>

        {/* Live preview */}
        {banner.enabled && banner.text && (
          <div className="banner-preview" data-testid="banner-preview">
            <span className="banner-preview-label">Preview (logged-out user):</span>
            <div className="promo-banner" style={{ margin: 0 }}>
              <div className="promo-banner-top">
                <span className="promo-banner-icon">&#127873;</span>
                <span className="promo-banner-text">{banner.text}</span>
                <span className="promo-banner-cta" style={{ pointerEvents: "none" }}>Sign Up</span>
                {banner.showGiveawayModal && (
                  <span className="promo-banner-cta promo-banner-cta-outline" style={{ pointerEvents: "none" }}>Details</span>
                )}
              </div>
              <span className="promo-banner-subtext">
                Register with a verified email to qualify.
              </span>
            </div>

            <span className="banner-preview-label" style={{ marginTop: 12 }}>Preview (verified, not yet qualified):</span>
            <div className="promo-banner" style={{ margin: 0 }}>
              <div className="promo-banner-top">
                <span className="promo-banner-icon">&#127873;</span>
                <span className="promo-banner-text">{banner.text}</span>
                {banner.showGiveawayModal && (
                  <span className="promo-banner-cta promo-banner-cta-outline" style={{ pointerEvents: "none" }}>Details</span>
                )}
              </div>
              {!banner.showTracker && (
                <span className="promo-banner-subtext promo-banner-subtext-ok">
                  Registered and verified &mdash; you qualify for rewards!
                </span>
              )}
              {banner.showTracker && banner.giveawayMinPoints > 0 && (
                <div className="promo-tracker">
                  <div className="promo-tracker-bar-bg">
                    <div className="promo-tracker-bar-fill" style={{ width: "35%" }} />
                  </div>
                  <div className="promo-tracker-stats">
                    <span className="promo-tracker-points">
                      7,000 / {banner.giveawayMinPoints.toLocaleString()} pts
                    </span>
                    <span className="promo-tracker-meta">12 games this month</span>
                  </div>
                </div>
              )}
            </div>

            {banner.showTracker && banner.giveawayMinPoints > 0 && (
              <>
                <span className="banner-preview-label" style={{ marginTop: 12 }}>Preview (verified, qualified):</span>
                <div className="promo-banner" style={{ margin: 0 }}>
                  <div className="promo-banner-top">
                    <span className="promo-banner-icon">&#127873;</span>
                    <span className="promo-banner-text">{banner.text}</span>
                    {banner.showGiveawayModal && (
                      <span className="promo-banner-cta promo-banner-cta-outline" style={{ pointerEvents: "none" }}>Details</span>
                    )}
                  </div>
                  <div className="promo-tracker promo-tracker-qualified">
                    <span className="promo-tracker-qualified-check">&#10003;</span>
                    <span className="promo-tracker-qualified-text">
                      {(banner.qualifiedMessage || "You're entered in the {month} drawing! Increase your odds — refer a friend for bonus entries.")
                        .replace(/\{month\}/g, currentMonth)}
                      {" "}
                      <span style={{ color: "#4ecca3", fontWeight: 600, textDecoration: "underline" }}>Share your link</span>
                    </span>
                  </div>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
