/**
 * Analytics event log — the single ingest hot path for the unified
 * events / sessions / visitor_profile pipeline.
 *
 * All capture paths funnel here:
 *  - **A. server-side auto-capture** — middleware and service-function hooks
 *    call {@link recordEvent} directly after their DB writes.
 *  - **B. client beacon** — `POST /api/events/track` batches events into
 *    multiple calls to {@link recordEvent}.
 *  - **C. socket wrapper** — a thin wrapper coalesces socket connect/
 *    disconnect into one event per 60s window per socket.
 *
 * Ingest invariants:
 *  - Never throws. A failure in enrichment or DB write logs and returns.
 *  - Session assignment is serialized by an UPSERT on `visitor_profile`,
 *    so two near-simultaneous events for the same visitor never mint two
 *    sessions. Under the hood, SQLite serializes writes.
 *  - Events with `dnt=1` store a minimal row (visitor_id, ts, name, path)
 *    with UA/geo/properties/ip_hash stripped.
 *  - Dedup is enforced by `UNIQUE(visitor_id, client_event_id)` — retries
 *    from a flaky client beacon are silently absorbed.
 *  - First-touch UTM is NOT written here. Instead, when a landing page
 *    event carries UTM, we delegate to the existing
 *    {@link recordVisitorAttribution} pipeline so first-touch semantics
 *    stay centralised in one place.
 */

import { createHash, randomUUID } from "crypto";
import { UAParser } from "ua-parser-js";
import type { Database as DatabaseType } from "better-sqlite3";
import type { Request } from "express";
import db from "../db";
import { config } from "../config";
import { lookupGeo, getIp } from "./geo";
import { isBot } from "./botDetection";
import {
  ANALYTICS_EVENTS,
  type AnalyticsEventCategory,
  PROPS_MAX_BYTES,
} from "@price-game/shared";
import {
  recordVisitorAttribution,
  type VisitorAttribution,
} from "./visitorAttribution";
import type { Attribution } from "./attribution";

/** Parsed User-Agent fields used on events + sessions. */
interface ParsedUA {
  browser: string | null;
  os: string | null;
  deviceType: "desktop" | "mobile" | "tablet" | "unknown";
}

/** LRU-light cache for UA parse results. Same UA repeats across all events
 * in a session so caching is effectively free. Bounded to avoid a bad UA
 * flood OOMing the process. */
const UA_CACHE_MAX = 2000;
const uaCache = new Map<string, ParsedUA>();

function parseUserAgent(ua: string | null | undefined): ParsedUA {
  if (!ua) return { browser: null, os: null, deviceType: "unknown" };
  const cached = uaCache.get(ua);
  if (cached) return cached;

  const parsed = new UAParser(ua).getResult();
  const device = parsed.device?.type as string | undefined;
  const deviceType: ParsedUA["deviceType"] =
    device === "mobile"
      ? "mobile"
      : device === "tablet"
        ? "tablet"
        : device === "wearable" || device === "embedded" || device === "console" || device === "smarttv"
          ? "unknown"
          : "desktop";

  const result: ParsedUA = {
    browser: parsed.browser?.name ?? null,
    os: parsed.os?.name ?? null,
    deviceType,
  };

  // Very loose LRU: if over capacity, drop the oldest insertion.
  if (uaCache.size >= UA_CACHE_MAX) {
    const firstKey = uaCache.keys().next().value;
    if (firstKey !== undefined) uaCache.delete(firstKey);
  }
  uaCache.set(ua, result);
  return result;
}

/**
 * Strip PII-bearing query params from a URL. Keeps the path and safe
 * query params so that `?range=30d&mode=classic` remains analyzable,
 * while tokens/secrets/emails are dropped.
 *
 * @param url - Raw URL or path+query.
 * @returns Sanitized URL string.
 */
