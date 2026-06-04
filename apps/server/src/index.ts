import dotenv from "dotenv";
import path from "path";

// Load .env from project root (2 levels up from apps/server/src)
dotenv.config({ path: path.resolve(__dirname, "..", "..", "..", ".env") });

import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import compression from "compression";
import rateLimit from "express-rate-limit";
import gameRouter from "./routes/game";
import leaderboardRouter from "./routes/leaderboard";
import playerRouter from "./routes/player";
import multiplayerRouter from "./routes/multiplayer";
import {
  inviteRewardsApiRouter,
  inviteResolverRouter,
  userBuffsRouter,
} from "./routes/inviteRewards";
import shareRouter from "./routes/share";
import dailyRouter from "./routes/daily";
import { createAdminRouter } from "./routes/admin";
import { createUserRouter } from "./routes/user";
import { createShortLinkRouter } from "./routes/shortLinks";
import { createAttributionRouter } from "./routes/attribution";
import { createSeoRouter, createIndexHtmlMetaMiddleware, resolveIndexHtmlPath, resolveShareMeta, resolvePageVisibilityMeta } from "./routes/seo";
import { renderSeoBody } from "./routes/seoBody";
import { createEventsRouter } from "./routes/events";
import { createStreamerRouter, createSqlitePersistence } from "./routes/streamer";
import { startSessionCloseout, startEventRetentionPurge } from "./services/sessionCloseout";
import { startAnalyticsHourlyJob } from "./services/analyticsHourly";
import { createContentRouter } from "./routes/content";
import { createPushRouter } from "./routes/push";
import { createAdminNotificationRouter } from "./routes/adminNotifications";
import { createAdminGalleryRouter } from "./routes/adminGallery";
import { createAdminLeaderboardRouter } from "./routes/adminLeaderboard";
import { createEmailRouter } from "./routes/email";
import { createAdminEmailRouter } from "./routes/adminEmail";
import { createImageRouter } from "./routes/image";
import { initWebPush } from "./services/pushNotification";
import { startNotificationScheduler } from "./services/notificationScheduler";
import { startEmailScheduler } from "./services/emailScheduler";
import { visitorCookie } from "./middleware/visitorCookie";
import { streamerBotDetect } from "./middleware/streamerBot";
import { denyPublicBroadcastFromEnv } from "./middleware/broadcastAccess";
import { setupSocketHandlers } from "./socket/handlers";
import { setupAdminAnalyticsNamespace } from "./socket/adminAnalyticsNamespace";
import { cleanupStaleRooms, reapDisconnectedPlayers, getRoom } from "./services/roomManager";
import { runAutoLobbyTick } from "./services/autoLobby/manager";
import { findElapsedCountdowns, cancelCountdown } from "./services/autoLobby/countdown";
import { runGhostUsersTick } from "./services/ghostUsers/manager";
import { simulateGhostDailyPlays } from "./services/ghostUsers/dailySim";
import { retireInactiveGhosts } from "./services/ghostUsers/cycling";
import { startRound } from "./services/multiplayerEngine";
import { handleTimerExpire, triggerPostRoundStart } from "./socket/gameHandlers";
import { SOCKET_EVENTS } from "@price-game/shared";
import { getLivePlayerIds, setDisconnectGraceMs } from "./socket/socketState";
import { MP_DISCONNECT_GRACE_MS } from "@price-game/shared";
import { cleanupRoomMemory } from "./services/multiplayerEngine";
import { fetchRates, getRates } from "./services/exchangeRates";
import { expireOverdueRewards, sendClaimReminders } from "./services/rewards";
import { seedInitialAdmin, cleanupExpiredSessions } from "./services/adminAuth";
import { cleanupExpiredPendingTokens } from "./services/adminTotp";
import { cleanupExpiredUserSessions, cleanupExpiredTokens } from "./services/userAuth";
import { getPromoBanner, getDisabledGameModes, getDisabledAvatars, getLegalDocument, isPageEnabled } from "./services/siteSettings";
import { AVATARS } from "@price-game/shared";
import db from "./db";
import { config } from "./config";
import { createAdminMetricsRouter } from "./routes/adminMetrics";

