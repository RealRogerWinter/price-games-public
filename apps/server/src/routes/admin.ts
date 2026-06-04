/**
 * Admin REST API routes.
 *
 * Provides login/logout/session endpoints and analytics query endpoints
 * for the admin dashboard. All analytics routes require a valid admin
 * session (enforced by the requireAdmin middleware). Uses a factory
 * pattern so tests can inject a custom database instance.
 */

import { Router, Request, Response } from "express";
import type { Database as DatabaseType } from "better-sqlite3";
import { requireAdmin, requireExtensionAdmin, require2faEnrolled, cookieOptions, setDb } from "../middleware/adminAuth";
import { adminLogin, adminLoginVerify2fa, destroyAdminSession } from "../services/adminAuth";
import {
  beginTotpSetup,
  verifyAndEnableTotp,
  getTotpStatus,
  disableTotp,
  regenerateRecoveryCodes,
} from "../services/adminTotp";
// v1 analytics services were deleted in PR #209 — Insights (`/admin/analytics`)
// is the single source of truth. The Active Rooms ops widget on the
// Dashboard reads `mp_rooms` directly via this small inline helper since
// "what's running right now" is operational state, not analytics-stream
// data and doesn't fit the events rollup model.
import type { Database as MpDb } from "better-sqlite3";
function getActiveRooms(database: MpDb) {
  // Returns the `AnalyticsActiveRoom` shape from packages/shared/src/types.ts:
  // code, gameMode, status, currentRound, totalRounds, playerCount, createdAt.
  // Recency-filtered to the last 2h (matching `cleanupStaleRooms`'s hard cap)
  // so abandoned-but-not-yet-cleaned-up rooms don't pollute the live ops view.
  return database
    .prepare(
      `SELECT
         code,
         game_mode AS gameMode,
         status,
         current_round AS currentRound,
         total_rounds AS totalRounds,
         (SELECT COUNT(*) FROM mp_players
            WHERE room_code = mr.code AND is_kicked = 0) AS playerCount,
         created_at AS createdAt
       FROM mp_rooms mr
       WHERE status != 'finished'
         AND COALESCE(last_activity_at, created_at) >= datetime('now', '-2 hours')
       ORDER BY created_at DESC`,
    )
    .all();
}
import {
  listProducts,
  getProduct,
  createProduct,
  updateProduct,
  setProductActive,
  bulkSetProductActive,
  setProductArchived,
  bulkSetProductArchived,
  getProductCategories,
  upsertProductByAsin,
} from "../services/adminProducts";
import {
  getManufacturerContactsByName,
  addManufacturerContact,
  updateManufacturerContact,
  deleteManufacturerContact,
} from "../services/adminManufacturers";
import {
  addReward,
  listRewards,
  getReward,
  deleteReward,
  awardRewardToUser,
  getQualifyingPlayers,
  previewRandomRoll,
  confirmPendingAward,
  discardPendingAward,
  searchUsers,
} from "../services/rewards";
import {
  createUtmTag,
  getUtmTag,
  listUtmTags,
  updateUtmTag,
  setUtmTagStatus,
  deleteUtmTag,
  getUtmTagStats,
  getUtmTagTimeSeries,
  getUtmTagComparison,
  generateShortCodeSuggestion,
  type UtmTagComparisonOrigin,
} from "../services/utmTags";
import { getPromoBanner, updatePromoBanner, getDisabledGameModes, setDisabledGameModes, getDisabledAvatars, setDisabledAvatars, getLegalDocument, setLegalDocument, getSiteContent, setSiteContent, getEnabledPages, setEnabledPages } from "../services/siteSettings";
import { getAutoLobbySettings, setAutoLobbySettings } from "../services/autoLobby/settings";
import { getGhostSettings, setGhostSettings } from "../services/ghostUsers/settings";
import {
  listGhosts,
  bulkCreateGhosts,
  getGhostById,
  setGhostActive,
  setShiftState,
  deleteGhost,
  endAllShifts,
} from "../services/ghostUsers/repository";
import { simulateGhostDailyPlays } from "../services/ghostUsers/dailySim";
import {
  AdminDailyError,
  getAdminDailyOverview,
  updateAdminDailyEnabled,
  updateAdminDailySchedule,
  setAdminDailyProducts,
  regenerateAdminDailyPuzzle,
  getAdminDailyStats,
  clearAdminDailyPlay,
} from "../services/adminDaily";
import { SAFE_LOGIN_ERRORS } from "../services/authHelpers";
import { exportGdprData, forgetGdprData } from "../services/gdpr";
import {
  getOverview as getOverviewV2,
  getDailyTimeseries,
  getAcquisitionSources,
  getUtmTagPerformance,
  getTopPaths,
  getGamesPerSession,
  getHourlyHeatmap,
  getGamesByModeBreakdown,
  getGamesDailyUniques,
  getJoinSourceBreakdown,
  getStartSourceBreakdown,
  getShareLinkFunnel,
  type FilterInput,
  type Audience,
  type DeviceFilter,
} from "../services/analyticsV2";
import {
  getCohortRetention,
  getCohortSummary,
  getRetentionCurves,
  getStickiness,
  computeAllFunnels,
  computeFunnel,
  PREBUILT_FUNNELS,
  getGeoCountries,
} from "../services/analyticsRetention";
import { toCsv } from "../services/analyticsCsv";
import { detectAnomalies } from "../services/analyticsAnomaly";
import {
  listUsers,
  getUserById,
  updateUser,
  deleteUser,
  deactivateUser,
  reactivateUser,
  forceResetPassword,
  getUserGameHistoryPaginated,
  getUserStatsById,
  getUserActivity,
} from "../services/adminUsers";
import {
  getReferralSummary,
  getReferralDaily,
  getReferralTopReferrers,
  getRejectionBreakdown,
  getReferredUsersByReferrer,
} from "../services/adminReferrals";
import type { AdminReferralRange } from "@price-game/shared";
import type { AdminProductListParams, AdminUserListParams, RandomRollCriteria } from "@price-game/shared";
import { VALID_GAME_MODES, GAME_MODES, AVATARS, AVATAR_LABELS, isValidProfileAvatar, isValidDailyDate, parseTimeZoneQuery } from "@price-game/shared";
import { config } from "../config";

type AdminProductListParamsSortBy = AdminProductListParams["sortBy"];

/** Known-safe product/contact error messages that can be forwarded to the client. */
const SAFE_CRUD_ERRORS = new Set([
  "Title is required",
  "Title cannot be empty",
  "Price must be a non-negative number",
  "Manufacturer not found",
  "ASIN is required",
  "Invalid ASIN format",
  "Price exceeds maximum",
  "Gift card code is required",
  "Amount must be a positive integer (in cents)",
  "Amount exceeds maximum allowed value",
  "Reward not found",
  "Reward is not available",
  "User not found",
  "No qualifying players found",
  "Invalid reward type",
  "A reward with this code already exists",
  // UTM tag errors
  "UTM tag name is required",
  "UTM tag name exceeds maximum length of 200 characters",
  "A UTM tag with this name already exists",
  "utm_source is required",
  "utm_source exceeds maximum length of 128 characters",
  "UTM field exceeds maximum length of 128 characters",
  "Destination URL is required",
  "Destination URL exceeds maximum length of 2048 characters",
  "Destination URL must be an HTTP(S) URL or path starting with /",
  "UTM tag not found",
  "Cannot delete UTM tag with matched signups",
  "Cannot update system-managed UTM tag",
  "Cannot delete system-managed UTM tag",
  "Invalid status filter",
  "Invalid origin filter",
  "Invalid status",
  // Short-link errors (migration v30)
  "Short code must be 3-32 lowercase letters, digits, or hyphens (no leading or trailing hyphen)",
  "A UTM tag with this short code already exists",
]);

/**
 * Return a safe error message for CRUD operations. If the error is in
 * the known-safe set or matches a known pattern, return a sanitized
 * version. Otherwise return a generic fallback.
 */
function safeCrudError(err: unknown, fallback: string): string {
  const message = err instanceof Error ? err.message : fallback;
  if (SAFE_CRUD_ERRORS.has(message)) return message;
  // Field-length validation errors from adminProducts.ts
  if (/^\w+ exceeds maximum length of \d+ characters$/.test(message)) return message;
  // Price upper bound
  if (message === "Price exceeds maximum allowed value") return message;
  // imageUrl scheme validation
  if (message === "imageUrl must be an HTTP or HTTPS URL") return message;
  // Contact type/confidence: return only the static prefix + valid options, not the user-supplied value
  if (message.startsWith("Invalid contactType")) return "Invalid contactType. Must be one of: media, promotions, pr, partnerships, general, support";
  if (message.startsWith("Invalid confidence")) return "Invalid confidence. Must be one of: high, medium, low";
  return fallback;
}

/** Module-level database reference; lazily resolved from ../db when not injected. */
let _db: DatabaseType;

/** Module-level contacts database reference; lazily resolved when not injected. */
let _contactsDb: DatabaseType | null = null;

/**
 * Return the active database instance, falling back to the default export
 * from ../db if none was injected via createAdminRouter.
 *
 * @returns The database instance.
 */
function getDb(): DatabaseType {
  if (!_db) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    _db = require("../db").default;
  }
  return _db;
}

/**
 * Return the contacts database instance, lazily opening it if not injected.
 *
 * @returns The contacts database instance, or null if unavailable.
 */
/**
 * Parse the common analytics v2 filter from Express query params.
 *
 * Accepts `range=7d|28d|90d`, `audience=all|anon|loggedIn`, and
 * `device=all|desktop|mobile|tablet`. Returns null for any malformed
 * input so callers can 400 cleanly.
 *
 * @param req - Express request.
 * @returns FilterInput or null.
 */
function parseV2Filter(req: Request): FilterInput | null {
  const rangeStr = String(req.query.range ?? "7d");
  const rangeDays =
    rangeStr === "7d" ? 7
    : rangeStr === "28d" ? 28
    : rangeStr === "90d" ? 90
    : rangeStr === "1d" ? 1
    : null;
  if (rangeDays === null) return null;

  const audRaw = req.query.audience;
  let audience: Audience = "all";
  if (audRaw !== undefined) {
    if (audRaw === "all" || audRaw === "anon" || audRaw === "loggedIn") {
      audience = audRaw;
    } else {
      return null;
    }
  }

  const devRaw = req.query.device;
  let deviceType: DeviceFilter = "all";
  if (devRaw !== undefined) {
    if (devRaw === "all" || devRaw === "desktop" || devRaw === "mobile" || devRaw === "tablet") {
      deviceType = devRaw;
    } else {
      return null;
    }
  }

  // Optional `?tz=` overrides the default PST bucketing for daily series
  // and the heatmap. Falls back to ADMIN_TIMEZONE for missing or
  // IANA-invalid values so a malformed tz never 400s the dashboard.
  const timeZone = parseTimeZoneQuery(req.query.tz);

  return { rangeDays, audience, deviceType, timeZone };
}

/**
 * Parse and clamp an integer query param. Returns the fallback for any
 * unparseable input and clamps parsed values into [min, max].
 */
/**
 * Parse the `range` query parameter for the referral analytics endpoints.
 * Defaults to "28d" for unknown / missing values rather than 400-ing — the
 * dashboard treats range as a soft input.
 */
function parseReferralRange(raw: unknown): AdminReferralRange {
  const v = String(raw ?? "").toLowerCase();
  if (v === "7d" || v === "28d" || v === "90d" || v === "all") return v;
  return "28d";
}

/**
 * Parse the `range` query parameter for the UTM dashboard endpoints
 * (`/utm-tags/comparison`, `/utm-tags/:id/timeseries`,
 * `/utm-tags/:id/stats?range=`). Accepts the same `7d`/`28d`/`90d`
 * strings as the rest of the v2 analytics surface for uniformity. Bare
 * numeric strings (`7`/`28`/`90`) are also accepted so the URL stays
 * pretty if the frontend prefers numeric query params.
 *
 * @param raw - Query param value.
 * @returns 7 | 28 | 90, or null when the input is invalid.
 */
function parseUtmRange(raw: unknown): 7 | 28 | 90 | null {
  const v = String(raw ?? "").toLowerCase();
  if (v === "7" || v === "7d") return 7;
  if (v === "28" || v === "28d") return 28;
  if (v === "90" || v === "90d") return 90;
  return null;
}

