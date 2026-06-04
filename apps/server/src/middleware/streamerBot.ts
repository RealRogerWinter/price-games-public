/**
 * Streamer-bot detection middleware.
 *
 * The streamer-bot (`packages/bot-streamer`) drives a real Chromium browser
 * via Playwright and connects to the production server like any other client.
 * Without an explicit signal, it pollutes analytics counters (games started,
 * games completed, visitor attribution counts) because nothing on the wire
 * distinguishes it from a human player.
 *
 * To exclude it cleanly, the bot's Playwright context sets the
 * `X-Streamer-Bot` HTTP header to a shared secret on every request — both
 * regular HTTP and the Socket.IO WebSocket handshake. This middleware reads
 * the header and, if it matches `config.streamerBotSecret`, stamps
 * `req.isStreamerBot = true` so downstream record-event / record-history
 * paths can skip writing.
 *
 * Security:
 *  - Comparison is constant-time so the secret can't be guessed via timing.
 *  - When `STREAMER_BOT_SECRET` is unset (development), the middleware is a
 *    no-op — a missing or any-valued header is ignored. This matches the
 *    "fail closed" semantics: never accidentally exclude real-user data.
 */

import { Request, Response, NextFunction } from "express";
import { timingSafeEqual } from "crypto";
import { config } from "../config";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /**
       * True when the request carried a valid `X-Streamer-Bot` header
       * matching the configured shared secret. Analytics record paths
       * skip when set so the streamer-bot's traffic does not inflate
       * games-played counters.
       */
      isStreamerBot?: boolean;
    }
  }
}

/** HTTP header name (case-insensitive — Express lowercases on read). */
export const STREAMER_BOT_HEADER = "x-streamer-bot";

/**
 * Constant-time compare of an arbitrary user-supplied value against the
 * configured secret. Returns false when either side is empty so an unset
 * `STREAMER_BOT_SECRET` cannot be matched by sending an empty header.
 *
 * @param headerValue - The value of the `X-Streamer-Bot` header (or null).
 * @param secret - The configured secret to match against.
 * @returns True when both are non-empty and byte-for-byte equal.
 */
export function matchesStreamerBotSecret(
  headerValue: string | null | undefined,
  secret: string,
): boolean {
  if (!secret) return false;
  if (typeof headerValue !== "string" || headerValue.length === 0) return false;
  // `timingSafeEqual` requires equal-length buffers. Length-mismatch is a
  // trivial fast-fail; pad both sides to a fixed length before the compare
  // so the timing of the shortcut itself can't leak the secret length.
  const a = Buffer.from(headerValue);
  const b = Buffer.from(secret);
  if (a.length !== b.length) {
    // Compare against itself so the work happens in both branches.
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}

/**
 * Shared header-extraction helper used by both the Express middleware and
 * the Socket.IO handshake hook. Pulls the `X-Streamer-Bot` header from a
 * Node-style headers map (which may yield `string | string[] | undefined`
 * depending on the transport) and runs the constant-time secret compare.
 *
 * @param headers - The request/handshake headers (e.g. `req.headers` or
 *   `socket.handshake.headers`).
 * @param secret - The configured shared secret.
 * @returns True iff the header is present and matches the secret.
 */
export function detectStreamerBotFromHeaders(
  headers: Record<string, string | string[] | undefined>,
  secret: string,
): boolean {
  const raw = headers[STREAMER_BOT_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return matchesStreamerBotSecret(value ?? null, secret);
}

/**
 * Express middleware. Sets `req.isStreamerBot = true` when the request
 * carries a valid `X-Streamer-Bot` header. Never throws.
 */
export function streamerBotDetect(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  if (
    detectStreamerBotFromHeaders(
      req.headers as Record<string, string | string[] | undefined>,
      config.streamerBotSecret,
    )
  ) {
    req.isStreamerBot = true;
  }
  next();
}