// Refuse to start in production if any of the dev/sandbox bypass flags are
// enabled. These flags exist to let the sandbox compose file disable 2FA /
// CAPTCHA — harmless there, catastrophic if ever set on the production host.
// The sandbox runs with NODE_ENV=production (to mirror prod helmet/CSP) and
// sets SANDBOX=1 as an explicit opt-in; the guard honours that marker but
// nothing else. A production deploy would have to add SANDBOX=1 on top of
// the skip flag — a much louder mistake than a bare SKIP_* typo.
if (process.env.NODE_ENV === "production" && process.env.SANDBOX !== "1") {
  const dangerousFlags = ["SKIP_ADMIN_2FA", "SKIP_TURNSTILE", "SKIP_INVITE_IP_CHECKS"].filter(
    (name) => process.env[name] === "1",
  );
  if (dangerousFlags.length > 0) {
    console.error(
      `FATAL: ${dangerousFlags.join(", ")} set in production. ` +
        "These bypass anti-abuse / auth controls and must never be enabled on the production host. " +
        "Unset them (or set SANDBOX=1 if this is the sandbox compose) and restart.",
    );
    process.exit(1);
  }
}

const app = express();
// Production runs in a Docker container behind Caddy on the host. Caddy
// connects to localhost:3001 → docker port-mapping NATs the connection so
// the container sees source IP = the docker bridge gateway (e.g.
// 172.18.0.1), NOT loopback. A strict "loopback" trust set therefore
// silently rejects Caddy's X-Forwarded-For and collapses every external
// client into one shared `req.ip` — which makes every per-IP rate limiter
// (image, api, admin login, room create, room join) a global limiter.
//
// Trust loopback + link-local + unique-local (RFC-1918 + fc00::/7) so the
// docker-bridge hop is honored as a proxy. Public-internet sources are
// still untrusted, so XFF spoofing from outside the perimeter is blocked.
// `socketState.getClientIp` mirrors this set for Socket.IO connections.
app.set("trust proxy", ["loopback", "linklocal", "uniquelocal"]);
const httpServer = createServer(app);

const allowedOrigins: (string | RegExp)[] = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean)
  : [/^https?:\/\/localhost(:\d+)?$/, /^https:\/\/([\w-]+\.)*price\.games$/];

if (config.chromeExtensionId) {
  allowedOrigins.push(`chrome-extension://${config.chromeExtensionId}`);
}

const io = new Server(httpServer, {
  cors: { origin: allowedOrigins },
  pingInterval: config.socketPingInterval,
  pingTimeout: config.socketPingTimeout,
  // Replay packets missed during brief disconnects (up to 2 minutes).
  // Belt-and-suspenders layer on top of our token-based rejoin — rejoin
  // still runs and still does the full-state snapshot when
  // `socket.recovered === false`.
  connectionStateRecovery: {
    maxDisconnectionDuration: 2 * 60 * 1000,
    skipMiddlewares: true,
  },
});

const isProduction = process.env.NODE_ENV === "production";
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "https://www.googletagmanager.com", "https://www.google-analytics.com", "'sha256-U6CX+C5mLqWFha8cR5RW4tv8Vag9NuPhelaZEsAKAL0='", "https://challenges.cloudflare.com", "https://static.cloudflareinsights.com", "https://www.redditstatic.com"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: [
        "'self'",
        "data:",
        // Required by the Share Results canvas renderer: the PNG share card
        // is drawn client-side, exported via canvas.toBlob(), and shown as
        // <img src={URL.createObjectURL(blob)}>. Without blob: in img-src,
        // browsers silently refuse to load the blob URL and the preview
        // renders broken. Same-origin only — blob: URIs carry no cross-origin
        // data.
        "blob:",
        "https://m.media-amazon.com",
        "https://images-na.ssl-images-amazon.com",
        "https://images-eu.ssl-images-amazon.com",
        "https://ecx.images-amazon.com",
        "https://images.amazon.com",
        "https://*.tile.openstreetmap.org",
        "https://www.google-analytics.com",
        "https://www.googletagmanager.com",
        // Reddit Pixel uses image beacons (alb.reddit.com/rp.gif) for PageVisit
        // and custom event delivery, in addition to the fetch/XHR path that
        // hits the same host — so alb.reddit.com must be in BOTH img-src and
        // connect-src.
        "https://alb.reddit.com",
      ],
      connectSrc: isProduction
        ? ["'self'", "wss:", "https://www.google-analytics.com", "https://*.google-analytics.com", "https://*.analytics.google.com", "https://analytics.google.com", "https://challenges.cloudflare.com", "https://cloudflareinsights.com", "https://alb.reddit.com", "https://events.reddit.com", "https://pixel-config.reddit.com", "https://cdn.jsdelivr.net"]
        : ["'self'", "wss:", "ws:", "https://www.google-analytics.com", "https://*.google-analytics.com", "https://*.analytics.google.com", "https://analytics.google.com", "https://challenges.cloudflare.com", "https://cloudflareinsights.com", "https://alb.reddit.com", "https://events.reddit.com", "https://pixel-config.reddit.com", "https://cdn.jsdelivr.net"],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameSrc: ["'self'", "https://challenges.cloudflare.com"],
      frameAncestors: ["'none'"],
      upgradeInsecureRequests: [],
    },
  },
  crossOriginEmbedderPolicy: false, // Allow loading product images from external origins
  // PR3 sec L2: HSTS now ships with `preload` so the response is eligible
  // for the browser preload list. Caddy already sets the same header in
  // production (see Caddyfile `security_headers`); aligning helmet's value
  // closes the gap for direct-served deployments.
  strictTransportSecurity: {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true,
  },
}));

