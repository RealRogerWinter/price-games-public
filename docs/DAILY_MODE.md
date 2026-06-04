---
title: Daily Mode
status: stable
last_reviewed: 2026-06-03
owner: core
audience: all
category: game-design
summary: The once-a-day puzzle: rotation, seeding, streaks, sharing.
related_code:
  - apps/server/src/routes
  - packages/shared/src
---
# Daily Challenge Mode

A Wordle-style shared daily puzzle. Every player globally plays the same 5-round game on a given UTC calendar day. One attempt per 24 hours, with streak tracking.

## How it works

1. **Admin enables** the feature via the admin panel (Daily Mode → toggle ON). **Disabled by default.**
2. At any point during a UTC day, a player opens the home page and sees the **Daily Challenge hero card** pinned above the mode grid.
3. The card discloses today's mode (e.g. "Today: Precision") — the products are the surprise, not the mechanic.
4. Tapping the card opens the **intro screen** with the date, mode, current streak, and a one-line rule reminder. Explicit microcopy: "Your attempt begins when you make your first guess."
5. Tapping "Start" creates a daily session. The player is NOT locked in yet — that happens on the first guess submission.
6. The player plays 5 rounds of the disclosed mode. **Running score is hidden** — only per-round feedback is shown.
7. After the final round, the **daily results screen** shows: animated score count-up, per-round pip row, streak block, countdown to next UTC midnight, and a "Try another mode" link.

## Weekly rotation

The daily selects a game mode from a fixed weekly schedule:

| UTC Day | Default Mode |
|---------|-------------|
| Sunday  | Higher-Lower |
| Monday  | Precision (classic) |
| Tuesday | Higher-Lower |
| Wednesday | Comparison |
| Thursday  | Precision (classic) |
| Friday    | Higher-Lower |
| Saturday  | Comparison |

Admins can edit the schedule from the admin panel. Any registered game mode listed in `DAILY_ADMIN_ALLOWED_MODES` (the full catalog: `classic`, `higher-lower`, `comparison`, `closest-without-going-over`, `price-match`, `riser`, `odd-one-out`, `market-basket`, `sort-it-out`, `budget-builder`, `chain-reaction`, `bidding`) is selectable.

The daily round composer picks the correct number of products per round for each mode (via `getDailyProductsPerRound` in `@price-game/shared`) and generates deterministic medium-tier metadata (reference prices for higher-lower, questions for comparison, speed patterns / durations for riser, budget amounts for budget-builder, etc.). Product selection is a seeded shuffle-and-slice rather than the difficulty-aware cluster/spread/category logic used by the main composer — daily puzzles remain reproducible across users but may have less aggressively balanced product picks than single-player.

**Bidding War** is daily-eligible as a **multiplayer** variant. When the day's scheduled mode is `bidding`, the daily-challenge card funnels the player into the standard MP quickplay matchmaker instead of the solo ClosestPage path: the client calls `POST /api/mp/quickplay` with `isDailyGame: true` + `dailyDate`, which matches against other same-date daily rooms (fallthrough creates a public room with 2–4 bots). The daily puzzle's product IDs are injected into the MP round composer so every daily room sees the same lineup. At game end, each human player's total score + per-round scores are written to `daily_plays` and the streak bumps exactly once per player per date. Normal MP/quickplay Bidding War is unaffected and remains available after the player completes the daily.

`DAILY_POOL` (`classic`, `higher-lower`, `comparison`, `bidding`) is still the "default fallback" pool: it defines the schedule used when admins have not customised the rotation, and `getDailyModeForDate` walks it when a scheduled mode has been disabled globally. If all pool modes are disabled, the daily card is hidden for that day.

## Puzzle generation

- **Server-side, deterministic**: `mulberry32(FNV-1a(salt + date + saltVersion))` drives a seeded Fisher-Yates shuffle of the active product pool.
- **Cached**: the first request for a given date generates and caches the puzzle in `daily_puzzles`. Subsequent requests return the cached row.
- **Race-safe**: `INSERT OR IGNORE` + re-SELECT prevents duplicate rows under concurrent first-requesters.
- **Salt rotation**: bump `DAILY_SEED_SALT` env var to regenerate future (uncached) dates. Past dates are unaffected.

## Once-per-day enforcement