export function scrubUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  // Accept both absolute and relative URLs.
  let pathname: string;
  let search: URLSearchParams;
  try {
    const parsed = new URL(url, "http://placeholder.local");
    pathname = parsed.pathname;
    search = parsed.searchParams;
  } catch {
    return url.slice(0, 512);
  }

  const scrubbed = new URLSearchParams();
  for (const [key, value] of search) {
    // OAuth `code` and `state` are rotating session secrets; `phone`, `ssn`,
    // `dob` are direct PII. Scrub them alongside the token/auth family.
    if (/token|password|secret|key|email|jwt|auth|code|state|phone|ssn|dob/i.test(key)) continue;
    // Values that look like JWTs (3 base64 chunks joined by dots) are dropped.
    if (/^[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}$/.test(value)) continue;
    scrubbed.set(key, value);
  }

  const search_str = scrubbed.toString();
  const result = search_str ? `${pathname}?${search_str}` : pathname;
  return result.slice(0, 512);
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

const ACQUISITION_SOURCE_CLASSIFIER: Record<string, string> = {
  google: "organic",
  bing: "organic",
  duckduckgo: "organic",
  yahoo: "organic",
  facebook: "social",
  instagram: "social",
  twitter: "social",
  x: "social",
  tiktok: "social",
  youtube: "social",
  linkedin: "social",
  reddit: "social",
  pinterest: "social",
};

/**
 * Classify a UTM source into a coarse acquisition bucket used by rollups.
 *
 * @param utmSource - Raw utm_source value, or null.
 * @param utmMedium - Raw utm_medium value, or null.
 * @returns One of: "paid", "organic", "social", "email", "referral", "direct", "unknown".
 */
export function classifyAcquisition(
  utmSource: string | null | undefined,
  utmMedium: string | null | undefined,
): string {
  if (utmMedium) {
    const m = utmMedium.toLowerCase();
    if (m === "cpc" || m === "ppc" || m === "paid" || m === "paidsocial" || m === "display") return "paid";
    if (m === "email" || m === "newsletter") return "email";
    if (m === "referral") return "referral";
    if (m === "social") return "social";
    if (m === "organic") return "organic";
  }
  if (utmSource) {
    const s = utmSource.toLowerCase();
    const bucket = ACQUISITION_SOURCE_CLASSIFIER[s];
    if (bucket) return bucket;
    return "referral";
  }
  return "direct";
}

/** Input to {@link recordEvent}. Everything except `eventName` is optional. */
export interface RecordEventInput {
  eventName: string;
  eventType?: AnalyticsEventCategory;
  visitorId: string;
  userId?: string | null;
  path?: string | null;
  referrer?: string | null;
  /** Raw User-Agent string (from req.headers["user-agent"] or socket handshake). */
  userAgent?: string | null;
  /** Raw client IP — only used for hashing. Never stored verbatim. */
  ip?: string | null;
  /** CF-IPCountry header, if present; pre-resolved by the caller for performance. */
  country?: string | null;
  /** Region code, e.g. from CF-Region-Code. */
  region?: string | null;
  /** ts_client from browser beacon (ms epoch). */
  tsClient?: number | null;
  /** Tab UUID from client beacon. */
  tabId?: string | null;
  /** Monotonic sequence from client beacon. */
  seq?: number | null;
  /** UUID v4 from client for dedup. */
  clientEventId?: string | null;
  /** Respect DNT/GPC header. */
  dnt?: boolean;
  /** Arbitrary properties (JSON-serialized, capped at PROPS_MAX_BYTES). */
  properties?: Record<string, unknown> | null;
  /** Convenience fields for semantic indexing. */
  gameMode?: string | null;
  gameSessionId?: string | null;
  mpRoomCode?: string | null;
  /** UTM payload extracted from landing URL; if present, delegated to visitor_attribution. */
  attribution?: Attribution | null;
  /** Override the server timestamp (for tests). */
  nowMs?: number;
  /**
   * When true, the event originates from the streamer-bot client. The
   * record call short-circuits before any DB write so the bot's gameplay
   * does not bump games-played counters or insert event rows. Set by the
   * streamer-bot Express/Socket.IO middleware via `req.isStreamerBot` /
   * `socket.data.isStreamerBot` and forwarded by the helpers below.
   */
  isStreamerBot?: boolean;
}

interface VisitorProfileRow {
  current_session_id: string | null;
  current_session_started: number | null;
  total_sessions: number;
  total_events: number;
  first_seen_at: number;
  ever_played: number;
  dnt: number | null;
}

/**
 * Event names that count as a "game start" for `analytics_sessions.games_started`,
 * `visitor_profile.total_games_started`, and `visitor_profile.ever_played`.
 *
 * Single-player, multiplayer, and daily-challenge starts all roll up into the
 * same counter so that v2 analytics' `games_started` metric covers every form
 * of gameplay rather than only the SP path it was originally written for.
 */