// PR3 sec L3: Permissions-Policy that mirrors the Caddyfile policy so
// direct-served deployments (sandbox, dev, container without a fronting
// proxy) advertise the same default-deny posture for camera, microphone,
// geolocation, and payment APIs. Helmet doesn't set this header by
// default, and the prior config had Caddy as the only source.
app.use((_req, res, next) => {
  res.setHeader(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=(), payment=()",
  );
  next();
});
app.use(cors({ origin: allowedOrigins }));
// HTTP response compression. Mounted before any routers so JSON, HTML,
// JS, and CSS responses ship gzipped/br when shipped directly by Express.
// Lighthouse phase-1 measured a 2,590ms LCP saving and 473 KB transfer
// reduction in environments without a fronting reverse proxy — the
// largest single perf win in the codebase for sandbox / dev / direct-
// served deployments.
//
// In production we sit behind Caddy with `encode zstd gzip` (see
// Caddyfile). Caddy forwards the client's Accept-Encoding upstream;
// without this gate Express would compress with gzip and Caddy would
// pass that through, blocking Caddy's zstd negotiation for clients
// that support it. Setting BEHIND_REVERSE_PROXY=1 in the prod env
// turns Express compression off and lets Caddy own the encoding
// decision (it negotiates zstd with capable clients, gzip otherwise).
if (process.env.BEHIND_REVERSE_PROXY !== "1") {
  app.use(compression());
}
app.use(cookieParser());
// Issue / read the anonymous visitor_id cookie. Scoped to /api so that
// static asset requests (served by Caddy in prod, Vite in dev, but also
// handled by this Express server for some paths) don't incur the extra
// cookie write. Runs after cookieParser (needs req.cookies) and before
// the /api routers (so every REST handler sees req.visitorId).
app.use("/api", visitorCookie);
// Streamer-bot detection — stamps `req.isStreamerBot = true` when the
// request carries a valid `X-Streamer-Bot` shared-secret header. Analytics
// record paths gate on this flag to keep the bot's traffic out of the
// games-played counters. No-op in dev (when STREAMER_BOT_SECRET is unset).
// Mounted at /api so the /r short-link redirect path doesn't pay the cost.
app.use("/api", streamerBotDetect);
app.use(express.json({ limit: "100kb" }));

