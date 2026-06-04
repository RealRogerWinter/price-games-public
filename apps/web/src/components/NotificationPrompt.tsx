/**
 * Soft-ask notification permission dialog.
 *
 * Shown after user engagement (e.g., completing a daily game or playing
 * 3+ single-player games). Uses a custom in-app dialog before triggering
 * the browser's native permission prompt, which yields significantly
 * higher opt-in rates (70-85% vs 40-60% for cold prompts).
 *
 * Respects a 7-day cooldown when the user clicks "Not Now".
 */

import { useState, useEffect } from "react";
import { useUserAuth } from "../context/UserAuthContext";
import { usePushNotifications } from "../hooks/usePushNotifications";
import { useBroadcastMode } from "../broadcast/useBroadcastMode";

const DISMISS_KEY = "notif_prompt_dismissed_at";
const DISMISS_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Determine whether the notification prompt should be shown.
 *
 * Conditions:
 * - User is authenticated
 * - Browser supports push notifications
 * - Permission is "default" (not yet granted or denied)
 * - Not dismissed within the last 7 days
 */
function shouldShowPrompt(
  isAuthenticated: boolean,
  isSupported: boolean,
  permission: string,
): boolean {
  if (!isAuthenticated || !isSupported || permission !== "default") return false;

  const dismissedAt = localStorage.getItem(DISMISS_KEY);
  if (dismissedAt) {
    const elapsed = Date.now() - parseInt(dismissedAt, 10);
    if (elapsed < DISMISS_COOLDOWN_MS) return false;
  }

  return true;
}

/**
 * Soft-ask dialog for push notification permission.
 * Renders nothing if the prompt should not be shown.
 */
export default function NotificationPrompt() {
  const broadcast = useBroadcastMode();
  const { isAuthenticated } = useUserAuth();
  const { isSupported, permission, isSubscribed, subscribe, loading } = usePushNotifications();
  const [visible, setVisible] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (isSubscribed || dismissed) {
      setVisible(false);
      return;
    }
    setVisible(shouldShowPrompt(isAuthenticated, isSupported, permission));
  }, [isAuthenticated, isSupported, permission, isSubscribed, dismissed]);

  if (broadcast || !visible) return null;

  async function handleEnable() {
    const success = await subscribe();
    if (success) {
      setVisible(false);
    }
  }

  function handleDismiss() {
    localStorage.setItem(DISMISS_KEY, String(Date.now()));
    setDismissed(true);
    setVisible(false);
  }

  return (
    <div className="notif-prompt-overlay" data-testid="notif-prompt">
      <div className="notif-prompt-dialog">
        <h3 className="notif-prompt-title">Stay in the game!</h3>
        <p className="notif-prompt-body">
          Get reminders when your streak is about to expire and when new daily
          puzzles drop. You can customize what you receive in your notification
          settings.
        </p>
        <div className="notif-prompt-actions">
          <button
            className="notif-prompt-btn notif-prompt-btn-primary"
            onClick={handleEnable}
            disabled={loading}
            data-testid="notif-prompt-enable"
          >
            {loading ? "Enabling..." : "Enable Notifications"}
          </button>
          <button
            className="notif-prompt-btn notif-prompt-btn-secondary"
            onClick={handleDismiss}
            data-testid="notif-prompt-dismiss"
          >
            Not Now
          </button>
        </div>
      </div>
    </div>
  );
}
