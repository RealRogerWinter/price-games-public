---
title: Analytics
status: stable
last_reviewed: 2026-06-03
owner: growth
audience: contributor
category: analytics
summary: What we track, how, and why. Beacon limiter and event schema.
related_code:
  - apps/server/src/routes
  - apps/web/src
---
# Analytics

First-party analytics pipeline for Price Games. Built on the existing `visitor_id` cookie and `visitor_attribution` UTM system; adds a unified event stream, session model, cross-device stitching, and per-visitor rollups so the admin dashboards can answer "how many games does the average visitor play?" and similar product questions without any third-party tracker.

## Design goals

- **No third-party trackers**. No GA4, Mixpanel, Amplitude. Everything is first-party under `/api/events/*`.
- **Server-side is authoritative**. Core events (`game_started`, `game_completed`, `user_signed_up`, ...) are emitted from service functions and route handlers so ad-blockers can't drop them.
- **Client beacon is supplemental**. Page views and custom UI events come from a buffered beacon at `/api/events/track`. Always respects DNT and Sec-GPC.
- **Single source of truth per concern**. First-touch UTM lives on `visitor_attribution` (existing); per-session UTM lives on `analytics_sessions.entry_utm_*`; raw observability lives on `events`. Queries JOIN them — they never duplicate.

## Terminology

- **Visitor** — one browser/device, identified by the `visitor_id` cookie (UUID, httpOnly, sameSite=lax, 90-day, refreshed on every response for Safari ITP).
- **User** — a logged-in account. One user may own many visitor_ids across devices (linked via `visitor_aliases`).
- **Session** — a bounded sequence of events from one visitor. Closed after **30 minutes idle** (or **4 hours idle** if the visitor has ever played a game — accommodates slow multiplayer lobbies). Hard 4-hour absolute cap regardless.
- **Engagement rate** — % of sessions with ≥1 `game_started` event. The primary positive metric. Replaces "bounce rate" as the actionable number (GA4 did the same in 2020).
- **Bounced session** — `games_started == 0 AND (duration < 30s OR page_view_count <= 1)`. Reported but secondary.

Event names follow the industry convention `object_action_past_tense`, snake_case: `page_viewed`, `game_completed`, `user_signed_up`, `mp_room_joined`, `utm_captured`, `performance_metric_reported`. The full canonical list lives in `packages/shared/src/analytics.ts`.

## Database schema

All analytics tables live in the main `price-game.db`. Added in migration **v42**.

| Table | Purpose |
|---|---|
| `events` | Append-only event log. 90-day retention (`EVENT_RETENTION_DAYS`). |
| `analytics_sessions` | One row per session. Tracks entry/exit path, UTM, device, counters. |
| `visitor_profile` | One row per visitor. Lifetime rollup + concurrency point for session assignment. |
| `visitor_aliases` | Cross-device identity merge. `(visitor_id, user_id)` inserted on every login. |
| `analytics_hourly` | Pre-aggregation keyed by (hour, device_type, is_logged_in, country, acquisition_source). Rebuilt every 10 minutes for the last 48h. Drives all timeseries dashboards. |

`users` additions: `total_sessions`, `last_session_at`, `signup_session_id`, `primary_device_type`, `primary_country`.

### Relationship to existing UTM system

The new pipeline **reuses** the existing attribution system rather than duplicating it:

- `visitor_attribution` (migration v31) — remains the single source of truth for **first-touch** UTM. `recordEvent()` calls `recordVisitorAttribution()` when it sees a UTM-bearing landing; first-touch wins via `INSERT OR IGNORE`.
- `users.utm_*` (migration v28) — still populated on signup via `mergeVisitorAttributionIntoUser()`.
- `utm_tags` (migrations v29 + v30 + v66) — admin-configured campaign templates plus system-managed origin rows for outgoing emails and push notifications (migration v66 added the `origin_key` column with a partial unique index on `(origin_key, destination_url)`). System rows are materialized lazily by `apps/server/src/services/outboundLinks.ts` — one row per email/push template type — and back the short-link substitution that auto-rewriting applies to email body URLs. The acquisition source breakdown query JOINs `utm_tags` to `analytics_sessions` on `(utm_source, utm_medium, utm_campaign)` to show sessions / engagement / signup conversion per campaign.
- `analytics_sessions.entry_utm_*` and `last_utm_source` — per-session UTM. Complements (not replaces) `visitor_attribution`'s first-touch. Enables last-touch and session-of-conversion attribution.
- `referrals` — unchanged. New events `referral_clicked` and `referral_signed_up` instrument the existing flow.

## Ingest

One hot path: `apps/server/src/services/eventLog.ts` → `recordEvent()`.

```
Client beacon ─┐
                ├─> recordEvent() ─┬─> UPSERT visitor_profile (decides session_id atomically)
Server hooks ──┘                    ├─> UPSERT analytics_sessions (bumps counters)
                                    ├─> INSERT events (with client_event_id dedup)
                                    └─> recordVisitorAttribution()  [if UTM detected]
```