const GAME_START_EVENTS: readonly string[] = [
  ANALYTICS_EVENTS.GAME_STARTED,
  ANALYTICS_EVENTS.MP_GAME_STARTED,
  ANALYTICS_EVENTS.DAILY_STARTED,
];

/**
 * Event names that count as a "game completion" for
 * `analytics_sessions.games_completed` and `visitor_profile.total_games_completed`.
 *
 * MP completion is emitted once per *real* player (bot- and ghost-filtered at
 * the call site), so a 4-real / 3-bot room produces 4 events that each bump
 * one player's counters by 1.
 *
 * `DAILY_COMPLETED` is intentionally *not* in this list. It is a semantic
 * marker emitted ALONGSIDE the underlying `GAME_COMPLETED` (SP daily) or
 * `MP_GAME_COMPLETED` (MP daily) so analytics can dimension by "daily
 * completions". Counting it here would double the headline KPI for every
 * daily play.
 */
const GAME_COMPLETE_EVENTS: readonly string[] = [
  ANALYTICS_EVENTS.GAME_COMPLETED,
  ANALYTICS_EVENTS.MP_GAME_COMPLETED,
];

/**
 * Record one event. Atomically decides session assignment, updates the
 * visitor profile, inserts the event row, and (when a new landing with
 * UTM is detected) delegates first-touch attribution to
 * {@link recordVisitorAttribution}.
 *
 * @param input - Event input (see {@link RecordEventInput}).
 * @param database - Optional database override (defaults to the main DB).
 * @returns The assigned `session_id` for the event, or null on failure.
 */
export function recordEvent(
  input: RecordEventInput,
  database: DatabaseType = db,
): string | null {
  // Streamer-bot exclusion: the bot's Playwright context sends a
  // `X-Streamer-Bot` header that Express/Socket.IO middleware
  // translates into this flag. Skipping at the ingest hot path drops
  // the event entirely (no events row, no visitor_profile counter
  // bump, no analytics_sessions update) so the bot's gameplay does
  // not show up as games-played in any downstream rollup.
  if (input.isStreamerBot) return null;
  try {
    return doRecord(input, database);
  } catch (err) {
    console.error("recordEvent failed:", err);
    return null;
  }
}

