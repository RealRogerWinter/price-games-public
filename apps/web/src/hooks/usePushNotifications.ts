/**
 * React hook for managing push notification subscriptions.
 *
 * Handles service worker registration, permission requests, subscription
 * creation/removal, and syncing with the server. Designed to be used in
 * the NotificationPrompt component and SettingsPage preferences section.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { getVapidKey, subscribePush, unsubscribePush } from "../api/pushClient";

/** Convert a URL-safe base64 string to a Uint8Array (needed for applicationServerKey). */
function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

// Module-level VAPID key cache
let cachedVapidKey: string | null = null;

export interface UsePushNotificationsResult {
  /** Whether the browser supports push notifications. */
  isSupported: boolean;
  /** Current Notification permission state. */
  permission: NotificationPermission | "unsupported";
  /** Whether the current browser has an active push subscription. */
  isSubscribed: boolean;
  /** Request permission and create a push subscription. */
  subscribe: () => Promise<boolean>;
  /** Remove the current push subscription. */
  unsubscribe: () => Promise<void>;
  /** Whether an async operation is in progress. */
  loading: boolean;
  /** Error message from the last failed operation. */
  error: string | null;
}

/**
 * Hook for managing web push notification subscriptions.
 *
 * @returns Push notification state and control functions
 */
export function usePushNotifications(): UsePushNotificationsResult {
  const isSupported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

  const [permission, setPermission] = useState<NotificationPermission | "unsupported">(
    isSupported ? Notification.permission : "unsupported",
  );
  const [isSubscribed, setIsSubscribed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const registrationRef = useRef<ServiceWorkerRegistration | null>(null);

  // Register service worker and check existing subscription on mount
  useEffect(() => {
    if (!isSupported) return;

    let cancelled = false;

    async function init() {
      try {
        const registration = await navigator.serviceWorker.register("/sw.js");
        if (cancelled) return;
        registrationRef.current = registration;

        const existingSub = await registration.pushManager.getSubscription();
        if (cancelled) return;

        if (existingSub) {
          setIsSubscribed(true);
          // Silently re-sync subscription with server (handles endpoint rotation)
          try {
            const subJson = existingSub.toJSON();
            if (subJson.endpoint && subJson.keys) {
              await subscribePush({
                endpoint: subJson.endpoint,
                expirationTime: subJson.expirationTime ?? null,
                keys: subJson.keys as { p256dh: string; auth: string },
              });
            }
          } catch {
            // Non-critical — subscription is still valid locally
          }
        }
      } catch {
        // Service worker registration failed — push not available
      }
    }

    init();
    return () => { cancelled = true; };
  }, [isSupported]);

  const subscribe = useCallback(async (): Promise<boolean> => {
    if (!isSupported) return false;
    setLoading(true);
    setError(null);

    try {
      // Get VAPID key
      if (!cachedVapidKey) {
        const { vapidPublicKey } = await getVapidKey();
        cachedVapidKey = vapidPublicKey;
      }

      // Ensure service worker is registered
      let registration = registrationRef.current;
      if (!registration) {
        registration = await navigator.serviceWorker.register("/sw.js");
        registrationRef.current = registration;
      }

      // Wait for the service worker to be ready
      await navigator.serviceWorker.ready;

      // Request notification permission
      const result = await Notification.requestPermission();
      setPermission(result);

      if (result !== "granted") {
        setError("Notification permission denied");
        return false;
      }

      // Create push subscription
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(cachedVapidKey) as BufferSource,
      });

      // Send to server
      const subJson = subscription.toJSON();
      await subscribePush({
        endpoint: subJson.endpoint!,
        expirationTime: subJson.expirationTime ?? null,
        keys: subJson.keys as { p256dh: string; auth: string },
      });

      setIsSubscribed(true);
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to subscribe";
      setError(msg);
      return false;
    } finally {
      setLoading(false);
    }
  }, [isSupported]);

  const unsubscribeHandler = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const registration = registrationRef.current;
      if (!registration) return;

      const subscription = await registration.pushManager.getSubscription();
      if (subscription) {
        const endpoint = subscription.endpoint;
        await subscription.unsubscribe();
        await unsubscribePush(endpoint);
      }

      setIsSubscribed(false);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to unsubscribe";
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, []);

  return {
    isSupported,
    permission,
    isSubscribed,
    subscribe,
    unsubscribe: unsubscribeHandler,
    loading,
    error,
  };
}
