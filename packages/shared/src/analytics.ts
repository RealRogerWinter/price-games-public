/**
 * Analytics event taxonomy — shared across client and server.
 *
 * Event names follow `object_action` in past tense, snake_case. This is the
 * Segment / Amplitude industry convention; it keeps queries and dashboards
 * unambiguous (events record something that already happened, not intent).
 *
 * Categories are a coarse grouping used for filtering; they are NEVER shown
 * in dashboards as a primary axis.
 */

/** Coarse category used for filtering and ingest routing. */
export type AnalyticsEventCategory =
  | "page"
  | "game"
  | "auth"
  | "mp"
  | "system"
  | "custom";

/**
 * Canonical list of built-in event names. The client and server-side emitters
 * use these as string literals; arbitrary strings are allowed but discouraged.
 *
 * Keep this list in sync with the server-side emitters and with any docs in
 * `docs/ANALYTICS.md`.
 */
export const ANALYTICS_EVENTS = {
  // Page / session
  PAGE_VIEWED: "page_viewed",
  SESSION_STARTED: "session_started",
  SESSION_ENDED: "session_ended",

  // Game lifecycle (single-player)
  GAME_STARTED: "game_started",
  GAME_ROUND_SUBMITTED: "game_round_submitted",
  GAME_COMPLETED: "game_completed",
  GAME_ABANDONED: "game_abandoned",

  // Daily challenge
  DAILY_STARTED: "daily_started",
  DAILY_COMPLETED: "daily_completed",
  DAILY_SHARED: "daily_shared",

  // Multiplayer lifecycle
  MP_ROOM_CREATED: "mp_room_created",
  MP_ROOM_JOINED: "mp_room_joined",
  MP_ROOM_LEFT: "mp_room_left",
  MP_GAME_STARTED: "mp_game_started",
  MP_GAME_COMPLETED: "mp_game_completed",

  // Auth
  USER_SIGNED_UP: "user_signed_up",
  USER_LOGGED_IN: "user_logged_in",
  USER_LOGGED_OUT: "user_logged_out",

  // Rewards / engagement
  REWARD_EARNED: "reward_earned",
  REWARD_CLAIMED: "reward_claimed",
  SHARE_CLICKED: "share_clicked",
  LEADERBOARD_VIEWED: "leaderboard_viewed",
  PROFILE_VIEWED: "profile_viewed",
  SETTINGS_CHANGED: "settings_changed",
  NOTIFICATION_PERMISSION_GRANTED: "notification_permission_granted",
  NOTIFICATION_PERMISSION_DENIED: "notification_permission_denied",

  // Attribution / acquisition (integrates with visitor_attribution + utm_tags + referrals)
  UTM_CAPTURED: "utm_captured",
  UTM_SHORT_LINK_REDIRECTED: "utm_short_link_redirected",
  REFERRAL_CLICKED: "referral_clicked",
  REFERRAL_SIGNED_UP: "referral_signed_up",

  // System / quality
  ERROR_SHOWN: "error_shown",
  PERFORMANCE_METRIC_REPORTED: "performance_metric_reported",
  FEATURE_FLAG_EXPOSED: "feature_flag_exposed",
  BUFFER_OVERFLOWED: "buffer_overflowed",
} as const;

export type AnalyticsEventName =
  (typeof ANALYTICS_EVENTS)[keyof typeof ANALYTICS_EVENTS];

/**
 * How a player ended up in a multiplayer room. Recorded on the `mp_players`
 * row at insert time and threaded through the `mp_room_joined` /
 * `mp_room_created` event properties so analytics can break down room
 * arrivals by acquisition path.
 *
 * - `share_link`: landed via a `/<roomCode>` URL (someone shared it).
 * - `browser`: joined from the public lobby browser listing.
 * - `quickplay`: server-routed via `POST /api/mp/quickplay`.
 * - `create`: created the room (host's own arrival path).
 *
 * Set once at creation/join; rejoin/reconnect does not overwrite it.
 */
export type JoinSource = "share_link" | "browser" | "quickplay" | "create";

/** Canonical {@link JoinSource} values, runtime-iterable. */
export const JOIN_SOURCES: readonly JoinSource[] = [
  "share_link",
  "browser",
  "quickplay",
  "create",
] as const;

/**
 * Narrow an unknown value to a {@link JoinSource}, returning null if it
 * isn't one of the canonical strings. Use this at boundaries that accept
 * join_source from untrusted input (socket payloads, REST bodies).
 */