function doRecord(
  input: RecordEventInput,
  database: DatabaseType,
): string | null {
  const now = input.nowMs ?? Date.now();
  const visitorId = input.visitorId;
  if (!visitorId) return null;

  const bot = isBot(input.userAgent, visitorId, now) ? 1 : 0;
  const ua = parseUserAgent(input.userAgent);
  const ip = input.ip ?? null;
  const ipHash = ip ? sha256(ip + config.eventIpSalt) : null;

  const propertiesJson = serializeProperties(input.properties);
  const eventType: AnalyticsEventCategory = input.eventType ?? "custom";
  const scrubbedPath = scrubUrl(input.path);
  const scrubbedReferrer = scrubUrl(input.referrer);
  // Resolve effective DNT below from the visitor_profile RETURNING clause
  // so server-emitted events fired without request context (mpRoundEnd
  // round timer, etc.) still honor the visitor's previously-observed
  // DNT/GPC preference.
  const dntInputParam: number | null =
    input.dnt === undefined ? null : input.dnt ? 1 : 0;

  // --- 1. UPSERT visitor_profile. The CASE expressions decide atomically
  //        whether we mint a new session or reuse the current one.
  const candidateSessionId = randomUUID();
  const idleMs = config.sessionIdleMs;
  const activeIdleMs = config.sessionActiveGameIdleMs;
  const absCapMs = config.sessionAbsoluteCapMs;

  const profileRow = database
    .prepare(
      `INSERT INTO visitor_profile (
         visitor_id, first_seen_at, last_seen_at,
         current_session_id, current_session_started,
         total_sessions, total_events, total_page_views,
         total_games_started, total_games_completed,
         ever_registered, ever_played,
         user_id, first_country, first_device_type,
         is_bot, dnt
       ) VALUES (
         @vid, @now, @now,
         @cand, @now,
         1, 1, @incPageView,
         @incGameStart, @incGameComplete,
         @hasUser, @incGamePlay,
         @userId, @country, @deviceType,
         @bot, @dntIn
       )
       ON CONFLICT(visitor_id) DO UPDATE SET
         last_seen_at = @now,
         current_session_id = CASE
           WHEN visitor_profile.current_session_id IS NULL THEN @cand
           WHEN visitor_profile.ever_played = 1
                AND (@now - visitor_profile.last_seen_at) <= @activeIdle
                AND (@now - visitor_profile.current_session_started) <= @absCap
             THEN visitor_profile.current_session_id
           WHEN visitor_profile.ever_played = 0
                AND (@now - visitor_profile.last_seen_at) <= @idle
                AND (@now - visitor_profile.current_session_started) <= @absCap
             THEN visitor_profile.current_session_id
           ELSE @cand
         END,
         current_session_started = CASE
           WHEN visitor_profile.current_session_id IS NULL THEN @now
           WHEN visitor_profile.ever_played = 1
                AND (@now - visitor_profile.last_seen_at) <= @activeIdle
                AND (@now - visitor_profile.current_session_started) <= @absCap
             THEN visitor_profile.current_session_started
           WHEN visitor_profile.ever_played = 0
                AND (@now - visitor_profile.last_seen_at) <= @idle
                AND (@now - visitor_profile.current_session_started) <= @absCap
             THEN visitor_profile.current_session_started
           ELSE @now
         END,
         total_sessions = total_sessions + CASE
           WHEN visitor_profile.current_session_id IS NULL THEN 1
           WHEN visitor_profile.ever_played = 1
                AND (@now - visitor_profile.last_seen_at) <= @activeIdle
                AND (@now - visitor_profile.current_session_started) <= @absCap
             THEN 0
           WHEN visitor_profile.ever_played = 0
                AND (@now - visitor_profile.last_seen_at) <= @idle
                AND (@now - visitor_profile.current_session_started) <= @absCap
             THEN 0
           ELSE 1
         END,
         total_events = total_events + 1,
         total_page_views = total_page_views + @incPageView,
         total_games_started = total_games_started + @incGameStart,
         total_games_completed = total_games_completed + @incGameComplete,
         ever_registered = CASE WHEN @hasUser = 1 THEN 1 ELSE ever_registered END,
         ever_played = CASE WHEN @incGamePlay = 1 THEN 1 ELSE ever_played END,
         user_id = COALESCE(@userId, visitor_profile.user_id),
         is_bot = CASE WHEN @bot = 1 THEN 1 ELSE visitor_profile.is_bot END,
         dnt = COALESCE(@dntIn, visitor_profile.dnt)
       RETURNING current_session_id, current_session_started,
                 total_sessions, total_events,
                 first_seen_at, ever_played, dnt`,
    )
    .get({
      vid: visitorId,
      now,
      cand: candidateSessionId,
      incPageView: input.eventName === ANALYTICS_EVENTS.PAGE_VIEWED ? 1 : 0,
      incGameStart: GAME_START_EVENTS.includes(input.eventName) ? 1 : 0,
      incGameComplete: GAME_COMPLETE_EVENTS.includes(input.eventName) ? 1 : 0,
      incGamePlay: GAME_START_EVENTS.includes(input.eventName) ? 1 : 0,
      hasUser: input.userId ? 1 : 0,
      userId: input.userId ?? null,
      country: input.country ?? null,
      deviceType: ua.deviceType,
      bot,
      activeIdle: activeIdleMs,
      idle: idleMs,
      absCap: absCapMs,
      dntIn: dntInputParam,
    }) as VisitorProfileRow | undefined;

  if (!profileRow || !profileRow.current_session_id) return null;

  const sessionId = profileRow.current_session_id;
  const isNewSession = sessionId === candidateSessionId;
  const wasFirstEver = profileRow.total_events === 1;
  // Effective DNT for this event: explicit input wins; otherwise fall back
  // to the visitor's sticky preference returned from the UPSERT. Null/
  // unknown defaults to opt-in (0).
  const dntFlag = profileRow.dnt === 1 ? 1 : 0;

  // --- 2. UPSERT analytics_sessions. For a reused session we bump counters;
  //        for a new session we insert the entry context.
  const geoRec = {
    country: input.country ?? null,
    region: input.region ?? null,
  };

  database
    .prepare(
      `INSERT INTO analytics_sessions (
         id, visitor_id, user_id, started_at, last_event_at,
         event_count, page_view_count, games_started, games_completed,
         signup_occurred, login_occurred,
         entry_path, entry_referrer,
         entry_utm_source, entry_utm_medium, entry_utm_campaign,
         last_utm_source, exit_path,
         country, browser, os, device_type,
         is_returning, is_bot
       ) VALUES (
         @sid, @vid, @uid, @now, @now,
         1, @incPageView, @incGameStart, @incGameComplete,
         @incSignup, @incLogin,
         @path, @referrer,
         @utmSource, @utmMedium, @utmCampaign,
         @utmSource, @path,
         @country, @browser, @os, @deviceType,
         @returning, @bot
       )
       ON CONFLICT(id) DO UPDATE SET
         last_event_at = @now,
         event_count = event_count + 1,
         page_view_count = page_view_count + @incPageView,
         games_started = games_started + @incGameStart,
         games_completed = games_completed + @incGameComplete,
         signup_occurred = CASE WHEN @incSignup = 1 THEN 1 ELSE signup_occurred END,
         login_occurred = CASE WHEN @incLogin = 1 THEN 1 ELSE login_occurred END,
         user_id = COALESCE(analytics_sessions.user_id, @uid),
         last_utm_source = COALESCE(@utmSource, analytics_sessions.last_utm_source),
         exit_path = COALESCE(@path, analytics_sessions.exit_path)`,
    )
    .run({
      sid: sessionId,
      vid: visitorId,
      uid: input.userId ?? null,
      now,
      incPageView: input.eventName === ANALYTICS_EVENTS.PAGE_VIEWED ? 1 : 0,
      incGameStart: GAME_START_EVENTS.includes(input.eventName) ? 1 : 0,
      incGameComplete: GAME_COMPLETE_EVENTS.includes(input.eventName) ? 1 : 0,
      incSignup: input.eventName === ANALYTICS_EVENTS.USER_SIGNED_UP ? 1 : 0,
      incLogin: input.eventName === ANALYTICS_EVENTS.USER_LOGGED_IN ? 1 : 0,
      path: scrubbedPath,
      referrer: scrubbedReferrer,
      utmSource: input.attribution?.utm_source ?? null,
      utmMedium: input.attribution?.utm_medium ?? null,
      utmCampaign: input.attribution?.utm_campaign ?? null,
      country: geoRec.country,
      browser: ua.browser,
      os: ua.os,
      deviceType: ua.deviceType,
      returning: isNewSession && !wasFirstEver ? 1 : 0,
      bot,
    });

  // --- 3. Insert the event row. Uses INSERT OR IGNORE so a retried beacon
  //        with the same client_event_id is absorbed.
  database
    .prepare(
      `INSERT OR IGNORE INTO events (
         ts_server, ts_client, visitor_id, user_id, session_id,
         event_type, event_name, path, referrer,
         game_mode, game_session_id, mp_room_code,
         properties, country, region, browser, os, device_type,
         ua_hash, ip_hash, ip_salt_version,
         is_bot, client_event_id, tab_id, seq, dnt
       ) VALUES (
         @ts, @tsClient, @vid, @uid, @sid,
         @type, @name, @path, @referrer,
         @gameMode, @gameSessionId, @mpRoom,
         @properties, @country, @region, @browser, @os, @deviceType,
         @uaHash, @ipHash, @saltVer,
         @bot, @clientEventId, @tabId, @seq, @dnt
       )`,
    )
    .run({
      ts: now,
      tsClient: input.tsClient ?? null,
      vid: visitorId,
      uid: input.userId ?? null,
      sid: sessionId,
      type: eventType,
      name: input.eventName,
      path: scrubbedPath,
      referrer: dntFlag ? null : scrubbedReferrer,
      gameMode: input.gameMode ?? null,
      gameSessionId: input.gameSessionId ?? null,
      mpRoom: input.mpRoomCode ?? null,
      properties: dntFlag ? null : propertiesJson,
      country: dntFlag ? null : geoRec.country,
      region: dntFlag ? null : geoRec.region,
      browser: dntFlag ? null : ua.browser,
      os: dntFlag ? null : ua.os,
      // DNT/GPC: device_type is UA-derived, so strip it to match the
      // minimal-row promise in docs/ANALYTICS.md. Column is NOT NULL so
      // write the neutral sentinel 'unknown'.
      deviceType: dntFlag ? "unknown" : ua.deviceType,
      // Salt the UA hash like ip_hash so it can't be correlated across sites
      // from hash alone (defense in depth — UA strings are still low-entropy).
      uaHash: dntFlag || !input.userAgent ? null : sha256(input.userAgent + config.eventIpSalt),
      ipHash: dntFlag ? null : ipHash,
      saltVer: config.eventIpSaltVersion,
      bot,
      clientEventId: input.clientEventId ?? null,
      tabId: input.tabId ?? null,
      seq: input.seq ?? null,
      dnt: dntFlag,
    });

  // --- 4. Delegate first-touch UTM to existing pipeline. No duplication.
  //        If this is a fresh attribution row, fire a follow-up `utm_captured`
  //        event through the same ingest path so session counters (event_count,
  //        last_event_at) stay consistent with reality. The recursion guard
  //        on eventName prevents an infinite loop when the caller itself is
  //        `utm_captured`.
  if (
    input.attribution?.utm_source &&
    input.eventName !== ANALYTICS_EVENTS.UTM_CAPTURED
  ) {
    const inserted = recordVisitorAttribution(database, visitorId, input.attribution);
    if (inserted) {
      doRecord(
        {
          eventName: ANALYTICS_EVENTS.UTM_CAPTURED,
          eventType: "system",
          visitorId,
          userId: input.userId ?? null,
          userAgent: input.userAgent,
          ip: input.ip,
          country: input.country,
          region: input.region,
          path: input.path,
          dnt: input.dnt,
          nowMs: now,
          // Do NOT re-pass attribution; recordVisitorAttribution already
          // INSERT OR IGNORE'd so a nested call would be a no-op anyway,
          // but leaving it off makes the intent explicit.
        },
        database,
      );
    }
  } else if (input.attribution?.utm_source) {
    // We're already on the utm_captured path — still need to persist the
    // attribution row (idempotent) without spawning a nested event.
    recordVisitorAttribution(database, visitorId, input.attribution);
  }

  return sessionId;
}