/**
 * Parse the `origin` query parameter for `/utm-tags/comparison`. Defaults
 * to `admin` when omitted OR set to an empty string (e.g. from a
 * `URLSearchParams` toggle that clears the param without removing the
 * key); returns null on an explicit-but-invalid value so the route can 400.
 */
function parseUtmComparisonOrigin(
  raw: unknown,
): UtmTagComparisonOrigin | null {
  if (raw === undefined || raw === "") return "admin";
  const v = String(raw).toLowerCase();
  if (v === "admin" || v === "system" || v === "all") return v;
  return null;
}

type ParseResult<T> = { ok: true; criteria: T } | { ok: false; error: string };

const VALID_ROLL_PERIODS = new Set([
  "last_week",
  "last_month",
  "last_3_months",
  "all_time",
  "calendar_month",
]);
const VALID_ROLL_MODES = new Set([
  "points_only",
  "streak_only",
  "points_and_streak",
  "points_or_streak",
]);

/**
 * Validate a free-form criteria object (from query string or JSON body)
 * into the shared {@link RandomRollCriteria} type. Centralised so the
 * preview-qualifying GET and the random-roll POST reject identically.
 */
function validateRollCriteriaShape(
  source: {
    minPoints: unknown;
    period: unknown;
    mode: unknown;
    minStreak: unknown;
    useLifetimePoints: unknown;
    month?: unknown;
    excludedUserIds?: unknown;
    excludeTestAccounts?: unknown;
  },
): ParseResult<RandomRollCriteria> {
  const minPoints =
    typeof source.minPoints === "number" ? source.minPoints : Number(source.minPoints);
  if (!Number.isInteger(minPoints) || minPoints < 0) {
    return { ok: false, error: "minPoints must be a non-negative integer" };
  }
  if (typeof source.period !== "string" || !VALID_ROLL_PERIODS.has(source.period)) {
    return { ok: false, error: "Invalid period" };
  }
  const mode = (source.mode ?? "points_only") as string;
  if (!VALID_ROLL_MODES.has(mode)) {
    return { ok: false, error: "Invalid mode" };
  }
  const minStreakRaw =
    typeof source.minStreak === "number" ? source.minStreak : Number(source.minStreak ?? 0);
  if (!Number.isInteger(minStreakRaw) || minStreakRaw < 0) {
    return { ok: false, error: "minStreak must be a non-negative integer" };
  }
  if (
    (mode === "streak_only" || mode === "points_and_streak" || mode === "points_or_streak") &&
    minStreakRaw < 1
  ) {
    return {
      ok: false,
      error: "minStreak must be at least 1 when mode references streak",
    };
  }

  let month: { year: number; monthIndex: number } | undefined;
  if (source.period === "calendar_month") {
    const m = source.month;
    if (!m || typeof m !== "object") {
      return { ok: false, error: "month is required when period=calendar_month" };
    }
    const monthObj = m as { year?: unknown; monthIndex?: unknown };
    const year = Number(monthObj.year);
    const monthIndex = Number(monthObj.monthIndex);
    if (!Number.isInteger(year) || year < 2000 || year > 3000) {
      return { ok: false, error: "month.year must be a reasonable integer" };
    }
    if (!Number.isInteger(monthIndex) || monthIndex < 0 || monthIndex > 11) {
      return { ok: false, error: "month.monthIndex must be an integer 0..11" };
    }
    month = { year, monthIndex };
  }

  let excludedUserIds: string[] | undefined;
  if (source.excludedUserIds !== undefined) {
    if (Array.isArray(source.excludedUserIds)) {
      excludedUserIds = source.excludedUserIds.filter(
        (id): id is string => typeof id === "string" && id.length > 0,
      );
    } else if (typeof source.excludedUserIds === "string") {
      excludedUserIds = source.excludedUserIds
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    } else {
      return { ok: false, error: "excludedUserIds must be an array or comma-separated string" };
    }
  }

  let excludeTestAccounts: boolean | undefined;
  if (typeof source.excludeTestAccounts === "boolean") {
    excludeTestAccounts = source.excludeTestAccounts;
  } else if (typeof source.excludeTestAccounts === "string") {
    excludeTestAccounts = source.excludeTestAccounts !== "false";
  }

  return {
    ok: true,
    criteria: {
      mode: mode as RandomRollCriteria["mode"],
      minPoints,
      period: source.period as RandomRollCriteria["period"],
      useLifetimePoints:
        source.useLifetimePoints === true || source.useLifetimePoints === "true",
      minStreak: minStreakRaw,
      ...(month ? { month } : {}),
      ...(excludedUserIds ? { excludedUserIds } : {}),
      ...(excludeTestAccounts !== undefined ? { excludeTestAccounts } : {}),
    },
  };
}

function parseRollCriteriaFromQuery(req: Request): ParseResult<RandomRollCriteria> {
  // Accept compact ?month=YYYY-MM in query strings; expand to {year, monthIndex}.
  let month: { year: number; monthIndex: number } | undefined;
  const rawMonth = typeof req.query.month === "string" ? req.query.month : "";
  if (rawMonth) {
    const m = /^(\d{4})-(\d{2})$/.exec(rawMonth);
    if (m) month = { year: Number(m[1]), monthIndex: Number(m[2]) - 1 };
  }
  return validateRollCriteriaShape({
    minPoints: req.query.minPoints,
    period: req.query.period,
    mode: req.query.mode,
    minStreak: req.query.minStreak,
    useLifetimePoints: req.query.useLifetimePoints,
    month,
    excludedUserIds: req.query.excludedUserIds,
    excludeTestAccounts: req.query.excludeTestAccounts,
  });
}

function parseRollCriteriaFromBody(criteria: unknown): ParseResult<RandomRollCriteria> {
  if (!criteria || typeof criteria !== "object") {
    return { ok: false, error: "criteria is required" };
  }
  const c = criteria as Record<string, unknown>;
  return validateRollCriteriaShape({
    minPoints: c.minPoints,
    period: c.period,
    mode: c.mode,
    minStreak: c.minStreak,
    useLifetimePoints: c.useLifetimePoints,
    month: c.month,
    excludedUserIds: c.excludedUserIds,
    excludeTestAccounts: c.excludeTestAccounts,
  });
}

function clampInt(raw: unknown, min: number, max: number, fallback: number): number {
  const n = parseInt(String(raw ?? ""), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function getContactsDb(): DatabaseType | null {
  if (!_contactsDb) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { openContactsDb } = require("../pipeline/manufacturer-contacts/contacts-db");
      _contactsDb = openContactsDb();
    } catch {
      return null;
    }
  }
  return _contactsDb;
}

/**
 * Create and return an Express Router with all admin API endpoints.
 *
 * If database instances are provided they will be used for all queries.
 * When omitted the router lazily resolves the default databases on first request.
 *
 * @param db - Optional main database instance (useful for testing).
 * @param contactsDb - Optional contacts database instance (useful for testing).
 * @returns Configured Express Router.
 */
