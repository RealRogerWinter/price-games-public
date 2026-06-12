---
title: Ghost Users
status: stable
last_reviewed: 2026-06-03
owner: core
audience: contributor
category: game-design
summary: "Anonymous play, ghost-to-real account conversion, and history retention."
related_code:
  - apps/server/src/db.ts
  - apps/server/src/routes
---
# Ghost Users

Persistent synthetic player accounts that seat auto-lobbies, accrue
real scores, maintain daily streaks, and — when leaderboard visibility
is enabled — appear on the public leaderboard with full profile pages,
while staying invisible to auth, email schedulers, rewards,
notifications, and admin user management.

**Ships dark.** The system is inert until an admin explicitly enables
it via `PUT /api/admin/ghost-users/settings`.

## Architecture: separate `ghost_users` table

Ghosts live in their own table, not a flag on `users`. The boundary is
**structural**: every auth lookup, email recipient query, reward
eligibility query, and notification scheduler query reads from `users`,
which means ghosts physically can't appear in those code paths. No
filter to forget; no security regression possible from a missed
predicate.

The cost is paid in the leaderboard surface: the ~3 leaderboard read
sites become `UNION ALL` over both tables. That trade-off is ironclad —
"forgot a UNION" surfaces a real-user-only leaderboard, which is
strictly safer than "forgot a `WHERE is_ghost = 0`" leaking ghosts into
auth.

## Schema (migration v51)

```
ghost_users
  id, username, username_normalized, avatar
  lifetime_score
  account_created_at        synthetic, lognormal-distributed (1d-540d)
  on_shift, shift_started_at, shift_ends_at, on_break_until
  is_active                  admin-controlled
  last_played_at             cycling input
  daily_streak_current/best/last_date

ghost_game_history           per-round records (mirrors user_game_history)

mp_players.ghost_user_id     nullable FK; mutually exclusive with user_id
mp_leaderboard.ghost_user_id same idea, used by the leaderboard UNION
```

## Modules

| File | Responsibility |
|---|---|
| `services/ghostUsers/settings.ts` | Admin-configurable JSON blob in `site_settings.ghost_users` |
| `services/ghostUsers/persona.ts` | Synthetic identity generator (username + avatar + age) |
| `services/ghostUsers/reservedNames.ts` | Global ghost-name reservation check (60s cache, invalidate hook) |
| `services/ghostUsers/repository.ts` | CRUD primitives over `ghost_users` |
| `services/ghostUsers/shifts.ts` | Diurnal shift duration / start-time / break sampling |
| `services/ghostUsers/manager.ts` | 60s tick: bring shifts on/off, honor breaks, evict on kill-switch |
| `services/ghostUsers/cap.ts` | 70th-percentile score ceiling, 6h cache |
| `services/ghostUsers/credit.ts` | Score-credit with cap soft-limit + history write |
| `services/ghostUsers/cycling.ts` | Retire long-inactive ghosts (mimics real-user churn) |
| `services/ghostUsers/streaks.ts` | Synthetic daily-streak advancement |

## Settings (admin endpoints)

`GET /api/admin/ghost-users/settings`
`PUT /api/admin/ghost-users/settings`

```json
{
  "enabled":             false,    // master toggle
  "killSwitch":          false,    // emergency: stops + evicts everything
  "showOnLeaderboard":   false,    // surfaces ghosts on the public leaderboard
  "percentileCap":       70,       // ghosts capped at Nth percentile of real-user lifetime_score
  "targetCount":         35        // bulk-create form default
}
```

Plus `GET /api/admin/ghost-users` (paginated roster) and
`POST /api/admin/ghost-users/bulk { count }`.

## Behavior

### Shifts

Each ghost runs on bursts: lognormal duration (median ~25min, 5-90min
range), with start times sampled from a diurnal distribution that peaks
6-10pm local. ~10% of shifts roll into a multi-hour break afterwards
instead of immediately scheduling the next one.

The 60s manager tick:
1. Honors `killSwitch` (one click ends every shift).
2. Ends any shift whose `shift_ends_at` has passed.
3. Clears expired `on_break_until` so those ghosts become eligible.
4. Starts at most one new shift per tick — biased toward peak hours so
   the on-shift count climbs gradually rather than bursting.

### Auto-lobby seating

`spawnAutoLobby` (in `services/autoLobby/manager.ts`) prefers seating
on-shift ghosts in disguised slots, falling back to the existing
synthesized-name path when ghosts are sparse / disabled / kill-switched.
Each ghost-seated `mp_players` row carries `ghost_user_id`, which the
round-end credit path uses to award score back to the right ghost.

### Score credit (percentile cap)

`creditGhostScore` is the only mutation point that adds points to a
ghost. Before write, it checks the cached cap (70th percentile of real
users with ≥5 sessions, recomputed every 6h). If the proposed total
would exceed the cap, the credit is **soft-limited** (curtailed to land
exactly at the cap) rather than rejected — players see ghosts plateau
in the long tail rather than stop scoring mid-game.

