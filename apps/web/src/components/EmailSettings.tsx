/**
 * Email preferences panel for the SettingsPage.
 *
 * Parallel to `NotificationSettings`, but for the marketing-email channel.
 * Everything here is strictly opt-in: all flags start `false` and the
 * master toggle gates the per-type toggles.
 */

import { useState, useEffect, useCallback } from "react";
import type { EmailPreferences } from "@price-game/shared";
import { getEmailPreferences, updateEmailPreferences } from "../api/emailClient";

/**
 * User-facing email preferences panel. Renders a master toggle, per-type
 * toggles, and a preferred-hour + timezone control so the scheduler can
 * land sends during the user's daytime.
 */
export default function EmailSettings() {
  const [prefs, setPrefs] = useState<EmailPreferences | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setPrefs(await getEmailPreferences());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load preferences");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Auto-detect timezone on first load if the server still has "UTC".
  useEffect(() => {
    if (prefs && prefs.timezone === "UTC") {
      const detected = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (detected && detected !== "UTC") {
        handleChange("timezone", detected);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefs?.timezone]);

  async function handleChange<K extends keyof EmailPreferences>(
    key: K,
    value: EmailPreferences[K],
  ) {
    if (!prefs) return;
    setSaving(true);
    setError(null);
    // Optimistic update so toggles feel snappy; revert on failure.
    const prior = prefs;
    setPrefs({ ...prefs, [key]: value });
    try {
      const updated = await updateEmailPreferences({ [key]: value } as Partial<EmailPreferences>);
      setPrefs(updated);
    } catch (err) {
      setPrefs(prior);
      setError(err instanceof Error ? err.message : "Failed to save preference");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="profile-section">
        <h3 className="profile-section-title">Email updates</h3>
        <p className="profile-empty">Loading...</p>
      </div>
    );
  }

  if (!prefs) {
    return (
      <div className="profile-section">
        <h3 className="profile-section-title">Email updates</h3>
        <p className="profile-empty">{error ?? "Email preferences unavailable."}</p>
      </div>
    );
  }

  return (
    <div className="profile-section" data-testid="email-settings">
      <h3 className="profile-section-title">Email updates</h3>
      <p style={{ color: "#8a96b0", fontSize: "0.85rem", margin: "0 0 12px" }}>
        Email is off by default — pick any of these if you want occasional
        reminders about your streak, inactivity, or new features.
      </p>
      {error && <p className="notif-error">{error}</p>}

      <div className="notif-setting-row">
        <label className="notif-setting-label">
          Enable emails
          <span className="notif-setting-hint">
            {prefs.emailEnabled ? "On" : "Off — other toggles below have no effect until this is on"}
          </span>
        </label>
        <button
          type="button"
          className={`notif-toggle ${prefs.emailEnabled ? "notif-toggle-on" : ""}`}
          onClick={() => handleChange("emailEnabled", !prefs.emailEnabled)}
          disabled={saving}
          data-testid="email-master-toggle"
          role="switch"
          aria-checked={prefs.emailEnabled}
          aria-label={`Email notifications ${prefs.emailEnabled ? "enabled" : "disabled"}`}
        >
          <span className="notif-toggle-knob" />
        </button>
      </div>

      <EmailTypeToggle
        label="Streak at risk"
        hint="If your streak is about to break tomorrow"
        enabled={prefs.streakRisk}
        onChange={(v) => handleChange("streakRisk", v)}
        disabled={!prefs.emailEnabled || saving}
        testId="email-toggle-streak-risk"
      />
      <EmailTypeToggle
        label="Save a long streak"
        hint="Only when a long-running streak is about to end"
        enabled={prefs.streakSave}
        onChange={(v) => handleChange("streakSave", v)}
        disabled={!prefs.emailEnabled || saving}
        testId="email-toggle-streak-save"
      />
      <EmailTypeToggle
        label="Come back"
        hint="Gentle nudge if you've been away for a while"
        enabled={prefs.inactivityReminder}
        onChange={(v) => handleChange("inactivityReminder", v)}
        disabled={!prefs.emailEnabled || saving}
        testId="email-toggle-inactivity"
      />
      <EmailTypeToggle
        label="Weekly digest"
        hint="A once-a-week roundup of new modes and highlights"
        enabled={prefs.weeklyDigest}
        onChange={(v) => handleChange("weeklyDigest", v)}
        disabled={!prefs.emailEnabled || saving}
        testId="email-toggle-digest"
      />
      <EmailTypeToggle
        label="Top 3 leaderboard placement"
        hint="Celebrate when you land in the daily, weekly, or monthly top 3"
        enabled={prefs.leaderboardPlacement}
        onChange={(v) => handleChange("leaderboardPlacement", v)}
        disabled={!prefs.emailEnabled || saving}
        testId="email-toggle-leaderboard-placement"
      />
      <EmailTypeToggle
        label="Promotional"
        hint="Special events and new features"
        enabled={prefs.promotional}
        onChange={(v) => handleChange("promotional", v)}
        disabled={!prefs.emailEnabled || saving}
        testId="email-toggle-promotional"
      />
      <EmailTypeToggle
        label="Giveaway results"
        hint="Hear back when a giveaway you qualified for is drawn — even if you didn't win"
        enabled={prefs.giveawayLoss}
        onChange={(v) => handleChange("giveawayLoss", v)}
        disabled={!prefs.emailEnabled || saving}
        testId="email-toggle-giveaway-loss"
      />

      {prefs.emailEnabled && (
        <div className="notif-setting-row">
          <label className="notif-setting-label">
            Preferred hour
            <span className="notif-setting-hint">
              Local hour to receive email (timezone: {prefs.timezone})
            </span>
          </label>
          <select
            value={prefs.preferredHour}
            onChange={(e) => handleChange("preferredHour", Number(e.target.value))}
            disabled={saving}
            data-testid="email-preferred-hour"
            style={{
              padding: "6px 10px",
              background: "#16213e",
              border: "1px solid #333",
              borderRadius: 6,
              color: "#e0e0e0",
            }}
          >
            {Array.from({ length: 24 }, (_, i) => i).map((h) => (
              <option key={h} value={h}>{formatHour(h)}</option>
            ))}
          </select>
        </div>
      )}
    </div>
  );
}

function EmailTypeToggle(props: {
  label: string;
  hint: string;
  enabled: boolean;
  onChange: (v: boolean) => void;
  disabled: boolean;
  testId: string;
}) {
  return (
    <div className="notif-setting-row">
      <label className="notif-setting-label">
        {props.label}
        <span className="notif-setting-hint">{props.hint}</span>
      </label>
      <button
        type="button"
        className={`notif-toggle ${props.enabled ? "notif-toggle-on" : ""}`}
        onClick={() => props.onChange(!props.enabled)}
        disabled={props.disabled}
        data-testid={props.testId}
        role="switch"
        aria-checked={props.enabled}
        aria-label={`${props.label} ${props.enabled ? "enabled" : "disabled"}`}
      >
        <span className="notif-toggle-knob" />
      </button>
    </div>
  );
}

function formatHour(h: number): string {
  const hour12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  const period = h < 12 ? "am" : "pm";
  return `${hour12}:00 ${period}`;
}