// Rate limiting for REST API endpoints. Applied as a TWO-stage chain
// per route below: the per-IP `apiLimiter` skips bot traffic, then
// `botApiLimiter` catches it with a single shared bucket sized for the
// bot's known burst pattern. Sizing it at 15× the human per-IP cap
// gives the bot enough headroom for a 5-round price-match plan
// (~8 clicks × 5 rounds = 40 reqs/min worst case) while bounding the
// blast radius if STREAMER_BOT_SECRET ever leaks: a malicious holder
// of the secret cannot exhaust the server's resources, only consume
// the bot's quota, and `streamer:rate_limited` telemetry would surface
// the abuse for revocation.
//
// The auth-surface limiters below (adminLoginLimiter, userLoginLimiter,
// userRegisterLimiter, emailActionLimiter, oauthLimiter,
// admin2faVerifyLimiter, galleryLimiter) are intentionally NOT exempted
// for the bot or any other client — they gate brute-force and abuse
// paths the bot has no business hitting. `imageLimiter` is also left
// alone since the bot doesn't generate image requests in volume.
const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: config.apiRateLimit,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please try again later" },
  // Bypass the per-IP cap for verified streamer-bot traffic. `botApiLimiter`
  // (below) catches it with a separate shared-bucket cap.
  skip: (req) => req.isStreamerBot === true,
});
const botApiLimiter = rateLimit({
  windowMs: 60 * 1000,
  // 15× the human per-IP cap. Tuned for solo-rotation worst case
  // (price-match: ~8 clicks per round × 5 rounds = ~40 submit-related
  // requests per minute) plus headroom for plan transitions and the
  // stats/music relay traffic.
  max: config.apiRateLimit * 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Streamer-bot quota exhausted" },
  // Skip non-bot traffic — that path is governed by `apiLimiter`.
  skip: (req) => req.isStreamerBot !== true,
  // Single shared bucket regardless of source IP: there is exactly one
  // valid bot-secret-holder, so per-IP keying would let an attacker
  // who leaked the secret distribute requests across many IPs to
  // multiply the cap.
  keyGenerator: () => "streamer-bot",
});
app.use("/api/game", apiLimiter, botApiLimiter, gameRouter);
app.use("/api/leaderboard", apiLimiter, botApiLimiter, leaderboardRouter);
app.use("/api/player", apiLimiter, botApiLimiter, playerRouter);
app.use("/api/mp", apiLimiter, botApiLimiter, multiplayerRouter);
app.use("/api/mp", apiLimiter, botApiLimiter, inviteRewardsApiRouter);
app.use("/api/users", apiLimiter, botApiLimiter, userBuffsRouter);
app.use("/r", apiLimiter, botApiLimiter, inviteResolverRouter);
app.use("/api/share", apiLimiter, botApiLimiter, shareRouter);
app.use("/api/daily", apiLimiter, botApiLimiter, dailyRouter);
app.use("/api/attribution", apiLimiter, botApiLimiter, createAttributionRouter());
app.use("/api/content", apiLimiter, botApiLimiter, createContentRouter());
app.use("/api/events", createEventsRouter());
// Streamer-bot stats relay. The bot POSTs here on every round; the
// server fans out via Socket.IO so all `?broadcast=1` viewers see
// the same numbers regardless of which Chromium is rendering them.
app.use("/api/streamer", apiLimiter, botApiLimiter, createStreamerRouter(io, createSqlitePersistence(db)));

// Sandbox-only TTS diagnostic. Spawns real Piper subprocesses and
// fans out the resulting tts.utterance.* envelopes via Socket.IO so
// the broadcast page exercises the production reducer path with
// real-time PCM batching. Mounted only in sandbox builds; production
// never exposes this surface.
if (process.env.SANDBOX === "1") {
  // Lazy require so the import doesn't pull node:child_process into
  // production startup (defensive — the file itself is sandbox-safe
  // either way, but skipping the require keeps the dep graph honest).
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createSandboxTtsRouter } = require("./routes/sandboxTts");
  // Apply the same `apiLimiter` every other API route uses — even
  // though the route itself has an in-flight guard, the rate limiter
  // bounds the rapid-sequential-call case (each call spawns a fresh
  // Piper subprocess).
  app.use("/api/sandbox/tts", apiLimiter, createSandboxTtsRouter(io));
  console.log("[sandbox] TTS lipsync diagnostic mounted at /api/sandbox/tts/cycle-moods");
}

// Setup Socket.IO multiplayer handlers
setDisconnectGraceMs(MP_DISCONNECT_GRACE_MS);
setupSocketHandlers(io);
setupAdminAnalyticsNamespace(io, db);

// Cleanup stale rooms periodically (DB + in-memory state)
setInterval(() => {
  try {
    // First, mark ghost players (connected in DB but no live socket) as disconnected.
    // This ensures cleanup rules see the correct connected player count.
    reapDisconnectedPlayers(getLivePlayerIds());

    const deletedCodes = cleanupStaleRooms();
    for (const code of deletedCodes) {
      cleanupRoomMemory(code);
    }
  } catch (err) {
    console.error("Room cleanup error:", err);
  }
}, config.roomCleanupInterval);