Defense-in-depth: if a ghost's score is somehow already past cap (admin
override, schema drift), `creditGhostScore` refuses to compound further
without pulling the score down (no flicker).

### Cycling out

Real users go inactive over time. To match that shape, the daily
cycling tick (1h cadence, idempotent) flips `is_active = 0` on every
ghost that:
  - has an account at least 90 days old, AND
  - hasn't played in 30+ days (`last_played_at IS NULL` is treated as
    "never played" so a never-played ghost still cycles out by age).

Retirement is non-destructive — the row stays in the DB so historical
mp_leaderboard / ghost_game_history references stay valid; admins can
resurrect or hard-delete.

### Daily streaks

Per-ghost-per-day "did this ghost play the daily?" probability is 70%.
The 1h cadence call to `advanceGhostStreaks` is idempotent within a UTC
day, so the worst case is one extra read per ghost per hour with no
state change. Mimics the streak distribution of a real engaged
playerbase (mean streak ~3-4 days with long-streak outliers).

## Name reservation

Ghost usernames are globally reserved across the site:
- Real-user signup (`services/userAuth.ts`) rejects collisions with the
  same "Username already exists" message used for real-user collisions.
- Anonymous-player MP display names (`services/roomManager.ts:createRoom`
  + `joinRoom`) reject ghost names with "That display name is taken".
- The labeled-bot name generator in `addBots` (Adjective-Animal pool)
  pre-populates its dedupe set with ghost names so a future generator
  change can't accidentally produce a collision.

The check is implemented as `isReservedByGhost(db, name)` with a 60s
in-memory cache and an `invalidateReservedNamesCache()` hook called from
every mutation in `services/ghostUsers/repository.ts`. Cache TTL is the
worst-case window during which a freshly-created ghost could be picked
by a still-pending signup; tested deterministically via fake timers.

## Test coverage

100+ tests across the new modules. Critical-path coverage:
- Settings / clamping / kill-switch precedence
- Persona dedupes against both `users` and `ghost_users` tables
- Reserved-names cache TTL + invalidation
- Repository CRUD including cascade-clear of mp_player ghost_user_id
- Shift duration / start / break distributions (statistical bounds)
- Manager tick state transitions
- Cap percentile math + cache TTL
- Credit soft-cap correctness + defense-in-depth backstop
- Cycling threshold, MIN_ACCOUNT_AGE filter, never-played edge case
- Streak advance / break / reset / idempotency

## Leaderboard surface

When `showOnLeaderboard=true` (and `enabled=true`, `killSwitch=false`):

- **Lifetime leaderboard** (`getLifetimeLeaderboard` gameType=all): UNION
  ALL over `users` and `ghost_users`. Pagination is global across both
  via the outer ORDER BY. The percentile cap inside `creditGhostScore`
  keeps ghost scores in the bottom 30% so the podium stays real-user.
- **Streak leaderboard** (`getLongestStreakLeaderboard`): UNION ALL over
  both tables' `daily_streak_*` columns.
- **`getLeaderboardAvailability.all`**: counts ghost contributors so the
  "all" pill reflects the combined leaderboard size.

Period boards (day/week/month) and SP/MP slices remain real-users-only —
they aggregate `user_game_history` with time/type filters and are
intentionally scoped to real engagement.

## Profile route

`/api/player/:username` checks `users` first; if no real-user match AND
ghosts are visible, falls back to `ghost_users` + `ghost_game_history`.
Returned profile shape is identical to a real-user profile so the public
client renders both branches with the same component.

Same fallback applies to `/api/player/:username/score-history` and
`/api/player/:username/history` — they read `ghost_game_history` for
ghost usernames.

The visibility gate means that typing a known ghost username into the
URL bar while the system is dark returns 404. Once the admin enables it,
the same URL resolves a profile.

## Admin surface

`AdminGhostUsersPage` at `/admin/ghost-users`:

- Master toggles: enabled, showOnLeaderboard, percentileCap (numeric)
- **Red kill-switch button** with confirm dialog — sets `killSwitch=true`
  + ends every on-shift ghost in one server round-trip. Hidden once
  active and replaced by a "Clear kill-switch" recovery button.
- Bulk-create N ghosts (server caps at 500/call)
- Roster table with per-row actions: deactivate / reactivate / end shift
  / hard delete (with confirm)
- Status column derived from `is_active` + `on_shift` + `on_break_until`

Endpoints (mounted at `/api/admin/ghost-users`, all require admin + 2FA):

| Endpoint | Purpose |
|---|---|
| `GET /settings` | Read system config |
| `PUT /settings` | Partial-merge update with clamping |
| `GET /` | Paginated roster |
| `POST /bulk` | Bulk-create N (capped at 500) |
| `PATCH /:id` | isActive flag and/or endShift |
| `DELETE /:id` | Hard-delete (cascades ghost_game_history; nulls FK refs) |
| `POST /kill-switch` | Emergency disable |

## Related

- `docs/AUTO_LOBBIES.md` — the quickplay matchmaking system that ghosts seat into
- `apps/server/src/db.ts` — migration v51
