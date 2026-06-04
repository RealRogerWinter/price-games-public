import { useState, useEffect, useCallback, useRef } from "react";
import {
  getPreferences,
  savePreferences,
  type CookiePreferences,
} from "../utils/cookieConsent";
import { grantAnalyticsConsent, revokeAnalyticsConsent } from "../utils/analytics";
import { grantRedditConsent, revokeRedditConsent } from "../utils/redditPixel";
import { captureUtmFromUrl, trackAttributionOnServer } from "../utils/attribution";
import { useBroadcastMode } from "../broadcast/useBroadcastMode";

/**
 * Cookie consent banner + settings modal.
 *
 * - Shows a notification bar at the bottom on first visit.
 * - "Accept all" enables all cookie categories; "Reject all" disables every
 *   category the user can opt out of (including Necessary — kept toggleable
 *   so the Reject/Accept pair stays symmetric).
 * - "Customise" opens a modal with per-category toggles.
 * - Logged-in users can reopen settings from their Settings page
 *   via the "open-cookie-settings" custom event.
 *
 * Note: GA is bootstrapped in main.tsx (before React renders) so it
 * doesn't depend on this component mounting. This component only
 * manages consent grant/revoke.
 */
export default function CookieConsent() {
  const broadcast = useBroadcastMode();
  const [prefs, setPrefs] = useState<CookiePreferences>(getPreferences);
  const [showBanner, setShowBanner] = useState(!prefs.consented);
  const [showSettings, setShowSettings] = useState(false);
  const [draft, setDraft] = useState(prefs);
  const modalRef = useRef<HTMLDivElement>(null);

  // Apply analytics preference on mount & whenever it changes. GA, the Reddit
  // Pixel, and UTM-attribution capture all piggyback on the single "Analytics"
  // toggle. UTM capture is a no-op after the first hit (first-touch wins), so
  // re-running it on every render is safe.
  useEffect(() => {
    if (prefs.consented && prefs.analytics) {
      grantAnalyticsConsent();
      grantRedditConsent();
      captureUtmFromUrl();
      void trackAttributionOnServer();
    } else {
      revokeAnalyticsConsent();
      revokeRedditConsent();
    }
  }, [prefs]);

  // Toggle a body class while the banner is visible so pages can reserve
  // bottom space (via CSS) and avoid having their bottom-anchored controls
  // covered by the banner overlay.
  useEffect(() => {
    const visible = showBanner && !showSettings;
    document.body.classList.toggle("cookie-banner-visible", visible);
    return () => {
      document.body.classList.remove("cookie-banner-visible");
    };
  }, [showBanner, showSettings]);

  const commit = useCallback((next: CookiePreferences) => {
    savePreferences(next);
    setPrefs(next);
    setShowBanner(false);
    setShowSettings(false);
  }, []);

  const acceptAll = useCallback(() => {
    commit({ consented: true, necessary: true, analytics: true });
  }, [commit]);

  const rejectAll = useCallback(() => {
    commit({ consented: true, necessary: false, analytics: false });
  }, [commit]);

  const openSettings = useCallback(() => {
    setDraft(getPreferences());
    setShowSettings(true);
  }, []);

  const closeSettings = useCallback(() => {
    setShowSettings(false);
  }, []);

  // Allow other components (e.g. SettingsPage) to open the settings modal
  useEffect(() => {
    const handler = () => openSettings();
    window.addEventListener("open-cookie-settings", handler);
    return () => window.removeEventListener("open-cookie-settings", handler);
  }, [openSettings]);

  // Close modal on Escape key
  useEffect(() => {
    if (!showSettings) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeSettings();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [showSettings, closeSettings]);

  // Focus the modal when it opens
  useEffect(() => {
    if (showSettings && modalRef.current) {
      modalRef.current.focus();
    }
  }, [showSettings]);

  const saveDraft = useCallback(() => {
    commit({ consented: true, necessary: draft.necessary, analytics: draft.analytics });
  }, [draft, commit]);

  // Broadcast-mode renders for the 24/7 stream bot — hide the banner so it
  // never appears on stream. Analytics consent state still flows through the
  // useEffect above, so cookie/GA preferences for the bot's profile are
  // honoured the same as for any other client.
  if (broadcast) return null;

  return (
    <>
      {/* ---------- Banner ---------- */}
      {showBanner && !showSettings && (
        <div className="cookie-banner" role="region" aria-label="Cookie consent">
          <span className="cookie-banner-icon" aria-hidden="true">🍪</span>
          <p className="cookie-banner-text">
            We use cookies for core features and, with your permission,{" "}
            <strong>analytics</strong> to help improve the game.
          </p>
          <div className="cookie-banner-actions">
            <button className="btn cookie-btn cookie-btn-link" onClick={openSettings}>
              Customise
            </button>
            <div className="cookie-banner-choice">
              <button
                className="btn cookie-btn cookie-btn-secondary cookie-btn-choice"
                onClick={rejectAll}
              >
                Reject all
              </button>
              <button
                className="btn btn-primary cookie-btn cookie-btn-choice"
                onClick={acceptAll}
              >
                Accept all
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ---------- Settings modal ---------- */}
      {showSettings && (
        <div className="cookie-modal-overlay" onClick={closeSettings}>
          <div
            ref={modalRef}
            className="cookie-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="cookie-modal-heading"
            tabIndex={-1}
            onClick={(e) => e.stopPropagation()}
          >
            <button className="cookie-modal-close" onClick={closeSettings} aria-label="Close">
              &times;
            </button>
            <h2 id="cookie-modal-heading" className="cookie-modal-title">Cookie settings</h2>
            <p className="cookie-modal-blurb">
              Choose which cookie features to enable. Your choice is saved on
              this device and can be changed any time.
            </p>

            <div className="cookie-category">
              <div className="cookie-category-header">
                <span className="cookie-category-name">Necessary</span>
                <label className="cookie-toggle">
                  <input
                    type="checkbox"
                    checked={draft.necessary}
                    onChange={(e) => setDraft({ ...draft, necessary: e.target.checked })}
                    aria-label="Enable necessary cookies"
                  />
                  <span className="cookie-toggle-slider" />
                </label>
              </div>
              <p className="cookie-category-desc">
                Keep the site working — sign-in sessions, saved game progress,
                and personal preferences like sound and currency.
              </p>
            </div>

            <div className="cookie-category">
              <div className="cookie-category-header">
                <span className="cookie-category-name">Analytics</span>
                <label className="cookie-toggle">
                  <input
                    type="checkbox"
                    checked={draft.analytics}
                    onChange={(e) => setDraft({ ...draft, analytics: e.target.checked })}
                    aria-label="Enable analytics cookies"
                  />
                  <span className="cookie-toggle-slider" />
                </label>
              </div>
              <p className="cookie-category-desc">
                Help us understand how the game is played and measure marketing
                so we know what to improve.
              </p>
            </div>

            <div className="cookie-modal-actions">
              <button className="btn cookie-btn cookie-btn-secondary" onClick={rejectAll}>
                Reject all
              </button>
              <button className="btn btn-primary cookie-btn" onClick={saveDraft}>
                Save preferences
              </button>
              <button className="btn btn-primary cookie-btn" onClick={acceptAll}>
                Accept all
              </button>
            </div>
          </div>
        </div>
      )}

    </>
  );
}

/** Dispatch event to open the cookie settings modal from anywhere. */
export function openCookieSettings(): void {
  window.dispatchEvent(new CustomEvent("open-cookie-settings"));
}