Session assignment uses an `UPSERT RETURNING` on `visitor_profile`. SQLite serializes writes, so two concurrent events for the same visitor always resolve to the same `session_id` — no application-level mutex.

Performance budget: **1–2ms p99** per event. UA parsing is LRU-cached; geo resolution prefers the Cloudflare `CF-IPCountry` header (zero cost); MaxMind falls back only if configured via `MAXMIND_DB_PATH`.

### Capture points

**Server-side** (primary):
- `apps/server/src/routes/game.ts` — `game_started`, `game_round_submitted`, `game_completed`
- `apps/server/src/routes/daily.ts` — `daily_started`
- `apps/server/src/routes/user.ts` — `user_signed_up`, `user_logged_in`, `user_logged_out` (+ `linkVisitorToUser` for cross-device merge on login)

**Client-side** (engagement-only):
- `apps/web/src/analytics/AnalyticsProvider.tsx` — mounted at the App root
- `apps/web/src/analytics/usePageViewTracking.ts` — auto `page_viewed` on React Router navigation (skips initial mount; server covers that)
- `apps/web/src/analytics/useTrackEvent.ts` — public hook for custom events
- Web Vitals (LCP / CLS / INP / TTFB) flow through as `performance_metric_reported`

## Privacy

- Raw IPs are never stored. `ip_hash = SHA-256(ip + EVENT_IP_SALT)`, salt rotatable via `IP_SALT_VERSION`.
- `DNT: 1` and `Sec-GPC: 1` HTTP headers (and `navigator.doNotTrack`/`navigator.globalPrivacyControl` on the client) result in a **minimal row**: only `visitor_id`, `ts_server`, `event_name`, `path`, `session_id` — no UA, geo, properties, or ip_hash.
- Bot traffic is flagged at ingest via UA regex + per-visitor velocity heuristic. Bot rows are retained but excluded from all dashboards by default.
- PII in URLs (`token`, `password`, `secret`, `key`, `email`, JWT-shaped values) is scrubbed from `path` and `referrer` before storage.
- **Right to access**: `GET /api/admin/gdpr/export?userId=X` returns a full JSON dump of all analytics rows for the user.
- **Right to delete**: `DELETE /api/admin/gdpr/forget?userId=X` cascades delete across `events`, `analytics_sessions`, `visitor_profile`, `visitor_aliases`. Rollups in `analytics_hourly` retain aggregate counts (untraceable to the user).

## Configuration

Environment variables (defaults in parens):

| Var | Default | Purpose |
|---|---|---|
| `EVENT_IP_SALT` | `dev-analytics-salt-do-not-ship` | Salt for IP hashing. **Must** be set in production. |
| `IP_SALT_VERSION` | `1` | Bump to rotate salts; historical rows keep their version. |
| `EVENT_RETENTION_DAYS` | `90` | Retention for raw `events` rows. |
| `SESSION_IDLE_MS` | `1800000` (30 min) | Default session idle cutoff. |
| `SESSION_ACTIVE_GAME_IDLE_MS` | `14400000` (4 h) | Active-game idle extension. |
| `SESSION_ABSOLUTE_CAP_MS` | `14400000` (4 h) | Hard absolute session length cap. |
| `SESSION_CLOSEOUT_INTERVAL_MS` | `300000` (5 min) | Closeout sweep cadence. |
| `ANALYTICS_HOURLY_INTERVAL_MS` | `600000` (10 min) | `analytics_hourly` rebuild cadence. |
| `EVENT_TRACK_RATE_LIMIT` | `120` | Per-IP rate limit for `/api/events/track`. |
| `EVENT_TRACK_RATE_WINDOW_MS` | `60000` | Rate-limit window. |
| `MAXMIND_DB_PATH` | unset | Optional. Path to a MaxMind GeoLite2 `.mmdb` file. If absent, geo falls back to `CF-IPCountry` only. |

## Maintenance jobs

- **Session closeout** — every 5 min (`SESSION_CLOSEOUT_INTERVAL_MS`). Closes idle sessions, sets `bounced`, mirrors `last_session_bounced` onto `visitor_profile`, bumps `users.total_sessions`.
- **Hourly rollup** — every 10 min (`ANALYTICS_HOURLY_INTERVAL_MS`). Rebuilds the last 48 hours of `analytics_hourly` (absorbs late-arriving events from suspended tabs).
- **Retention purge** — daily. Deletes `events` rows older than `EVENT_RETENTION_DAYS`.

All jobs `unref()` their timer handles so process exit is never blocked.

## What still ships in follow-up PRs

This foundation covers the ingest pipeline, server capture, client beacon, session/visit rollups, GDPR endpoints, and maintenance jobs. Admin UI changes (new `/admin/analytics` tabs, pre-built funnels, cohort retention, country map, live-visitors badge) ship in follow-up work.

## Synthetic events (backfilled history)

Multiplayer and daily completions only started emitting events into the live ingest pipeline once multiplayer instrumentation was added. To avoid an artificial cliff in v2 dashboards on that migration date, a one-time script (`apps/server/scripts/backfill-analytics-events.ts`) reconstructs historical events from the gameplay tables (`mp_leaderboard`, `mp_rooms`, `daily_plays`) and writes them into `events` with `is_synthetic = 1` (column added in migration v58).

