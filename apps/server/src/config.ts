/**
 * Centralized configuration — reads from environment variables with defaults.
 */

function envInt(key: string, fallback: number): number {
  const v = process.env[key];
  if (v === undefined) return fallback;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n >= 1 ? n : fallback;
}

export const config = {
  port: envInt("PORT", 3001),
  apiRateLimit: envInt("API_RATE_LIMIT", 60),
  // 120/min/IP. Pre-2026-05 this was 30/min, but combined with a buggy
  // `trust proxy` setting the limiter was effectively global; the new
  // per-IP keying needs a budget that survives a cold-cache cold load
  // (a 30-product carousel can burst dozens of `/api/image/:id` requests
  // before any client cache fills).
  imageRateLimit: envInt("IMAGE_RATE_LIMIT", 120),
  imageProxyTimeout: envInt("IMAGE_PROXY_TIMEOUT", 10),
  imageCacheSize: envInt("IMAGE_CACHE_SIZE", 5000),
  socketPingInterval: envInt("SOCKET_PING_INTERVAL", 15000),
  socketPingTimeout: envInt("SOCKET_PING_TIMEOUT", 10000),
  socketMaxEventsPerSecond: envInt("SOCKET_MAX_EVENTS_PER_SEC", 30),
  roomCleanupInterval: envInt("ROOM_CLEANUP_INTERVAL", 60000),
  roomCreateLimitPerMinute: envInt("ROOM_CREATE_LIMIT", 5),
  roomJoinLimitPerMinute: envInt("ROOM_JOIN_LIMIT", 10),

  // Admin panel
  adminBcryptRounds: envInt("ADMIN_BCRYPT_ROUNDS", 12),
  adminSessionDurationMs: envInt("ADMIN_SESSION_DURATION_MS", 8 * 60 * 60 * 1000),
  adminIdleTimeoutMs: envInt("ADMIN_IDLE_TIMEOUT_MS", 2 * 60 * 60 * 1000),
  adminMaxFailedLogins: envInt("ADMIN_MAX_FAILED_LOGINS", 5),
  adminLockoutDurationMs: envInt("ADMIN_LOCKOUT_DURATION_MS", 15 * 60 * 1000),
  adminLoginRateLimit: envInt("ADMIN_LOGIN_RATE_LIMIT", 15),
  adminLoginRateWindowMs: envInt("ADMIN_LOGIN_RATE_WINDOW_MS", 15 * 60 * 1000),
  admin2faVerifyRateLimit: envInt("ADMIN_2FA_VERIFY_RATE_LIMIT", 10),
  admin2faVerifyRateWindowMs: envInt("ADMIN_2FA_VERIFY_RATE_WINDOW_MS", 15 * 60 * 1000),
  adminSessionCleanupIntervalMs: envInt("ADMIN_SESSION_CLEANUP_INTERVAL_MS", 15 * 60 * 1000),
  adminCookieName: process.env.ADMIN_COOKIE_NAME || "admin_session",
  admin2faPendingTokenDurationMs: envInt("ADMIN_2FA_PENDING_TOKEN_DURATION_MS", 5 * 60 * 1000),
  admin2faTotpWindow: envInt("ADMIN_2FA_TOTP_WINDOW", 1),
  admin2faRecoveryCodeCount: envInt("ADMIN_2FA_RECOVERY_CODE_COUNT", 10),
  admin2faEncryptionKey: process.env.ADMIN_2FA_ENCRYPTION_KEY || "",
  chromeExtensionId: process.env.CHROME_EXTENSION_ID || "",

  // Product Universe
  puJobIntervalMs: envInt("PU_JOB_INTERVAL_MS", 30000),
  puRateLimit: envInt("PU_RATE_LIMIT", 60),
  puRateWindowMs: envInt("PU_RATE_WINDOW_MS", 60 * 1000),
  puMaxJobAttempts: envInt("PU_MAX_JOB_ATTEMPTS", 3),
  puSearchCacheTtlMs: envInt("PU_SEARCH_CACHE_TTL_MS", 7 * 24 * 60 * 60 * 1000),
  puAiProvider: process.env.PU_AI_PROVIDER || "claude",
  puAiModel: process.env.PU_AI_MODEL || "claude-sonnet-4-20250514",
  puAnthropicApiKey: process.env.ANTHROPIC_API_KEY || "",
  puBraveSearchApiKey: process.env.BRAVE_SEARCH_API_KEY || "",
  puSearchResultsPerQuery: envInt("PU_SEARCH_RESULTS_PER_QUERY", 5),
  puResearchModel: process.env.PU_RESEARCH_MODEL || "claude-opus-4-20250514",

  // User accounts
  userBcryptRounds: envInt("USER_BCRYPT_ROUNDS", 12),
  userSessionDurationMs: envInt("USER_SESSION_DURATION_MS", 30 * 24 * 60 * 60 * 1000),
  // Safety cap for sessions created with stayLoggedIn=false. The browser
  // cookie is already a session cookie in that case (no maxAge), but we
  // also shorten the server-side expires_at so a mis-configured browser
  // that holds onto the cookie past the session can't keep using it.
  userShortSessionDurationMs: envInt("USER_SHORT_SESSION_DURATION_MS", 24 * 60 * 60 * 1000),
  userIdleTimeoutMs: envInt("USER_IDLE_TIMEOUT_MS", 7 * 24 * 60 * 60 * 1000),
  userMaxFailedLogins: envInt("USER_MAX_FAILED_LOGINS", 5),
  userLockoutDurationMs: envInt("USER_LOCKOUT_DURATION_MS", 15 * 60 * 1000),
  userLoginRateLimit: envInt("USER_LOGIN_RATE_LIMIT", 10),
  userLoginRateWindowMs: envInt("USER_LOGIN_RATE_WINDOW_MS", 15 * 60 * 1000),
  userRegisterRateLimit: envInt("USER_REGISTER_RATE_LIMIT", 3),
  userRegisterRateWindowMs: envInt("USER_REGISTER_RATE_WINDOW_MS", 60 * 60 * 1000),
  userMaxSessions: envInt("USER_MAX_SESSIONS", 5),
  userSessionCleanupIntervalMs: envInt("USER_SESSION_CLEANUP_INTERVAL_MS", 60 * 60 * 1000),
  userCookieName: process.env.USER_COOKIE_NAME || "user_session",
  userMinPasswordLength: envInt("USER_MIN_PASSWORD_LENGTH", 10),
  userMaxPasswordLength: envInt("USER_MAX_PASSWORD_LENGTH", 128),

  // Anonymous visitor attribution
  // Cookie carries a random UUID used to tie pre-signup UTM and game plays
  // together. httpOnly (server-only), sameSite=lax so external ad-click
  // landings still carry it. 90 days is long enough to span a normal
  // click → signup → giveaway funnel without becoming long-lived PII.
  visitorCookieName: process.env.VISITOR_COOKIE_NAME || "visitor_id",
  visitorCookieMaxAgeMs: envInt(
    "VISITOR_COOKIE_MAX_AGE_MS",
    90 * 24 * 60 * 60 * 1000,
  ),

  // Email (Resend)
  resendApiKey: process.env.RESEND_API_KEY || "",
  emailFrom: process.env.EMAIL_FROM || "Price Games <noreply@price.games>",
  appUrl: process.env.APP_URL || "http://localhost:5173",

  // OAuth
  googleClientId: process.env.GOOGLE_CLIENT_ID || "",
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET || "",
  facebookAppId: process.env.FACEBOOK_APP_ID || "",
  facebookAppSecret: process.env.FACEBOOK_APP_SECRET || "",
  amazonClientId: process.env.AMAZON_CLIENT_ID || "",
  amazonClientSecret: process.env.AMAZON_CLIENT_SECRET || "",
  oauthCallbackBase: process.env.OAUTH_CALLBACK_BASE || process.env.APP_URL || "",

  // Cloudflare Turnstile
  turnstileSiteKey: process.env.TURNSTILE_SITE_KEY || "",
  turnstileSecretKey: process.env.TURNSTILE_SECRET_KEY || "",

  // Push notifications
  vapidPublicKey: process.env.VAPID_PUBLIC_KEY || "",
  vapidPrivateKey: process.env.VAPID_PRIVATE_KEY || "",
  vapidSubject: process.env.VAPID_SUBJECT || "mailto:admin@price.games",
  notifSchedulerIntervalMs: envInt("NOTIF_SCHEDULER_INTERVAL_MS", 60000),
  notifMaxAttempts: envInt("NOTIF_MAX_ATTEMPTS", 3),
  notifStreakReminderHours: envInt("NOTIF_STREAK_REMINDER_HOURS", 20),

  // Email marketing / re-engagement (separate cadence from push; coarser).
  // Default scheduler tick is 15 min, vs push's 60 s — email triggers are
  // time-of-day aware (streak-risk next day, weekly digest, inactivity
  // bands), so sub-minute precision is wasted and just burns cycles.
  emailSchedulerIntervalMs: envInt("EMAIL_SCHEDULER_INTERVAL_MS", 15 * 60 * 1000),
  // Hard-floor cooldown: no user receives a marketing email more often
  // than this, regardless of how many triggers fire. Protects against
  // admin misconfiguration and keeps us out of spam-report territory.
  emailGlobalCooldownHours: envInt("EMAIL_GLOBAL_COOLDOWN_HOURS", 24),
  emailMaxPerTick: envInt("EMAIL_MAX_PER_TICK", 50),
  emailMaxAttempts: envInt("EMAIL_MAX_ATTEMPTS", 3),
  // HMAC secret for one-click unsubscribe tokens (RFC 8058). No default in
  // production — see the boot-time warning below.
  emailUnsubSecret: process.env.EMAIL_UNSUB_SECRET || "",
  // Optional Resend webhook secret for bounce / complaint / open events.
  emailResendWebhookSecret: process.env.RESEND_WEBHOOK_SECRET || "",

  // Daily challenge
  dailySeedSalt: process.env.DAILY_SEED_SALT || "dev-daily-salt-do-not-ship",

  // Analytics pipeline
  // Raw events retained for 90 days; pre-aggregated rollups (analytics_hourly,
  // analytics_daily) keep longer and power the dashboards. Sessions and
  // visitor_profile are retained as long as the visitor cookie lifetime to
  // avoid breaking cross-visit metrics.
  eventRetentionDays: envInt("EVENT_RETENTION_DAYS", 90),
  // Salt used when hashing IPs stored on the events row. Rotatable via
  // IP_SALT_VERSION: a new value increments the salt_version column on new
  // rows so historical and current hashes remain distinct. Use a strong
  // random string in production; the dev default must not ship.
  eventIpSalt: process.env.EVENT_IP_SALT || "dev-analytics-salt-do-not-ship",
  eventIpSaltVersion: envInt("IP_SALT_VERSION", 1),
  // Session boundary tuning. The idle cutoff aligns with GA4's default; the
  // absolute cap prevents a single phone-left-on-overnight from accreting
  // into a 24-hour session, and the active-game extension keeps a slow
  // multiplayer lobby from splitting into two sessions.
  sessionIdleMs: envInt("SESSION_IDLE_MS", 30 * 60 * 1000),
  sessionActiveGameIdleMs: envInt("SESSION_ACTIVE_GAME_IDLE_MS", 4 * 60 * 60 * 1000),
  sessionAbsoluteCapMs: envInt("SESSION_ABSOLUTE_CAP_MS", 4 * 60 * 60 * 1000),
  // Closeout sweep runs every N ms, closing sessions whose last_event_at is
  // older than sessionIdleMs (or sessionActiveGameIdleMs for sessions with
  // active games). 5 min is the smallest window that keeps bounced-session
  // classification timely without over-polling.
  sessionCloseoutIntervalMs: envInt("SESSION_CLOSEOUT_INTERVAL_MS", 5 * 60 * 1000),
  // analytics_hourly rebuild. Rebuilds the last 48h window each run, so the
  // dashboards absorb late-arriving events without ever-full-scanning.
  analyticsHourlyIntervalMs: envInt("ANALYTICS_HOURLY_INTERVAL_MS", 10 * 60 * 1000),
  // Client beacon rate limit (120 events/min per visitor_id).
  eventTrackRateLimit: envInt("EVENT_TRACK_RATE_LIMIT", 120),
  eventTrackRateWindowMs: envInt("EVENT_TRACK_RATE_WINDOW_MS", 60 * 1000),

  // Shared secret matched against the `X-Streamer-Bot` header sent by
  // the bot-streamer's Playwright context. Empty in dev — the middleware
  // becomes a no-op and no traffic is excluded. Must be set in any env
  // where the streamer-bot points at the server (sandbox, prod) so the
  // bot's gameplay does not pollute analytics counters.
  streamerBotSecret: process.env.STREAMER_BOT_SECRET || "",
} as const;

