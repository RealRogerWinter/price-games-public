/**
 * Cloudflare Turnstile verification service.
 *
 * Validates Turnstile tokens server-side by calling the Cloudflare siteverify
 * endpoint. Skips verification when the secret key is not configured (dev/test).
 */

import { config } from "../config";

interface TurnstileResponse {
  success: boolean;
  "error-codes"?: string[];
}

/**
 * Whether the Turnstile challenge is enforced on this server.
 *
 * False when `SKIP_TURNSTILE=1` (sandbox/dev escape hatch) or when no secret
 * key is configured. The web reads this via `/api/auth-config` to decide
 * whether to render the widget at all.
 */
export function isTurnstileEnabled(): boolean {
  if (process.env.SKIP_TURNSTILE === "1") return false;
  return !!config.turnstileSecretKey;
}

/**
 * Verify a Cloudflare Turnstile token.
 *
 * @param token - The Turnstile response token from the client.
 * @param ip - The client's IP address.
 * @returns true if the token is valid, false otherwise.
 */
export async function verifyTurnstileToken(
  token: string,
  ip: string,
): Promise<boolean> {
  // Skip verification when the sandbox/dev flag is set or no secret is configured.
  if (!isTurnstileEnabled()) {
    return true;
  }

  try {
    const res = await fetch(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          secret: config.turnstileSecretKey,
          response: token,
          remoteip: ip,
        }),
      },
    );

    if (!res.ok) return false;

    const data = (await res.json()) as TurnstileResponse;
    return data.success === true;
  } catch {
    return false;
  }
}