function serializeProperties(
  properties: Record<string, unknown> | null | undefined,
): string | null {
  if (!properties) return null;
  try {
    const json = JSON.stringify({ v: 1, ...properties });
    if (Buffer.byteLength(json, "utf8") > PROPS_MAX_BYTES) {
      return JSON.stringify({ v: 1, _truncated: true });
    }
    return json;
  } catch {
    return null;
  }
}

/**
 * Helper: extract a UTM payload from an Express request's query string.
 *
 * @param req - Express request.
 * @returns Attribution object with at least `utm_source`, or null.
 */
export function extractAttributionFromRequest(req: Request): Attribution | null {
  const q = (req.query ?? {}) as Record<string, unknown>;
  const utmSource = str(q.utm_source);
  if (!utmSource) return null;
  const headers = (req.headers ?? {}) as Record<string, string | string[] | undefined>;
  return {
    utm_source: utmSource,
    utm_medium: str(q.utm_medium) ?? undefined,
    utm_campaign: str(q.utm_campaign) ?? undefined,
    utm_content: str(q.utm_content) ?? undefined,
    utm_term: str(q.utm_term) ?? undefined,
    landing_page: req.originalUrl ?? undefined,
    referrer: str(headers.referer) ?? undefined,
  };
}

function str(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed.slice(0, 128) : undefined;
}

