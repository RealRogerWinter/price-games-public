/**
 * Server-side UTM attribution storage.
 *
 * Accepts attribution payloads captured client-side (see
 * apps/web/src/utils/attribution.ts) and stores them on the users row.
 *
 * Enforces first-touch-wins via a SQL `utm_source IS NULL` guard so that
 * concurrent or late-arriving attribution posts cannot overwrite the
 * original signup source.
 */

import type { Database as DatabaseType } from "better-sqlite3";
import {
  claimVisitorAttribution,
  getVisitorAttribution,
} from "./visitorAttribution";

/** Attribution fields accepted from the client. */
export interface Attribution {
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  utm_content?: string;
  utm_term?: string;
  landing_page?: string;
  referrer?: string;
}

/** Recognized keys accepted from the client payload. Anything else is dropped. */
const ATTRIBUTION_KEYS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_content",
  "utm_term",
  "landing_page",
  "referrer",
] as const;

type AttributionKey = (typeof ATTRIBUTION_KEYS)[number];

const MAX_VALUE_LENGTH = 128;

/**
 * How long after signup the /attribute-signup endpoint is willing to write
 * attribution data. Prevents late-arriving UTM posts from clobbering clean
 * signups and limits the abuse surface.
 */
export const ATTRIBUTION_WINDOW_MINUTES = 10;

/**
 * Validate and sanitize an attribution payload from the client.
 *
 * @param input - Arbitrary value from a request body.
 * @returns A sanitized Attribution object, or null if nothing recognisable
 *          was provided. Unknown keys, non-string values, and empty strings
 *          are dropped. String values are clamped to 128 chars.
 *
 *          **utm_source is required**: payloads without a non-empty
 *          `utm_source` return null. This upholds the first-touch-wins
 *          invariant enforced by the SQL guard in storeSignupAttribution,
 *          which uses `utm_source IS NULL` as its sentinel — a partial
 *          payload without utm_source would leave the column NULL after
 *          the write and defeat the guard on the next call.
 */
export function validateAttribution(input: unknown): Attribution | null {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return null;
  }

  const result: Attribution = {};

  for (const key of ATTRIBUTION_KEYS) {
    // Use Object.prototype.hasOwnProperty to sidestep prototype-pollution tricks
    // on the incoming payload (e.g. `__proto__` keys).
    if (!Object.prototype.hasOwnProperty.call(input, key)) continue;

    const raw = (input as Record<string, unknown>)[key];
    if (typeof raw !== "string" || raw.length === 0) continue;

    const clamped =
      raw.length > MAX_VALUE_LENGTH ? raw.slice(0, MAX_VALUE_LENGTH) : raw;
    (result as Record<AttributionKey, string>)[key] = clamped;
  }

  // utm_source is mandatory — see doc comment above.
  if (!result.utm_source) return null;

  return result;
}

/**
 * Write attribution onto the users row. First-touch wins: the SQL
 * `utm_source IS NULL` guard ensures the row is only updated if no
 * attribution has been written yet.
 *
 * @param db - Database connection.
 * @param userId - User to attribute.
 * @param attribution - Sanitized attribution payload (or null for a no-op).
 * @returns true if the row was updated, false if no-op.
 */
export function storeSignupAttribution(
  db: DatabaseType,
  userId: string,
  attribution: Attribution | null,
): boolean {
  if (attribution === null) return false;
  // Defense in depth: enforce the utm_source invariant at the storage layer
  // too, so a caller that bypasses validateAttribution cannot leave the row
  // in a state that defeats the SQL first-touch guard.
  if (!attribution.utm_source) return false;

  const result = db
    .prepare(
      `UPDATE users
         SET utm_source      = ?,
             utm_medium      = ?,
             utm_campaign    = ?,
             utm_content     = ?,
             utm_term        = ?,
             landing_page    = ?,
             signup_referrer = ?
       WHERE id = ?
         AND utm_source IS NULL`,
    )
    .run(
      attribution.utm_source ?? null,
      attribution.utm_medium ?? null,
      attribution.utm_campaign ?? null,
      attribution.utm_content ?? null,
      attribution.utm_term ?? null,
      attribution.landing_page ?? null,
      attribution.referrer ?? null,
      userId,
    );

  return result.changes > 0;
}

/**
 * Merge a visitor_attribution row into a freshly-created user. Called from
 * the signup handlers (both /register and /attribute-signup) to promote
 * pre-signup anonymous attribution — the UTM tuple captured when the
 * visitor first arrived — onto their users row, and to mark the visitor
 * row as claimed so it is no longer counted as "unclaimed" in funnels.
 *
 * First-touch semantics are preserved: the users row is only written
 * when its utm_source is still NULL (same guard as storeSignupAttribution).
 * Claiming is idempotent — calling this twice with the same user is safe.
 *
 * @param db - Database instance.
 * @param userId - Freshly created user id to merge onto.
 * @param visitorId - Visitor UUID from the visitor_id cookie, or
 *   null/undefined if the request carried no cookie.
 * @returns true if the user row was updated with visitor attribution,
 *   false if no merge happened (no visitor row, already-attributed user,
 *   or claim refused).
 */
export function mergeVisitorAttributionIntoUser(
  db: DatabaseType,
  userId: string,
  visitorId: string | null | undefined,
): boolean {
  if (!visitorId) return false;

  // Peek at the row first so we can decide whether merging is worth
  // claiming the visitor at all. A visitor without a utm_source is
  // impossible per the NOT NULL schema, but we still guard here for
  // defense in depth.
  const visitor = getVisitorAttribution(db, visitorId);
  if (!visitor || !visitor.utmSource) return false;

  // Claim unconditionally (even if we won't overwrite the users row),
  // so the visitor is no longer double-counted as "unclaimed" in the
  // admin funnel.
  claimVisitorAttribution(db, visitorId, userId);

  // Synthesize an Attribution-shaped payload and reuse storeSignupAttribution
  // so the `utm_source IS NULL` guard + column list stay centralised.
  const attribution: Attribution = {
    utm_source: visitor.utmSource,
    utm_medium: visitor.utmMedium ?? undefined,
    utm_campaign: visitor.utmCampaign ?? undefined,
    utm_content: visitor.utmContent ?? undefined,
    utm_term: visitor.utmTerm ?? undefined,
    landing_page: visitor.landingPage ?? undefined,
    referrer: visitor.referrer ?? undefined,
  };

  return storeSignupAttribution(db, userId, attribution);
}

/**
 * Check whether a user is eligible to be attributed via the
 * /attribute-signup endpoint: they must exist, have no existing
 * attribution, and have been created within the attribution window.
 *
 * @param db - Database connection.
 * @param userId - User to check.
 * @returns true if the user can still be attributed.
 */
export function hasRecentSignupWithoutAttribution(
  db: DatabaseType,
  userId: string,
): boolean {
  const row = db
    .prepare("SELECT created_at, utm_source FROM users WHERE id = ?")
    .get(userId) as { created_at: string; utm_source: string | null } | undefined;

  if (!row) return false;
  if (row.utm_source !== null) return false;

  const createdAt = Date.parse(row.created_at);
  if (Number.isNaN(createdAt)) return false;

  const ageMs = Date.now() - createdAt;
  return ageMs <= ATTRIBUTION_WINDOW_MINUTES * 60 * 1000;
}