export function asJoinSource(value: unknown): JoinSource | null {
  return typeof value === "string" &&
    (JOIN_SOURCES as readonly string[]).includes(value)
    ? (value as JoinSource)
    : null;
}

/**
 * Where a play started from. Unified across single-player and multiplayer:
 *   - `homepage`: SP — clicked "Play" / mode tile on the landing page.
 *   - `game-browser`: SP — picked a mode from the dedicated game-browser
 *     route, or MP — joined a room from the public lobby browser.
 *   - `quickplay`: MP — entered via Quick Play matchmaking.
 *   - `room-creation`: MP — created the room (host's own start path).
 *   - `mp-invite`: MP — joined via a `/<roomCode>` share link.
 *
 * Recorded into `properties.start_source` on `game_started` /
 * `mp_game_started` events so the dashboard can break down where games
 * are originating without needing to disambiguate SP vs MP.
 */
export type StartSource =
  | "homepage"
  | "game-browser"
  | "quickplay"
  | "room-creation"
  | "mp-invite";

/** Canonical {@link StartSource} values, runtime-iterable. */
export const START_SOURCES: readonly StartSource[] = [
  "homepage",
  "game-browser",
  "quickplay",
  "room-creation",
  "mp-invite",
] as const;

/**
 * Narrow an unknown value to a {@link StartSource}. Returns null if not
 * one of the canonical buckets — callers should treat null as "unknown
 * source" and emit the event without the property rather than guessing.
 */
export function asStartSource(value: unknown): StartSource | null {
  return typeof value === "string" &&
    (START_SOURCES as readonly string[]).includes(value)
    ? (value as StartSource)
    : null;
}

/**
 * Map a multiplayer {@link JoinSource} to its canonical {@link StartSource}
 * label. The two taxonomies overlap but use different names for historical
 * reasons (`join_source` on `mp_players` predates the unified `start_source`
 * scheme); this keeps every MP arrival round-trip-safe to the new bucket.
 */
export function joinSourceToStartSource(joinSource: JoinSource): StartSource {
  switch (joinSource) {
    case "share_link":
      return "mp-invite";
    case "browser":
      return "game-browser";
    case "quickplay":
      return "quickplay";
    case "create":
      return "room-creation";
  }
}

/** Payload accepted by the public client-side `useTrackEvent()` hook. */
export interface TrackPayload {
  /** Canonical event name — prefer ANALYTICS_EVENTS.* constants. */
  name: string;
  /** Coarse category; defaults to "custom" if omitted. */
  category?: AnalyticsEventCategory;
  /** Arbitrary properties. Serialized JSON must stay under PROPS_MAX_BYTES. */
  properties?: Record<string, string | number | boolean | null>;
}

/** Max size of a single event's serialized `properties` payload, in bytes. */
export const PROPS_MAX_BYTES = 2048;

/** Max events per client beacon batch (to stay well under the 64 KB sendBeacon cap). */
export const BEACON_MAX_EVENTS = 40;

/** Envelope the client posts to `POST /api/events/track`. */
export interface BeaconEnvelope {
  /** Client-reported wall-clock ms when the envelope was sent. */
  sentAt: number;
  /** Tab-scoped UUID; lets the server fold same-tab events into the same session. */
  tabId: string;
  /** Individual events, each with a monotonic seq within the tab. */
  events: Array<{
    name: string;
    category?: AnalyticsEventCategory;
    properties?: Record<string, string | number | boolean | null>;
    /** Page path at event time. */
    path: string;
    /** Client-reported ms timestamp. */
    ts: number;
    /** Monotonic sequence within this tab. */
    seq: number;
    /** UUIDv4 for server-side deduplication against retries. */
    clientEventId: string;
  }>;
}

/**
 * Regex for detecting obvious bots by User-Agent. Not exhaustive — pair with
 * per-visitor rate heuristics for better coverage.
 *
 * Deliberately case-insensitive and anchored to substring matches so that
 * vendor-prefixed UAs (e.g. `Mozilla/5.0 (compatible; Googlebot/2.1; ...)`)
 * still trip the regex.
 */
export const BOT_UA_REGEX =
  /bot|crawler|spider|curl|wget|headlesschrome|headless|preview|unfurl|slackbot|facebookexternalhit|twitterbot|linkedinbot|whatsapp|telegrambot|discordbot|gptbot|claudebot|chatgpt|perplexitybot|bytespider|applebot|bingbot|duckduckbot|yandexbot|baiduspider|ahrefsbot|semrushbot|mj12bot/i;

