/**
 * Push notification API client.
 *
 * Provides typed functions for subscription management, preference CRUD,
 * and VAPID key retrieval.
 */

import type { NotificationPreferences, PushSubscriptionPayload } from "@price-game/shared";

const BASE = "/api/push";

/**
 * Sends a request to the push API.
 *
 * @param url - Endpoint path appended to /api/push
 * @param options - Optional fetch RequestInit overrides
 * @returns Parsed JSON response
 * @throws Error if the response is not ok
 */
async function pushRequest<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${url}`, {
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    ...options,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: "Request failed" }));
    throw new Error(body.error || `API error ${res.status}`);
  }
  return res.json();
}

/**
 * Fetch the server's VAPID public key.
 *
 * @returns Object containing the VAPID public key string
 */
export function getVapidKey(): Promise<{ vapidPublicKey: string }> {
  return pushRequest("/vapid-key");
}

/**
 * Save a push subscription to the server.
 *
 * @param subscription - Browser PushSubscription.toJSON() payload
 * @returns Success indicator
 */
export function subscribePush(subscription: PushSubscriptionPayload): Promise<{ ok: boolean }> {
  return pushRequest("/subscribe", {
    method: "POST",
    body: JSON.stringify(subscription),
  });
}

/**
 * Remove a push subscription from the server.
 *
 * @param endpoint - The subscription endpoint URL to remove
 * @returns Success indicator and whether a row was removed
 */
export function unsubscribePush(endpoint: string): Promise<{ ok: boolean; removed: boolean }> {
  return pushRequest("/unsubscribe", {
    method: "POST",
    body: JSON.stringify({ endpoint }),
  });
}

/**
 * Get the current user's notification preferences.
 *
 * @returns Notification preferences
 */
export function getNotifPreferences(): Promise<NotificationPreferences> {
  return pushRequest("/preferences");
}

/**
 * Update the current user's notification preferences.
 *
 * @param prefs - Partial preferences to update
 * @returns Updated preferences
 */
export function updateNotifPreferences(
  prefs: Partial<NotificationPreferences>,
): Promise<NotificationPreferences> {
  return pushRequest("/preferences", {
    method: "PUT",
    body: JSON.stringify(prefs),
  });
}
