/**
 * User-facing email preferences API client.
 *
 * The server routes are mounted at /api/email and require an authenticated
 * user session. Preferences default to all-off (email is strictly opt-in);
 * the backend returns those defaults for users without a row.
 */

import type { EmailPreferences } from "@price-game/shared";

const BASE = "/api/email";

async function emailRequest<T>(url: string, options?: RequestInit): Promise<T> {
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

/** Get the current user's email preferences. */
export function getEmailPreferences(): Promise<EmailPreferences> {
  return emailRequest("/preferences");
}

/** Update the current user's email preferences; returns the new snapshot. */
export function updateEmailPreferences(
  prefs: Partial<EmailPreferences>,
): Promise<EmailPreferences> {
  return emailRequest("/preferences", {
    method: "PUT",
    body: JSON.stringify(prefs),
  });
}
