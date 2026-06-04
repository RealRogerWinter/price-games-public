---
title: Multiplayer Invites
status: stable
last_reviewed: 2026-06-03
owner: core
audience: contributor
category: game-design
summary: "Inviting friends to a lobby: links, QR codes, and the reward economy."
related_code:
  - apps/server/src/routes
  - apps/server/src/socket
---
# Multiplayer Lobby-Invite Rewards

A gameplay-tied incentive: when you share your multiplayer **room link** and a friend joins and plays, both of you get a temporary score buff. The reward is meant to nudge "real humans playing together" — the configuration most likely to drive week-2 retention — without distorting the leaderboard or opening a farming meta.

> This system is **strictly distinct from the signup-referral system** (`/?ref=XYZ`, `referrals` table, monthly Amazon-gift-card giveaway entries). Different lever, different abuse model, different reward shape. They share zero code paths beyond the visitor-cookie helpers.

## Reward shape (V1)

| Beneficiary | Multiplier | Matches | Notes |
|---|---|---|---|
| **Inviter** (host) | **+25% score** | next **3** matches | Felt; bounded; works without an idle-economy or cosmetic shop. |
| **Joiner** | **+10% score** | next **1** match | Smaller welcome bonus — they didn't do the work but participation should feel like a participation, not a marketing moment. |

Buffed scores **count toward the leaderboard** and `users.lifetime_score`. Each buffed `user_game_history` row is tagged `was_buffed = 1` with the pre-buff `raw_score` preserved, so a future "ranked-pure" leaderboard view can carve buffed runs out without a migration.

Buffs **do not stack** — when a player ends a match with multiple active buffs, the highest multiplier is consumed; the others wait. There is no expiry decay; buffs only disappear when consumed (or 14 days after issue, the hard TTL).

## Trigger

The reward is **earned** the first time the joiner submits an actual guess in their **3rd round** in the room (not just sits through the round timer). Server-auto-inserted "you ran out of time" rows (`{"timedOut": true}`) do not count toward the threshold; any actual guess does. Round-1-only / lobby-only joins do *not* earn — that gate is what defeats the "press join + leave" exploit.

Until earn, the attribution row is `pending`. After, it's `earned`. There is no `unearned` recovery — once `pending` rolls over, it stays.

## URL & cookie flow

- The host opens the share modal in the lobby. The modal mints an opaque token via `POST /api/mp/rooms/:code/invite-token` and renders `https://price.games/r/<10-char-token>` as the share URL (plus a QR code).
- The joiner clicks/scans the link → server hits `GET /r/:token` → 302 to `/{roomCode}` with `Set-Cookie: pg_inv=<token>; HttpOnly; SameSite=Lax; Max-Age=1800`.
- Joiner lands on the SPA, JoinScreen prefills the room code, and the user joins via socket.
- The Socket.IO middleware reads the `pg_inv` cookie from the handshake and stores it on `socket.data.inviteToken`.
- After `joinRoom()` succeeds, `roomHandlers.handleRoomJoin` calls `inviteRewards.attributeJoin(...)` which runs all abuse checks in a single `BEGIN IMMEDIATE` transaction and inserts either a `pending` or `rejected` attribution row.
- After every round ends, `mpRoundEnd.endRound` calls `recordRoundCompleted(...)` for each joiner who submitted a non-default guess in that round. On the 3rd-round transition, the attribution flips to `earned`, two `mp_pending_buffs` rows are inserted (host + joiner), and `invite:reward_earned` / `invite:welcome_bonus` socket events fire.
- When a player finishes a future match, `mpRoundEnd.saveToLeaderboard` calls `applyBuffs(...)` to consume the highest active buff. The result is persisted with `was_buffed = 1` and emitted as `invite:buff_consumed` so the client can show the "+25% applied" math on the results screen.

