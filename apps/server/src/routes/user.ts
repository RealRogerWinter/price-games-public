/**
 * User account REST API routes.
 *
 * Provides registration, login/logout, session management, email verification,
 * password/email changes, game history, and stats endpoints. Uses a factory
 * pattern so tests can inject a custom database instance.
 */

import { Router, Request, Response } from "express";
import type { Database as DatabaseType } from "better-sqlite3";
import { requireUser, optionalUser, userCookieOptions, setDb } from "../middleware/userAuth";
import {
  createUser,
  userLogin,
  destroyUserSession,
  verifyEmail,
  createEmailVerificationToken,
  changePassword,
  changeEmail,
  changeUsername,
  changeAvatar,
  rowToUserAccount,
  createPasswordResetToken,
  resetPassword,
  findUserByEmail,
} from "../services/userAuth";
import {
  sendVerificationEmail,
  sendPasswordResetEmail,
} from "../services/email";
import {
  generateOAuthState,
  validateOAuthState,
  getGoogleAuthUrl,
  exchangeGoogleCode,
  getFacebookAuthUrl,
  exchangeFacebookCode,
  getAmazonAuthUrl,
  exchangeAmazonCode,
  findOrCreateOAuthUser,
  createOAuthSession,
} from "../services/oauth";
import { getUserGameHistory, getUserStats, getUserScoreHistory } from "../services/userGameHistory";
import {
  getUserWinRecord,
  getVisitorWinRecord,
  getUserWinRecordByMode,
} from "../services/winRecordRead";
import { buildSPRecap, buildMPRecap, createShareRow } from "../services/historyRecap";
import { getPerRoundMaxScore } from "@price-game/shared";
import type { GameMode, SharedGameRecord, SharedRoundSnapshot } from "@price-game/shared";
import { getUserRewards, claimReward, claimRewardByToken } from "../services/rewards";
import { getStreakForUser } from "../services/dailyStreak";
import { VALID_GAME_MODES, parseTimeZoneQuery } from "@price-game/shared";
import { isAvatarEnabled } from "../services/siteSettings";
import { safeErrorMessage } from "../services/errors";
import { UserFacingError } from "../services/errors";
import { SAFE_LOGIN_ERRORS } from "../services/authHelpers";
import { config } from "../config";
import { createPendingReferral, getReferralDashboard } from "../services/referrals";
import { verifyTurnstileToken, isTurnstileEnabled } from "../services/turnstile";
import {
  validateAttribution,
  storeSignupAttribution,
  hasRecentSignupWithoutAttribution,
  mergeVisitorAttributionIntoUser,
} from "../services/attribution";
import { relinkPushSubscriptionsForVisitor } from "../services/pushNotification";
import { claimAnonymousDailyPlays } from "../services/dailyClaim";
import { claimAnonymousGameHistory } from "../services/gameHistoryClaim";
import { recordEventFromRequest, linkVisitorToUser } from "../services/eventLog";
import { ANALYTICS_EVENTS } from "@price-game/shared";

/** Module-level database reference; lazily resolved from ../db when not injected. */
let _db: DatabaseType;

/**
 * Return the active database instance, falling back to the default export
 * from ../db if none was injected via createUserRouter.
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
 * Create and return an Express Router with all user API endpoints.
 *
 * If a database instance is provided it will be used for all queries and
 * also forwarded to the userAuth middleware via setDb(). When omitted the
 * router lazily resolves the default database on first request.
 *
 * @param db - Optional database instance (useful for testing).
 * @returns Configured Express Router.
 */