// Auto-lobby manager — split into two cadences so the user-visible
// countdown doesn't queue behind the spawn/churn work.
//
//   * Fast tick (every 2s): scan for elapsed countdowns and fire
//     startRound() within ~2s of the target time. Cheap — one indexed
//     SELECT against a tiny row set.
//   * Slow tick (every 30s): runAutoLobbyTick — spawn new auto-lobbies
//     toward the admin target and churn idle ones so the visible count
//     varies. 30s spreads naturally over the engagement-expert
//     recommended 90-240s churn band.
const AUTO_LOBBY_COUNTDOWN_TICK_MS = 2 * 1000;
const AUTO_LOBBY_SPAWN_TICK_MS = 30 * 1000;

setInterval(() => {
  let elapsed: string[] = [];
  try {
    elapsed = findElapsedCountdowns(db);
  } catch (err) {
    console.error("Auto-lobby countdown lookup error:", err);
    return;
  }
  // Process each elapsed countdown in its own try/catch so a single bad
  // room can't abort the whole batch. Re-check the connected-human count
  // inside the loop body — findElapsedCountdowns already filters on it,
  // but a human can disconnect between that SELECT and our startRound()
  // call. Without the recheck, the round fires and bots play themselves.
  for (const code of elapsed) {
    try {
      const room = getRoom(code);
      if (!room || room.status !== "lobby") {
        cancelCountdown(db, code);
        continue;
      }
      const stillHasHuman = db
        .prepare(
          `SELECT 1 FROM mp_players
            WHERE room_code = ? AND is_kicked = 0 AND is_bot = 0 AND connected = 1
            LIMIT 1`,
        )
        .get(code);
      if (!stillHasHuman) {
        cancelCountdown(db, code);
        continue;
      }
      // Clear the countdown columns BEFORE startRound so a transient
      // error in startRound can't leave us re-firing the same room each
      // tick.
      cancelCountdown(db, code);
      const payload = startRound(code, room.hostPlayerId, (rc: string) => handleTimerExpire(io, rc));
      if (payload) {
        io.to(code).emit(SOCKET_EVENTS.GAME_ROUND_START, payload);
        triggerPostRoundStart(io, code, payload);
      }
    } catch (err) {
      console.error(`Auto-lobby start-round error for ${code}:`, err);
    }
  }
}, AUTO_LOBBY_COUNTDOWN_TICK_MS);

setInterval(() => {
  try {
    runAutoLobbyTick(db);
  } catch (err) {
    console.error("Auto-lobby spawn tick error:", err);
  }
}, AUTO_LOBBY_SPAWN_TICK_MS);

// Ghost-user manager — bring shifts on/off, honor breaks, evict on
// kill-switch. 60s cadence: cheap (one indexed scan + a handful of
// targeted UPDATEs per tick) but slow enough that a player watching the
// live lobby browser doesn't see the on-shift count flip every second.
const GHOST_USERS_TICK_MS = 60 * 1000;
setInterval(() => {
  try {
    runGhostUsersTick(db);
  } catch (err) {
    console.error("Ghost-users tick error:", err);
  }
}, GHOST_USERS_TICK_MS);

// Daily cadence ticks for the slower lifecycle steps. Both run on a 1h
// interval (cheap; the streak advance is idempotent within a UTC day so
// the worst case is a single-pass extra read once per hour, and the
// cycling sweep is a single indexed UPDATE). The 1h cadence means a
// streak break or a freshly-retired ghost reflects within an hour
// instead of having to wait for a true once-per-day cron.
const GHOST_DAILY_TICK_MS = 60 * 60 * 1000;
setInterval(() => {
  try {
    simulateGhostDailyPlays(db, new Date().toISOString().slice(0, 10));
  } catch (err) {
    console.error("Ghost daily-sim tick error:", err);
  }
  try {
    retireInactiveGhosts(db);
  } catch (err) {
    console.error("Ghost-cycling tick error:", err);
  }
}, GHOST_DAILY_TICK_MS);

app.get("/api/health", (_req, res) => {
  try {
    const dbCheck = db.prepare("SELECT 1").get();
    res.json({
      status: "ok",
      db: dbCheck ? "connected" : "error",
    });
  } catch {
    res.status(503).json({ status: "error", db: "disconnected" });
  }
});

app.get("/api/exchange-rates", (_req, res) => {
  res.json(getRates());
});

// Public promo banner settings (no auth required)
app.get("/api/settings/banner", (_req, res) => {
  res.json(getPromoBanner(db));
});