export function createAdminRouter(db?: DatabaseType, contactsDb?: DatabaseType): Router {
  // Always reset module-level refs to avoid cross-test pollution.
  _db = undefined as unknown as DatabaseType;
  _contactsDb = null;
  if (db) {
    _db = db;
    setDb(db);
  }
  if (contactsDb) {
    _contactsDb = contactsDb;
  }

  const router = Router();

  // POST /login - Authenticate admin user and set session cookie
  router.post("/login", (req: Request, res: Response) => {
    const { username, password } = req.body;

    if (typeof username !== "string" || typeof password !== "string" || !username || !password) {
      res.status(400).json({ error: "Username and password are required" });
      return;
    }

    if (username.length > 128 || password.length > 1024) {
      res.status(400).json({ error: "Input too long" });
      return;
    }

    try {
      const ip = req.ip || req.socket.remoteAddress || "unknown";
      const userAgent = req.headers["user-agent"] || "unknown";
      const result = adminLogin(getDb(), username, password, ip, userAgent);

      // Sandbox/dev deployments with SKIP_ADMIN_2FA=1 advertise a skip2fa
      // flag so the web client bypasses its client-side 2FA enrollment
      // redirect. Prod leaves this false/undefined.
      const skip2fa = process.env.SKIP_ADMIN_2FA === "1";
      if (result.requiresTwoFactor) {
        // 2FA required — return pending token, do NOT set cookie
        res.json({
          user: result.user,
          requiresTwoFactor: true,
          pendingToken: result.pendingToken,
          skip2fa,
        });
      } else {
        res.cookie(config.adminCookieName, result.token, cookieOptions());
        res.json({ user: result.user, skip2fa });
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Login failed";
      if (message === "Account is temporarily locked") {
        res.status(429).json({ error: message });
      } else {
        res.status(401).json({ error: SAFE_LOGIN_ERRORS.has(message) ? message : "Login failed" });
      }
    }
  });

  // POST /login/verify-2fa - Complete 2FA login verification
  router.post("/login/verify-2fa", (req: Request, res: Response) => {
    const { pendingToken, code, isRecoveryCode } = req.body;

    if (typeof pendingToken !== "string" || typeof code !== "string" || !pendingToken || !code) {
      res.status(400).json({ error: "Pending token and code are required" });
      return;
    }

    if (pendingToken.length > 128 || code.length > 32) {
      res.status(400).json({ error: "Input too long" });
      return;
    }

    try {
      const ip = req.ip || req.socket.remoteAddress || "unknown";
      const userAgent = req.headers["user-agent"] || "unknown";
      const result = adminLoginVerify2fa(getDb(), pendingToken, code, !!isRecoveryCode, ip, userAgent);

      res.cookie(config.adminCookieName, result.token, cookieOptions());
      res.json({ user: result.user });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Verification failed";
      if (message === "Account is temporarily locked") {
        res.status(429).json({ error: message });
      } else if (message === "Pending token expired or invalid") {
        res.status(401).json({ error: message });
      } else {
        res.status(401).json({ error: SAFE_LOGIN_ERRORS.has(message) ? message : "Verification failed" });
      }
    }
  });

  // POST /logout - Destroy admin session and clear cookie (or Bearer token)
  router.post("/logout", requireAdmin, (req: Request, res: Response) => {
    const authHeader = req.headers?.authorization;
    if (authHeader && authHeader.startsWith("Bearer ")) {
      destroyAdminSession(getDb(), authHeader.slice(7));
    }
    const token = req.cookies?.[config.adminCookieName];
    if (token) {
      destroyAdminSession(getDb(), token);
    }
    res.clearCookie(config.adminCookieName, cookieOptions(true));
    res.json({ ok: true });
  });

  // GET /me - Return the currently authenticated admin user
  router.get("/me", requireAdmin, (req: Request, res: Response) => {
    res.json({ user: req.adminUser, skip2fa: process.env.SKIP_ADMIN_2FA === "1" });
  });

  // ===== 2FA Management Routes =====

  // GET /2fa/status - Check 2FA status for the current admin
  router.get("/2fa/status", requireAdmin, (req: Request, res: Response) => {
    const status = getTotpStatus(getDb(), req.adminUser!.id);
    res.json(status);
  });

  // POST /2fa/setup - Begin TOTP setup (generate secret + QR code)
  router.post("/2fa/setup", requireAdmin, async (req: Request, res: Response) => {
    try {
      const result = await beginTotpSetup(getDb(), req.adminUser!.id);
      res.json(result);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Setup failed";
      res.status(400).json({ error: message });
    }
  });

  // POST /2fa/verify-setup - Verify TOTP code to complete 2FA setup
  router.post("/2fa/verify-setup", requireAdmin, (req: Request, res: Response) => {
    const { code } = req.body;

    if (typeof code !== "string" || !code || code.length > 10) {
      res.status(400).json({ error: "Valid code is required" });
      return;
    }

    try {
      const ip = req.ip || req.socket.remoteAddress || "unknown";
      const userAgent = req.headers["user-agent"] || "unknown";
      const result = verifyAndEnableTotp(getDb(), req.adminUser!.id, code, ip, userAgent);
      res.json(result);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Verification failed";
      res.status(400).json({ error: SAFE_LOGIN_ERRORS.has(message) ? message : "Verification failed" });
    }
  });

  // POST /2fa/disable - Disable 2FA (requires password + TOTP/recovery code)
  router.post("/2fa/disable", requireAdmin, require2faEnrolled, (req: Request, res: Response) => {
    const { password, code, isRecoveryCode } = req.body;

    if (typeof password !== "string" || typeof code !== "string" || !password || !code) {
      res.status(400).json({ error: "Password and code are required" });
      return;
    }

    if (password.length > 1024 || code.length > 32) {
      res.status(400).json({ error: "Input too long" });
      return;
    }

    try {
      const ip = req.ip || req.socket.remoteAddress || "unknown";
      const userAgent = req.headers["user-agent"] || "unknown";
      disableTotp(getDb(), req.adminUser!.id, password, code, !!isRecoveryCode, ip, userAgent);
      res.json({ ok: true });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Disable failed";
      if (message === "Invalid password") {
        res.status(401).json({ error: message });
      } else {
        res.status(400).json({ error: SAFE_LOGIN_ERRORS.has(message) ? message : "Disable failed" });
      }
    }
  });

  // POST /2fa/regenerate-codes - Regenerate recovery codes (requires password)
  router.post("/2fa/regenerate-codes", requireAdmin, require2faEnrolled, (req: Request, res: Response) => {
    const { password } = req.body;

    if (typeof password !== "string" || !password) {
      res.status(400).json({ error: "Password is required" });
      return;
    }

    if (password.length > 1024) {
      res.status(400).json({ error: "Input too long" });
      return;
    }

    try {
      const ip = req.ip || req.socket.remoteAddress || "unknown";
      const userAgent = req.headers["user-agent"] || "unknown";
      const result = regenerateRecoveryCodes(getDb(), req.adminUser!.id, password, ip, userAgent);
      res.json(result);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Regeneration failed";
      if (message === "Invalid password") {
        res.status(401).json({ error: message });
      } else {
        res.status(400).json({ error: SAFE_LOGIN_ERRORS.has(message) ? message : "Regeneration failed" });
      }
    }
  });

  // GET /analytics/active-rooms — live operational view of currently
  // running multiplayer rooms. Kept as the lone /analytics/* v1-shaped
  // endpoint because room-state isn't analytics-stream data and doesn't
  // fit the events rollup model. Auto-refreshed every 30s by the
  // Dashboard. Recency-filtered (≥ -2h activity) so abandoned-but-
  // not-yet-cleaned-up rooms don't pollute the live view.
  router.get("/analytics/active-rooms", requireAdmin, require2faEnrolled, (_req: Request, res: Response) => {
    res.json(getActiveRooms(getDb()));
  });

  // === Analytics v2 — backed by analytics_hourly + analytics_sessions ===
  // These endpoints power the /admin/analytics dashboard surface. Every
  // query is pre-aggregated so dashboards stay fast at any event volume.
  //
  // Each handler wraps its service call in try/catch so synchronous
  // better-sqlite3 exceptions (schema drift, DB locked, etc.) surface as
  // a 500 with a server-side log entry instead of an unhandled Express
  // error. Matches the pattern used by the GDPR and backfill handlers.
  const wrapV2 = (
    handler: (db: DatabaseType, filter: FilterInput, req: Request) => unknown,
  ) =>
    (req: Request, res: Response): void => {
      const filter = parseV2Filter(req);
      if (!filter) {
        res.status(400).json({ error: "invalid filter" });
        return;
      }
      try {
        res.json(handler(getDb(), filter, req));
      } catch (err) {
        console.error("[admin/analytics/v2]", err);
        res.status(500).json({ error: "internal error" });
      }
    };

  // GET /analytics/v2/overview — KPI cards for the Overview tab
  router.get("/analytics/v2/overview", requireAdmin, require2faEnrolled,
    wrapV2((db, f) => getOverviewV2(db, f)));

  // GET /analytics/v2/daily — zero-filled daily timeseries for the main chart
  router.get("/analytics/v2/daily", requireAdmin, require2faEnrolled,
    wrapV2((db, f) => getDailyTimeseries(db, f)));

  // GET /analytics/v2/acquisition — coarse source breakdown
  router.get("/analytics/v2/acquisition", requireAdmin, require2faEnrolled,
    wrapV2((db, f) => getAcquisitionSources(db, f)));

  // GET /analytics/v2/utm-tags — per-campaign engagement report
  router.get("/analytics/v2/utm-tags", requireAdmin, require2faEnrolled,
    wrapV2((db, f) => getUtmTagPerformance(db, f)));

  // GET /analytics/v2/paths — top entry/exit paths (Engagement tab)
  router.get("/analytics/v2/paths", requireAdmin, require2faEnrolled,
    wrapV2((db, f, req) => {
      const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? "20"), 10) || 20));
      return getTopPaths(db, f, limit);
    }));

  // GET /analytics/v2/games-per-session — histogram for Engagement tab
  router.get("/analytics/v2/games-per-session", requireAdmin, require2faEnrolled,
    wrapV2((db, f) => getGamesPerSession(db, f)));

  // GET /analytics/v2/heatmap — hour-of-day × day-of-week heatmap
  router.get("/analytics/v2/heatmap", requireAdmin, require2faEnrolled,
    wrapV2((db, f) => getHourlyHeatmap(db, f)));

  // GET /analytics/v2/games-by-mode — daily series by (mode, variant) where
  // variant is single|multiplayer|daily. Drives the Games tab combined
  // chart and per-mode bar.
  router.get("/analytics/v2/games-by-mode", requireAdmin, require2faEnrolled,
    wrapV2((db, f) => getGamesByModeBreakdown(db, f)));

  // GET /analytics/v2/join-source — multiplayer arrival breakdown by
  // join_source (share_link / browser / quickplay / create).
  router.get("/analytics/v2/join-source", requireAdmin, require2faEnrolled,
    wrapV2((db, f) => getJoinSourceBreakdown(db, f)));

  // GET /analytics/v2/games-daily-uniques — daily unique players + total
  // games for the Games tab variant chart's overlay line. Reuses the same
  // daily-play dedup as games-by-mode so a daily play counts once.
  router.get("/analytics/v2/games-daily-uniques", requireAdmin, require2faEnrolled,
    wrapV2((db, f) => getGamesDailyUniques(db, f)));

  // GET /analytics/v2/start-source — unified game-start breakdown across SP
  // and MP by `start_source` (homepage / game-browser / quickplay /
  // room-creation / mp-invite). Counts both `game_started` and
  // `mp_game_started` events.
  router.get("/analytics/v2/start-source", requireAdmin, require2faEnrolled,
    wrapV2((db, f) => getStartSourceBreakdown(db, f)));

  // GET /analytics/v2/share-link-funnel — copy → click → join → complete.
  router.get("/analytics/v2/share-link-funnel", requireAdmin, require2faEnrolled,
    wrapV2((db, f) => getShareLinkFunnel(db, f)));

  // === Phase 3 analytics — retention / funnels / geo ===

  // GET /analytics/v2/retention/cohorts — weekly cohort retention triangle
  router.get("/analytics/v2/retention/cohorts", requireAdmin, require2faEnrolled,
    (req: Request, res: Response) => {
      try {
        const weeksBack = clampInt(req.query.weeks, 4, 26, 12);
        const maxWeeks = clampInt(req.query.maxWeeks, 4, 26, 12);
        res.json(getCohortRetention(getDb(), weeksBack, maxWeeks));
      } catch (err) {
        console.error("[admin/analytics/v2/retention/cohorts]", err);
        res.status(500).json({ error: "internal error" });
      }
    });

  // GET /analytics/v2/retention/summary — D1/D7/D30 per cohort
  router.get("/analytics/v2/retention/summary", requireAdmin, require2faEnrolled,
    (req: Request, res: Response) => {
      try {
        const weeksBack = clampInt(req.query.weeks, 4, 26, 12);
        res.json(getCohortSummary(getDb(), weeksBack));
      } catch (err) {
        console.error("[admin/analytics/v2/retention/summary]", err);
        res.status(500).json({ error: "internal error" });
      }
    });

  // GET /analytics/v2/retention/curves — retention curves for overlay chart
  router.get("/analytics/v2/retention/curves", requireAdmin, require2faEnrolled,
    (req: Request, res: Response) => {
      try {
        const weeksBack = clampInt(req.query.weeks, 2, 12, 6);
        const maxDays = clampInt(req.query.maxDays, 7, 90, 30);
        res.json(getRetentionCurves(getDb(), weeksBack, maxDays));
      } catch (err) {
        console.error("[admin/analytics/v2/retention/curves]", err);
        res.status(500).json({ error: "internal error" });
      }
    });

  // GET /analytics/v2/retention/stickiness — DAU/MAU ratio
  router.get("/analytics/v2/retention/stickiness", requireAdmin, require2faEnrolled,
    (req: Request, res: Response) => {
      try {
        const rangeDays = clampInt(req.query.days, 7, 90, 28);
        res.json(getStickiness(getDb(), rangeDays));
      } catch (err) {
        console.error("[admin/analytics/v2/retention/stickiness]", err);
        res.status(500).json({ error: "internal error" });
      }
    });

  // GET /analytics/v2/funnels — all pre-built funnels at once
  router.get("/analytics/v2/funnels", requireAdmin, require2faEnrolled,
    (_req: Request, res: Response) => {
      try {
        res.json(computeAllFunnels(getDb()));
      } catch (err) {
        console.error("[admin/analytics/v2/funnels]", err);
        res.status(500).json({ error: "internal error" });
      }
    });

  // GET /analytics/v2/funnels/:id — single pre-built funnel by id
  router.get("/analytics/v2/funnels/:id", requireAdmin, require2faEnrolled,
    (req: Request, res: Response) => {
      const def = PREBUILT_FUNNELS.find((f) => f.id === req.params.id);
      if (!def) {
        res.status(404).json({ error: "funnel not found" });
        return;
      }
      try {
        res.json(computeFunnel(getDb(), def));
      } catch (err) {
        console.error("[admin/analytics/v2/funnels/:id]", err);
        res.status(500).json({ error: "internal error" });
      }
    });

  // GET /analytics/v2/geo/countries — country-level breakdown
  router.get("/analytics/v2/geo/countries", requireAdmin, require2faEnrolled,
    wrapV2((db, f) => getGeoCountries(db, f)));

  // === Referral analytics (dedicated /admin/referrals dashboard) ===

  // GET /analytics/referrals/summary — KPI counters for the window
  router.get("/analytics/referrals/summary", requireAdmin, require2faEnrolled,
    (req: Request, res: Response) => {
      try {
        const range = parseReferralRange(req.query.range);
        res.json(getReferralSummary(getDb(), range));
      } catch (err) {
        console.error("[admin/analytics/referrals/summary]", err);
        res.status(500).json({ error: "internal error" });
      }
    });

  // GET /analytics/referrals/daily — zero-filled created/credited time-series
  router.get("/analytics/referrals/daily", requireAdmin, require2faEnrolled,
    (req: Request, res: Response) => {
      try {
        const range = parseReferralRange(req.query.range);
        const tz = parseTimeZoneQuery(req.query.tz);
        res.json(getReferralDaily(getDb(), range, tz));
      } catch (err) {
        console.error("[admin/analytics/referrals/daily]", err);
        res.status(500).json({ error: "internal error" });
      }
    });

  // GET /analytics/referrals/top-referrers — leaderboard ordered by credited desc
  router.get("/analytics/referrals/top-referrers", requireAdmin, require2faEnrolled,
    (req: Request, res: Response) => {
      try {
        const range = parseReferralRange(req.query.range);
        const limit = clampInt(req.query.limit, 1, 100, 20);
        res.json(getReferralTopReferrers(getDb(), range, limit));
      } catch (err) {
        console.error("[admin/analytics/referrals/top-referrers]", err);
        res.status(500).json({ error: "internal error" });
      }
    });

  // GET /analytics/referrals/rejections — breakdown of rejected referrals by reason
  router.get("/analytics/referrals/rejections", requireAdmin, require2faEnrolled,
    (req: Request, res: Response) => {
      try {
        const range = parseReferralRange(req.query.range);
        res.json(getRejectionBreakdown(getDb(), range));
      } catch (err) {
        console.error("[admin/analytics/referrals/rejections]", err);
        res.status(500).json({ error: "internal error" });
      }
    });

  // GET /analytics/referrals/by-referrer — list of users a single referrer brought in
  router.get("/analytics/referrals/by-referrer", requireAdmin, require2faEnrolled,
    (req: Request, res: Response) => {
      try {
        const referrerId = typeof req.query.referrerId === "string" ? req.query.referrerId.trim() : "";
        if (!referrerId || referrerId.length > 128) {
          res.status(400).json({ error: "referrerId is required (max 128 chars)" });
          return;
        }
        const range = parseReferralRange(req.query.range);
        res.json(getReferredUsersByReferrer(getDb(), referrerId, range));
      } catch (err) {
        console.error("[admin/analytics/referrals/by-referrer]", err);
        res.status(500).json({ error: "internal error" });
      }
    });

  // === Phase 4: anomalies + CSV export ===

  // GET /analytics/v2/anomalies — current analytics anomalies for the
  // Overview banner. Returns [] when all clear.
  router.get("/analytics/v2/anomalies", requireAdmin, require2faEnrolled,
    (_req: Request, res: Response) => {
      try {
        res.json(detectAnomalies(getDb()));
      } catch (err) {
        console.error("[admin/analytics/v2/anomalies]", err);
        res.status(500).json({ error: "internal error" });
      }
    });

  // CSV export — one endpoint per dashboard data set. Every handler
  // re-runs the same query the JSON endpoint uses and pipes it through
  // `toCsv`. `Content-Disposition: attachment` forces a download.
  const sendCsv = (res: Response, rows: Array<Record<string, unknown>>, filename: string): void => {
    const body = toCsv(rows);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(body);
  };

  router.get("/analytics/v2/export/daily.csv", requireAdmin, require2faEnrolled,
    (req: Request, res: Response) => {
      const filter = parseV2Filter(req);
      if (!filter) {
        res.status(400).json({ error: "invalid filter" });
        return;
      }
      try {
        sendCsv(res, getDailyTimeseries(getDb(), filter) as unknown as Array<Record<string, unknown>>, "analytics-daily.csv");
      } catch (err) {
        console.error("[admin/analytics/v2/export/daily]", err);
        res.status(500).json({ error: "internal error" });
      }
    });

  router.get("/analytics/v2/export/acquisition.csv", requireAdmin, require2faEnrolled,
    (req: Request, res: Response) => {
      const filter = parseV2Filter(req);
      if (!filter) {
        res.status(400).json({ error: "invalid filter" });
        return;
      }
      try {
        sendCsv(res, getAcquisitionSources(getDb(), filter) as unknown as Array<Record<string, unknown>>, "analytics-acquisition.csv");
      } catch (err) {
        console.error("[admin/analytics/v2/export/acquisition]", err);
        res.status(500).json({ error: "internal error" });
      }
    });

  router.get("/analytics/v2/export/utm-tags.csv", requireAdmin, require2faEnrolled,
    (req: Request, res: Response) => {
      const filter = parseV2Filter(req);
      if (!filter) {
        res.status(400).json({ error: "invalid filter" });
        return;
      }
      try {
        sendCsv(res, getUtmTagPerformance(getDb(), filter) as unknown as Array<Record<string, unknown>>, "analytics-utm-tags.csv");
      } catch (err) {
        console.error("[admin/analytics/v2/export/utm-tags]", err);
        res.status(500).json({ error: "internal error" });
      }
    });

  router.get("/analytics/v2/export/paths.csv", requireAdmin, require2faEnrolled,
    (req: Request, res: Response) => {
      const filter = parseV2Filter(req);
      if (!filter) {
        res.status(400).json({ error: "invalid filter" });
        return;
      }
      try {
        const limit = clampInt(req.query.limit, 1, 500, 100);
        sendCsv(res, getTopPaths(getDb(), filter, limit) as unknown as Array<Record<string, unknown>>, "analytics-paths.csv");
      } catch (err) {
        console.error("[admin/analytics/v2/export/paths]", err);
        res.status(500).json({ error: "internal error" });
      }
    });

  router.get("/analytics/v2/export/geo.csv", requireAdmin, require2faEnrolled,
    (req: Request, res: Response) => {
      const filter = parseV2Filter(req);
      if (!filter) {
        res.status(400).json({ error: "invalid filter" });
        return;
      }
      try {
        sendCsv(res, getGeoCountries(getDb(), filter) as unknown as Array<Record<string, unknown>>, "analytics-geo.csv");
      } catch (err) {
        console.error("[admin/analytics/v2/export/geo]", err);
        res.status(500).json({ error: "internal error" });
      }
    });

  router.get("/analytics/v2/export/retention.csv", requireAdmin, require2faEnrolled,
    (_req: Request, res: Response) => {
      try {
        sendCsv(res, getCohortSummary(getDb()) as unknown as Array<Record<string, unknown>>, "analytics-retention.csv");
      } catch (err) {
        console.error("[admin/analytics/v2/export/retention]", err);
        res.status(500).json({ error: "internal error" });
      }
    });

  router.get("/analytics/v2/export/funnels.csv", requireAdmin, require2faEnrolled,
    (_req: Request, res: Response) => {
      try {
        // Flatten funnel results into one row per (funnel, step) so the
        // CSV consumer (Excel, pandas) gets a tidy table.
        const funnels = computeAllFunnels(getDb());
        const rows: Array<Record<string, unknown>> = [];
        for (const f of funnels) {
          for (const s of f.steps) {
            rows.push({
              funnel_id: f.id,
              funnel_name: f.name,
              step: s.step,
              step_label: s.label,
              visitors: s.visitors,
              conversion_from_prev: s.conversionFromPrev,
              conversion_from_start: s.conversionFromStart,
            });
          }
        }
        sendCsv(res, rows, "analytics-funnels.csv");
      } catch (err) {
        console.error("[admin/analytics/v2/export/funnels]", err);
        res.status(500).json({ error: "internal error" });
      }
    });

  // GDPR right-to-access: download all analytics rows for a given user_id.
  // Response is JSON; large users may need to paginate in a future iteration.
  router.get("/gdpr/export", requireAdmin, require2faEnrolled, (req: Request, res: Response) => {
    const userId = typeof req.query.userId === "string" ? req.query.userId : "";
    if (!/^[0-9a-f-]{36}$|^[a-zA-Z0-9_-]{1,64}$/.test(userId)) {
      res.status(400).json({ error: "userId required" });
      return;
    }
    try {
      const payload = exportGdprData(getDb(), userId);
      res.json(payload);
    } catch (err) {
      console.error("[admin] GDPR export failed:", err);
      res.status(500).json({ error: "export failed" });
    }
  });

  // GDPR right-to-delete: forget all analytics rows for a user. Rollups in
  // analytics_hourly retain aggregate counts (un-traceable to the user).
  router.delete("/gdpr/forget", requireAdmin, require2faEnrolled, (req: Request, res: Response) => {
    const userId = typeof req.query.userId === "string" ? req.query.userId : "";
    if (!/^[0-9a-f-]{36}$|^[a-zA-Z0-9_-]{1,64}$/.test(userId)) {
      res.status(400).json({ error: "userId required" });
      return;
    }
    try {
      const counts = forgetGdprData(getDb(), userId);
      res.json({ ok: true, counts });
    } catch (err) {
      console.error("[admin] GDPR forget failed:", err);
      res.status(500).json({ error: "forget failed" });
    }
  });

  // ===== Product Management Routes =====

  // GET /products - Paginated product list with search/filter/sort
  router.get("/products", requireAdmin, require2faEnrolled, (req: Request, res: Response) => {
    const page = parseInt(req.query.page as string, 10) || undefined;
    const pageSize = parseInt(req.query.pageSize as string, 10) || undefined;
    const search = (req.query.search as string) || undefined;
    const category = (req.query.category as string) || undefined;
    const sortBy = (req.query.sortBy as string) || undefined;
    const sortOrder = (req.query.sortOrder as string) || undefined;

    let isActive: boolean | undefined;
    if (req.query.isActive === "true") isActive = true;
    else if (req.query.isActive === "false") isActive = false;

    let isArchived: boolean | undefined;
    if (req.query.isArchived === "true") isArchived = true;
    else if (req.query.isArchived === "false") isArchived = false;

    const validSortBy = ["id", "title", "priceCents", "category", "manufacturer", "addedAt"];
    if (sortBy && !validSortBy.includes(sortBy)) {
      res.status(400).json({ error: "Invalid sortBy value" });
      return;
    }
    if (sortOrder && sortOrder !== "asc" && sortOrder !== "desc") {
      res.status(400).json({ error: "sortOrder must be 'asc' or 'desc'" });
      return;
    }

    const result = listProducts(getDb(), {
      page,
      pageSize,
      search,
      category,
      isActive,
      isArchived,
      sortBy: sortBy as AdminProductListParamsSortBy,
      sortOrder: sortOrder as "asc" | "desc",
    });
    res.json(result);
  });

  // GET /products/categories - Distinct product categories
  router.get("/products/categories", requireAdmin, require2faEnrolled, (_req: Request, res: Response) => {
    res.json(getProductCategories(getDb()));
  });

  // PATCH /products/bulk-archive - Archive/unarchive multiple products
  // Registered before /:id routes to avoid param matching conflicts.
  router.patch("/products/bulk-archive", requireAdmin, require2faEnrolled, (req: Request, res: Response) => {
    const { ids, isArchived } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      res.status(400).json({ error: "ids must be a non-empty array" });
      return;
    }
    if (ids.length > 500) {
      res.status(400).json({ error: "Cannot update more than 500 products at once" });
      return;
    }
    if (!ids.every((id: unknown) => typeof id === "number" && Number.isInteger(id) && id > 0)) {
      res.status(400).json({ error: "All ids must be positive integers" });
      return;
    }
    if (typeof isArchived !== "boolean") {
      res.status(400).json({ error: "isArchived must be a boolean" });
      return;
    }
    const updated = bulkSetProductArchived(getDb(), ids, isArchived);
    res.json({ updated });
  });

  // PATCH /products/bulk-status - Set active/inactive for multiple products
  // Registered before /:id routes to avoid param matching conflicts.
  router.patch("/products/bulk-status", requireAdmin, require2faEnrolled, (req: Request, res: Response) => {
    const { ids, isActive } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      res.status(400).json({ error: "ids must be a non-empty array" });
      return;
    }
    if (ids.length > 500) {
      res.status(400).json({ error: "Cannot update more than 500 products at once" });
      return;
    }
    if (!ids.every((id: unknown) => typeof id === "number" && Number.isInteger(id) && id > 0)) {
      res.status(400).json({ error: "All ids must be positive integers" });
      return;
    }
    if (typeof isActive !== "boolean") {
      res.status(400).json({ error: "isActive must be a boolean" });
      return;
    }
    const updated = bulkSetProductActive(getDb(), ids, isActive);
    res.json({ updated });
  });

  // GET /products/:id - Get single product
  router.get("/products/:id", requireAdmin, require2faEnrolled, (req: Request, res: Response) => {
    const id = parseInt(req.params.id as string, 10);
    if (isNaN(id)) {
      res.status(400).json({ error: "Invalid product ID" });
      return;
    }
    const product = getProduct(getDb(), id);
    if (!product) {
      res.status(404).json({ error: "Product not found" });
      return;
    }
    res.json(product);
  });

  // POST /products - Create product
  router.post("/products", requireAdmin, require2faEnrolled, (req: Request, res: Response) => {
    try {
      const product = createProduct(getDb(), req.body);
      res.status(201).json(product);
    } catch (err: unknown) {
      res.status(400).json({ error: safeCrudError(err, "Failed to create product") });
    }
  });

  // PUT /products/:id - Update product
  router.put("/products/:id", requireAdmin, require2faEnrolled, (req: Request, res: Response) => {
    const id = parseInt(req.params.id as string, 10);
    if (isNaN(id)) {
      res.status(400).json({ error: "Invalid product ID" });
      return;
    }
    try {
      const product = updateProduct(getDb(), id, req.body);
      if (!product) {
        res.status(404).json({ error: "Product not found" });
        return;
      }
      res.json(product);
    } catch (err: unknown) {
      res.status(400).json({ error: safeCrudError(err, "Failed to update product") });
    }
  });

  // PATCH /products/:id/status - Set active/inactive
  router.patch("/products/:id/status", requireAdmin, require2faEnrolled, (req: Request, res: Response) => {
    const id = parseInt(req.params.id as string, 10);
    if (isNaN(id)) {
      res.status(400).json({ error: "Invalid product ID" });
      return;
    }
    const { isActive } = req.body;
    if (typeof isActive !== "boolean") {
      res.status(400).json({ error: "isActive must be a boolean" });
      return;
    }
    const product = setProductActive(getDb(), id, isActive);
    if (!product) {
      res.status(404).json({ error: "Product not found" });
      return;
    }
    res.json(product);
  });

  // PATCH /products/:id/archive - Archive/unarchive a product
  router.patch("/products/:id/archive", requireAdmin, require2faEnrolled, (req: Request, res: Response) => {
    const id = parseInt(req.params.id as string, 10);
    if (isNaN(id)) {
      res.status(400).json({ error: "Invalid product ID" });
      return;
    }
    const { isArchived } = req.body;
    if (typeof isArchived !== "boolean") {
      res.status(400).json({ error: "isArchived must be a boolean" });
      return;
    }
    const product = setProductArchived(getDb(), id, isArchived);
    if (!product) {
      res.status(404).json({ error: "Product not found" });
      return;
    }
    res.json(product);
  });

  // ===== Manufacturer Contact Routes =====

  // GET /manufacturers/by-name/:name - Get manufacturer with contacts
  router.get("/manufacturers/by-name/:name", requireAdmin, require2faEnrolled, (req: Request, res: Response) => {
    const cDb = getContactsDb();
    if (!cDb) {
      res.status(503).json({ error: "Contacts database not available" });
      return;
    }
    const name = req.params.name as string;
    if (!name || name.length > 200 || !/^[\p{L}\p{N}\s\-&.,'"()]+$/u.test(name)) {
      res.status(400).json({ error: "Invalid manufacturer name" });
      return;
    }
    const result = getManufacturerContactsByName(cDb, name);
    if (!result) {
      res.status(404).json({ error: "Manufacturer not found" });
      return;
    }
    res.json(result);
  });

  // POST /manufacturers/:id/contacts - Add contact
  router.post("/manufacturers/:id/contacts", requireAdmin, require2faEnrolled, (req: Request, res: Response) => {
    const cDb = getContactsDb();
    if (!cDb) {
      res.status(503).json({ error: "Contacts database not available" });
      return;
    }
    const manufacturerId = parseInt(req.params.id as string, 10);
    if (isNaN(manufacturerId)) {
      res.status(400).json({ error: "Invalid manufacturer ID" });
      return;
    }
    try {
      const contact = addManufacturerContact(cDb, manufacturerId, req.body);
      res.status(201).json(contact);
    } catch (err: unknown) {
      res.status(400).json({ error: safeCrudError(err, "Failed to add contact") });
    }
  });

  // PUT /manufacturers/:id/contacts/:contactId - Update contact
  router.put("/manufacturers/:id/contacts/:contactId", requireAdmin, require2faEnrolled, (req: Request, res: Response) => {
    const cDb = getContactsDb();
    if (!cDb) {
      res.status(503).json({ error: "Contacts database not available" });
      return;
    }
    const manufacturerId = parseInt(req.params.id as string, 10);
    const contactId = parseInt(req.params.contactId as string, 10);
    if (isNaN(contactId) || isNaN(manufacturerId)) {
      res.status(400).json({ error: "Invalid contact ID" });
      return;
    }
    try {
      const contact = updateManufacturerContact(cDb, contactId, req.body, manufacturerId);
      if (!contact) {
        res.status(404).json({ error: "Contact not found" });
        return;
      }
      res.json(contact);
    } catch (err: unknown) {
      res.status(400).json({ error: safeCrudError(err, "Failed to update contact") });
    }
  });

  // DELETE /manufacturers/:id/contacts/:contactId - Delete contact
  router.delete("/manufacturers/:id/contacts/:contactId", requireAdmin, require2faEnrolled, (req: Request, res: Response) => {
    const cDb = getContactsDb();
    if (!cDb) {
      res.status(503).json({ error: "Contacts database not available" });
      return;
    }
    const manufacturerId = parseInt(req.params.id as string, 10);
    const contactId = parseInt(req.params.contactId as string, 10);
    if (isNaN(contactId) || isNaN(manufacturerId)) {
      res.status(400).json({ error: "Invalid contact ID" });
      return;
    }
    const deleted = deleteManufacturerContact(cDb, contactId, manufacturerId);
    if (!deleted) {
      res.status(404).json({ error: "Contact not found" });
      return;
    }
    res.json({ ok: true });
  });

  // ===== Rewards Routes =====

  // GET /rewards - List rewards with optional status filter and pagination
  router.get("/rewards", requireAdmin, require2faEnrolled, (req: Request, res: Response) => {
    const page = parseInt(req.query.page as string, 10) || undefined;
    const pageSize = parseInt(req.query.pageSize as string, 10) || undefined;
    const status = (req.query.status as string) || undefined;

    if (status && !["all", "available", "awarded", "claimed"].includes(status)) {
      res.status(400).json({ error: "Invalid status filter" });
      return;
    }

    const result = listRewards(getDb(), { page, pageSize, status });
    res.json(result);
  });

  // POST /rewards - Add a new reward to the pool
  router.post("/rewards", requireAdmin, require2faEnrolled, (req: Request, res: Response) => {
    try {
      const reward = addReward(getDb(), req.body, req.adminUser!.id);
      res.status(201).json(reward);
    } catch (err: unknown) {
      res.status(400).json({ error: safeCrudError(err, "Failed to create reward") });
    }
  });

  // GET /rewards/qualifying-players - Preview qualifying players for random roll.
  // Registered before /:id to avoid param matching.
  //
  // Now also accepts:
  //   - period=calendar_month + month=YYYY-MM (for calendar-month qualifying)
  //   - excludedUserIds (CSV) — filtered out before the SQL HAVING clause
  //   - excludeTestAccounts=false — opt-in to include is_test_account=1 users
  router.get("/rewards/qualifying-players", requireAdmin, require2faEnrolled, (req: Request, res: Response) => {
    const parsed = parseRollCriteriaFromQuery(req);
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    const players = getQualifyingPlayers(getDb(), parsed.criteria);
    res.json({ players, total: players.length });
  });

  // GET /rewards/search-users - Search users by username for manual award
  router.get("/rewards/search-users", requireAdmin, require2faEnrolled, (req: Request, res: Response) => {
    const q = (req.query.q as string) || "";
    if (!q || q.length > 100) {
      res.json([]);
      return;
    }
    const users = searchUsers(getDb(), q);
    res.json(users);
  });

  // GET /rewards/:id - Get reward details
  router.get("/rewards/:id", requireAdmin, require2faEnrolled, (req: Request, res: Response) => {
    const id = req.params.id as string;
    const reward = getReward(getDb(), id);
    if (!reward) {
      res.status(404).json({ error: "Reward not found" });
      return;
    }
    res.json(reward);
  });

  // DELETE /rewards/:id - Delete an available reward
  router.delete("/rewards/:id", requireAdmin, require2faEnrolled, (req: Request, res: Response) => {
    const id = req.params.id as string;
    const deleted = deleteReward(getDb(), id);
    if (!deleted) {
      res.status(404).json({ error: "Reward not found or already awarded" });
      return;
    }
    res.json({ ok: true });
  });

  // POST /rewards/:id/award - Manually award a reward to a user
  router.post("/rewards/:id/award", requireAdmin, require2faEnrolled, (req: Request, res: Response) => {
    const id = req.params.id as string;
    const { userId } = req.body;
    if (!userId || typeof userId !== "string") {
      res.status(400).json({ error: "userId is required" });
      return;
    }

    try {
      const reward = awardRewardToUser(getDb(), id, userId, req.adminUser!.id);
      res.json(reward);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Award failed";
      const status = message === "Reward not found" || message === "User not found" ? 404 : 400;
      res.status(status).json({ error: safeCrudError(err, "Failed to award reward") });
    }
  });

  // POST /rewards/random-roll - Phase 1 of the two-phase roll. Picks a
  // candidate winner + writes a pending-review award row but sends NO
  // notification emails. The admin must follow up with confirm or
  // discard.
  router.post("/rewards/random-roll", requireAdmin, require2faEnrolled, (req: Request, res: Response) => {
    const { rewardId, criteria } = req.body ?? {};
    if (!rewardId || typeof rewardId !== "string") {
      res.status(400).json({ error: "rewardId is required" });
      return;
    }
    const parsed = parseRollCriteriaFromBody(criteria);
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error });
      return;
    }

    try {
      const result = previewRandomRoll(getDb(), rewardId, parsed.criteria, req.adminUser!.id);
      res.json({
        candidateAward: result.candidateAward,
        reward: result.reward,
        totalQualifying: result.totalQualifying,
        nonWinnerNotifyCount: result.nonWinners.length,
      });
    } catch (err: unknown) {
      res.status(400).json({ error: safeCrudError(err, "Random roll failed") });
    }
  });

  // POST /rewards/awards/:awardId/confirm - Phase 2: confirm a pending
  // award. Sends winner + non-winner emails and starts the claim window.
  router.post(
    "/rewards/awards/:awardId/confirm",
    requireAdmin,
    require2faEnrolled,
    (req: Request, res: Response) => {
      const awardId = req.params.awardId as string;
      try {
        const reward = confirmPendingAward(getDb(), awardId, req.adminUser!.id);
        res.json({ ok: true, reward });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : "Confirm failed";
        const status = message === "Award not found" ? 404 : 400;
        res.status(status).json({ error: safeCrudError(err, "Failed to confirm award") });
      }
    },
  );

  // POST /rewards/awards/:awardId/discard - Phase 2 alt: discard the
  // pending award. Removes the row, returns the reward to the pool, and
  // sends NO emails.
  router.post(
    "/rewards/awards/:awardId/discard",
    requireAdmin,
    require2faEnrolled,
    (req: Request, res: Response) => {
      const awardId = req.params.awardId as string;
      try {
        discardPendingAward(getDb(), awardId, req.adminUser!.id);
        res.json({ ok: true });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : "Discard failed";
        const status = message === "Award not found" ? 404 : 400;
        res.status(status).json({ error: safeCrudError(err, "Failed to discard award") });
      }
    },
  );

  // ===== Promo Banner Routes =====

  // GET /banner - Get current promo banner settings
  router.get("/banner", requireAdmin, require2faEnrolled, (_req: Request, res: Response) => {
    res.json(getPromoBanner(getDb()));
  });

  // PUT /banner - Update promo banner settings
  router.put("/banner", requireAdmin, require2faEnrolled, (req: Request, res: Response) => {
    const {
      enabled,
      text,
      linkText,
      linkUrl,
      audienceMode,
      showLink,
      showGiveawayModal,
      giveawayMinPoints,
      giveawayMinStreak,
      giveawayQualifyMode,
      showTracker,
      qualifiedMessage,
    } = req.body;

    if (text !== undefined && (typeof text !== "string" || text.length > 500)) {
      res.status(400).json({ error: "Banner text must be a string under 500 characters" });
      return;
    }
    if (linkText !== undefined && (typeof linkText !== "string" || linkText.length > 100)) {
      res.status(400).json({ error: "Link text must be a string under 100 characters" });
      return;
    }
    if (linkUrl !== undefined) {
      if (typeof linkUrl !== "string" || linkUrl.length > 500) {
        res.status(400).json({ error: "Link URL must be a string under 500 characters" });
        return;
      }
      // Prevent open redirect: linkUrl must be a relative path (starts with "/" but not "//")
      if (linkUrl && (!linkUrl.startsWith("/") || linkUrl.startsWith("//"))) {
        res.status(400).json({ error: "Link URL must be a relative path starting with /" });
        return;
      }
    }
    if (enabled !== undefined && typeof enabled !== "boolean") {
      res.status(400).json({ error: "enabled must be a boolean" });
      return;
    }
    if (audienceMode !== undefined && !["all", "logged_in"].includes(audienceMode)) {
      res.status(400).json({ error: "audienceMode must be 'all' or 'logged_in'" });
      return;
    }
    if (showLink !== undefined && typeof showLink !== "boolean") {
      res.status(400).json({ error: "showLink must be a boolean" });
      return;
    }
    if (showGiveawayModal !== undefined && typeof showGiveawayModal !== "boolean") {
      res.status(400).json({ error: "showGiveawayModal must be a boolean" });
      return;
    }
    if (giveawayMinPoints !== undefined && (typeof giveawayMinPoints !== "number" || giveawayMinPoints < 0 || !Number.isInteger(giveawayMinPoints))) {
      res.status(400).json({ error: "giveawayMinPoints must be a non-negative integer" });
      return;
    }
    if (giveawayMinStreak !== undefined && (typeof giveawayMinStreak !== "number" || giveawayMinStreak < 0 || !Number.isInteger(giveawayMinStreak))) {
      res.status(400).json({ error: "giveawayMinStreak must be a non-negative integer" });
      return;
    }
    if (giveawayQualifyMode !== undefined) {
      const validModes = ["points_only", "streak_only", "points_and_streak", "points_or_streak"];
      if (typeof giveawayQualifyMode !== "string" || !validModes.includes(giveawayQualifyMode)) {
        res.status(400).json({ error: "giveawayQualifyMode must be one of points_only, streak_only, points_and_streak, points_or_streak" });
        return;
      }
    }

    if (showTracker !== undefined && typeof showTracker !== "boolean") {
      res.status(400).json({ error: "showTracker must be a boolean" });
      return;
    }
    if (qualifiedMessage !== undefined && (typeof qualifiedMessage !== "string" || qualifiedMessage.length > 500)) {
      res.status(400).json({ error: "qualifiedMessage must be a string under 500 characters" });
      return;
    }

    const updated = updatePromoBanner(getDb(), {
      enabled,
      text,
      linkText,
      linkUrl,
      audienceMode,
      showLink,
      showGiveawayModal,
      giveawayMinPoints,
      giveawayMinStreak,
      giveawayQualifyMode,
      showTracker,
      qualifiedMessage,
    });
    res.json(updated);
  });

  // ===== Game Mode Settings Routes =====

  // GET /game-modes - Get all game modes and which are disabled
  router.get("/game-modes", requireAdmin, require2faEnrolled, (_req: Request, res: Response) => {
    const disabledModes = getDisabledGameModes(getDb());
    res.json({ modes: GAME_MODES, disabledModes });
  });

  // PUT /game-modes - Update disabled game modes
  router.put("/game-modes", requireAdmin, require2faEnrolled, (req: Request, res: Response) => {
    const { disabledModes } = req.body;
    if (!Array.isArray(disabledModes)) {
      res.status(400).json({ error: "disabledModes must be an array" });
      return;
    }
    if (!disabledModes.every((m: unknown) => typeof m === "string")) {
      res.status(400).json({ error: "All entries in disabledModes must be strings" });
      return;
    }
    for (const m of disabledModes) {
      if (!VALID_GAME_MODES.has(m)) {
        res.status(400).json({ error: `Invalid game mode: ${m}` });
        return;
      }
    }
    try {
      const saved = setDisabledGameModes(getDb(), disabledModes);
      res.json({ modes: GAME_MODES, disabledModes: saved });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to update game modes";
      res.status(400).json({ error: message });
    }
  });

  // ===== Auto-Lobby Settings Routes =====

  // GET /auto-lobbies - Read the current auto-lobby system configuration.
  router.get("/auto-lobbies", requireAdmin, require2faEnrolled, (_req: Request, res: Response) => {
    res.json({ settings: getAutoLobbySettings(getDb()) });
  });

  // PUT /auto-lobbies - Partial-merge update. setAutoLobbySettings() does its
  // own clamping/normalization, so the route just rejects non-object bodies
  // and forwards the rest.
  router.put("/auto-lobbies", requireAdmin, require2faEnrolled, (req: Request, res: Response) => {
    const body = req.body;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      res.status(400).json({ error: "Body must be an object" });
      return;
    }
    try {
      const saved = setAutoLobbySettings(getDb(), body);
      res.json({ settings: saved });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to update auto-lobby settings";
      res.status(400).json({ error: message });
    }
  });

  // ===== Ghost Users Routes (PR A foundation; full CRUD in PR B) =====

  // GET /ghost-users/settings — current admin config.
  router.get("/ghost-users/settings", requireAdmin, require2faEnrolled, (_req: Request, res: Response) => {
    res.json({ settings: getGhostSettings(getDb()) });
  });

  // PUT /ghost-users/settings — partial-merge update with clamping.
  router.put("/ghost-users/settings", requireAdmin, require2faEnrolled, (req: Request, res: Response) => {
    const body = req.body;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      res.status(400).json({ error: "Body must be an object" });
      return;
    }
    try {
      const saved = setGhostSettings(getDb(), body);
      res.json({ settings: saved });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to update ghost-user settings";
      res.status(400).json({ error: message });
    }
  });

  // GET /ghost-users — paginated roster (admin tab data source). PR B
  // adds bulk-create / patch / delete routes; this read-only endpoint is
  // shipped now so admins can curl-inspect the roster post-merge while
  // the system is dark.
  router.get("/ghost-users", requireAdmin, require2faEnrolled, (req: Request, res: Response) => {
    const limit = Math.max(1, Math.min(parseInt(String(req.query.limit ?? "100"), 10) || 100, 500));
    const offset = Math.max(0, parseInt(String(req.query.offset ?? "0"), 10) || 0);
    const ghosts = listGhosts(getDb(), { limit, offset });
    res.json({ ghosts });
  });

  // POST /ghost-users/bulk — bulk-create N ghosts. Body: { count: number }.
  // Hard-caps at 500 per call (matches the service-layer BULK_CREATE_MAX).
  // Above that, we 400 rather than silently clamp so the admin UX shows
  // the rejection instead of a confusing "asked for 9999, got 500".
  router.post("/ghost-users/bulk", requireAdmin, require2faEnrolled, (req: Request, res: Response) => {
    const count = parseInt(String((req.body as { count?: unknown })?.count ?? "0"), 10);
    if (!Number.isFinite(count) || count <= 0) {
      res.status(400).json({ error: "count must be a positive integer" });
      return;
    }
    if (count > 500) {
      res.status(400).json({ error: "count must be 500 or fewer per call" });
      return;
    }
    try {
      const created = bulkCreateGhosts(getDb(), count);
      res.json({ created: created.length, ghosts: created });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to create ghost users";
      res.status(500).json({ error: message });
    }
  });

  // PATCH /ghost-users/:id — update is_active (deactivate / reactivate)
  // and optionally force-end the current shift. Limited surface area on
  // purpose: rename / avatar change are not exposed because regenerating
  // the persona is cheaper than mutating it (mutation would invalidate
  // the reservedNames cache in a path that's already covered by
  // bulk-create / delete).
  router.patch("/ghost-users/:id", requireAdmin, require2faEnrolled, (req: Request, res: Response) => {
    const id = String(req.params.id ?? "");
    if (!id) {
      res.status(400).json({ error: "id required" });
      return;
    }
    const ghost = getGhostById(getDb(), id);
    if (!ghost) {
      res.status(404).json({ error: "ghost not found" });
      return;
    }
    const body = (req.body ?? {}) as { isActive?: unknown; endShift?: unknown };

    // Tight validation: every supplied field must match the expected
    // type. Silently ignoring `isActive: "true"` (string) would let a
    // bad client think it had updated the ghost when nothing changed.
    const hasIsActive = "isActive" in body && body.isActive !== undefined;
    const hasEndShift = "endShift" in body && body.endShift !== undefined;
    if (hasIsActive && typeof body.isActive !== "boolean") {
      res.status(400).json({ error: "isActive must be a boolean" });
      return;
    }
    if (hasEndShift && typeof body.endShift !== "boolean") {
      res.status(400).json({ error: "endShift must be a boolean" });
      return;
    }
    if (!hasIsActive && !hasEndShift) {
      res.status(400).json({ error: "body must include isActive and/or endShift" });
      return;
    }

    // Wrap the two writes in a single transaction so a partial failure
    // can't leave the row in an inconsistent state (e.g. is_active=0 but
    // on_shift=1). Idempotent under concurrent admin clicks because the
    // updates are simple column writes guarded by row id.
    getDb().transaction(() => {
      if (hasIsActive) {
        setGhostActive(getDb(), id, body.isActive as boolean);
      }
      if (hasEndShift && body.endShift === true) {
        setShiftState(getDb(), id, {
          onShift: false,
          startedAt: null,
          endsAt: null,
        });
      }
    })();

    res.json({ ghost: getGhostById(getDb(), id) });
  });

  // DELETE /ghost-users/:id — hard-delete. Cascades ghost_game_history
  // via the FK; also nulls ghost_user_id on any mp_players /
  // mp_leaderboard rows still pointing at the deleted ghost.
  router.delete("/ghost-users/:id", requireAdmin, require2faEnrolled, (req: Request, res: Response) => {
    const id = String(req.params.id ?? "");
    if (!id) {
      res.status(400).json({ error: "id required" });
      return;
    }
    const ghost = getGhostById(getDb(), id);
    if (!ghost) {
      res.status(404).json({ error: "ghost not found" });
      return;
    }
    deleteGhost(getDb(), id);
    res.json({ deleted: true, id });
  });

  // POST /ghost-users/simulate-daily-now — manual trigger for the daily-
  // play simulator. Body: { date?: "YYYY-MM-DD", onShiftOnly?: boolean }.
  // Defaults: today's UTC date; onShiftOnly=false so admins can fire the
  // simulator on demand without waiting for shift rotation (useful for
  // sandbox / demo). The production hourly tick uses the default
  // `onShiftOnly=true` so daily plays trickle out across the day.
  // Returns the SimulationResult counters so the admin can see exactly
  // what happened (ghosts processed, plays written, streaks capped,
  // never-played rows cleaned).
  router.post("/ghost-users/simulate-daily-now", requireAdmin, require2faEnrolled, (req: Request, res: Response) => {
    const dateRaw = (req.body?.date as string | undefined) ?? undefined;
    const today = new Date().toISOString().slice(0, 10);
    let date = today;
    if (dateRaw !== undefined) {
      // Strict YYYY-MM-DD shape so a typo doesn't silently get accepted
      // as the year-3000 string. Range-check the parsed date too — a
      // syntactically valid string like "2026-13-99" would otherwise
      // produce a garbage timestamp downstream.
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateRaw)) {
        res.status(400).json({ error: "date must be in YYYY-MM-DD format" });
        return;
      }
      const dt = new Date(`${dateRaw}T00:00:00Z`);
      if (Number.isNaN(dt.getTime()) || dt.toISOString().slice(0, 10) !== dateRaw) {
        res.status(400).json({ error: "date is not a valid calendar date" });
        return;
      }
      date = dateRaw;
    }
    // Admin path defaults to bypassing the on-shift filter so a manual
    // trigger always fires — but lets the caller opt in to the strict
    // production behavior with `{ onShiftOnly: true }` to verify shift
    // gating on the sandbox.
    const onShiftOnly = req.body?.onShiftOnly === true;
    const result = simulateGhostDailyPlays(getDb(), date, { onShiftOnly });
    res.json(result);
  });

  // POST /ghost-users/kill-switch — emergency disable. Sets killSwitch
  // flag (which short-circuits isGhostSystemEnabled) AND immediately
  // ends every on-shift ghost. Used for the "Reddit thread emergency"
  // path so a single click stops everything.
  router.post("/ghost-users/kill-switch", requireAdmin, require2faEnrolled, (_req: Request, res: Response) => {
    // Atomic: setGhostSettings and endAllShifts in a single transaction
    // so the manager tick can't observe killSwitch=true with shifts
    // still live (or, conversely, shifts ended but killSwitch=false).
    let evicted = 0;
    getDb().transaction(() => {
      setGhostSettings(getDb(), { killSwitch: true });
      evicted = endAllShifts(getDb());
    })();
    res.json({ killSwitchActive: true, evictedShifts: evicted });
  });

  // ===== Avatar Settings Routes =====

  // GET /avatars - Get all avatars with their enabled/disabled status and user counts
  router.get("/avatars", requireAdmin, require2faEnrolled, (_req: Request, res: Response) => {
    const disabledAvatars = getDisabledAvatars(getDb());
    const rows = getDb()
      .prepare("SELECT avatar, COUNT(*) as count FROM users WHERE avatar IS NOT NULL AND is_active = 1 GROUP BY avatar")
      .all() as { avatar: string; count: number }[];
    const userCounts: Record<string, number> = {};
    for (const row of rows) {
      userCounts[row.avatar] = row.count;
    }
    res.json({ avatars: AVATARS, labels: AVATAR_LABELS, disabledAvatars, userCounts });
  });

  // PUT /avatars - Update disabled avatars
  router.put("/avatars", requireAdmin, require2faEnrolled, (req: Request, res: Response) => {
    const { disabledAvatars } = req.body;
    if (!Array.isArray(disabledAvatars)) {
      res.status(400).json({ error: "disabledAvatars must be an array" });
      return;
    }
    if (!disabledAvatars.every((a: unknown) => typeof a === "string")) {
      res.status(400).json({ error: "All entries in disabledAvatars must be strings" });
      return;
    }
    for (const a of disabledAvatars) {
      if (!isValidProfileAvatar(a)) {
        res.status(400).json({ error: `Invalid avatar: ${a}` });
        return;
      }
    }
    try {
      const saved = setDisabledAvatars(getDb(), disabledAvatars);
      const rows = getDb()
        .prepare("SELECT avatar, COUNT(*) as count FROM users WHERE avatar IS NOT NULL AND is_active = 1 GROUP BY avatar")
        .all() as { avatar: string; count: number }[];
      const userCounts: Record<string, number> = {};
      for (const row of rows) {
        userCounts[row.avatar] = row.count;
      }
      res.json({ avatars: AVATARS, labels: AVATAR_LABELS, disabledAvatars: saved, userCounts });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to update avatar settings";
      res.status(400).json({ error: message });
    }
  });

  // ===== Legal Document Routes =====

  // GET /legal/:key - Get a legal document (privacy_policy or terms_of_service)
  router.get("/legal/:key", requireAdmin, require2faEnrolled, (req: Request, res: Response) => {
    const { key } = req.params;
    if (key !== "privacy_policy" && key !== "terms_of_service") {
      res.status(404).json({ error: "Not found" });
      return;
    }
    try {
      const content = getLegalDocument(getDb(), key);
      res.json({ key, content });
    } catch {
      res.json({ key, content: "" });
    }
  });

  // PUT /legal/:key - Update a legal document
  router.put("/legal/:key", requireAdmin, require2faEnrolled, (req: Request, res: Response) => {
    const { key } = req.params;
    if (key !== "privacy_policy" && key !== "terms_of_service") {
      res.status(404).json({ error: "Not found" });
      return;
    }

    const { content } = req.body;
    if (typeof content !== "string") {
      res.status(400).json({ error: "content must be a string" });
      return;
    }
    // Cap at 100KB to prevent abuse
    if (content.length > 100_000) {
      res.status(400).json({ error: "Content exceeds maximum length of 100,000 characters" });
      return;
    }

    try {
      setLegalDocument(getDb(), key, content);
      res.json({ key, ok: true });
    } catch {
      res.status(500).json({ error: "Failed to save legal document" });
    }
  });

  // ===== Site Content Routes (About, FAQ, Contact) =====

  // GET /content/:key - Load an editable site content document.
  router.get("/content/:key", requireAdmin, require2faEnrolled, (req: Request, res: Response) => {
    const key = typeof req.params.key === "string" ? req.params.key : "";
    if (key !== "about" && key !== "faq" && key !== "contact") {
      res.status(404).json({ error: "Not found" });
      return;
    }
    try {
      const content = getSiteContent(getDb(), key);
      res.json(content);
    } catch {
      res.status(500).json({ error: "Failed to load content" });
    }
  });

  // PUT /content/:key - Replace an editable site content document.
  router.put("/content/:key", requireAdmin, require2faEnrolled, (req: Request, res: Response) => {
    const key = typeof req.params.key === "string" ? req.params.key : "";
    if (key !== "about" && key !== "faq" && key !== "contact") {
      res.status(404).json({ error: "Not found" });
      return;
    }
    try {
      const saved = setSiteContent(getDb(), key, req.body);
      res.json({ key, ok: true, content: saved });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to save content";
      res.status(400).json({ error: msg });
    }
  });

  // ===== Public Page Visibility Routes =====

  // GET /pages - Load the enabled/disabled map for the six SEO pages.
  router.get("/pages", requireAdmin, require2faEnrolled, (_req: Request, res: Response) => {
    try {
      res.json({ pages: getEnabledPages(getDb()) });
    } catch {
      res.status(500).json({ error: "Failed to load page visibility" });
    }
  });

  // PUT /pages - Replace the enabled/disabled map for the six SEO pages.
  router.put("/pages", requireAdmin, require2faEnrolled, (req: Request, res: Response) => {
    try {
      const saved = setEnabledPages(getDb(), req.body?.pages);
      res.json({ pages: saved });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to save page visibility";
      res.status(400).json({ error: msg });
    }
  });

  // ===== User Management Routes =====
  // Note: /analytics/games-for-date, /analytics/user-registrations,
  // /analytics/user-retention, /analytics/top-players were deleted in PR
  // #209 alongside the v1 dashboard. Their replacements live under
  // /admin/analytics/v2/* — see Insights → Retention / Engagement / Geo.

  // GET /users - Paginated user list with search/filter/sort
  router.get("/users", requireAdmin, require2faEnrolled, (req: Request, res: Response) => {
    const page = parseInt(req.query.page as string, 10) || undefined;
    const pageSize = parseInt(req.query.pageSize as string, 10) || undefined;
    const search = (req.query.search as string) || undefined;
    const sortBy = (req.query.sortBy as string) || undefined;
    const sortOrder = (req.query.sortOrder as string) || undefined;

    let isActive: boolean | undefined;
    if (req.query.isActive === "true") isActive = true;
    else if (req.query.isActive === "false") isActive = false;

    const validSortBy = ["username", "email", "created_at", "lifetime_score", "last_login_at"];
    if (sortBy && !validSortBy.includes(sortBy)) {
      res.status(400).json({ error: "Invalid sortBy value" });
      return;
    }
    if (sortOrder && sortOrder !== "asc" && sortOrder !== "desc") {
      res.status(400).json({ error: "sortOrder must be 'asc' or 'desc'" });
      return;
    }

    type UserSortBy = AdminUserListParams["sortBy"];
    const result = listUsers(getDb(), {
      page,
      pageSize,
      search,
      isActive,
      sortBy: sortBy as UserSortBy,
      sortOrder: sortOrder as "asc" | "desc",
    });
    res.json(result);
  });

  // GET /users/:id/game-history - User's paginated game history
  // Registered before /:id to avoid param matching.
  router.get("/users/:id/game-history", requireAdmin, require2faEnrolled, (req: Request, res: Response) => {
    const id = req.params.id as string;
    const page = parseInt(req.query.page as string, 10) || 1;
    const pageSize = parseInt(req.query.pageSize as string, 10) || 20;
    const result = getUserGameHistoryPaginated(getDb(), id, page, pageSize);
    res.json(result);
  });

  // GET /users/:id/stats - User's aggregate game stats
  router.get("/users/:id/stats", requireAdmin, require2faEnrolled, (req: Request, res: Response) => {
    const id = req.params.id as string;
    const result = getUserStatsById(getDb(), id);
    res.json(result);
  });

  // GET /users/:id/activity - User's daily game activity
  router.get("/users/:id/activity", requireAdmin, require2faEnrolled, (req: Request, res: Response) => {
    const id = req.params.id as string;
    const days = Math.min(Math.max(parseInt(req.query.days as string, 10) || 30, 1), 365);
    const timeZone = parseTimeZoneQuery(req.query.tz);
    res.json(getUserActivity(getDb(), id, days, timeZone));
  });

  // POST /users/:id/deactivate - Deactivate a user account
  router.post("/users/:id/deactivate", requireAdmin, require2faEnrolled, (req: Request, res: Response) => {
    const id = req.params.id as string;
    const result = deactivateUser(getDb(), id);
    if (!result) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    res.json(result);
  });

  // POST /users/:id/reactivate - Reactivate a user account
  router.post("/users/:id/reactivate", requireAdmin, require2faEnrolled, (req: Request, res: Response) => {
    const id = req.params.id as string;
    const result = reactivateUser(getDb(), id);
    if (!result) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    res.json(result);
  });

  // POST /users/:id/reset-password - Force password reset
  router.post("/users/:id/reset-password", requireAdmin, require2faEnrolled, (req: Request, res: Response) => {
    const id = req.params.id as string;
    const tempPassword = forceResetPassword(getDb(), id);
    if (!tempPassword) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    res.json({ temporaryPassword: tempPassword });
  });

  // GET /users/:id - Get single user details
  router.get("/users/:id", requireAdmin, require2faEnrolled, (req: Request, res: Response) => {
    const id = req.params.id as string;
    const user = getUserById(getDb(), id);
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    res.json(user);
  });

  // PUT /users/:id - Update user profile
  router.put("/users/:id", requireAdmin, require2faEnrolled, (req: Request, res: Response) => {
    const id = req.params.id as string;
    const { username, email, isActive } = req.body;

    if (username !== undefined) {
      if (typeof username !== "string" || username.length === 0) {
        res.status(400).json({ error: "Username must be a non-empty string" });
        return;
      }
      if (username.length > 64) {
        res.status(400).json({ error: "Username exceeds maximum length of 64 characters" });
        return;
      }
    }
    if (email !== undefined) {
      if (typeof email !== "string" || email.length === 0) {
        res.status(400).json({ error: "Email must be a non-empty string" });
        return;
      }
      if (email.length > 254) {
        res.status(400).json({ error: "Email exceeds maximum length of 254 characters" });
        return;
      }
    }
    if (isActive !== undefined && typeof isActive !== "boolean") {
      res.status(400).json({ error: "isActive must be a boolean" });
      return;
    }

    try {
      const result = updateUser(getDb(), id, { username, email, isActive });
      if (!result) {
        res.status(404).json({ error: "User not found" });
        return;
      }
      res.json(result);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Update failed";
      const safeMessages = new Set(["Username is already taken", "Email is already in use"]);
      res.status(400).json({ error: safeMessages.has(message) ? message : "Update failed" });
    }
  });

  // DELETE /users/:id - Permanently delete user
  router.delete("/users/:id", requireAdmin, require2faEnrolled, (req: Request, res: Response) => {
    const id = req.params.id as string;
    const deleted = deleteUser(getDb(), id);
    if (!deleted) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    res.json({ ok: true });
  });

  // ===== Extension Routes =====

  // POST /extension/login - Authenticate and return token in body (no cookie)
  router.post("/extension/login", (req: Request, res: Response) => {
    const { username, password } = req.body;

    if (typeof username !== "string" || typeof password !== "string" || !username || !password) {
      res.status(400).json({ error: "Username and password are required" });
      return;
    }

    if (username.length > 128 || password.length > 1024) {
      res.status(400).json({ error: "Input too long" });
      return;
    }

    try {
      const ip = req.ip || req.socket.remoteAddress || "unknown";
      const userAgent = req.headers["user-agent"] || "unknown";
      const result = adminLogin(getDb(), username, password, ip, userAgent);

      if (result.requiresTwoFactor) {
        // Check extension permission before issuing pending token
        if (!result.user.canUseExtension) {
          res.status(403).json({ error: "Extension access not permitted" });
          return;
        }
        res.json({ user: result.user, requiresTwoFactor: true, pendingToken: result.pendingToken });
        return;
      }

      if (!result.user.canUseExtension) {
        destroyAdminSession(getDb(), result.token);
        res.status(403).json({ error: "Extension access not permitted" });
        return;
      }

      res.json({ token: result.token, user: result.user });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Login failed";
      if (message === "Account is temporarily locked") {
        res.status(429).json({ error: message });
      } else {
        res.status(401).json({ error: SAFE_LOGIN_ERRORS.has(message) ? message : "Login failed" });
      }
    }
  });

  // POST /extension/login/verify-2fa - Complete 2FA for extension login
  router.post("/extension/login/verify-2fa", (req: Request, res: Response) => {
    const { pendingToken, code, isRecoveryCode } = req.body;

    if (typeof pendingToken !== "string" || typeof code !== "string" || !pendingToken || !code) {
      res.status(400).json({ error: "Pending token and code are required" });
      return;
    }

    if (pendingToken.length > 128 || code.length > 32) {
      res.status(400).json({ error: "Input too long" });
      return;
    }

    try {
      const ip = req.ip || req.socket.remoteAddress || "unknown";
      const userAgent = req.headers["user-agent"] || "unknown";
      const result = adminLoginVerify2fa(getDb(), pendingToken, code, !!isRecoveryCode, ip, userAgent);

      if (!result.user.canUseExtension) {
        destroyAdminSession(getDb(), result.token);
        res.status(403).json({ error: "Extension access not permitted" });
        return;
      }

      // Extension uses Bearer tokens, not cookies
      res.json({ token: result.token, user: result.user });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Verification failed";
      if (message === "Account is temporarily locked") {
        res.status(429).json({ error: message });
      } else if (message === "Pending token expired or invalid") {
        res.status(401).json({ error: message });
      } else {
        res.status(401).json({ error: SAFE_LOGIN_ERRORS.has(message) ? message : "Verification failed" });
      }
    }
  });

  // GET /extension/verify - Check if the current session token is still valid.
  // PR3 sec M2: requireExtensionAdmin enforces Bearer-only auth + the
  // canUseExtension permission flag. Reusing the dashboard requireAdmin
  // here would have allowed a leaked extension token (lives in
  // chrome.storage.local) to be replayed as a Bearer to any other
  // admin endpoint.
  router.get("/extension/verify", requireExtensionAdmin, (_req: Request, res: Response) => {
    res.json({ ok: true, user: _req.adminUser });
  });

  // POST /extension/import - Import/upsert a product by ASIN.
  // Bearer-only via requireExtensionAdmin (PR3 sec M2 — see /extension/verify).
  router.post("/extension/import", requireExtensionAdmin, (req: Request, res: Response) => {
    try {
      const result = upsertProductByAsin(getDb(), req.body);
      res.status(result.created ? 201 : 200).json(result);
    } catch (err: unknown) {
      res.status(400).json({ error: safeCrudError(err, "Import failed") });
    }
  });

  // GET /extension/download - Download the Chrome extension as a zip file
  router.get("/extension/download", requireAdmin, require2faEnrolled, (_req: Request, res: Response) => {
    const path = require("path");
    const fs = require("fs");
    const archiver = require("archiver");

    const extDir = path.resolve(__dirname, "../../../extension");
    const distDir = path.join(extDir, "dist");
    const manifestPath = path.join(extDir, "manifest.json");
    const iconsDir = path.join(extDir, "icons");

    if (!fs.existsSync(distDir) || !fs.existsSync(manifestPath)) {
      res.status(404).json({ error: "Extension build not found. Run npm run build in apps/extension first." });
      return;
    }

    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", "attachment; filename=price-games-extension.zip");

    const archive = archiver("zip", { zlib: { level: 9 } });
    archive.on("error", (err: Error) => {
      console.error("Archiver error:", err);
      if (!res.headersSent) res.status(500).json({ error: "Failed to generate archive" });
      else res.destroy();
    });
    archive.pipe(res);

    archive.directory(distDir, false);
    archive.file(manifestPath, { name: "manifest.json" });
    if (fs.existsSync(iconsDir)) {
      archive.directory(iconsDir, "icons");
    }

    archive.finalize();
  });

  // ===== UTM Tag Management Routes =====

  // GET /utm-tags - List UTM tag presets with pagination, status filter,
  // and origin filter ('admin' default | 'system' | 'all').
  router.get("/utm-tags", requireAdmin, require2faEnrolled, (req: Request, res: Response) => {
    const page = parseInt(req.query.page as string, 10) || undefined;
    const pageSize = parseInt(req.query.pageSize as string, 10) || undefined;
    const status = (req.query.status as string) || undefined;
    const origin = (req.query.origin as string) || undefined;

    try {
      const result = listUtmTags(getDb(), { page, pageSize, status, origin });
      res.json(result);
    } catch (err: unknown) {
      res.status(400).json({ error: safeCrudError(err, "Failed to list UTM tags") });
    }
  });

  // POST /utm-tags - Create a new UTM tag preset
  router.post("/utm-tags", requireAdmin, require2faEnrolled, (req: Request, res: Response) => {
    try {
      const tag = createUtmTag(getDb(), req.body, req.adminUser!.id);
      res.status(201).json(tag);
    } catch (err: unknown) {
      res.status(400).json({ error: safeCrudError(err, "Failed to create UTM tag") });
    }
  });

  // GET /utm-tags/short-code/suggest - Propose a fresh short code suggestion.
  // MUST be registered before /utm-tags/:id so Express does not treat
  // "short-code" as an :id parameter.
  router.get(
    "/utm-tags/short-code/suggest",
    requireAdmin,
    require2faEnrolled,
    (_req: Request, res: Response) => {
      try {
        const code = generateShortCodeSuggestion(getDb());
        res.json({ code });
      } catch (err: unknown) {
        res.status(500).json({ error: safeCrudError(err, "Failed to generate short code") });
      }
    },
  );

  // GET /utm-tags/comparison - Cross-tag leaderboard powering the
  // upgraded admin dashboard. MUST be registered before /utm-tags/:id
  // so Express does not treat "comparison" as an :id (mirroring the
  // /utm-tags/short-code/suggest pattern above).
  router.get(
    "/utm-tags/comparison",
    requireAdmin,
    require2faEnrolled,
    (req: Request, res: Response) => {
      const range = parseUtmRange(req.query.range);
      if (range == null) {
        res.status(400).json({ error: "range must be 7, 28, or 90" });
        return;
      }
      const origin = parseUtmComparisonOrigin(req.query.origin);
      if (origin == null) {
        res.status(400).json({ error: "origin must be admin, system, or all" });
        return;
      }
      const result = getUtmTagComparison(getDb(), {
        rangeDays: range,
        origin,
      });
      res.json(result);
    },
  );

  // GET /utm-tags/:id - Fetch a single UTM tag
  router.get("/utm-tags/:id", requireAdmin, require2faEnrolled, (req: Request, res: Response) => {
    const id = req.params.id as string;
    const tag = getUtmTag(getDb(), id);
    if (!tag) {
      res.status(404).json({ error: "UTM tag not found" });
      return;
    }
    res.json(tag);
  });

  // PUT /utm-tags/:id - Update a UTM tag preset
  router.put("/utm-tags/:id", requireAdmin, require2faEnrolled, (req: Request, res: Response) => {
    const id = req.params.id as string;
    try {
      const tag = updateUtmTag(getDb(), id, req.body);
      if (!tag) {
        res.status(404).json({ error: "UTM tag not found" });
        return;
      }
      res.json(tag);
    } catch (err: unknown) {
      res.status(400).json({ error: safeCrudError(err, "Failed to update UTM tag") });
    }
  });

  // PATCH /utm-tags/:id/status - Archive or unarchive a UTM tag
  router.patch("/utm-tags/:id/status", requireAdmin, require2faEnrolled, (req: Request, res: Response) => {
    const id = req.params.id as string;
    const { status } = req.body ?? {};
    if (status !== "active" && status !== "archived") {
      res.status(400).json({ error: "Invalid status" });
      return;
    }
    try {
      const tag = setUtmTagStatus(getDb(), id, status);
      if (!tag) {
        res.status(404).json({ error: "UTM tag not found" });
        return;
      }
      res.json(tag);
    } catch (err: unknown) {
      res.status(400).json({ error: safeCrudError(err, "Failed to update UTM tag status") });
    }
  });

  // DELETE /utm-tags/:id - Hard-delete a UTM tag with no matched signups
  router.delete("/utm-tags/:id", requireAdmin, require2faEnrolled, (req: Request, res: Response) => {
    const id = req.params.id as string;
    try {
      const deleted = deleteUtmTag(getDb(), id);
      if (!deleted) {
        res.status(404).json({ error: "UTM tag not found" });
        return;
      }
      res.json({ ok: true });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Delete failed";
      // Matched-signups guard → 409 Conflict; other errors → 400.
      const status = message === "Cannot delete UTM tag with matched signups" ? 409 : 400;
      res.status(status).json({ error: safeCrudError(err, "Failed to delete UTM tag") });
    }
  });

  // GET /utm-tags/:id/stats?range=7|28|90 - Conversion funnel for a UTM tag.
  // Omitting `range` returns the lifetime view (existing default behavior).
  router.get("/utm-tags/:id/stats", requireAdmin, require2faEnrolled, (req: Request, res: Response) => {
    const id = req.params.id as string;
    const opts: { rangeDays?: number } = {};
    if (req.query.range !== undefined) {
      const range = parseUtmRange(req.query.range);
      if (range == null) {
        res.status(400).json({ error: "range must be 7, 28, or 90" });
        return;
      }
      opts.rangeDays = range;
    }
    const stats = getUtmTagStats(getDb(), id, opts);
    if (!stats) {
      res.status(404).json({ error: "UTM tag not found" });
      return;
    }
    res.json(stats);
  });

  // GET /utm-tags/:id/timeseries?range=7|28|90 - Daily traffic series.
  router.get(
    "/utm-tags/:id/timeseries",
    requireAdmin,
    require2faEnrolled,
    (req: Request, res: Response) => {
      const id = req.params.id as string;
      const range = parseUtmRange(req.query.range);
      if (range == null) {
        res.status(400).json({ error: "range must be 7, 28, or 90" });
        return;
      }
      const points = getUtmTagTimeSeries(getDb(), id, range);
      if (points == null) {
        res.status(404).json({ error: "UTM tag not found" });
        return;
      }
      res.json(points);
    },
  );

  // ─────────────────────── Daily challenge admin routes ───────────────────────
  // All gated by requireAdmin. AdminDailyError → 400 by default; specific
  // sentinels ("manual_override_protected", "no_available_mode") → 409 / 404.

  function handleAdminDailyError(err: unknown, res: Response): void {
    if (err instanceof AdminDailyError) {
      const msg = err.userMessage;
      if (msg === "manual_override_protected") {
        res.status(409).json({ error: msg });
        return;
      }
      if (msg === "no_available_mode") {
        res.status(404).json({ error: msg });
        return;
      }
      res.status(400).json({ error: msg });
      return;
    }
    res.status(500).json({ error: "Internal server error" });
  }

  // GET /api/admin/daily/overview?days=14&startDate=YYYY-MM-DD
  router.get("/daily/overview", requireAdmin, require2faEnrolled, (req: Request, res: Response) => {
    const daysRaw = req.query.days;
    let days = 14;
    if (typeof daysRaw === "string") {
      const parsed = parseInt(daysRaw, 10);
      if (Number.isFinite(parsed) && parsed > 0 && parsed <= 60) days = parsed;
    }
    let startDate: string | undefined;
    if (typeof req.query.startDate === "string" && req.query.startDate) {
      if (!isValidDailyDate(req.query.startDate)) {
        res.status(400).json({ error: "Invalid startDate format" });
        return;
      }
      startDate = req.query.startDate;
    }
    try {
      const overview = getAdminDailyOverview(getDb(), days, startDate);
      res.json(overview);
    } catch (err) {
      handleAdminDailyError(err, res);
    }
  });

  // PUT /api/admin/daily/enabled
  router.put("/daily/enabled", requireAdmin, require2faEnrolled, (req: Request, res: Response) => {
    const enabled = req.body?.enabled;
    if (typeof enabled !== "boolean") {
      res.status(400).json({ error: "enabled must be a boolean" });
      return;
    }
    try {
      const result = updateAdminDailyEnabled(getDb(), enabled);
      res.json({ enabled: result });
    } catch (err) {
      handleAdminDailyError(err, res);
    }
  });

  // PUT /api/admin/daily/schedule
  router.put("/daily/schedule", requireAdmin, require2faEnrolled, (req: Request, res: Response) => {
    const schedule = req.body?.schedule;
    try {
      const result = updateAdminDailySchedule(getDb(), schedule);
      res.json({ schedule: result });
    } catch (err) {
      handleAdminDailyError(err, res);
    }
  });

  // PUT /api/admin/daily/:date/products
  router.put("/daily/:date/products", requireAdmin, require2faEnrolled, (req: Request, res: Response) => {
    const { date } = req.params as { date: string };
    const { gameMode, productIds } = req.body ?? {};
    if (typeof gameMode !== "string") {
      res.status(400).json({ error: "gameMode is required" });
      return;
    }
    if (!Array.isArray(productIds)) {
      res.status(400).json({ error: "productIds must be an array" });
      return;
    }
    try {
      const row = setAdminDailyProducts(getDb(), date, gameMode as never, productIds);
      res.json(row);
    } catch (err) {
      handleAdminDailyError(err, res);
    }
  });

  // POST /api/admin/daily/:date/regenerate
  router.post("/daily/:date/regenerate", requireAdmin, require2faEnrolled, (req: Request, res: Response) => {
    const { date } = req.params as { date: string };
    const force = req.body?.force === true;
    try {
      const row = regenerateAdminDailyPuzzle(getDb(), date, force);
      res.json(row);
    } catch (err) {
      handleAdminDailyError(err, res);
    }
  });

  // GET /api/admin/daily/stats
  router.get("/daily/stats", requireAdmin, require2faEnrolled, (_req: Request, res: Response) => {
    try {
      const stats = getAdminDailyStats(getDb());
      res.json(stats);
    } catch (err) {
      handleAdminDailyError(err, res);
    }
  });

  // DELETE /api/admin/daily/plays/:userId/:date
  router.delete("/daily/plays/:userId/:date", requireAdmin, require2faEnrolled, (req: Request, res: Response) => {
    const { userId, date } = req.params as { userId: string; date: string };
    try {
      const result = clearAdminDailyPlay(getDb(), userId, date);
      res.json(result);
    } catch (err) {
      handleAdminDailyError(err, res);
    }
  });

  return router;
}