// Warn at startup if a production deploy is using the dev salt — leaking
// the dev salt would let an attacker pre-compute future puzzles.
if (
  process.env.NODE_ENV === "production" &&
  config.dailySeedSalt === "dev-daily-salt-do-not-ship"
) {
  console.warn(
    "WARNING: DAILY_SEED_SALT is set to the dev default in production. Set a strong random value before launching the daily challenge."
  );
}

// Same guard for the analytics IP/UA hash salt. Leaking the dev default
// would make every ip_hash and ua_hash trivially reversible for a known
// IP/UA space.
if (
  process.env.NODE_ENV === "production" &&
  config.eventIpSalt === "dev-analytics-salt-do-not-ship"
) {
  console.warn(
    "WARNING: EVENT_IP_SALT is set to the dev default in production. Set a strong random value before enabling analytics traffic — otherwise ip_hash and ua_hash are trivially reversible."
  );
}

// Streamer-bot exclusion silently no-ops without this secret. When the
// streamer container is running against a production server, an unset
// secret means every game the bot plays inflates games-played counters
// — operationally easy to miss because nothing crashes. Surface a
// startup warning so a misconfigured deploy is loud instead of silent.
if (
  process.env.NODE_ENV === "production" &&
  !config.streamerBotSecret
) {
  console.warn(
    "WARNING: STREAMER_BOT_SECRET is unset. If the streamer-bot is pointed at this server its gameplay will be counted as real-user analytics."
  );
}