// === Statistical helpers ===

/**
 * z-score for a 95% two-sided confidence interval (1.959963984540054 ≈ 1.96).
 * Pulled out as a named constant so callers don't sprinkle magic numbers and
 * so changing to a different confidence level is a one-line edit.
 */
export const WILSON_Z_95 = 1.959963984540054;

/**
 * Wilson 95% confidence interval for a binomial proportion.
 *
 * Wilson is the right tool at small N — Clopper-Pearson over-covers, the
 * normal approximation degenerates to width 0 when k=0 or k=n, and Bayesian
 * Beta(1,1) gives nearly identical bounds with more setup. We use Wilson
 * everywhere a conversion rate is shown in the admin dashboard (display CI
 * and ranking-by-lower-bound for tag comparisons).
 */
export interface WilsonInterval {
  /** Point estimate k/n. NaN when n=0 (caller decides how to render). */
  point: number;
  /** Lower bound, 0..1 inclusive. 0 when n=0. */
  lo: number;
  /** Upper bound, 0..1 inclusive. 1 when n=0. */
  hi: number;
  /** (hi - lo) / 2 — used for "±x.xpp" inline labels. 0.5 when n=0. */
  halfWidth: number;
}

/**
 * Compute the Wilson 95% confidence interval for k successes in n trials.
 *
 * Stable for the small-N edge cases that break naive normal-approximation
 * intervals: k=0 and k=n give non-degenerate bounds (≠0 and ≠1), and n=0
 * returns the maximally-uninformative interval [0, 1] so callers don't
 * have to guard divide-by-zero. Negative or non-integer inputs fall back
 * to the n=0 case (defensive — math is undefined otherwise).
 *
 * Formula (z = 1.96 for 95%):
 *   denom  = 1 + z^2 / n
 *   center = (k/n + z^2 / (2n)) / denom
 *   half   = (z / denom) * sqrt( (k/n)(1 - k/n)/n + z^2/(4 n^2) )
 *   lo     = center - half
 *   hi     = center + half
 *
 * @param k - Successes (e.g. signups). Must be 0 ≤ k ≤ n.
 * @param n - Trials (e.g. sessions).
 * @returns WilsonInterval — see field docs.
 */
export function wilsonInterval(k: number, n: number): WilsonInterval {
  if (!Number.isFinite(k) || !Number.isFinite(n) || n <= 0 || k < 0 || k > n) {
    return { point: NaN, lo: 0, hi: 1, halfWidth: 0.5 };
  }
  const z = WILSON_Z_95;
  const z2 = z * z;
  // Use the textbook integer-form (Wikipedia Wilson_score_interval) so
  // numerator/denominator stay close to integer arithmetic and the
  // boundary cases k=0 and k=n produce lo=0 and hi=1 to within ULP error
  // (the multiplication-and-divide form would add a few ULPs of drift).
  const nz = n + z2;
  const center = (k + z2 / 2) / nz;
  const half = (z * Math.sqrt((k * (n - k)) / n + z2 / 4)) / nz;
  // Snap to [0, 1] to absorb the residual ULP drift; hard-snap k=0 → lo=0
  // and k=n → hi=1 so the documented contract holds bit-exactly.
  const lo = k === 0 ? 0 : Math.max(0, center - half);
  const hi = k === n ? 1 : Math.min(1, center + half);
  return { point: k / n, lo, hi, halfWidth: (hi - lo) / 2 };
}

/**
 * Decide whether two Wilson 95% CIs are non-overlapping — a conservative
 * proxy for "the two proportions are significantly different at the 5%
 * level." This is a stricter test than a two-proportion z-test (the
 * non-overlap criterion has Type-I error ~1% rather than 5%), but it is
 * trivially explainable to non-statisticians ("the bars don't touch") and
 * sufficient for the admin dashboard's "★ significantly different from
 * average" surfacing.
 *
 * @param a - First Wilson interval.
 * @param b - Second Wilson interval.
 * @returns "above" if a is entirely above b, "below" if entirely below,
 *   "overlap" otherwise.
 */
export function wilsonCompare(
  a: WilsonInterval,
  b: WilsonInterval,
): "above" | "below" | "overlap" {
  if (a.lo > b.hi) return "above";
  if (a.hi < b.lo) return "below";
  return "overlap";
}