// Public game mode settings (no auth required — tells client which modes are disabled)
app.get("/api/settings/game-modes", (_req, res) => {
  try {
    res.json({ disabledModes: getDisabledGameModes(db) });
  } catch {
    res.json({ disabledModes: [] });
  }
});

// Public avatar settings (no auth required — tells client which avatars are enabled)
app.get("/api/settings/avatars", (_req, res) => {
  try {
    const disabled = getDisabledAvatars(db);
    const disabledSet = new Set(disabled);
    const enabledAvatars = AVATARS.filter((a) => !disabledSet.has(a));
    res.json({ enabledAvatars });
  } catch {
    res.json({ enabledAvatars: [...AVATARS] });
  }
});

// Public legal document endpoint (privacy policy and terms of service)
app.get("/api/settings/legal/:key", apiLimiter, (req, res) => {
  const { key } = req.params;
  if (key !== "privacy_policy" && key !== "terms_of_service") {
    res.status(404).json({ error: "Not found" });
    return;
  }
  // Gate on the admin visibility toggle. `privacy_policy` stores under
  // the `privacy` page key and `terms_of_service` under `terms`, keeping
  // the public slugs short while reusing the shared page-visibility map.
  const pageKey = key === "privacy_policy" ? "privacy" : "terms";
  if (!isPageEnabled(db, pageKey)) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  try {
    const content = getLegalDocument(db, key);
    res.json({ key, content });
  } catch {
    res.json({ key, content: "" });
  }
});

// H1 fix: dedicated rate limiter for image proxy (heavier endpoint due to curl scraping).
// On 429 responses we explicitly set `Cache-Control: no-store` so iOS Safari does not
// cache the rate-limit body as a broken image — observed in the wild on mobile
// clients, where a single burst of requests would cause subsequent product images to
// appear broken for the full heuristic-freshness window until a manual refresh.
//
// The streamer bot is exempt (see apiLimiter comment). Without this, every
// time the bot played a round its repeated `/api/image/:id` fetches ate
// into the shared NAT-egress IP's budget and tripped 429s for every other
// human player on that IP — observed as a global "$?" placeholder spike.
const imageLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: config.imageRateLimit,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.isStreamerBot === true,
  handler: (_req, res) => {
    res.setHeader("Cache-Control", "no-store, must-revalidate");
    res.status(429).send("Too many image requests");
  },
});

app.use("/api/image", imageLimiter, createImageRouter(() => db));

// Admin panel rate limiter (password login).
// Wrapped to match the exact mount point only — Express app.use() does
// prefix matching, so bare adminLoginLimiter on "/api/admin/login" would
// also fire for "/api/admin/login/verify-2fa", defeating the split.
const adminLoginLimiter = rateLimit({
  windowMs: config.adminLoginRateWindowMs,
  max: config.adminLoginRateLimit,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many login attempts, please try again later" },
});
app.use("/api/admin/login", (req, res, next) => {
  if (req.path !== "/") return next();
  adminLoginLimiter(req, res, next);
});
app.use("/api/admin/extension/login", (req, res, next) => {
  if (req.path !== "/") return next();
  adminLoginLimiter(req, res, next);
});
// Separate budget for 2FA verification so failed TOTP attempts don't
// eat into the password-login allowance
const admin2faVerifyLimiter = rateLimit({
  windowMs: config.admin2faVerifyRateWindowMs,
  max: config.admin2faVerifyRateLimit,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many verification attempts, please try again later" },
});
app.use("/api/admin/login/verify-2fa", admin2faVerifyLimiter);
app.use("/api/admin/extension/login/verify-2fa", admin2faVerifyLimiter);
app.use("/api/admin/notifications", apiLimiter, createAdminNotificationRouter(undefined, io));
app.use("/api/admin/email", apiLimiter, createAdminEmailRouter());
// Gallery endpoints: JSON calls (/assets, /assets/*) get a generous
// per-minute limit; authenticated /files/* binary fetches are exempt
// entirely because the gallery page fires hundreds of parallel image
// requests per view and auth still runs on every request inside the
// router. Unauthenticated /files/* hits DO count against the limit,
// so a cold-cache flood can't bypass rate limiting by picking the
// /files/ sub-path — the skip only kicks in when a session cookie is
// already attached. cookieParser() has already run globally by this
// point, so req.cookies is populated.
const galleryLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 2000,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please try again later" },
  skip: (req) => {
    if (!req.path.startsWith("/files/")) return false;
    const cookies = req.cookies as Record<string, string> | undefined;
    return Boolean(cookies?.[config.adminCookieName]);
  },
});
app.use("/api/admin/gallery", galleryLimiter, createAdminGalleryRouter());
app.use("/api/admin/leaderboard", apiLimiter, createAdminLeaderboardRouter());
app.use("/api/admin/metrics", apiLimiter, createAdminMetricsRouter(io));
app.use("/api/admin", apiLimiter, createAdminRouter());