The plain `/{roomCode}` URL still works as a fallback (e.g. when a friend pastes only the room code) — joiners can always join, the inviter just doesn't earn a reward in that path.

## Anti-abuse caps

All checks are silent — rejected attributions are recorded with a `reject_reason` for analytics but the joiner never sees a refusal. Exposing the reason would be a free abuse oracle.

| Rule | Threshold | Reason code |
|---|---|---|
| Self-invite (same visitor cookie) | hard reject | `self_invite` |
| Inviter and joiner share an IP | hard reject | `ip_collision` |
| Joiner account (when logged in) | < 10 minutes old | `new_account` |
| Same `(inviter_visitor_id, joiner_identity_key)` pair within 30 days | hard reject | `pair_dedup` |
| Per-host earned in last 24 h | ≥ 5 | `cap_daily` |
| Per-host earned in last 7 days | ≥ 5 | `cap_weekly` |
| Per joiner-IP earned in last 24 h | ≥ 3 | `ip_throttle` |
| Unknown / revoked token | hard reject | `unknown_token` |

`joiner_identity_key` is `u:<userId>` when the joiner is logged in, else `v:<visitorId>`. Pair dedup is the binding constraint that prevents two real friends farming each other.

## Welfare guardrails

- **No leaderboard penalty** for not inviting; rewards are purely additive.
- **No streak / decay pressure** on the buff — it doesn't expire mid-match, doesn't punish a missed window.
- **No email harvesting** on the share path. The link is the link; we don't capture the joiner's email.
- **Same-IP rejection has no appeal flow** — couples and roommates don't earn this reward, but they can still play together. Acceptable loss vs. fraud-review queue.

## Source of truth for tunables

All magic numbers live in [`apps/server/src/services/inviteRewards.ts`](../apps/server/src/services/inviteRewards.ts) as exported constants:

```ts
INVITE_REWARD_HOST_MULTIPLIER  = 1.25
INVITE_REWARD_HOST_MATCHES     = 3
INVITE_REWARD_JOINER_MULTIPLIER = 1.10
INVITE_REWARD_JOINER_MATCHES    = 1
INVITE_BUFF_TTL_SECONDS         = 14 * 24 * 60 * 60
INVITE_REWARD_TRIGGER_ROUNDS    = 3
INVITE_NEW_ACCOUNT_GATE_SECONDS = 600
INVITE_PAIR_DEDUP_SECONDS       = 30 * 24 * 60 * 60
INVITE_HOST_WEEKLY_CAP          = 5
INVITE_HOST_DAILY_CAP           = 5
INVITE_IP_DAILY_CAP             = 3
INVITE_TOKEN_LENGTH             = 10
```

Changing any of these requires a doc update in the same PR — that's our rule for transparency on retention mechanics.

## Sandbox-only bypass for testing the buff flow

Both the `ip_collision` and `ip_throttle` anti-abuse rules block the
common dev-loop where a single tester wants to walk both sides of the
flow (invite from one tab, accept from another) on the same machine.

To unblock that, the server honors a sandbox-only env flag:

```bash
SANDBOX=1
SKIP_INVITE_IP_CHECKS=1
```

When **both** are set, `inviteRewards` skips the same-IP rejection AND
the per-IP daily cap, so a single IP can self-test the +25% / +10%
buff path end-to-end. The rest of the rules (self-invite, pair dedup,
new-account gate, per-host caps) still apply.

A boot-time guard in `apps/server/src/index.ts` refuses to start the
server if `SKIP_INVITE_IP_CHECKS=1` is set without `SANDBOX=1` — same
pattern used for `SKIP_ADMIN_2FA` and `SKIP_TURNSTILE`. Production
images never set either flag.

The flag is wired on by default in `docker-compose.sandbox.yml`. To
exercise the real anti-abuse path inside a sandbox, unset it on the
container env and restart.

## `public_game` — adjacent buff source on the same consumer

