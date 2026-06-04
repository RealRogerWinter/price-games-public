/**
 * iOS "Add to Home Screen" install prompt.
 *
 * Push notifications on iOS Safari require the PWA to be installed on the
 * Home Screen. This component detects iOS Safari in non-standalone mode and
 * shows a guided prompt explaining how to install.
 *
 * Uses a 30-day dismissal cooldown via localStorage.
 */

import { useState, useEffect } from "react";
import { useUserAuth } from "../context/UserAuthContext";
import { useBroadcastMode } from "../broadcast/useBroadcastMode";

const DISMISS_KEY = "ios_install_dismissed_at";
const DISMISS_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/** Detect iOS Safari in browser mode (not installed as PWA). */
function isIOSSafariBrowser(): boolean {
  const ua = navigator.userAgent;
  const isIOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const isSafari = /Safari/.test(ua) && !/CriOS|FxiOS|OPiOS|EdgiOS/.test(ua);
  const isStandalone = ("standalone" in navigator) && (navigator as { standalone?: boolean }).standalone === true;
  return isIOS && isSafari && !isStandalone;
}

function shouldShow(isAuthenticated: boolean): boolean {
  if (!isAuthenticated || !isIOSSafariBrowser()) return false;

  const dismissedAt = localStorage.getItem(DISMISS_KEY);
  if (dismissedAt) {
    const elapsed = Date.now() - parseInt(dismissedAt, 10);
    if (elapsed < DISMISS_COOLDOWN_MS) return false;
  }
  return true;
}

/**
 * Guided iOS install prompt component.
 * Renders nothing on non-iOS or when already installed as PWA.
 */
export default function IOSInstallPrompt() {
  const broadcast = useBroadcastMode();
  const { isAuthenticated } = useUserAuth();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    setVisible(shouldShow(isAuthenticated));
  }, [isAuthenticated]);

  if (broadcast || !visible) return null;

  function handleDismiss() {
    localStorage.setItem(DISMISS_KEY, String(Date.now()));
    setVisible(false);
  }

  return (
    <div className="ios-install-overlay" data-testid="ios-install-prompt">
      <div className="ios-install-dialog">
        <h3 className="ios-install-title">Install Price Games</h3>
        <p className="ios-install-body">
          Install Price Games on your Home Screen to enable push notifications
          and get the full app experience.
        </p>
        <ol className="ios-install-steps">
          <li>
            Tap the <strong>Share</strong> button{" "}
            <span className="ios-install-icon" aria-label="share icon">
              &#x2B06;&#xFE0F;
            </span>{" "}
            in the toolbar below
          </li>
          <li>
            Scroll down and tap <strong>"Add to Home Screen"</strong>
          </li>
          <li>
            Tap <strong>"Add"</strong> to confirm
          </li>
        </ol>
        <button
          className="ios-install-dismiss"
          onClick={handleDismiss}
          data-testid="ios-install-dismiss"
        >
          Maybe Later
        </button>
      </div>
    </div>
  );
}
