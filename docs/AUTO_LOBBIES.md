---
title: Auto Lobbies
status: stable
last_reviewed: 2026-06-03
owner: core
audience: contributor
category: game-design
summary: "Quickplay matchmaking: auto-spawned lobbies, bot disguise, fill-up logic."
related_code:
  - apps/server/src/socket
  - apps/server/src/routes
---
# Auto-Lobbies

The auto-lobby system spawns and maintains a population of public,
joinable multiplayer lobbies pre-populated with bots. It exists to solve
the "empty lobby browser" problem during low-traffic windows: a new
visitor who lands on the multiplayer page should never see zero
joinable rooms.

## How it works

A background scheduler tick (default 30s, in `apps/server/src/index.ts`)
does two jobs:

1. **Maintain population.** If the count of public lobbies is below the
   admin-configured target, spawn more — capped at 3 per tick to avoid
   identical creation timestamps clustering in the lobby browser.
2. **Drive countdowns.** When a real human joins an auto-lobby, the
   `joinRoom` flow writes a `countdown_target_at` to the room. Each tick
   checks for elapsed countdowns and fires `startRound()` for them
   (only when ≥1 connected human is still seated).

When the master toggle is off, no spawn ever happens; existing idle
auto-lobbies are reaped within ~5 minutes by the standard
`cleanupStaleRooms` sweep.

## The disguise layer

Each bot in an auto-lobby has an `is_disguised` flag (DB column on
`mp_players`). The wire payload (`MultiplayerPlayer.isBot`) returns
`false` for disguised bots so the client renders them like any other
anonymous player. Server-side logic — scoring, scheduling, ready-checks
— uses `isServerSideBot()` from `services/autoLobby/identity.ts` which
ignores `is_disguised` and only looks at `is_bot`.

Disguised bots use a separate human-handle name pool (`mike_42`,
`sarahxo`, `pricepro`); labeled bots keep the legacy `Adjective Animal`
generator so a player who pattern-matches on capitalized two-word names
sees only the labeled bots.

## Configuration

Stored as a single JSON blob under `auto_lobbies` in `site_settings`.
Admin REST: `GET/PUT /api/admin/auto-lobbies` (require admin + 2FA).

| Field | Default | Notes |
|---|---|---|
| `enabled` | `false` | Master toggle. Ships dark. |
| `targetCount` | 6 | Visible lobbies the system aims to maintain. |
| `disguiseRatioMin` / `disguiseRatioMax` | 50 / 70 | Per-spawn disguise ratio (uniform draw within range). |
| `countdownMinSeconds` / `countdownMaxSeconds` | 15 / 45 | Pre-game countdown bounds. |
| `modeAllowlist` | `[]` (= all enabled modes) | Admin can scope auto-spawn to a subset. |

## Tuning

Disguised bots route through a softer skill profile so the real player
typically wins (target ≈60% human win rate at game 5+). All numbers
live in `services/autoLobby/tuning.ts`:

- Sigma multiplier: 1.25× baseline / 1.40× during the new-player ramp.
- Categorical correctness: 48/60/72% baseline, 42/55/65% soft.
- Archetype mix shifted away from `expert` (10% baseline, 5% soft) and
  toward `average-joe` / `wild-card`.
- Session ramp: games 0–1 use the soft profile, games 2–4 interpolate,
  game 5+ settles to baseline. Ramp lookup keyed on the human's
  server-side session game count.
- Per-bot AR(1) momentum scalar (`momentum.ts`) clamped [0.7, 1.3]
  multiplies sigma each round, producing 2–4 round streaks instead of
  uniform performance.
- Humanlike submission delay (`timing.ts`): 70/20/10 mixture of
  lognormal-medium / fast-confident / thinking-pause; shifts to 50/10/40
  on hard difficulty.

Labeled bots keep the baseline (un-softened) personality system —
they're the "honest competition" and an obvious win against one feels
earned.

## Schema

Migration `v49` adds:

- `mp_rooms.is_auto_lobby INTEGER NOT NULL DEFAULT 0`
- `mp_rooms.countdown_started_at TEXT`
- `mp_rooms.countdown_target_at TEXT`
- `mp_players.is_disguised INTEGER NOT NULL DEFAULT 0`
- Partial index `idx_mp_rooms_auto_lobby` on `(is_auto_lobby, status)`
  to keep manager-tick queries cheap.

## Lobby endpoint

`/api/mp/lobbies` (in `routes/multiplayer.ts`) was relaxed to surface
auto-lobbies: real user-created lobbies still require ≥1 connected
human (so zombie rooms stay hidden), but auto-lobbies are exempt.

## What's not yet wired

Pure-function modules exist for these but the integration plumbing is
follow-up work:

- **Bot guess pipeline:** `tuning.ts` + `momentum.ts` aren't yet read
  by `botGuess.ts` / `botPersonality.ts`. Disguised bots currently use
  the baseline personality system.
- **Bot scheduler timing:** `timing.ts` isn't yet substituted for the
  flat 2–6s delay in `botScheduler.ts`.
- **Drop-out behavior:** No pre-game leave (`dropout.ts` is unimplemented).
- **Admin panel UI:** REST endpoints exist; the React admin page is
  follow-up. Admins can flip the toggle via `curl PUT
  /api/admin/auto-lobbies` for now.
- **Reset-on-second-human-join broadcast:** First human's join sets the
  countdown; additional human joiners trigger `startCountdown` but the
  reset isn't broadcast to peers in the lobby. Single-human-joins-
  auto-lobby (the common case) is fully wired.

## Files

- `services/autoLobby/settings.ts` — admin config + clamping
- `services/autoLobby/identity.ts` — wire-payload disguise mask
- `services/autoLobby/nameGenerator.ts` — human-handle name pool
- `services/autoLobby/tuning.ts` — softer skill profile + session ramp
- `services/autoLobby/momentum.ts` — AR(1) per-round streak scalar
- `services/autoLobby/timing.ts` — humanlike submission delay
- `services/autoLobby/manager.ts` — spawn / close / mode pick / tick
- `services/autoLobby/countdown.ts` — pre-game timer state
- `apps/web/src/components/multiplayer/AutoLobbyCountdown.tsx` —
  banner UI