The `mp_pending_buffs` table is intentionally generic — `source` is a string discriminator, not a foreign-key-tied invite role. A second source ships alongside the invite system:

| Source | Multiplier | Matches | Trigger |
|---|---|---|---|
| `public_game` | **+10% score** | next **1** match | Awarded automatically to every real-human player who completes the final round of a publicly-listed lobby. |

The grant lives in [`grantPublicGameBuff`](../apps/server/src/services/inviteRewards.ts) and is called from `mpRoundEnd.saveToLeaderboard` on the `isLastRound` branch when `room.is_public === 1`. Bots and ghosts are skipped; logged-in users without a `visitor_id` get a `u:<userId>` sentinel so dedup queries can't false-positive across users.

The function is idempotent against an already-active `public_game` buff for the same beneficiary — a player who finishes back-to-back public games doesn't pile up rows. Once consumed, a fresh grant is permitted on the next public-game completion. Migration v54 made `mp_pending_buffs.attribution_id` nullable so non-invite sources can grant without an attribution row.

Tunables (`apps/server/src/services/inviteRewards.ts`):

```ts
PUBLIC_GAME_BUFF_MULTIPLIER = 1.10
PUBLIC_GAME_BUFF_MATCHES    = 1
```

Buffs from any source share the same `applyBuffs` consumer (highest-multiplier wins, no stacking) and emit the same `invite:buff_consumed` socket event. The MP results screen branches on `source` for the buff-card title ("Friendship Boost applied" / "Welcome bonus applied" / "Public-lobby bonus applied").

## Out of scope (today)

- Per-channel direct-share buttons (WhatsApp / Discord / X / iMessage) — V1 ships native share + copy + QR.
- A "Together Tokens" cosmetic currency — deferred until a cosmetic shop exists.
- Idle-economy "Rush" buff integration — tracked as a separate, not-yet-documented workstream.
- Email / push notifications when rewards are earned — V1 is web-only in-session feedback.

## Adjacent fixes that shipped with this feature

These are not part of the invite-reward state machine itself but shipped
alongside the invite-reward system because the multiplayer flow couldn't
ship cleanly without them.

- **Public-lobby toggle finally takes effect.** `roomManager.updateSettings`
  + `socket/roomHandlers.ts:handleRoomSettings` now accept and persist
  `isPublic`. The pre-existing host UI checkbox was a write the server
  silently ignored, leaving rooms stuck in their creation visibility. The
  `room:settings_updated` socket broadcast now also carries `isPublic` so
  every client in the room sees the change live.

- **Self-rejoin is blocked.** Joining your own lobby through the public
  browser used to create a duplicate `mp_players` row under the same
  display name — same identity, fresh socket replaced the old one
  (marked offline). Two-layer fix: `LobbyBrowser` filters out the user's
  own current room before rendering, and `roomManager.joinRoom` rejects
  a join attempt with `"You are already in this room"` if a player
  matching the caller's identity (user_id when logged in, else
  visitor_id) is already present and not kicked.

- **Reserved usernames.** Guests can no longer pick a registered
  account's username as a multiplayer display name. Both `createRoom`
  and `joinRoom` call a new `isReservedUsername(name)` helper that
  matches against `users.username_normalized` (case-insensitive). The
  rejection message ("That name belongs to a registered account…") is
  the same username-existence signal the signup form already exposes —
  not a new enumeration vector. Logged-in users are exempt; their own
  username is fair game.

- **Migration version.** This feature's schema (`mp_invite_tokens`,
  `mp_invite_attributions`, `mp_pending_buffs`, plus the `was_buffed` /
  `raw_score` columns on `user_game_history`) landed as migration **v52**.
  Migration v54 later loosened `mp_pending_buffs.attribution_id` to be
  nullable so non-invite buff sources (e.g. `public_game`) can grant rows
  without an attribution parent. See [DATABASE.md](DATABASE.md) for the
  full schema and migration history.