export function createUserRouter(db?: DatabaseType): Router {
  if (db) {
    _db = db;
    setDb(db);
  }

  const router = Router();

  // GET /auth-config — Public auth feature flags read by the web app.
  // Currently exposes only `turnstileEnabled` so the registration form
  // knows whether to render the Cloudflare widget. Safe to expose publicly.
  router.get("/auth-config", (_req: Request, res: Response) => {
    res.json({ turnstileEnabled: isTurnstileEnabled() });
  });

  // POST /register — Create a new user account and set session cookie
  router.post("/register", async (req: Request, res: Response) => {
    try {
      const { username, email, password, referralCode, turnstileToken, attribution } = req.body;

      if (
        typeof username !== "string" || typeof email !== "string" || typeof password !== "string" ||
        !username || !email || !password
      ) {
        res.status(400).json({ error: "Username, email, and password are required" });
        return;
      }

      if (username.length > 128 || email.length > 256 || password.length > 1024) {
        res.status(400).json({ error: "Input too long" });
        return;
      }

      const ip = req.ip || req.socket.remoteAddress || "unknown";

      // Verify Turnstile token when the challenge is enforced on this server.
      // The isTurnstileEnabled() helper respects the SKIP_TURNSTILE=1 escape
      // hatch used by sandbox/dev deployments, so the challenge can be turned
      // off without needing to clear the secret key.
      if (isTurnstileEnabled()) {
        if (!turnstileToken || typeof turnstileToken !== "string") {
          res.status(400).json({ error: "Verification challenge is required" });
          return;
        }
        if (turnstileToken.length > 2048) {
          res.status(400).json({ error: "Invalid verification token" });
          return;
        }
        const valid = await verifyTurnstileToken(turnstileToken, ip);
        if (!valid) {
          res.status(400).json({ error: "Verification challenge failed. Please try again." });
          return;
        }
      }

      const user = createUser(getDb(), username, email, password);

      // Capture UTM attribution (marketing campaign source) if present.
      // Sanitized via validateAttribution — unknown/oversized keys are dropped.
      const sanitizedAttribution = validateAttribution(attribution);
      if (sanitizedAttribution) {
        try {
          storeSignupAttribution(getDb(), user.id, sanitizedAttribution);
        } catch (err) {
          console.error("[register] Failed to store attribution:", err);
        }
      }

      // Merge any anonymous visitor_attribution row (cookie-backed) into
      // the user. Runs AFTER the client-supplied payload so that if both
      // exist, the client-supplied one wins — but in practice the first
      // storeSignupAttribution will already have populated the row and
      // the merge's SQL guard (`utm_source IS NULL`) makes it a no-op.
      // If the client sent no payload, the cookie-backed row is the
      // authoritative source. Either way, the visitor row gets claimed
      // so it's no longer double-counted as unclaimed in funnels.
      try {
        mergeVisitorAttributionIntoUser(getDb(), user.id, req.visitorId);
      } catch (err) {
        console.error("[register] Failed to merge visitor attribution:", err);
      }

      // Auto-login: create a session
      const userAgent = req.headers["user-agent"] || "unknown";
      const result = userLogin(getDb(), email, password, ip, userAgent);

      // Re-link any push subscription on this browser to the new user.
      // Mirrors the login path (see user.ts /login for details).
      relinkPushSubscriptionsForVisitor(getDb(), req.visitorId, result.user.id);

      // Claim any daily challenge plays completed anonymously on this device.
      // Transfers daily_plays rows from visitor_id to user_id and initializes
      // the user's streak — so an anonymous player who registers keeps their
      // daily history and streak intact.
      try {
        claimAnonymousDailyPlays(getDb(), user.id, req.visitorId);
      } catch (err) {
        console.error("[register] Failed to claim anonymous daily plays:", err);
      }

      // Claim any completed single-player rounds played anonymously on this
      // device — credits the score to lifetime_score and fills in history.
      try {
        claimAnonymousGameHistory(getDb(), user.id, req.visitorId);
      } catch (err) {
        console.error("[register] Failed to claim anonymous game history:", err);
      }

      // Handle referral code — validate format matches generated codes (8 chars from CHARSET)
      if (referralCode && typeof referralCode === "string" && /^[A-Z2-9]{8}$/.test(referralCode)) {
        try {
          createPendingReferral(getDb(), user.id, referralCode, ip);
        } catch (err) {
          console.error("[register] Failed to create referral:", err);
        }
      }

      // Send verification email (fire-and-forget — don't block registration)
      const token = createEmailVerificationToken(getDb(), user.id, user.email);
      sendVerificationEmail(user.email, user.username, token).catch((err) => {
        console.error("[register] Failed to send verification email:", err);
      });

      res.cookie(config.userCookieName, result.token, userCookieOptions());
      // Analytics: log signup event and link visitor → user alias.
      linkVisitorToUser(req.visitorId, user.id, getDb());
      recordEventFromRequest(req, {
        eventName: ANALYTICS_EVENTS.USER_SIGNED_UP,
        eventType: "auth",
        userId: user.id,
        // Dedup key: signup is a once-per-user event; scope on user.id.
        clientEventId: `srv:user_signed_up:${user.id}`,
        properties: { referralCode: referralCode ?? null },
      });
      res.json({ user, emailVerificationPending: true });
    } catch (err: unknown) {
      const message = err instanceof UserFacingError ? err.message : "Registration failed";
      res.status(400).json({ error: message });
    }
  });

  // POST /login — Authenticate user and set session cookie
  router.post("/login", (req: Request, res: Response) => {
    const { identifier, password, stayLoggedIn: stayLoggedInRaw } = req.body;

    if (typeof identifier !== "string" || typeof password !== "string" || !identifier || !password) {
      res.status(400).json({ error: "Identifier and password are required" });
      return;
    }

    if (identifier.length > 256 || password.length > 1024) {
      res.status(400).json({ error: "Input too long" });
      return;
    }

    // stayLoggedIn is opt-in new, so missing is legal and means "keep
    // the historical 30-day behavior". Any explicit non-boolean value
    // is rejected to avoid silently coercing truthy strings. Note the
    // deliberate asymmetry with LoginForm: the web checkbox defaults to
    // unchecked (classic opt-in "remember me" UX) and always sends an
    // explicit `false`, while the server's fallback is `true` so legacy
    // clients and any non-form caller keep the pre-flag persistent-cookie
    // behavior unchanged. Other cookie-issuing paths in this file
    // (register auto-login, password change re-login, OAuth callback)
    // intentionally do not expose this toggle — they have no form UI
    // to carry the user's preference.
    if (stayLoggedInRaw !== undefined && typeof stayLoggedInRaw !== "boolean") {
      res.status(400).json({ error: "stayLoggedIn must be a boolean" });
      return;
    }
    const stayLoggedIn: boolean = stayLoggedInRaw ?? true;

    try {
      const ip = req.ip || req.socket.remoteAddress || "unknown";
      const userAgent = req.headers["user-agent"] || "unknown";
      const result = userLogin(getDb(), identifier, password, ip, userAgent, stayLoggedIn);

      // Re-link any push subscription registered on this browser to the new
      // user. Handles device rotation: if Alice subscribed here and then Bob
      // logs in on the same browser, the subscription should follow Bob.
      // Without this, the notification scheduler (which filters on BOTH
      // user_id and visitor_id) would keep targeting Alice.
      relinkPushSubscriptionsForVisitor(getDb(), req.visitorId, result.user.id);

      // Claim any daily challenge plays completed anonymously on this device.
      // Handles the case where a user played while logged out then logged
      // back in — their anonymous daily plays transfer to their account.
      try {
        claimAnonymousDailyPlays(getDb(), result.user.id, req.visitorId);
      } catch (err) {
        console.error("[login] Failed to claim anonymous daily plays:", err);
      }

      try {
        claimAnonymousGameHistory(getDb(), result.user.id, req.visitorId);
      } catch (err) {
        console.error("[login] Failed to claim anonymous game history:", err);
      }

      res.cookie(config.userCookieName, result.token, userCookieOptions({ stayLoggedIn }));
      linkVisitorToUser(req.visitorId, result.user.id, getDb());
      recordEventFromRequest(req, {
        eventName: ANALYTICS_EVENTS.USER_LOGGED_IN,
        eventType: "auth",
        userId: result.user.id,
        properties: { stayLoggedIn },
      });
      res.json({ user: result.user });
    } catch (err: unknown) {
      const message = err instanceof UserFacingError ? err.message : "Login failed";
      // Return generic 401 for all login failures to avoid disclosing account state
      res.status(401).json({ error: SAFE_LOGIN_ERRORS.has(message) ? message : "Login failed" });
    }
  });

  // POST /logout — Destroy session and clear cookie
  router.post("/logout", requireUser, (req: Request, res: Response) => {
    const token = req.cookies?.[config.userCookieName];
    if (token) {
      destroyUserSession(getDb(), token);
    }
    res.clearCookie(config.userCookieName, userCookieOptions({ clear: true }));
    recordEventFromRequest(req, {
      eventName: ANALYTICS_EVENTS.USER_LOGGED_OUT,
      eventType: "auth",
    });
    res.json({ ok: true });
  });

  // GET /me — Return the currently authenticated user (or null if not logged in)
  router.get("/me", optionalUser, (req: Request, res: Response) => {
    if (!req.user) {
      res.json({ user: null });
      return;
    }
    res.json({ user: req.user });
  });

  // POST /attribute-signup — Attach UTM attribution to a freshly-registered user.
  // Used by the client after OAuth redirects back (OAuth sign-in cannot
  // carry the attribution in the callback, so the client posts it here
  // once the session is established). First-touch wins: only writes if the
  // user has no existing attribution and was created within the window.
  //
  // Also merges any cookie-backed visitor_attribution row so that an OAuth
  // user who clicked a tracked link days earlier still gets credited to
  // their original cohort.
  router.post("/attribute-signup", requireUser, (req: Request, res: Response) => {
    try {
      const user = req.user!;
      const sanitized = validateAttribution(req.body?.attribution);

      // Fall-through: try the cookie-backed merge even if the client
      // payload was missing or invalid. That's how OAuth users who
      // didn't carry UTM through the redirect still get attributed.
      const eligible = hasRecentSignupWithoutAttribution(getDb(), user.id);

      let wasAttributed = false;
      if (eligible) {
        if (sanitized) {
          wasAttributed = storeSignupAttribution(getDb(), user.id, sanitized);
        }
        if (!wasAttributed) {
          wasAttributed = mergeVisitorAttributionIntoUser(
            getDb(),
            user.id,
            req.visitorId,
          );
        }
      }

      res.json({ wasAttributed });
    } catch (err) {
      console.error("[attribute-signup] Failed:", err);
      res.status(500).json({ error: "Failed to attribute signup" });
    }
  });

  // POST /verify-email — Verify email with token
  router.post("/verify-email", (req: Request, res: Response) => {
    const { token } = req.body;

    if (typeof token !== "string" || !token) {
      res.status(400).json({ error: "Token is required" });
      return;
    }

    if (token.length > 256) {
      res.status(400).json({ error: "Invalid token" });
      return;
    }

    const success = verifyEmail(getDb(), token);
    if (!success) {
      res.status(400).json({ error: "Invalid or expired verification token" });
      return;
    }

    res.json({ ok: true });
  });

  // POST /resend-verification — Create a new verification token and send email (requires auth)
  router.post("/resend-verification", requireUser, (req: Request, res: Response) => {
    try {
      const user = req.user!;
      if (user.emailVerified) {
        res.json({ ok: true });
        return;
      }
      const token = createEmailVerificationToken(getDb(), user.id, user.email);
      sendVerificationEmail(user.email, user.username, token).catch((err) => {
        console.error("[resend-verification] Failed to send email:", err);
      });
      res.json({ ok: true });
    } catch (err: unknown) {
      res.status(500).json({ error: safeErrorMessage(err) });
    }
  });

  // PUT /email — Change email address (requires auth + password)
  router.put("/email", requireUser, (req: Request, res: Response) => {
    const { newEmail, password } = req.body;

    if (typeof newEmail !== "string" || typeof password !== "string" || !newEmail || !password) {
      res.status(400).json({ error: "New email and password are required" });
      return;
    }

    try {
      const verifyToken = changeEmail(getDb(), req.user!.id, newEmail, password);
      // Send verification email to the new address
      sendVerificationEmail(newEmail, req.user!.username, verifyToken).catch((err) => {
        console.error("[change-email] Failed to send verification email:", err);
      });
      // Return updated user (email changed, emailVerified reset)
      const updatedRow = getDb().prepare("SELECT * FROM users WHERE id = ?").get(req.user!.id) as Record<string, unknown>;
      res.json({ ok: true, user: rowToUserAccount(updatedRow) });
    } catch (err: unknown) {
      const message = err instanceof UserFacingError ? err.message : "Failed to change email";
      res.status(400).json({ error: message });
    }
  });

  // PUT /password — Change password (requires auth + current password)
  router.put("/password", requireUser, (req: Request, res: Response) => {
    const { currentPassword, newPassword } = req.body;

    if (typeof currentPassword !== "string" || typeof newPassword !== "string" || !currentPassword || !newPassword) {
      res.status(400).json({ error: "Current and new passwords are required" });
      return;
    }

    try {
      changePassword(getDb(), req.user!.id, currentPassword, newPassword);

      // Re-login with new password to create a fresh session
      const ip = req.ip || req.socket.remoteAddress || "unknown";
      const userAgent = req.headers["user-agent"] || "unknown";
      const result = userLogin(getDb(), req.user!.email, newPassword, ip, userAgent);

      res.cookie(config.userCookieName, result.token, userCookieOptions());
      res.json({ ok: true, user: result.user });
    } catch (err: unknown) {
      const message = err instanceof UserFacingError ? err.message : "Failed to change password";
      res.status(400).json({ error: message });
    }
  });

  // PUT /username — Choose or change username (requires auth)
  router.put("/username", requireUser, (req: Request, res: Response) => {
    const { username } = req.body;

    if (typeof username !== "string" || !username) {
      res.status(400).json({ error: "Username is required" });
      return;
    }

    if (username.length > 128) {
      res.status(400).json({ error: "Input too long" });
      return;
    }

    try {
      const updatedUser = changeUsername(getDb(), req.user!.id, username);

      // Send verification email for new OAuth users who haven't verified yet
      let emailVerificationSent = false;
      if (!updatedUser.emailVerified && updatedUser.email) {
        const token = createEmailVerificationToken(getDb(), updatedUser.id, updatedUser.email);
        sendVerificationEmail(updatedUser.email, updatedUser.username, token).catch((err) => {
          console.error("[set-username] Failed to send verification email:", err);
        });
        emailVerificationSent = true;
      }

      res.json({ ok: true, user: updatedUser, emailVerificationSent });
    } catch (err: unknown) {
      const message = err instanceof UserFacingError ? err.message : "Failed to change username";
      res.status(400).json({ error: message });
    }
  });

  // PUT /avatar — Change avatar preference (requires auth)
  router.put("/avatar", requireUser, (req: Request, res: Response) => {
    const { avatar } = req.body;

    // Reject disabled avatars (null/clear is always allowed)
    if (avatar != null && !isAvatarEnabled(getDb(), avatar)) {
      res.status(400).json({ error: "This avatar is currently disabled" });
      return;
    }

    try {
      const updatedUser = changeAvatar(getDb(), req.user!.id, avatar ?? null);
      res.json({ ok: true, user: updatedUser });
    } catch (err: unknown) {
      if (!(err instanceof UserFacingError)) {
        console.error("[PUT /avatar] unexpected error:", err);
      }
      const message = err instanceof UserFacingError ? err.message : "Failed to change avatar";
      res.status(400).json({ error: message });
    }
  });

  // POST /forgot-password — Request a password reset email (public)
  router.post("/forgot-password", (req: Request, res: Response) => {
    const { email } = req.body;

    if (typeof email !== "string" || !email) {
      res.status(400).json({ error: "Email is required" });
      return;
    }

    if (email.length > 256) {
      res.status(400).json({ error: "Input too long" });
      return;
    }

    // Always return success to prevent email enumeration
    const user = findUserByEmail(getDb(), email);
    if (user && (user.is_active as number) === 1) {
      const token = createPasswordResetToken(getDb(), user.id as string);
      sendPasswordResetEmail(
        user.email as string,
        user.username as string,
        token,
      ).catch((err) => {
        console.error("[forgot-password] Failed to send email:", err);
      });
    }

    res.json({ ok: true });
  });

  // POST /reset-password — Set a new password using a reset token (public)
  router.post("/reset-password", (req: Request, res: Response) => {
    const { token, newPassword } = req.body;

    if (typeof token !== "string" || !token) {
      res.status(400).json({ error: "Token is required" });
      return;
    }

    if (token.length > 256) {
      res.status(400).json({ error: "Invalid token" });
      return;
    }

    if (typeof newPassword !== "string" || !newPassword) {
      res.status(400).json({ error: "New password is required" });
      return;
    }

    if (newPassword.length > 1024) {
      res.status(400).json({ error: "Input too long" });
      return;
    }

    try {
      const success = resetPassword(getDb(), token, newPassword);
      if (!success) {
        res.status(400).json({ error: "Invalid or expired reset token" });
        return;
      }
      res.json({ ok: true });
    } catch (err: unknown) {
      const message = err instanceof UserFacingError ? err.message : "Password reset failed";
      res.status(400).json({ error: message });
    }
  });

  // GET /history — Paginated game history (requires auth)
  router.get("/history", requireUser, (req: Request, res: Response) => {
    const limit = Math.min(Math.max(parseInt(req.query.limit as string, 10) || 20, 1), 100);
    const offset = Math.max(parseInt(req.query.offset as string, 10) || 0, 0);
    const gameType = (req.query.gameType || req.query.type) as string | undefined;
    const gameMode = req.query.gameMode as string | undefined;

    const validTypes = new Set(["single", "multiplayer"]);
    const options: { limit: number; offset: number; gameType?: "single" | "multiplayer"; gameMode?: string } = { limit, offset };
    if (gameType && validTypes.has(gameType)) {
      options.gameType = gameType as "single" | "multiplayer";
    }
    if (gameMode && VALID_GAME_MODES.has(gameMode)) {
      options.gameMode = gameMode;
    }

    const entries = getUserGameHistory(getDb(), req.user!.id, options);

    // Total count for pagination
    let countSql = "SELECT COUNT(*) as total FROM user_game_history WHERE user_id = ?";
    const countParams: unknown[] = [req.user!.id];
    if (options.gameType) {
      countSql += " AND game_type = ?";
      countParams.push(options.gameType);
    }
    if (options.gameMode) {
      countSql += " AND game_mode = ?";
      countParams.push(options.gameMode);
    }
    const countRow = getDb().prepare(countSql).get(...countParams) as { total: number };

    res.json({ entries, total: countRow.total });
  });

  // GET /history/:historyId/recap — Public read-only recap of a single game
  //
  // Returns a SharedGameRecord the `SharedGameView` renderer can display
  // unchanged. Public so the Leaderboard → Player Profile Modal can show
  // any player's recap (matches the access model of /s/:id).
  //
  // Fast path: if user_game_history.share_id is already set (true for every
  // new game, and for legacy games that have been opened at least once),
  // returns the cached shared_games row directly.
  //
  // Cold path (legacy rows only): synthesizes the SharedRoundSnapshot[] via
  // buildSPRecap / buildMPRecap, inserts a new shared_games row, and stamps
  // share_id on the history row — so every subsequent click is a cache hit.
  router.get("/history/:historyId/recap", requireUser, (req: Request<{ historyId: string }>, res: Response) => {
    const historyId = parseInt(req.params.historyId, 10);
    if (!Number.isFinite(historyId) || historyId <= 0) {
      res.status(400).json({ error: "Invalid history id" });
      return;
    }

    interface HistoryRow {
      id: number;
      user_id: string;
      game_type: string;
      game_mode: string;
      session_id: string | null;
      room_code: string | null;
      score: number;
      played_at: string;
      share_id: string | null;
    }
    const row = getDb()
      .prepare(
        `SELECT id, user_id, game_type, game_mode, session_id, room_code, score, played_at, share_id
         FROM user_game_history WHERE id = ?`,
      )
      .get(historyId) as HistoryRow | undefined;
    if (!row) {
      res.status(404).json({ error: "History entry not found" });
      return;
    }
    // PR3 sec H1: ownership gate. The route used to be public — sequential
    // history ids made arbitrary user game data enumerable (`for i in
    // 1..N: GET /api/user/history/$i/recap`). Public consumers (the player-
    // profile modal, the leaderboard click-through) now use `/s/:shareId`
    // instead, where shareId is opaque base64url. This route is reserved
    // for the authed user viewing their own row from the Settings → Game
    // History panel.
    if (row.user_id !== req.user!.id) {
      res.status(404).json({ error: "History entry not found" });
      return;
    }

    // Fast path: share_id already points to a cached record.
    if (row.share_id) {
      interface SharedRow {
        id: string;
        game_mode: string;
        total_score: number;
        per_round_max: number;
        player_name: string | null;
        round_data: string;
        created_at: number;
      }
      const shared = getDb()
        .prepare(
          `SELECT id, game_mode, total_score, per_round_max, player_name, round_data, created_at
           FROM shared_games WHERE id = ?`,
        )
        .get(row.share_id) as SharedRow | undefined;
      if (shared) {
        let parsed: SharedRoundSnapshot[];
        try {
          parsed = JSON.parse(shared.round_data) as SharedRoundSnapshot[];
        } catch {
          console.error(`Corrupted round_data for share ${shared.id}`);
          res.status(500).json({ error: "Failed to read recap" });
          return;
        }
        const record: SharedGameRecord = {
          id: shared.id,
          gameMode: shared.game_mode as GameMode,
          totalScore: shared.total_score,
          perRoundMax: shared.per_round_max,
          playerName: shared.player_name,
          roundData: parsed,
          createdAt: shared.created_at,
        };
        res.json(record);
        return;
      }
      // Rare: share_id was stamped but the shared row was deleted. Fall
      // through to rebuild, and re-stamp with the new id below.
    }

    const gameMode = row.game_mode as GameMode;
    // Cold path: build snapshots from the underlying session/room data.
    let roundData: SharedRoundSnapshot[] = [];
    try {
      if (row.game_type === "single" && row.session_id) {
        roundData = buildSPRecap(getDb(), row.session_id);
      } else if (row.game_type === "multiplayer" && row.room_code) {
        roundData = buildMPRecap(getDb(), row.room_code, row.user_id);
      }
    } catch (err) {
      console.error(`[recap ${historyId}] build failed:`, err);
      roundData = [];
    }

    const userRow = getDb()
      .prepare("SELECT username FROM users WHERE id = ?")
      .get(row.user_id) as { username: string } | undefined;
    const playerName = userRow?.username ?? null;

    if (roundData.length === 0) {
      // Underlying game rows gone (trimmed / never completed). Return an
      // empty record — SharedGameView handles this — and do NOT persist,
      // so a later data restore can still backfill.
      const record: SharedGameRecord = {
        id: `h-${row.id}`,
        gameMode,
        totalScore: row.score,
        perRoundMax: getPerRoundMaxScore(gameMode),
        playerName,
        roundData: [],
        createdAt: Math.floor(Date.parse(row.played_at) / 1000) || 0,
      };
      res.json(record);
      return;
    }

    // Persist + stamp so future fetches hit the fast path.
    let newShareId: string;
    try {
      newShareId = getDb().transaction(() => {
        const id = createShareRow(
          getDb(),
          gameMode,
          row.score,
          getPerRoundMaxScore(gameMode),
          playerName,
          roundData,
        );
        getDb()
          .prepare("UPDATE user_game_history SET share_id = ? WHERE id = ? AND share_id IS NULL")
          .run(id, row.id);
        return id;
      })();
    } catch (err) {
      console.error(`[recap ${historyId}] persist failed:`, err);
      // Degraded: still respond with the synthesized snapshot so the
      // user's click isn't wasted — just without caching.
      const record: SharedGameRecord = {
        id: `h-${row.id}`,
        gameMode,
        totalScore: row.score,
        perRoundMax: getPerRoundMaxScore(gameMode),
        playerName,
        roundData,
        createdAt: Math.floor(Date.parse(row.played_at) / 1000) || 0,
      };
      res.json(record);
      return;
    }

    const record: SharedGameRecord = {
      id: newShareId,
      gameMode,
      totalScore: row.score,
      perRoundMax: getPerRoundMaxScore(gameMode),
      playerName,
      roundData,
      createdAt: Math.floor(Date.now() / 1000),
    };
    res.json(record);
  });

  // GET /stats — Aggregate stats (requires auth)
  router.get("/stats", requireUser, (req: Request, res: Response) => {
    const stats = getUserStats(getDb(), req.user!.id);
    res.json(stats);
  });

  // GET /win-record — lifetime W/L/Streak snapshot for the current viewer.
  // Auth is OPTIONAL: logged-in users get their cached `users` counters;
  // anonymous visitors get the `visitor_attribution` counters keyed on the
  // `visitor_id` cookie. Anyone with neither receives a zeroed snapshot
  // (brand-new browser). With `?breakdown=mode`, includes a per-mode
  // breakdown (logged-in users only — visitors don't have per-mode
  // history rows). The HUD chip and profile surfaces all read from this.
  router.get("/win-record", optionalUser, (req: Request, res: Response) => {
    const db = getDb();
    const wantsBreakdown = req.query.breakdown === "mode";
    if (req.user) {
      const record = getUserWinRecord(db, req.user.id);
      const byMode = wantsBreakdown ? getUserWinRecordByMode(db, req.user.id) : undefined;
      res.json({ record, ...(byMode ? { byMode } : {}) });
      return;
    }
    if (req.visitorId) {
      const record = getVisitorWinRecord(db, req.visitorId);
      res.json({ record });
      return;
    }
    res.json({
      record: { wins: 0, losses: 0, currentStreak: 0, bestStreak: 0, totalGames: 0 },
    });
  });

  // GET /monthly-points — Points earned in the current calendar month (requires auth).
  // Also returns the user's current active daily-challenge streak so the
  // giveaway tracker can render both criteria without a second round-trip.
  router.get("/monthly-points", requireUser, (req: Request, res: Response) => {
    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
    const db = getDb();
    const row = db
      .prepare(
        `SELECT COALESCE(SUM(score), 0) AS points, COUNT(*) AS games
         FROM user_game_history
         WHERE user_id = ? AND played_at >= ?`
      )
      .get(req.user!.id, monthStart) as { points: number; games: number };
    const streak = getStreakForUser(db, req.user!.id).current;
    res.json({ points: row.points, gamesPlayed: row.games, streak });
  });

  // GET /score-history — Daily score aggregates for chart display (requires auth)
  router.get("/score-history", requireUser, (req: Request, res: Response) => {
    const days = Math.min(Math.max(parseInt(req.query.days as string, 10) || 30, 1), 365);
    const timeZone = parseTimeZoneQuery(req.query.tz);
    const history = getUserScoreHistory(getDb(), req.user!.id, days, timeZone);
    res.json({ history });
  });

  // GET /rewards — User's awarded rewards (requires auth)
  router.get("/rewards", requireUser, (req: Request, res: Response) => {
    const rewards = getUserRewards(getDb(), req.user!.id);
    res.json({ rewards });
  });

  // POST /rewards/:id/claim — Mark a reward as collected, reveals full code (requires auth)
  router.post("/rewards/:id/claim", requireUser, (req: Request, res: Response) => {
    const rewardId = req.params.id as string;
    const code = claimReward(getDb(), rewardId, req.user!.id);
    if (!code) {
      res.status(404).json({ error: "Reward not found, already claimed, or expired" });
      return;
    }
    res.json({ ok: true, code });
  });

  // POST /rewards/claim-by-token — Claim via the per-award token from the email link.
  // Returns 200 + code on success; on failure returns 4xx with a discriminated
  // `reason` so the web claim page can render a tailored message without
  // distinguishing "doesn't exist" from "malformed" (both → 'invalid').
  router.post("/rewards/claim-by-token", requireUser, (req: Request, res: Response) => {
    const token = (req.body?.token as string | undefined)?.trim();
    if (!token || typeof token !== "string") {
      res.status(400).json({ ok: false, reason: "invalid" });
      return;
    }
    const result = claimRewardByToken(getDb(), token, req.user!.id);
    if (result.ok) {
      res.json(result);
      return;
    }
    // Map reason → HTTP status. The user is already authenticated when
    // this fires, so a 403 for `wrong_user` (signed in as the wrong
    // account) is friendlier than a 404 — the UI uses it to suggest
    // signing out and signing in with the receiving account. Unknown
    // tokens still 404 to give no signal of existence; expired/voided/
    // already_claimed are 410 because the resource genuinely lapsed.
    const status = result.reason === "wrong_user" ? 403
      : result.reason === "invalid" ? 404
      : 410; // expired / voided / already_claimed
    res.status(status).json(result);
  });

  // GET /referrals — Referral dashboard (requires auth)
  router.get("/referrals", requireUser, (req: Request, res: Response) => {
    try {
      const dashboard = getReferralDashboard(getDb(), req.user!.id);
      res.json(dashboard);
    } catch (err: unknown) {
      console.error("[referrals] Failed to load referral dashboard:", err);
      res.status(500).json({ error: "Failed to load referral data" });
    }
  });

  // GET /oauth/providers — public endpoint listing which OAuth providers are configured
  router.get("/oauth/providers", (_req: Request, res: Response) => {
    const hasCallbackBase = !!config.oauthCallbackBase;
    res.json({
      google: !!(config.googleClientId && config.googleClientSecret && hasCallbackBase),
      facebook: !!(config.facebookAppId && config.facebookAppSecret && hasCallbackBase),
      amazon: !!(config.amazonClientId && config.amazonClientSecret && hasCallbackBase),
    });
  });

  /**
   * Shared OAuth callback handler. Validates CSRF state, exchanges the
   * authorization code, finds or creates the user, and sets a session cookie.
   */
  async function handleOAuthCallback(
    req: Request,
    res: Response,
    provider: string,
    exchangeFn: (code: string) => Promise<{ email: string; name: string; providerId: string }>,
  ): Promise<void> {
    try {
      const { code, state, error: oauthError } = req.query;
      if (oauthError || !code || !state) {
        res.redirect("/?auth_error=cancelled");
        return;
      }
      if (!validateOAuthState(state as string, provider)) {
        res.redirect("/?auth_error=invalid_state");
        return;
      }
      const profile = await exchangeFn(code as string);
      const { user, isNew } = findOrCreateOAuthUser(getDb(), provider, profile.providerId, profile.email, profile.name);

      // Merge any pre-existing visitor attribution onto the OAuth user.
      // Runs only for fresh OAuth accounts — existing users keep their
      // original first-touch attribution. The SQL guard inside
      // storeSignupAttribution is defense in depth for races.
      if (isNew) {
        try {
          mergeVisitorAttributionIntoUser(getDb(), user.id, req.visitorId);
        } catch (err) {
          console.error(`[oauth ${provider}] Failed to merge visitor attribution:`, err);
        }
      }

      const ip = req.ip || req.socket.remoteAddress || "unknown";
      const userAgent = req.headers["user-agent"] || "unknown";
      const token = createOAuthSession(getDb(), user.id, ip, userAgent);

      // Re-link any push subscription on this browser to the OAuth user,
      // mirroring the password-login path. See user.ts /login for details.
      relinkPushSubscriptionsForVisitor(getDb(), req.visitorId, user.id);

      // Claim any daily challenge plays completed anonymously on this device.
      // Mirrors the register/login paths — OAuth users should also get credit
      // for anonymous plays on this browser.
      try {
        claimAnonymousDailyPlays(getDb(), user.id, req.visitorId);
      } catch (err) {
        console.error(`[oauth ${provider}] Failed to claim anonymous daily plays:`, err);
      }

      try {
        claimAnonymousGameHistory(getDb(), user.id, req.visitorId);
      } catch (err) {
        console.error(`[oauth ${provider}] Failed to claim anonymous game history:`, err);
      }

      res.cookie(config.userCookieName, token, userCookieOptions());
      res.redirect("/");
    } catch {
      res.redirect("/?auth_error=oauth_failed");
    }
  }

  // OAuth: Google
  router.get("/oauth/google", (_req: Request, res: Response) => {
    if (!config.googleClientId) {
      res.status(501).json({ error: "Google OAuth not configured" });
      return;
    }
    const state = generateOAuthState("google");
    res.redirect(getGoogleAuthUrl(state));
  });

  router.get("/oauth/google/callback", (req: Request, res: Response) => {
    handleOAuthCallback(req, res, "google", exchangeGoogleCode)
      .catch(() => res.redirect("/?auth_error=oauth_failed"));
  });

  // OAuth: Facebook
  router.get("/oauth/facebook", (_req: Request, res: Response) => {
    if (!config.facebookAppId) {
      res.status(501).json({ error: "Facebook OAuth not configured" });
      return;
    }
    const state = generateOAuthState("facebook");
    res.redirect(getFacebookAuthUrl(state));
  });

  router.get("/oauth/facebook/callback", (req: Request, res: Response) => {
    handleOAuthCallback(req, res, "facebook", exchangeFacebookCode)
      .catch(() => res.redirect("/?auth_error=oauth_failed"));
  });

  // OAuth: Amazon
  router.get("/oauth/amazon", (_req: Request, res: Response) => {
    if (!config.amazonClientId) {
      res.status(501).json({ error: "Amazon OAuth not configured" });
      return;
    }
    const state = generateOAuthState("amazon");
    res.redirect(getAmazonAuthUrl(state));
  });

  router.get("/oauth/amazon/callback", (req: Request, res: Response) => {
    handleOAuthCallback(req, res, "amazon", exchangeAmazonCode)
      .catch(() => res.redirect("/?auth_error=oauth_failed"));
  });

  return router;
}
