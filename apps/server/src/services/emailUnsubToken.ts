/**
 * HMAC-signed unsubscribe tokens for marketing email.
 *
 * Signed, self-contained tokens mean we don't have to pre-insert a row per
 * outbound email just to back an unsubscribe link. A token carries
 * { userId, type, issuedAt } and an HMAC-SHA256 over those fields using
 * `config.emailUnsubSecret`. `verifyUnsubToken` enforces a TTL (default
 * 90 days) and constant-time comparison, so tokens survive DB wipes /
 * migrations and cannot be forged without the secret.
 *
 * Tokens are the mechanism behind RFC 8058 one-click unsubscribe
 * (List-Unsubscribe + List-Unsubscribe-Post headers) as well as the
 * plain "click to unsubscribe" link in the email footer.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "../config";

/** Default TTL: 90 days. Long enough that a saved email remains actionable
 *  but bounded so a leaked token does not unsubscribe someone indefinitely. */
const TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000;

export interface UnsubTokenPayload {
  userId: string;
  /** Specific email type to unsubscribe from, or "all" for master opt-out. */
  type: string;
}

interface SignedTokenData extends UnsubTokenPayload {
  /** Unix ms at issuance. */
  iat: number;
}

/** Base64url (no padding, URL-safe) encode/decode helpers. */
function b64urlEncode(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function b64urlDecode(s: string): Buffer {
  const pad = s.length % 4 === 0 ? 0 : 4 - (s.length % 4);
  const padded = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat(pad);
  return Buffer.from(padded, "base64");
}

function getSecret(): string {
  // Dev fallback only. In production, refuse to sign or verify tokens without
  // a configured secret — the dev literal is public in this repo, so falling
  // back to it would make every unsubscribe link forgeable by anyone who can
  // read the source.
  if (!config.emailUnsubSecret) {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "EMAIL_UNSUB_SECRET is not set; refusing to sign/verify unsubscribe tokens in production.",
      );
    }
    return "dev-email-unsub-secret-do-not-ship";
  }
  return config.emailUnsubSecret;
}

/**
 * Sign an unsubscribe token. The returned string is safe to include in
 * URLs as-is.
 *
 * @param payload - The userId and type the token authorizes.
 * @returns Opaque token string: `<b64url(payload)>.<b64url(hmac)>`.
 */
export function signUnsubToken(payload: UnsubTokenPayload): string {
  const data: SignedTokenData = { ...payload, iat: Date.now() };
  const body = b64urlEncode(Buffer.from(JSON.stringify(data), "utf8"));
  const mac = createHmac("sha256", getSecret()).update(body).digest();
  return `${body}.${b64urlEncode(mac)}`;
}

/**
 * Verify an unsubscribe token and return its payload if valid.
 *
 * @param token - Token produced by `signUnsubToken`.
 * @returns Parsed payload, or `null` if the token is malformed, has an
 *   invalid signature, or has expired.
 */
export function verifyUnsubToken(token: string): UnsubTokenPayload | null {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [body, mac] = parts;
  if (!body || !mac) return null;

  // Compare HMACs in constant time to avoid timing side-channels.
  const expected = createHmac("sha256", getSecret()).update(body).digest();
  let provided: Buffer;
  try {
    provided = b64urlDecode(mac);
  } catch {
    return null;
  }
  if (provided.length !== expected.length) return null;
  if (!timingSafeEqual(provided, expected)) return null;

  let parsed: SignedTokenData;
  try {
    parsed = JSON.parse(b64urlDecode(body).toString("utf8")) as SignedTokenData;
  } catch {
    return null;
  }

  if (
    typeof parsed.userId !== "string" ||
    typeof parsed.type !== "string" ||
    typeof parsed.iat !== "number"
  ) {
    return null;
  }

  if (Date.now() - parsed.iat > TOKEN_TTL_MS) return null;

  return { userId: parsed.userId, type: parsed.type };
}

/**
 * Build an absolute unsubscribe URL for inclusion in email bodies.
 *
 * @param userId - Target user.
 * @param type - Either a specific EmailNotificationType or "all".
 * @returns Absolute URL rooted at `config.appUrl`.
 */
export function buildUnsubscribeUrl(userId: string, type: string): string {
  const token = signUnsubToken({ userId, type });
  const base = config.appUrl.replace(/\/$/, "");
  return `${base}/api/email/unsubscribe?token=${encodeURIComponent(token)}`;
}