// Push notification routes
app.use("/api/push", apiLimiter, createPushRouter());

// Marketing / re-engagement email routes (preferences + one-click
// unsubscribe + Resend webhook). The webhook sub-route is intentionally
// mounted under the same rate limiter: Resend's call volume is low and
// we get cheap protection from the general API limit.
app.use("/api/email", apiLimiter, createEmailRouter());

// User account rate limiters
const userLoginLimiter = rateLimit({
  windowMs: config.userLoginRateWindowMs,
  max: config.userLoginRateLimit,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many login attempts, please try again later" },
});
const userRegisterLimiter = rateLimit({
  windowMs: config.userRegisterRateWindowMs,
  max: config.userRegisterRateLimit,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many registration attempts, please try again later" },
});
const emailActionLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please try again later" },
});
const oauthLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many OAuth requests, please try again later" },
});
app.use("/api/user/login", userLoginLimiter);
app.use("/api/user/register", userRegisterLimiter);
app.use("/api/user/forgot-password", emailActionLimiter);
app.use("/api/user/reset-password", emailActionLimiter);
app.use("/api/user/resend-verification", emailActionLimiter);
app.use("/api/user/verify-email", emailActionLimiter);
app.use("/api/user/oauth/google", oauthLimiter);
app.use("/api/user/oauth/facebook", oauthLimiter);
app.use("/api/user/username", emailActionLimiter);
app.use("/api/user", apiLimiter, createUserRouter());

// Initialize push notification service and scheduler
if (initWebPush()) {
  const notifInterval = startNotificationScheduler(db, io);
  process.on("SIGTERM", () => clearInterval(notifInterval));
  process.on("SIGINT", () => clearInterval(notifInterval));
} else {
  console.log("Push notifications disabled (VAPID keys not set)");
}

// Start the email scheduler independently of push. It runs on a
// separate interval (default 15 min) and is gated only on having a
// database — not on the Resend API key — so that scheduled rows still
// accumulate in dev (where sendEmail falls back to console logging).
const emailInterval = startEmailScheduler(db);
process.on("SIGTERM", () => clearInterval(emailInterval));
process.on("SIGINT", () => clearInterval(emailInterval));

// Catch-all 404 for undefined API routes (before static file serving)
app.use("/api", (_req, res) => {
  res.status(404).json({ error: "Not found" });
});

// Public short-link redirect (/go/:code). Mounted here so the handler wins
// over the SPA catchall below. The same apiLimiter used by every other
// public REST endpoint is applied only to the /go/:code route, not to the
// whole router mount — mount-level middleware would incorrectly count every
// request toward the rate limit.
app.use(createShortLinkRouter(undefined, apiLimiter));

// SEO: /robots.txt and /sitemap.xml. Mounted before the SPA catchall so
// these resolve as real text/xml responses instead of falling through to
// index.html.
app.use(createSeoRouter(() => db));