**Inclusion semantics:**

| Query path | Treats synthetic as | Why |
|---|---|---|
| `analytics_hourly` rollup (headline counts) | Included | The rollup runs a second aggregation pass over `events WHERE is_synthetic = 1` and merges into the `(unknown, unknown, unknown)` device/country/utm bucket. Headline games-per-day chart looks continuous across the migration. |
| Cohort retention, funnels, stickiness (`analyticsRetention.ts`) | Excluded | `AND is_synthetic = 0` on event-table reads. Synthetic events have no session, no intermediate-step events, and no device context — including them would silently break cohort sessionization and funnel drop-off math. |
| Live pulse `recent events` (`adminAnalyticsNamespace.ts`) | Excluded | Live pulse is real-time-only by definition. |
| Device / geo / acquisition breakdowns | Auto-excluded | Synthetic rows bucket as `'unknown'` across these dimensions, so any `device='desktop'` or `country='US'` filter naturally drops them. |

**Backfill semantics:** the script writes ONLY `daily_completed` for daily plays (no parallel `game_completed`/`mp_game_completed`). The synthetic-rollup CASE in `analyticsHourly.ts` accordingly counts `daily_completed` toward `games_completed` *only* when `is_synthetic = 1` — live `daily_completed` events are emitted alongside an underlying `game_completed` or `mp_game_completed` and would double-count if both branches included it.

**Games-by-mode dedup:** `getGamesByModeBreakdown` and `getGamesDailyUniques` both apply a paired-event dedup so a live daily play counts once (as `daily`), not twice (`single + daily` or `multiplayer + daily`). The pairing key is `game_session_id` for SP and `(mp_room_code, visitor_id)` plus a 60-second time-window guard for MP — `mp_room_code` is reused across "Play Again" runs and `daily_completed` only fires on the first play of the day, so without the window guard a naive room+visitor join would silently drop every subsequent Play Again as if it were a daily duplicate. The 60s window comfortably exceeds the millisecond-scale gap between paired events (both fire from the same `endRound()` handler) and stays well below the minimum spacing between two MP completions in the same room (a 5-round game with 30s+ rounds takes minutes). Synthetic rows lack a paired completion event, so the EXISTS check never matches and historical continuity is preserved. Without this dedup the Games-tab chart would inflate daily-active periods by ~2× relative to the rollup-sourced `gamesCompleted` KPI on the Overview tab.

**Idempotency:** every synthetic row carries a deterministic `client_event_id = synthetic:<event_name>:<source_row_id>`, so the existing `UNIQUE(visitor_id, client_event_id)` index absorbs reruns. Safe to run repeatedly.

**Ambiguity:** when a leaderboard row's player is anonymous and another anonymous player in the same room shared the same display name, the visitor lookup is ambiguous — the script skips the row and bumps `skippedNoVisitor` rather than mis-attribute. Operator can see the gap in script output.


## Testing

The analytics surface is the most thoroughly tested code in the repo. The full test pyramid:

- **Unit tests** — every service in `apps/server/src/services/` has a `*.test.ts` file. eventLog.test.ts (37 tests) is the canonical shape: per-feature describes covering the UPSERT, dedup, scrubbing, alias backfill.
- **Lint-style guards** — `recordEventCallsites.test.ts` greps every server-side `recordEvent` call to assert it has a deterministic `clientEventId` or is on the explicit allowlist. `analyticsSchema.test.ts` snapshots PRAGMA table_info for the five load-bearing tables.
- **Integration / E2E suites** under `apps/server/src/integration/`:
  - `analyticsE2E.sp.test.ts` — single-player full HTTP flow (start → guess → complete → rollup → dashboard read).
  - `analyticsE2E.mp.test.ts` — multiplayer over real Socket.IO, asserts per-real-player MP_GAME_COMPLETED.
  - `analyticsE2E.identity.test.ts` — anon-then-signup attribution via the alias backfill.
  - `analyticsE2E.dedup.test.ts` — UNIQUE(visitor_id, client_event_id) under retry / replay / clock skew.
  - `analyticsE2E.invariants.test.ts` — property-based with `fast-check` (conservation, monotonicity, idempotency, time-window additivity).
  - `beaconIngest.test.ts` — real Express + HTTP POST exercising the BeaconEnvelope wire format.
- **Universal afterEach** — every E2E test runs `assertGlobalInvariants` (dedup-key integrity, started ≥ completed, ts_server populated). New tests get free coverage of the invariants.
- **Per-file coverage gates** in `apps/server/vitest.config.ts`: eventLog ≥ 90% lines, analyticsHourly ≥ 90%, analyticsV2 ≥ 85%, visitorAttribution ≥ 90%. Tighter than the global 85% gate because the consequences of an analytics bug (silently skewed dashboards) are higher than a typical UI regression.

For the seven invariants the suite enforces and what they protect against, see [analytics-invariants.md](./analytics-invariants.md).