- **Logged-in users**: partial unique index `(user_id, daily_date) WHERE user_id IS NOT NULL` on `daily_plays`.
- **Devices (all users)**: partial unique index `(visitor_id, daily_date) WHERE visitor_id IS NOT NULL` on `daily_plays`.
- **Anonymous users**: localStorage key `priceGames.daily.lastCompleted` (best-effort, no server enforcement).
- **Race safety**: the first guess of a daily session attempts `INSERT INTO daily_plays`. On `SQLITE_CONSTRAINT_UNIQUE` → 409 `already_played`.
- **MP daily rooms**: the quickplay endpoint, socket `room:create`, and socket `room:join` all re-check the once-per-day guard before routing a player into a daily room. End-of-game writes to `daily_plays` with `session_id = "<roomCode>:<playerId>"` (unique per-player) and only bump the streak when the insert actually lands — a UNIQUE collision (player already played via SP that day) leaves the streak alone.

## Streak rules (brutal Wordle)

- Miss one UTC day → streak resets to zero.
- No grace days, no freezes.
- `users.daily_streak_current`, `daily_streak_best`, `daily_streak_last_date` track the server state.
- Anonymous users get a localStorage mirror of the same logic.
- On signup, the server takes `MAX(device streak, account streak)` — never sums.

## Longest streak leaderboard

The main `/leaderboard` page has a **Longest Streak** tab in addition to the Lifetime Score tab. It ranks users by `daily_streak_best` (ties broken by `daily_streak_current`, then username). Users whose best streak is 0 are hidden so the board never fills with players who haven't earned a position on it.

Backed by `GET /api/leaderboard/streaks?limit=20` — see [API_REFERENCE.md](API_REFERENCE.md) for the full spec. The tab is lazy-loaded on first switch (no extra request for users who stay on the default Lifetime Score view).

## Sharing

- **Text**: 1×5 pip row + "Price Games Daily #N | Mode | Score/Max" header + bare `play at price.games` footer (no `/s/:id` short link — spoiler avoidance).
- **PNG**: daily-specific template via the existing canvas renderer (implemented in `DailyResultPage.tsx`).

## Admin panel

Navigate to Admin → Daily Mode.

- **Enable/disable toggle**: disabled by default. Toggle ON to make the hero card visible to all players.
- **Weekly schedule**: Editable via `PUT /api/admin/daily/schedule`.
- **Upcoming puzzles**: table of today + next 13 days with mode, product count, manual-override flag, play count, average score.
- **Product override**: `PUT /api/admin/daily/:date/products` hand-curates products for a date. Sets `is_manual_override=1`.
- **Regenerate**: `POST /api/admin/daily/:date/regenerate`. Refuses to overwrite a manual-override unless `force=true`.
- **Stats**: total plays, unique players, top 10 streaks.
- **Support**: `DELETE /api/admin/daily/plays/:userId/:date` clears a user's play (does NOT touch streak).

## Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `DAILY_SEED_SALT` | `dev-daily-salt-do-not-ship` | Salt for the deterministic puzzle generator. Set to a strong random value in production. |

## API endpoints

### Public (under `/api/daily`)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/today` | Current puzzle metadata + alreadyPlayed + streak (logged-in only) |
| `POST` | `/start` | Create a daily session (409 if already played) |
| `GET` | `/history` | Last 30 daily plays (requires auth) |
| `GET` | `/recap/:date` | Rich recap for a completed daily — per-round scores + product snapshots (title, image, price, Amazon link). Powers the home card's "Recap" button. Because the daily puzzle is deterministic and shared across all users, the server resolves products from `daily_puzzles.round_data` for the date rather than persisting them on each play row. |

### Admin (under `/api/admin/daily`)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/overview?days=14&startDate=YYYY-MM-DD` | Enabled flag, schedule, rolling window. Optional `startDate` for week navigation. Response includes `productImageUrls` and `productPriceCents` per day. |
| `PUT` | `/enabled` | Toggle feature flag |
| `PUT` | `/schedule` | Replace weekly schedule |
| `PUT` | `/:date/products` | Override products for a date |
| `POST` | `/:date/regenerate` | Regenerate from seed |
| `GET` | `/stats` | Aggregate stats |
| `DELETE` | `/plays/:userId/:date` | Clear a user's play |

## Database tables

- `daily_puzzles` — one row per UTC date (PK: `daily_date`)
- `daily_plays` — one row per attempt (unique on `(user_id, daily_date)` for logged-in)
- `users.daily_streak_current`, `daily_streak_best`, `daily_streak_last_date`
- `game_sessions.is_daily`, `daily_date`

See `DATABASE.md` for full schemas.