/**
 * Shortcut: record a server-side event using Express request context.
 * Reads visitor_id, userId from auth session (via req.user), IP/UA/geo from
 * headers. Intended for middleware and route handlers.
 *
 * @param req - Express request (must have gone through visitorCookie middleware).
 * @param input - Event input; visitorId/userId are filled from req if omitted.
 */
export function recordEventFromRequest(
  req: Request,
  input: Partial<RecordEventInput> & { eventName: string },
): string | null {
  try {
    const visitorId = input.visitorId ?? req.visitorId;
    if (!visitorId) return null;

    const userId =
      input.userId ??
      (req as unknown as { user?: { id: string } }).user?.id ??
      null;

    // Req may be a mockReq in tests, lacking headers. Stay defensive: the
    // event pipeline is fire-and-forget and must never crash a request.
    const headers = (req.headers ?? {}) as Record<string, string | string[] | undefined>;
    const geo = input.country == null ? lookupGeo(req) : { country: input.country, region: input.region ?? null };
    // Distinguish "DNT header absent" from "DNT=0 explicit opt-in". Absent
    // (the common case) leaves dnt undefined so recordEvent's COALESCE
    // preserves the visitor's previously-observed sticky preference.
    // Without this, a visitor who set DNT=1 on a prior page-view would
    // have their sticky pref clobbered by every subsequent header-less
    // request.
    let dnt: boolean | undefined = input.dnt;
    if (dnt === undefined) {
      if (headers["dnt"] === "1" || headers["sec-gpc"] === "1") dnt = true;
      else if (headers["dnt"] === "0") dnt = false;
    }

    return recordEvent({
      ...input,
      visitorId,
      userId,
      userAgent: input.userAgent ?? (headers["user-agent"] as string | undefined) ?? null,
      ip: input.ip ?? getIp(req),
      country: geo.country,
      region: geo.region,
      path: input.path ?? req.originalUrl ?? null,
      referrer: input.referrer ?? (headers.referer as string | undefined) ?? null,
      attribution: input.attribution ?? extractAttributionFromRequest(req),
      dnt,
      // Forward the streamer-bot flag stamped by `streamerBotDetect`
      // middleware. recordEvent short-circuits when set so the bot's
      // page-view / game-event traffic never reaches the events table.
      isStreamerBot: input.isStreamerBot ?? req.isStreamerBot === true,
    });
  } catch (err) {
    console.error("recordEventFromRequest failed:", err);
    return null;
  }
}