// Warn at startup if OAuth providers are configured without a callback base URL
if (
  (config.googleClientId || config.facebookAppId || config.amazonClientId) &&
  !config.oauthCallbackBase
) {
  console.warn(
    "WARNING: OAuth provider credentials are set but OAUTH_CALLBACK_BASE is not configured. " +
    "OAuth login will not work until this is set (e.g. https://yourdomain.com).",
  );
}

// Warn at startup if the "short session" cap is not actually shorter than
// the persistent session duration. A misconfiguration here would silently
// defeat the DB-side safety cap for stayLoggedIn=false sessions — the
// browser-session cookie still provides the primary privacy guarantee,
// but the server-side absolute expiry is the second line of defense.
if (config.userShortSessionDurationMs >= config.userSessionDurationMs) {
  console.warn(
    "WARNING: USER_SHORT_SESSION_DURATION_MS (" +
      config.userShortSessionDurationMs +
      ") is not shorter than USER_SESSION_DURATION_MS (" +
      config.userSessionDurationMs +
      "). The 'Stay logged in unchecked' server-side cap is effectively disabled.",
  );
}

// Marketing-email unsubscribe tokens MUST be signed with a real secret in
// production. Without one, any attacker who can read a sent email could
// forge unsubscribe links for other users (or, worse, we'd fall back to a
// default and silently accept forged tokens).
if (process.env.NODE_ENV === "production" && !config.emailUnsubSecret) {
  console.warn(
    "WARNING: EMAIL_UNSUB_SECRET is not set. Marketing-email unsubscribe " +
      "links will be unsigned and trivially forgeable. Set a strong random " +
      "value before enabling any email triggers.",
  );
}

// Admin 2FA secrets are AES-encrypted at rest with this key. If it's empty,
// TOTP setup and verify both throw at call time — warn loudly at boot instead
// of discovering the misconfig at first admin login.
if (process.env.NODE_ENV === "production" && !config.admin2faEncryptionKey) {
  console.warn(
    "WARNING: ADMIN_2FA_ENCRYPTION_KEY is not set. Any admin 2FA setup/verify " +
      "call will throw. Generate one with `openssl rand -hex 32` and set it " +
      "before provisioning admin accounts.",
  );
}
