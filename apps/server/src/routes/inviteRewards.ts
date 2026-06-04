/**
 * HTTP routes for the lobby-invite reward system.
 *
 * Three routers exported:
 *   - inviteRewardsApiRouter — mounted at /api/mp; covers token mint + revoke
 *   - inviteResolverRouter   — mounted at /r;     302 → /{roomCode} + cookie
 *   - userBuffsRouter        — mounted at /api/users; GET /me/buffs
 *
 * The mint endpoint authorizes via `playerToken` (the value in
 * `mp_players.token`, returned to the client when the host joined the room).
 * The visitor cookie supplied by `visitorCookie` middleware is the identity
 * the reward attribution is keyed on — even if the host is a guest.
 *
 * The resolver is intentionally permissive: any unknown/revoked token
 * silently redirects to /multiplayer with no cookie. Joiners must NEVER see
 * a "your invite was rejected" message — that would be a free abuse oracle.
 */

import { Router, Request, Response } from "express";
import db from "../db";
import {
  mintInviteToken,
  revokeInviteToken,
  getActiveBuffs,
} from "../services/inviteRewards";
import { optionalUser } from "../middleware/userAuth";

const INVITE_COOKIE_NAME = "pg_inv";
const INVITE_COOKIE_MAX_AGE_MS = 30 * 60 * 1000; // 30 min — long enough to click + sign up

// ---------------------------------------------------------------------------
// /api/mp/rooms/:code/invite-token  +  /api/mp/invite-tokens/:token
// ---------------------------------------------------------------------------

export const inviteRewardsApiRouter: Router = Router();

interface MintBody {
  playerToken?: string;
}

inviteRewardsApiRouter.post(
  "/rooms/:code/invite-token",
  optionalUser,
  (req: Request<{ code: string }, unknown, MintBody>, res: Response): void => {
    const code = req.params.code;
    const playerToken = req.body?.playerToken;
    if (!playerToken || typeof playerToken !== "string") {
      res.status(400).json({ error: "playerToken required" });
      return;
    }
    const room = db
      .prepare("SELECT host_player_id FROM mp_rooms WHERE code = ?")
      .get(code) as { host_player_id: string } | undefined;
    if (!room) {
      res.status(404).json({ error: "Room not found" });
      return;
    }
    const player = db
      .prepare(
        "SELECT id FROM mp_players WHERE token = ? AND room_code = ? AND is_kicked = 0",
      )
      .get(playerToken, code) as { id: string } | undefined;
    if (!player || player.id !== room.host_player_id) {
      res.status(403).json({ error: "Only the host may mint invite tokens" });
      return;
    }
    // visitorCookie middleware (mounted at /api) guarantees req.visitorId.
    // Defensively short-circuit if it's somehow unset rather than minting
    // tokens for a literal "anon" identity.
    const visitorId = req.visitorId;
    if (!visitorId) {
      res.status(500).json({ error: "Visitor cookie not initialized" });
      return;
    }
    const ip = req.ip ?? "0.0.0.0";
    try {
      const result = mintInviteToken(db, {
        roomCode: code,
        inviterUserId: req.user?.id ?? null,
        inviterVisitorId: visitorId,
        inviterIp: ip,
        inviterFp: null,
      });
      // Compose the absolute URL using Express's proxy-aware proto + hostname
      // (controlled by `trust proxy = ["loopback","linklocal","uniquelocal"]`,
      // see `apps/server/src/index.ts:96`). Reading req.headers directly
      // would let an attacker reflect a controlled Host header into the share
      // URL we return as data — even though there's no open-redirect (we
      // never 302 to it), an attacker could phish "join my Price Games room"
      // links pointing at a confusable domain.
      const proto = req.protocol;
      const host = req.hostname;
      res.json({
        token: result.token,
        url: `${proto}://${host}/r/${result.token}`,
      });
    } catch (err) {
      console.error("[invite] mint failed", err);
      res.status(500).json({ error: "Failed to mint token" });
    }
  },
);

// Constrain :token to the canonical 10-char alphanumeric format. Defence-
// in-depth — prepared statements already prevent SQL injection — but it
// reduces the surface for malformed-input probes and matches the GET /r/
// resolver's regex.
inviteRewardsApiRouter.delete(
  "/invite-tokens/:token([A-Za-z0-9]{10})",
  (req: Request<{ token: string }>, res: Response): void => {
    // visitorCookie middleware (mounted at /api) guarantees req.visitorId.
    // Defensively short-circuit if it's somehow unset rather than minting
    // tokens for a literal "anon" identity.
    const visitorId = req.visitorId;
    if (!visitorId) {
      res.status(500).json({ error: "Visitor cookie not initialized" });
      return;
    }
    const ok = revokeInviteToken(db, req.params.token, visitorId);
    if (!ok) {
      res.status(404).json({ error: "Token not found" });
      return;
    }
    res.sendStatus(204);
  },
);

// ---------------------------------------------------------------------------
// /r/:token resolver
// ---------------------------------------------------------------------------

export const inviteResolverRouter: Router = Router();

// Path constraint: only 10-character alphanumeric tokens. The existing
// signup-referral redirect uses `/r/{8-char-code}` and is handled by the
// React-Router fallback — by constraining length here we let those requests
// fall through to the SPA without intercepting them.
inviteResolverRouter.get(
  "/:token([A-Za-z0-9]{10})",
  (req: Request<{ token: string }>, res: Response): void => {
    const tokenRow = db
      .prepare(
        `SELECT room_code FROM mp_invite_tokens
          WHERE token = ? AND revoked_at IS NULL`,
      )
      .get(req.params.token) as { room_code: string } | undefined;
    if (!tokenRow) {
      res.redirect("/multiplayer");
      return;
    }
    res.cookie(INVITE_COOKIE_NAME, req.params.token, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: INVITE_COOKIE_MAX_AGE_MS,
      path: "/",
    });
    res.redirect(`/${tokenRow.room_code}`);
  },
);

// ---------------------------------------------------------------------------
// /api/users/me/buffs
// ---------------------------------------------------------------------------

export const userBuffsRouter: Router = Router();

userBuffsRouter.get(
  "/me/buffs",
  optionalUser,
  (req: Request, res: Response): void => {
    // visitorCookie middleware (mounted at /api) guarantees req.visitorId.
    // Defensively short-circuit if it's somehow unset rather than minting
    // tokens for a literal "anon" identity.
    const visitorId = req.visitorId;
    if (!visitorId) {
      res.status(500).json({ error: "Visitor cookie not initialized" });
      return;
    }
    const active = getActiveBuffs(db, {
      beneficiaryUserId: req.user?.id ?? null,
      beneficiaryVisitorId: visitorId,
    });
    res.json({ active });
  },
);
