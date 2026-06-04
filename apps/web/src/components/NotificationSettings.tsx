/**
 * Notification settings panel for the SettingsPage.
 *
 * Provides a master push toggle and per-type notification preferences.
 * Fetches/saves preferences via the push API. Includes timezone detection
 * and quiet hours configuration.
 */

import { useState, useEffect, useCallback } from "react";
import { usePushNotifications } from "../hooks/usePushNotifications";
import { getNotifPreferences, updateNotifPreferences } from "../api/pushClient";
import type { NotificationPreferences } from "@price-game/shared";

/**
 * Notification settings component for the user settings page.
 * Allows users to manage push subscription and per-type preferences.
 */
export default function NotificationSettings() {
  const { isSupported, permission, isSubscribed, subscribe, unsubscribe, loading: pushLoading } = usePushNotifications();
  const [prefs, setPrefs] = useState<NotificationPreferences | null>(null);
  const [saving, setSaving] = useState(false);

  const fetchPrefs = useCallback(async () => {
    try {
      const data = await getNotifPreferences();
      setPrefs(data);
    } catch {
      // Prefs not available yet
    }
  }, []);

  useEffect(() => {
    if (isSubscribed) fetchPrefs();
  }, [isSubscribed, fetchPrefs]);

  async function handleTogglePush() {
    if (isSubscribed) {
      await unsubscribe();
    } else {
      const success = await subscribe();
      if (success) fetchPrefs();
    }
  }

  async function handlePrefChange(key: keyof NotificationPreferences, value: boolean | string | null) {
    if (!prefs) return;
    setSaving(true);
    try {
      const updated = await updateNotifPreferences({ [key]: value });
      setPrefs(updated);
    } catch {
      // Revert on failure
    } finally {
      setSaving(false);
    }
  }

  // Auto-detect timezone on mount
  useEffect(() => {
    if (prefs && prefs.timezone === "UTC") {
      const detected = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (detected && detected !== "UTC") {
        handlePrefChange("timezone", detected);
      }
    }
    // Only run when prefs first load
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefs?.timezone]);

  if (!isSupported) {
    return (
      <div className="profile-section">
        <h3 className="profile-section-title">Notifications</h3>
        <p className="profile-empty">
          Push notifications are not supported in this browser.
        </p>
      </div>
    );
  }

  if (permission === "denied") {
    return (
      <div className="profile-section">
        <h3 className="profile-section-title">Notifications</h3>
        <p className="profile-empty">
          Notifications are blocked for this site. To enable them, update your
          browser notification settings for price.games.
        </p>
      </div>
    );
  }

  return (
    <div className="profile-section" data-testid="notification-settings">
      <h3 className="profile-section-title">Notifications</h3>

      <div className="notif-setting-row">
        <label className="notif-setting-label">
          Push Notifications
          <span className="notif-setting-hint">
            {isSubscribed ? "Enabled" : "Disabled"}
          </span>
        </label>
        <button
          className={`notif-toggle ${isSubscribed ? "notif-toggle-on" : ""}`}
          onClick={handleTogglePush}
          disabled={pushLoading}
          data-testid="notif-master-toggle"
          aria-label={isSubscribed ? "Disable push notifications" : "Enable push notifications"}
        >
          <span className="notif-toggle-knob" />
        </button>
      </div>

      {isSubscribed && prefs && (
        <>
          <div className="notif-setting-row">
            <label className="notif-setting-label">
              Daily Puzzle Ready
              <span className="notif-setting-hint">When a new daily puzzle is available</span>
            </label>
            <button
              type="button"
              className={`notif-toggle ${prefs.dailyPuzzle ? "notif-toggle-on" : ""}`}
              onClick={() => handlePrefChange("dailyPuzzle", !prefs.dailyPuzzle)}
              disabled={saving}
              data-testid="notif-toggle-daily"
              role="switch"
              aria-checked={prefs.dailyPuzzle}
              aria-label={`Daily puzzle notifications ${prefs.dailyPuzzle ? "enabled" : "disabled"}`}
            >
              <span className="notif-toggle-knob" />
            </button>
          </div>

          <div className="notif-setting-row">
            <label className="notif-setting-label">
              Streak Reminders
              <span className="notif-setting-hint">Before your daily streak expires</span>
            </label>
            <button
              type="button"
              className={`notif-toggle ${prefs.streakReminder ? "notif-toggle-on" : ""}`}
              onClick={() => handlePrefChange("streakReminder", !prefs.streakReminder)}
              disabled={saving}
              data-testid="notif-toggle-streak"
              role="switch"
              aria-checked={prefs.streakReminder}
              aria-label={`Streak reminder notifications ${prefs.streakReminder ? "enabled" : "disabled"}`}
            >
              <span className="notif-toggle-knob" />
            </button>
          </div>

          <div className="notif-setting-row">
            <label className="notif-setting-label">
              Leaderboard Updates
              <span className="notif-setting-hint">When someone overtakes your position</span>
            </label>
            <button
              type="button"
              className={`notif-toggle ${prefs.leaderboardUpdates ? "notif-toggle-on" : ""}`}
              onClick={() => handlePrefChange("leaderboardUpdates", !prefs.leaderboardUpdates)}
              disabled={saving}
              data-testid="notif-toggle-leaderboard"
              role="switch"
              aria-checked={prefs.leaderboardUpdates}
              aria-label={`Leaderboard update notifications ${prefs.leaderboardUpdates ? "enabled" : "disabled"}`}
            >
              <span className="notif-toggle-knob" />
            </button>
          </div>

          <div className="notif-setting-row">
            <label className="notif-setting-label">
              Top 3 Placements
              <span className="notif-setting-hint">
                When you land in the top 3 of a daily, weekly, or monthly leaderboard
              </span>
            </label>
            <button
              type="button"
              className={`notif-toggle ${prefs.leaderboardPlacement ? "notif-toggle-on" : ""}`}
              onClick={() => handlePrefChange("leaderboardPlacement", !prefs.leaderboardPlacement)}
              disabled={saving}
              data-testid="notif-toggle-leaderboard-placement"
              role="switch"
              aria-checked={prefs.leaderboardPlacement}
              aria-label={`Top 3 placement notifications ${prefs.leaderboardPlacement ? "enabled" : "disabled"}`}
            >
              <span className="notif-toggle-knob" />
            </button>
          </div>

          <div className="notif-setting-row">
            <label className="notif-setting-label">
              Multiplayer Invites
              <span className="notif-setting-hint">When friends invite you to a room</span>
            </label>
            <button
              type="button"
              className={`notif-toggle ${prefs.multiplayerInvites ? "notif-toggle-on" : ""}`}
              onClick={() => handlePrefChange("multiplayerInvites", !prefs.multiplayerInvites)}
              disabled={saving}
              data-testid="notif-toggle-multiplayer"
              role="switch"
              aria-checked={prefs.multiplayerInvites}
              aria-label={`Multiplayer invite notifications ${prefs.multiplayerInvites ? "enabled" : "disabled"}`}
            >
              <span className="notif-toggle-knob" />
            </button>
          </div>

          <div className="notif-setting-row">
            <label className="notif-setting-label">
              Promotional
              <span className="notif-setting-hint">New features and special events</span>
            </label>
            <button
              className={`notif-toggle ${prefs.promotional ? "notif-toggle-on" : ""}`}
              onClick={() => handlePrefChange("promotional", !prefs.promotional)}
              disabled={saving}
              data-testid="notif-toggle-promotional"
            >
              <span className="notif-toggle-knob" />
            </button>
          </div>

          {prefs.timezone && prefs.timezone !== "UTC" && (
            <div className="notif-setting-row notif-timezone">
              <span className="notif-setting-label">
                Timezone
                <span className="notif-setting-hint">{prefs.timezone}</span>
              </span>
            </div>
          )}
        </>
      )}
    </div>
  );
}