// Serve static frontend in production.
// Hashed assets (JS/CSS in /assets/) are immutable — cache aggressively.
// index.html must always be revalidated so users pick up new chunk references
// after a deployment (prevents "Failed to fetch dynamically imported module").
const webDist = path.resolve(__dirname, "../../web/dist");
app.use(
  "/assets",
  express.static(path.join(webDist, "assets"), {
    maxAge: "1y",
    immutable: true,
  }),
);
// Serve static files from web/dist but exclude index.html — it needs the
// meta-injection pass below so bots receive per-route title/description.
app.use(express.static(webDist, { maxAge: 0, index: false }));
const metaInjector = createIndexHtmlMetaMiddleware(resolveIndexHtmlPath(webDist), {
  // Per-share dynamic meta: pulls score/mode/player from shared_games so
  // each /s/:id URL gets a descriptive title + OG preview. Falls through
  // to the page-visibility resolver, which forces `noindex` on any SEO
  // page the admin has marked as not visible.
  dynamicResolver: (pathname) =>
    resolveShareMeta(() => db, pathname) ?? resolvePageVisibilityMeta(() => db, pathname),
  // Per-route body content injected inside `<div id="root">…</div>` so
  // non-JS crawlers (AI search bots, link-preview fetchers) see real
  // page copy. React's `createRoot` replaces these children on
  // hydration, so real users only see the static copy for a beat before
  // the live app renders.
  bodyResolver: (pathname) => {
    try {
      return renderSeoBody(pathname, db);
    } catch {
      return "";
    }
  },
});
// Mounted before the SPA catch-all so the 404 happens before
// index.html is composed. NOTE: any future endpoint that reveals
// broadcast state (a JSON shadow of the overlay, an SSR'd shell)
// must mount AFTER this middleware to inherit the same hostname gate
// — the existing `/api/streamer/*` routes are above this line and
// are intentionally NOT covered, since they don't render the
// overlay (see I1/I2 in the PR review).
app.use(denyPublicBroadcastFromEnv());

app.get("*", metaInjector, (_req, res) => {
  // Fallback if the meta injector is disabled (template not found on disk).
  res.setHeader("Cache-Control", "no-cache");
  res.sendFile(path.join(webDist, "index.html"));
});

// Fetch exchange rates on startup (fire and forget)
fetchRates();

// Seed initial admin user from environment variables
seedInitialAdmin(db);

// Periodically clean up expired admin sessions and 2FA pending tokens
setInterval(() => {
  try {
    cleanupExpiredSessions(db);
    cleanupExpiredPendingTokens(db);
  } catch (err) {
    console.error("Admin session cleanup error:", err);
  }
}, config.adminSessionCleanupIntervalMs);

// Periodically clean up expired user sessions
setInterval(() => {
  try {
    cleanupExpiredUserSessions(db);
  } catch (err) {
    console.error("User session cleanup error:", err);
  }
}, config.userSessionCleanupIntervalMs);

// Periodically clean up expired/used email verification and password reset tokens
setInterval(() => {
  try {
    cleanupExpiredTokens(db);
  } catch (err) {
    console.error("Token cleanup error:", err);
  }
}, config.userSessionCleanupIntervalMs);

// Analytics maintenance jobs: close idle sessions, rebuild hourly rollups,
// purge events past retention. All unref'd so process exit isn't blocked.
startSessionCloseout(db);
startAnalyticsHourlyJob(db);
startEventRetentionPurge(db);

// Reward claim-window sweeper. Runs hourly: voids unclaimed awards past
// their 30-day deadline (returning the pool row to 'available') and sends
// 15/7/1-day claim reminders. The cadence is hourly because deadlines are
// date-grained, not minute-grained — the worst case is a 1h delay between
// crossing the deadline and the user seeing the expiry email.
const REWARD_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
function rewardSweepTick(): void {
  try {
    expireOverdueRewards(db);
    sendClaimReminders(db);
  } catch (err) {
    console.error("[reward-sweep] tick failed:", err);
  }
}
// Fire once on boot so a long-running expiry that lapsed during downtime
// is caught immediately, then re-arm on the hour.
rewardSweepTick();
setInterval(rewardSweepTick, REWARD_SWEEP_INTERVAL_MS).unref();

// Warn if APP_URL is not HTTPS in production
if (process.env.NODE_ENV === "production" && !config.appUrl.startsWith("https://")) {
  console.warn(
    "WARNING: APP_URL is not HTTPS. Email links will use insecure URLs. " +
    "Set APP_URL to an https:// URL in production.",
  );
}

httpServer.on("error", (err) => {
  console.error("Server failed to start:", err);
  process.exit(1);
});

httpServer.listen(config.port, () => {
  console.log(`Server running on http://localhost:${config.port}`);
});

// Graceful shutdown
// Force-exit timeout is set below Docker's stop_grace_period (30s in
// docker-compose.prod.yml) so we always exit cleanly before SIGKILL.
function shutdown() {
  console.log("Shutting down gracefully...");
  io.close(() => {
    httpServer.close(() => {
      db.close();
      console.log("Server stopped.");
      process.exit(0);
    });
  });
  setTimeout(() => process.exit(1), 25000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
process.on("SIGUSR2", shutdown);

export default app;