/**
 * Link a visitor to a user (cross-device merge). Idempotent insert into
 * visitor_aliases. Called on login/signup after existing attribution logic.
 *
 * @param visitorId - Visitor UUID.
 * @param userId - User ID just authenticated.
 * @param database - Optional DB override.
 */
export function linkVisitorToUser(
  visitorId: string | null | undefined,
  userId: string,
  database: DatabaseType = db,
): void {
  if (!visitorId) return;
  try {
    // Wrap the alias insert + three backfill UPDATEs in a single
    // transaction so concurrent signups for the same visitor either
    // observe a fully linked + backfilled state or a fully un-linked
    // state, never a half-applied middle.
    database.transaction(() => {
      database
        .prepare(
          `INSERT OR IGNORE INTO visitor_aliases (visitor_id, user_id, merged_at)
           VALUES (?, ?, ?)`,
        )
        .run(visitorId, userId, Date.now());
      // Backfill historical rows for this visitor so V2 audience-filtered
      // dashboards (loggedIn / anon clauses) include pre-signup activity.
      // Without this, an anon-played-then-signed-up visitor's pre-signup
      // events live in the table with user_id=NULL and never surface in
      // any logged-in cohort query — even though the user clearly should
      // own them. Three tables hold the user_id column we care about:
      //   1. events.user_id — per-event row
      //   2. analytics_sessions.user_id — per-session row
      //   3. visitor_profile.user_id — per-visitor row (already updated by
      //      the recordEvent UPSERT on next event, but stamping here keeps
      //      it consistent even if no further events arrive)
      // All three are no-ops when user_id is already set (COALESCE), so
      // calling linkVisitorToUser repeatedly is idempotent.
      database
        .prepare(
          `UPDATE events SET user_id = ? WHERE visitor_id = ? AND user_id IS NULL`,
        )
        .run(userId, visitorId);
      database
        .prepare(
          `UPDATE analytics_sessions SET user_id = ? WHERE visitor_id = ? AND user_id IS NULL`,
        )
        .run(userId, visitorId);
      database
        .prepare(
          `UPDATE visitor_profile SET user_id = ?, ever_registered = 1
            WHERE visitor_id = ? AND user_id IS NULL`,
        )
        .run(userId, visitorId);
    })();
  } catch (err) {
    console.error("linkVisitorToUser failed:", err);
  }
}

/** Re-exported for tests and for the utmTags click handler that wants to attribute a redirect. */
export { VisitorAttribution };
