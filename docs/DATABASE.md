---
title: Database
status: stable
last_reviewed: 2026-06-03
owner: infra
audience: operator
category: operations
summary: Every table, every migration, backup and restore.
related_code:
  - apps/server/src/db.ts
---
# Database

Price Games uses **SQLite** via `better-sqlite3`. The database file is stored at `apps/server/data/price-game.db` (hardcoded in `db.ts`).

## Tables

### Core Game Tables

| Table | Description |
|-------|-------------|
| `products` | Product catalog — ASIN, title, price (cents), category, image URL, active/archived status, manufacturer, PU enrichment state |
| `game_sessions` | Single-player game state — rounds, score, mode, round_data, selected products, linked user_id, optional total_rounds (configurable 3/5/10), daily challenge fields (is_daily, daily_date) |
| `game_rounds` | Per-round guess data for single-player games |
| ~~`leaderboard`~~ | **Removed in v53.** Was the legacy single-player per-mode high-score table. The lifetime board (`users.lifetime_score` + `user_game_history`) is the canonical leaderboard, and the moderation panel now sources from `user_game_history` directly. The soft-exclude columns moved with it. |

### Multiplayer Tables

| Table | Description |
|-------|-------------|
| `mp_rooms` | Room state — code, mode, round progress, bcrypt-hashed password, status (lobby/playing/ending/between_rounds/finished), creator_player_id, last_activity_at, is_public flag, bot_count, bot_difficulty, `is_daily_game` flag + `daily_date` for daily-challenge-routed rooms (see v45). |
| `mp_players` | Players in rooms — name, avatar, token, score, connection status, linked user_id, linked visitor_id (anonymous attribution), is_bot flag, **is_streamer_bot** flag (v67; analytics-exclusion marker, distinct from is_bot) |
| `mp_guesses` | Per-round guesses — UNIQUE(room_code, player_id, round_number) |
| `mp_leaderboard` | _(Deprecated for UI)_ Multiplayer high scores — includes placement and player count. The leaderboard v2 UI uses `users.lifetime_score` instead. |
| `mp_invite_tokens` | Lobby-invite reward system (v52). One row per host-minted invite token; carries inviter identity (user_id or visitor_id), IP, fingerprint, created_at, optional revoked_at. FK to `mp_rooms(code)`. |
| `mp_invite_attributions` | Lobby-invite reward system (v52). One row per attempted attribution: pending / earned / rejected / kicked. Indexed on `(token, status, earned_at)` and `(joiner_identity_key, created_at)` for cap and pair-dedup queries. |
| `mp_pending_buffs` | Score-buff system (v52; `attribution_id` loosened to nullable in v54). Outstanding score multipliers — beneficiary_user_id (nullable for guests), beneficiary_visitor_id, source (initially `invite_host` / `invite_joiner`, extended in v54 to include `public_game` and future non-invite sources), multiplier, matches_remaining, expires_at, attribution_id (nullable; only set for invite-derived sources). Decoupled from attribution rows so non-invite buff sources (`public_game`, future idle-economy buffs) can grant rows without an `mp_invite_attributions` parent. |

### User Account Tables

| Table | Description |
|-------|-------------|
| `users` | User accounts — username, email, bcrypt password hash, OAuth provider, email verified, lifetime score, **cached `total_games` count** (v62; maintained in lock-step with `user_game_history` inserts and admin exclude/restore), lockout state, username_pending flag, referral_code (unique 8-char code for inviting friends), daily streak fields (daily_streak_current, daily_streak_best, daily_streak_last_date), UTM attribution columns (utm_source/medium/campaign/content/term, landing_page, signup_referrer), **leaderboard moderation** (leaderboard_banned_at, leaderboard_banned_until, leaderboard_banned_reason, leaderboard_banned_by, is_test_account — v50). |
| `user_sessions` | Session tokens with expiry, idle timeout, IP, user-agent |
| `email_verification_tokens` | Email verification tokens with expiry and used_at tracking |
| `password_reset_tokens` | Password reset tokens — id (PK), user_id (FK), token (UNIQUE), created_at, expires_at, used_at |
| `user_game_history` | Per-game records — game type (single/multiplayer), mode, score, placement, players_count, **was_buffed** + **raw_score** (v52; lobby-invite buff audit), **soft-exclude columns** `excluded_at` / `excluded_by_admin_id` / `excluded_reason` (v53; admin moderation). UNIQUE(user_id, session_id). Reads on the v2 lifetime / period boards filter `excluded_at IS NULL`. |
| `user_product_views` | Tracks which products each user has seen for product memory / repeat avoidance |
| `referrals` | Referral tracking — referrer_id, referred_id, referral_code, status (pending/credited/rejected), rejection_reason, referrer_ip, referred_ip, created_at, credited_at |
| `user_rewards` | Legacy placeholder (unused — superseded by reward_pool/reward_awards) |
| `visitor_attribution` | Anonymous attribution tied to the `visitor_id` cookie — stores the first-touch UTM tuple (utm_source NOT NULL + optional medium/campaign/content/term), landing_page, referrer, first_seen_at, first_game_at/type/mode, games_played counter, and claimed_user_id (populated on signup). Unlike `users.utm_*`, this table tracks visitors who have NOT signed up yet, so pre-signup game plays can still be credited to a marketing cohort. See `docs/ARCHITECTURE.md § Anonymous visitor attribution`. |

### Admin Tables

| Table | Description |
|-------|-------------|
| `admin_users` | Admin accounts — username, bcrypt hash, lockout state, extension permission flag, TOTP 2FA fields (totp_secret_encrypted, totp_enabled, totp_verified_at, totp_last_used_counter) |
| `admin_sessions` | Admin session tokens with expiry and idle timeout (last_active_at) |
| `analytics_daily` | Pre-computed daily game summaries by type and mode |
| `analytics_daily_categories` | Pre-computed daily category usage counts |
| `reward_pool` | Gift card inventory — type, amount (cents), code (UNIQUE), status (available/awarded/claimed) |
| `reward_awards` | Award tracking — reward_id, user_id, method (manual/random_roll), criteria, claimed_at, claim_token (UNIQUE), claim_expires_at, voided_at, pending_review_at, reminder_{15,7,1}d_sent_at, expired_email_sent_at. UNIQUE(reward_id) is enforced as a partial index `WHERE voided_at IS NULL`, allowing a pool row to be re-awarded after expiry. |
| `site_settings` | Key-value store for admin-configurable settings (promo banner text/link/enabled, daily_enabled, daily_schedule) |
| `utm_tags` | Admin-authored UTM tag presets — name (UNIQUE), utm_source (NOT NULL), optional utm_medium/campaign/content/term, destination_url, status (active/archived), created_by, **short_code (partial UNIQUE, migration v30)**, **click_count INTEGER NOT NULL DEFAULT 0**, **last_clicked_at**. Used to generate shareable tracking URLs for marketing campaigns; results are computed by aggregating `users.utm_*` columns. Short-link redirect via `/go/:code` atomically bumps `click_count` on each hit; archived tags still resolve and still count clicks. |
| `admin_leaderboard_audit` | (v50) Append-only audit log of leaderboard moderation actions — `admin_user_id`, `admin_username`, `action` (exclude_entry / restore_entry / ban_user / unban_user / set_test_flag), `target_type` (entry / user), `target_id`, `target_label`, `reason`, `details_json`, `created_at`. Every write through the admin leaderboard service appends a row here so the panel can render a complete moderation history. |

### Admin 2FA Tables (migration v36)

| Table | Description |
|-------|-------------|
| `admin_2fa_recovery_codes` | Hashed one-time recovery codes — admin_user_id (FK, CASCADE), code_hash, salt, is_used, used_at, created_at |
| `admin_2fa_pending` | Short-lived pending login tokens — token_hash, admin_user_id (FK, CASCADE), expires_at, ip_address, user_agent |
| `admin_2fa_audit_log` | 2FA event audit trail — admin_user_id (FK, CASCADE), event, ip_address, user_agent, created_at |

### Daily Challenge Tables (migration v32)

| Table | Description |
|-------|-------------|
| `daily_puzzles` | Cached puzzle per UTC date — PK: `daily_date`, stores `game_mode`, `product_ids` (JSON), `round_data`, `salt_version`, `is_manual_override` |
| `daily_plays` | Completion ledger — partial unique on `(user_id, daily_date) WHERE user_id IS NOT NULL`, stores `session_id` (UNIQUE), `score`, `per_round_scores`, `streak_at_completion`. **v40** adds `visitor_id` with a second partial UNIQUE index on `(visitor_id, daily_date) WHERE visitor_id IS NOT NULL` so guest plays can be correlated to a browser and guest double-plays are blocked. |

Additional columns added by v32:
- `users.daily_streak_current`, `daily_streak_best`, `daily_streak_last_date` — streak tracking
- `game_sessions.is_daily`, `daily_date` — marks a session as belonging to the daily challenge

**Visitor → user claim axis.** `game_sessions.visitor_id` (v40) plus
`user_id` is the claim axis used by `claimAnonymousGameHistory()`:
on register/login/OAuth, any row with matching `visitor_id`,
`user_id IS NULL`, `completed_at IS NOT NULL`, and `is_daily = 0` is
recorded into `user_game_history` and tagged with the signing-in
user. Daily sessions are left to the sibling `claimAnonymousDailyPlays()`
(which owns the streak replay).

New `site_settings` keys (not pre-seeded; absence = defaults):
- `daily_enabled` — boolean, default `false` (feature OFF)
- `daily_schedule` — JSON array of 7 GameMode strings, default `DEFAULT_DAILY_SCHEDULE`
- `content_about` — JSON object `{key, title, body}` rendered on `/about`
- `content_faq` — JSON object `{key, title, items: [{question, answer}]}` rendered on `/faq`
- `content_contact` — JSON object `{key, title, body, email?, social: [{label, url}]}` rendered on `/contact`
- `enabled_pages` — JSON object `{about, faq, contact, game_modes, privacy, terms}` of booleans controlling whether each public SEO page is reachable. Default: every flag `false` (a fresh deploy hides all six pages until an admin opts them in via `/admin/pages`). Disabled pages are absent from the footer, the sitemap, and the content/legal APIs.

### Push Notification Tables (migration v35; device-aware columns added in v40)

| Table | Description |
|-------|-------------|
| `push_subscriptions` | Web Push subscriptions — user_id (FK, CASCADE), endpoint (UNIQUE), p256dh, auth, expiration_time, user_agent, is_active, **visitor_id** (v40; persistent per-browser cookie). One user can have multiple devices/browsers. |
| `notification_preferences` | Per-user notification preferences — user_id (PK, FK, CASCADE), push_enabled, daily_puzzle, streak_reminder, leaderboard_updates, multiplayer_invites, promotional, quiet_hours_start/end, timezone |
| `notification_templates` | Admin-managed templates — name (UNIQUE), type, title_template, body_template, icon, url_path, actions_json, ttl, urgency, is_active |
| `notification_log` | Send log with analytics — user_id, subscription_id, template_id, type, title, body, url_path, **status** (`pending`/`sent`/`clicked`/`failed`/`expired`/`suppressed`), http_status, error_message, **suppression_reason** (v47, free-form token like `already_played` / `streak_broken` set when status is `suppressed`), sent_at, clicked_at |
| `scheduled_notifications` | Background scheduler queue — user_id, template_id, type, payload_json, scheduled_at, status, attempts, sent_at, error_message |

The `notification scheduler's daily_puzzle filter skips a subscription if *either* its linked `user_id` *or* its linked `visitor_id` has a `daily_plays` row for today — see `notificationScheduler.ts evaluateDailyPuzzleNotifications`. This closes the bug where a registered user who played the daily while logged out would still receive a bogus reminder on their subscribed device.

**Streak-reminder suppression audit (v47)**: the scheduler also re-checks state at dispatch time and writes a `notification_log` row with `status='suppressed'` (rather than silently dropping) whenever a queued `streak_reminder` is no longer factually correct — either because the user already played today (`suppression_reason='already_played'`) or because their streak quietly broke between scheduling and dispatch (`suppression_reason='streak_broken'`). A companion sweep, `decayStaleStreaks` in `dailyStreak.ts`, runs at the top of each scheduler tick and zeros out `users.daily_streak_current` for any user whose `daily_streak_last_date` is older than yesterday — this stops `evaluateStreakReminders` from re-queuing reminders for streaks that are already dead.

### UTM Tag System Tables (migrations v29 + v30 + v31 + v66)

| Table | Description |
|-------|-------------|
| `utm_tags` | Admin-managed campaign presets AND system-managed origin rows. Columns include `id`, `name` (UNIQUE), `utm_source`, `utm_medium`, `utm_campaign`, `utm_content`, `utm_term`, `destination_url`, `status` (`active`/`archived`), `created_by` (FK admin_users, nullable), `short_code` (UNIQUE partial index), `click_count`, `last_clicked_at`, `origin_key` (added v66; non-null on system rows). Partial UNIQUE index on `(origin_key, destination_url) WHERE origin_key IS NOT NULL` keeps system rows deduped while letting admin rows freely share UTM tuples. |
| `visitor_attribution` | First-touch UTM for anonymous visitors keyed by `visitor_id` cookie; merged into `users.utm_*` on signup via `mergeVisitorAttributionIntoUser`. |
| `users.utm_*` columns (migration v28) | First-touch UTM tuple persisted on the user row at signup. |

System-managed rows in `utm_tags` are populated by the outbound-links service (`apps/server/src/services/outboundLinks.ts`) on demand — one row per `(origin_key, destination_url)` pair, idempotent across processes. They back the short-link substitution applied to email body URLs and refuse update / delete via service-layer guards. See [`docs/EMAIL_NOTIFICATIONS.md#utm-origin-tagging`](./EMAIL_NOTIFICATIONS.md#utm-origin-tagging).

### Email Notification Tables (migration v42)

Parallel to the push tables above but distinct — email runs on its own scheduler with a coarser cadence and opt-in defaults. See [`docs/EMAIL_NOTIFICATIONS.md`](./EMAIL_NOTIFICATIONS.md).

| Table | Description |
|-------|-------------|
| `email_preferences` | Per-user opt-in flags — user_id (PK, FK, CASCADE), email_enabled, streak_risk, streak_save, inactivity_reminder, weekly_digest, promotional, preferred_hour, timezone. **All booleans default 0** (unlike push). |
| `email_templates` | Admin-managed templates — name (UNIQUE), type, subject_template, html_template, text_template, is_active. |
| `email_log` | Every outbound attempt — user_id, template_id, type, to_address (captured at send time), subject, status (`queued`/`sent`/`opened`/`clicked`/`bounced`/`complained`/`failed`/`suppressed`), provider_message_id (Resend id for webhook correlation), error_message, sent_at, opened_at, clicked_at. Indexed on `(user_id, type, created_at DESC)` and `(status, created_at DESC)`. |
| `scheduled_emails` | Delayed-send queue — user_id, template_id, type, vars_json, scheduled_at, status (`pending`/`sent`/`failed`/`cancelled`), attempts, sent_at, error_message. Drained by the email scheduler. |
| `email_trigger_config` | One row per trigger type — is_enabled, cooldown_hours, threshold_json, template_id. Seeded on migration, all `is_enabled=0`. |
| `email_unsubscribes` | Append-only audit trail — user_id, type (NULL for master opt-out), source (`one_click` / `preferences` / `list_unsubscribe_header` / `complaint`). |

Send cooldowns are enforced against `email_log`: a user cannot receive another email within `emailGlobalCooldownHours` (default 24) of their last successful send, and a trigger's `cooldown_hours` prevents the same type from repeating within that window.

### Product Universe Tables

| Table | Description |
|-------|-------------|
| `pu_materials` | Materials knowledge base |
| `pu_product_materials` | Product-to-material links |
| `pu_companies` | Company knowledge graph |
| `pu_locations` | Geographic locations |
| `pu_supply_chain_nodes` | Supply chain stages |
| `pu_company_relationships` | Corporate relationships |
| `pu_product_companies` | Product-to-company links |
| `pu_product_similarity` | Product similarity scores |
| `pu_galaxy_positions` | 3D visualization positions |
| `pu_sources` | Data source references |
| `pu_enrichment_jobs` | Enrichment pipeline job tracking |
| `pu_search_cache` | Search result caching |
| `pu_material_locations` | Material sourcing locations |

### System Tables

| Table | Description |
|-------|-------------|
| `schema_version` | Migration version tracking — prevents re-running applied migrations |
| `shared_games` | Read-only shareable game snapshots backing the `/s/:id` view. See below. |

### Shared Games Table

The `shared_games` table stores decorative read-only snapshots of completed games so users can share a link that resolves to a rich view of the actual game. These records are **not tied to leaderboards or scoring** — they exist purely for the share feature (see `docs/SHARING.md`).

| Column | Type | Notes |
|--------|------|-------|
| `id` | TEXT PK | `nanoid(8)` URL-safe id, e.g. `aBcD1234` |
| `game_mode` | TEXT | One of the 11 GAME_MODES |
| `total_score` | INTEGER | Capped at 100,000 at the API layer |
| `per_round_max` | INTEGER | 1000 for standard modes, 1313 for chain-reaction; server-computed |
| `player_name` | TEXT | Nullable; sanitized via `sanitizeName(name, 30)` when present |
| `round_data` | TEXT | JSON blob of `SharedRoundSnapshot[]`, ≤16 KB |
| `created_at` | INTEGER | Unix seconds |

Index: `idx_shared_games_created ON shared_games(created_at)` for future time-range queries (currently unused).

Populated by `POST /api/share`, read by `GET /api/share/:id`. No authentication required — share links are public. See `docs/API_REFERENCE.md § Share` and `apps/server/src/routes/share.ts` for the validation, payload cap, and rate limiting details.

## Migration System

Migrations are tracked via `schema_version`. On startup, `db.ts` checks which migrations have been applied and runs pending ones in order. Existing databases that pre-date the migration system are auto-detected and bootstrapped (v1-v3 marked as pre-applied).

Migration v25 is a no-op (`SELECT 1;`) — legal documents are seeded programmatically by `seedLegalDocuments()` at startup. Referral codes for existing users are also backfilled outside the migration array via `backfillReferralCodes()`.

### Migration History

| Version | Description |
|---------|-------------|
| 1 | Add columns to game_sessions (game_mode, round_data), game_rounds (guess_data), leaderboard (game_mode), products (last_used_at, scraped_at, added_at, verified) |
| 2 | Add password column to mp_rooms |
| 3 | Create performance indexes on mp_players, mp_guesses, products, mp_rooms |
| 4 | Product manufacturer column |
| 5 | Create admin_users, admin_sessions, analytics_daily, analytics_daily_categories tables + indexes |
| 6 | Add last_activity_at column to mp_rooms (for room cleanup) + backfill + index |
| 7 | User accounts: users, user_sessions, email_verification_tokens, user_game_history, user_rewards |
| 8 | Link existing tables to user accounts: user_id on leaderboard, mp_leaderboard, mp_players, game_sessions |
| 9 | OAuth columns on users (oauth_provider, oauth_provider_id) |
| 10 | Game history dedup index (partial unique on user_id + session_id) |
| 11 | User product views tracking |
| 12 | Extension permissions (admin can_use_extension column) |
| 13-17 | Product Universe tables (materials, companies, locations, supply chain, similarity, galaxy, sources, enrichment jobs, search cache) |
| 18-19 | Data integrity fixes (unique constraints on game_rounds and pu_sources) |
| 20 | Rewards system: reward_pool and reward_awards tables |
| 21 | Site settings key-value table with default promo banner |
| 22 | UNIQUE constraint on reward_pool.code |
| 23 | Password reset tokens table |
| 24 | Add username_pending column to users |
| 25 | Legal documents seed (programmatic, no-op SQL) |
| 26 | Product archived status: `is_archived` column + index on `products` table |
| 27 | Add `referral_code` TEXT column (UNIQUE) on `users` table; create `referrals` table; backfill existing users with referral codes |
| 28 | Add UTM attribution columns to `users` table: `utm_source`, `utm_medium`, `utm_campaign`, `utm_content`, `utm_term`, `landing_page`, `signup_referrer` — captured at signup time to attribute conversions to marketing campaigns (e.g. Reddit ads) |
| 29 | Create `utm_tags` table (admin-authored UTM presets: `id`, `name` UNIQUE, `utm_source` NOT NULL, optional `utm_medium/campaign/content/term`, `destination_url`, `status` CHECK active\|archived, `created_by` FK admin_users). Adds index `idx_users_utm_cohort` on `users(utm_source, utm_medium, utm_campaign)` for fast funnel queries. Adds indexes `idx_utm_tags_status` and `idx_utm_tags_source_campaign`. |
| 30 | Add short-link + click-counter columns to `utm_tags`: `short_code TEXT`, `click_count INTEGER NOT NULL DEFAULT 0`, `last_clicked_at TEXT`. Creates `idx_utm_tags_short_code` as a partial UNIQUE index (`WHERE short_code IS NOT NULL`) so multiple NULLs are allowed while set codes remain unique. Backs the `/go/:code` public redirect and the admin QR-code generator. |
| 31 | Create `visitor_attribution` table for anonymous (pre-signup) UTM tracking: PK `visitor_id` (UUID from `visitor_id` cookie), `utm_source` NOT NULL, optional utm_medium/campaign/content/term, landing_page, referrer, first_seen_at, first_game_at/type/mode, games_played INTEGER NOT NULL DEFAULT 0, claimed_user_id + claimed_at (populated on signup). Indexes: `idx_visitor_attribution_utm(utm_source, utm_medium, utm_campaign)` and `idx_visitor_attribution_claimed(claimed_user_id)`. Also adds `visitor_id TEXT` column on `mp_players` so end-of-game code can credit multiplayer games to the visitor cohort. Enables the "first game played" funnel metric to count pre-signup plays. |
| 32 | Daily challenge mode: `daily_puzzles`, `daily_plays` tables; streak columns on `users`; `is_daily`/`daily_date` on `game_sessions` |
| 33 | Add `total_rounds INTEGER` column to `game_sessions` for per-session round count. NULL on legacy rows is treated as `DEFAULT_TOTAL_ROUNDS` (5) by `getSessionTotalRounds()`. Supports user-selectable rounds (3, 5, or 10) via the Game Options menu. |
| 34 | Add index `idx_users_lifetime_score` on `users(lifetime_score DESC)` for leaderboard v2 queries that rank users by total lifetime score. |
| 35 | Push notification tables: `push_subscriptions`, `notification_preferences`, `notification_templates`, `notification_log`, `scheduled_notifications` |
| 36 | Admin 2FA: TOTP columns on `admin_users` (totp_secret_encrypted, totp_enabled, totp_verified_at, totp_last_used_counter); `admin_2fa_recovery_codes`, `admin_2fa_pending`, `admin_2fa_audit_log` tables |
| 37 | Add `avatar TEXT` column to `users` table for user avatar preferences |
| 38 | Bots, public lobbies, and bidding support: `mp_players.is_bot INTEGER DEFAULT 0` (bot flag), `mp_rooms.is_public INTEGER DEFAULT 0` (public lobby flag), `mp_rooms.bot_count INTEGER DEFAULT 0`, `mp_rooms.bot_difficulty TEXT DEFAULT 'medium'`. Index: `idx_mp_rooms_public_lobby ON mp_rooms(is_public, status)`. |
| 39 | Best-ever leaderboard rank + rank history: `users.best_rank INTEGER` (nullable); `user_rank_history(id, user_id FK, rank, total_players, recorded_at)` with `idx_user_rank_history_user(user_id, recorded_at)`. One row per game completion for the rank-over-time chart. |
| 40 | Device-aware notifications: `push_subscriptions.visitor_id TEXT` (+ partial index `idx_push_subs_visitor ON push_subscriptions(visitor_id) WHERE visitor_id IS NOT NULL`), `daily_plays.visitor_id TEXT` (+ **partial UNIQUE** index `idx_daily_plays_visitor_date ON daily_plays(visitor_id, daily_date) WHERE visitor_id IS NOT NULL`), `game_sessions.visitor_id TEXT`. Lets the notification scheduler filter daily_puzzle reminders on either the user axis OR the visitor (device) axis, so a registered user who plays the daily while logged out no longer receives a bogus reminder on their own subscribed device. The new unique index also blocks guest double-plays from the same browser, mirroring the existing `(user_id, daily_date)` constraint. |
| 41 | `user_game_history.share_id TEXT` — links a game-history row to its generated share card. |
| 42 | **Analytics expansion** (see `docs/ANALYTICS.md`): `events` (append-only event log), `analytics_sessions` (bounded session rows with entry/exit UTM, bounced flag, counters), `visitor_profile` (per-visitor rollup + concurrency point for atomic session assignment), `visitor_aliases` (cross-device identity merge), `analytics_hourly` (pre-aggregation keyed by hour × device × logged-in × country × acquisition_source). Plus new columns on `users`: `total_sessions`, `last_session_at`, `signup_session_id`, `primary_device_type`, `primary_country`. First-touch UTM is NOT duplicated — `visitor_profile` LEFT JOINs `visitor_attribution` (v31) at query time. |
| 45 | **Daily-challenge MP routing**: `mp_rooms.is_daily_game INTEGER NOT NULL DEFAULT 0`, `mp_rooms.daily_date TEXT` — when the daily mode is Bidding War the card routes into the MP matchmaker, which creates/joins rooms carrying these flags so round composition reads from `daily_puzzles` and game end writes to `daily_plays` + bumps the streak. Partial index `idx_mp_rooms_daily_lobby ON mp_rooms(daily_date, status) WHERE is_daily_game = 1` keeps the same-date matchmaking lookup cheap. |
| 46 | Leaderboard placement notifications: adds `leaderboard_placement INTEGER DEFAULT 1` on `notification_preferences` and `leaderboard_placement INTEGER DEFAULT 0` on `email_preferences`; creates `leaderboard_placement_notifications(user_id, period, period_key, best_rank, channel, last_notified_at)` for per-bucket dedupe with `idx_leaderboard_placement_period(period, period_key)`. Seeds the email trigger config + a default email template. |
| 47 | **Notification suppression audit**: adds `suppression_reason TEXT` column to `notification_log`. The scheduler now writes a row with `status='suppressed'` whenever it drops a queued `streak_reminder` at the last mile — values include `already_played` (user completed today's daily after the reminder was queued) and `streak_broken` (the streak the reminder was meant to protect has since lapsed per the brutal Wordle rule). Pairs with `decayStaleStreaks` in `dailyStreak.ts` which proactively zeros `users.daily_streak_current` once per scheduler tick for any user whose `daily_streak_last_date` is older than yesterday. |
| 48 | **Giveaway-loss email**: adds `email_preferences.giveaway_loss INTEGER NOT NULL DEFAULT 1` (opt-in by default) and seeds a `giveaway_loss` row in `email_trigger_config` so non-winners of a reward roll can be notified. |
| 49 | **Auto-lobbies**: `mp_rooms.is_auto_lobby INTEGER NOT NULL DEFAULT 0` flags rooms spawned by the AutoLobbyManager; `mp_rooms.countdown_started_at TEXT` and `countdown_target_at TEXT` carry the pre-game countdown that fires when the first real human joins. `mp_players.is_disguised INTEGER NOT NULL DEFAULT 0` tags bots that should be hidden from the wire payload (rendered as anonymous players to the client; server-side logic still treats them as bots via `isServerSideBot()`). Partial index `idx_mp_rooms_auto_lobby ON mp_rooms(is_auto_lobby, status) WHERE is_auto_lobby = 1` keeps the spawner's "how many auto-lobbies are live?" query cheap. See `docs/AUTO_LOBBIES.md`. |
| 50 | **Admin leaderboard moderation**: adds soft-exclude columns on `leaderboard` (`excluded_at`, `excluded_by_admin_id`, `excluded_reason`) and account-level moderation columns on `users` (`leaderboard_banned_at`, `leaderboard_banned_until`, `leaderboard_banned_reason`, `leaderboard_banned_by`, `is_test_account`). Creates `admin_leaderboard_audit(id, admin_user_id, admin_username, action, target_type, target_id, target_label, reason, details_json, created_at)` as an append-only audit log with indexes on `created_at DESC` and `(target_type, target_id)`. Public leaderboard read paths (`/api/leaderboard*`, `getLifetimeLeaderboard` / `getPeriodLeaderboard` / `getLongestStreakLeaderboard`) filter on these columns to hide excluded entries, banned users, and test accounts. |
| 51 | **Ghost users (foundation)**: new `ghost_users` table for persistent synthetic player accounts (id, username, avatar, lifetime_score, account_created_at, shift state columns, is_active, last_played_at, daily_streak_current/best/last_date); new `ghost_game_history` mirroring `user_game_history`'s shape; nullable FK columns `mp_players.ghost_user_id` and `mp_leaderboard.ghost_user_id` linking auto-lobby seats and round results back to a ghost identity. Indexes on `(on_shift) WHERE on_shift=1`, `(is_active) WHERE is_active=1`, `(lifetime_score DESC)`, plus partial index `idx_mp_players_ghost ON mp_players(ghost_user_id) WHERE ghost_user_id IS NOT NULL`. Lives in its own table so auth, email, rewards, notifications, and admin user-management queries are ghost-free **by construction** — see `docs/GHOST_USERS.md`. |
| 52 | **Lobby-invite reward system**: creates `mp_invite_tokens` (one row per host-minted invite token, FK to `mp_rooms(code)`), `mp_invite_attributions` (one row per attempted attribution: pending / earned / rejected / kicked, indexed for cap and pair-dedup queries), and `mp_pending_buffs` (outstanding score multipliers; `attribution_id` is NOT NULL here and later loosened in v54). Also adds `user_game_history.was_buffed INTEGER NOT NULL DEFAULT 0` and `user_game_history.raw_score INTEGER` for buff auditing. |
| 53 | **Admin moderation moves to `user_game_history`** + drop legacy `leaderboard` table. Adds `excluded_at` / `excluded_by_admin_id` / `excluded_reason` columns on `user_game_history` with index `idx_user_game_history_excluded`, then `DROP TABLE leaderboard`. The legacy table fed the abandoned `/api/leaderboard?mode=` per-mode top-20 board; the moderation panel was pointed at it and therefore couldn't see most active users (every game played credits `user_game_history` directly, but only explicit `POST /:sessionId/leaderboard` calls inserted into the legacy table). The `excluded_at` filter is applied in `getLifetimeLeaderboard` / `getPeriodLeaderboard` so admin row-level exclusions immediately drop from the visible board, and `excludeEntry` / `restoreEntry` keep `users.lifetime_score` in sync by decrementing/incrementing on every transition. |
| 54 | **Loosen `mp_pending_buffs.attribution_id` to nullable** so non-invite buff sources (e.g. `public_game`, future `idle_rush`) can grant buffs without an associated `mp_invite_attributions` row. SQLite can't `DROP NOT NULL`, so the table is rebuilt → copied → dropped → renamed → reindexed; the FK to `mp_invite_attributions` (with `ON DELETE CASCADE`) is preserved so invite buffs still cascade-delete with their attribution rows. |
| 55 | **Ghost daily-play probability**: adds `ghost_users.daily_play_probability REAL NOT NULL DEFAULT 0.7` so each ghost carries a stable per-day probability of playing the daily, varying streak distributions across the synthetic population. |
| 56 | **Ghost daily-decision marker**: adds `ghost_users.last_daily_decision_date TEXT` recording the UTC date of the most recent play/no-play decision, so the daily-play simulator can run on every hourly tick without double-counting a ghost that already decided today. |
| 57 | **Multiplayer join-source dimension**: adds `mp_players.join_source TEXT` (nullable) recording how a player ended up in the room — `'share_link'`, `'browser'`, `'quickplay'`, or `'create'`. Set once at insert time by `roomManager.createRoom` / `joinRoom` and never mutated for rejoin / reconnect. Partial index `idx_mp_players_join_source` keeps the v2 analytics breakdown query (group by source over recent rooms) cheap. Forward-only — pre-migration rows stay NULL and v2 dashboards bucket them as `'unknown'`. Drives the per-source MP arrival breakdown that the v1 dashboard never had visibility into. |
| 58 | **Synthetic-events flag** for the historical-data backfill: adds `events.is_synthetic INTEGER NOT NULL DEFAULT 0` + partial index `idx_events_synthetic ON events(is_synthetic) WHERE is_synthetic = 1`. Synthesized rows reconstruct `mp_game_completed` / `mp_room_created` / `daily_completed` from the gameplay tables (`mp_leaderboard`, `mp_rooms`, `daily_plays`) so v2 dashboards aren't artificially zero before the live instrumentation landed. Headline count metrics include synthetic rows in `analyticsHourly.rebuildHourlyRange` (which now does a second pass over `events WHERE is_synthetic = 1` and merges into the `unknown/unknown/unknown` rollup bucket). Cohort / funnel / retention / device / geo queries exclude them via `is_synthetic = 0` because synthetic rows have no session, device, or attribution context — their inclusion would silently corrupt those metrics with `unknown` buckets. See `apps/server/scripts/backfill-analytics-events.ts` for the one-time backfill. |
| 59 | **Per-game id for event dedup**: adds `mp_rooms.current_game_id TEXT`, a UUID stamped on each `lobby → playing` transition and cleared on room reset. Because `mp_rooms.code` is reused across "Play Again" and `created_at` doesn't change on reset, this id disambiguates deterministic `client_event_id`s for game-level events (`mp_game_started`, `mp_game_completed`, daily MP completion) so a second game isn't suppressed as a duplicate of the first. Forward-only — legacy rows stay NULL and fall back to `<roomCode>:<created_at>`. |
| 60 | **DNT/GPC persistence**: adds `visitor_profile.dnt INTEGER` to persist a visitor's last-known Do-Not-Track / Global-Privacy-Control preference. Server-emitted events fired outside a request context (round timers, lobby→playing, daily completion) have no headers to read DNT from; this column lets those emitters honor an opt-out. NULL = unknown / never observed (treated as opt-in). |
| 61 | **Leaderboard-availability EXISTS indexes** (leaderboard performance work). Partial index `idx_user_game_history_played_active ON user_game_history(played_at) WHERE excluded_at IS NULL` plus sibling `idx_ghost_game_history_played` on `ghost_game_history(played_at)`. Lets `getLeaderboardAvailability` resolve each rolling-window probe (day / week / month) to a single indexed `EXISTS` lookup at the first qualifying row, instead of scanning the full history table and aggregating per-user. Drops that endpoint's p99 from 108ms to 6ms at heavy-seed scale. |
| 62 | **Cached `users.total_games`** (leaderboard performance work). Adds `total_games INTEGER NOT NULL DEFAULT 0` plus a one-time backfill (`COUNT(*)` from `user_game_history WHERE excluded_at IS NULL`). Maintained at write-time by `recordSinglePlayerGame` / `recordMultiplayerGame` (+1) and `excludeEntry` / `restoreEntry` (-1 / +1 with a `MAX(0, …)` clamp), all inside the existing transactions that update `lifetime_score`. Lets `getLifetimeLeaderboard` drop its `LEFT JOIN user_game_history` + `GROUP BY u.id` entirely. Same migration adds composite partial index `idx_users_leaderboard ON users(lifetime_score DESC, username ASC)` filtered by the leaderboard-visibility predicate set, so the query walks the index and quits at LIMIT — no temp B-tree for ORDER BY. Drops `/api/leaderboard/v2` p99 from 110ms to 6ms. |
| 63 | **Streak-leaderboard partial index** (leaderboard performance work). `idx_users_streak_best ON users(daily_streak_best DESC) WHERE daily_streak_best > 0 AND is_active = 1 AND leaderboard_banned_at IS NULL AND is_test_account = 0`. Borderline win at current scale but cheap insurance for future growth — the query was previously full-scanning users to satisfy `ORDER BY daily_streak_best DESC`. |
| 64 | **30-day reward claim window**. Rebuilds `reward_awards`: drops the column-level `UNIQUE(reward_id)` constraint and adds `claim_token TEXT NOT NULL`, `claim_expires_at TEXT NOT NULL`, `voided_at TEXT`, `reminder_15d_sent_at`/`reminder_7d_sent_at`/`reminder_1d_sent_at TEXT`, and `expired_email_sent_at TEXT`. New indexes: `idx_reward_awards_active_reward` (UNIQUE on `reward_id WHERE voided_at IS NULL` — lets a pool row be re-awarded after a prior award is voided), `idx_reward_awards_claim_token` (UNIQUE), `idx_reward_awards_pending_expiry` (partial on `claim_expires_at WHERE voided_at IS NULL AND claimed_at IS NULL`, used by the hourly sweeper). Existing pending awards are backfilled with a fresh 30-day window from migration time so users mid-flight aren't surprised by retroactive expiry. |
| 65 | **Two-phase admin random roll**. Adds `pending_review_at TEXT` to `reward_awards`. While set + `voided_at IS NULL` + `claimed_at IS NULL`, the row represents a candidate winner the admin has not yet confirmed — no notification emails have been sent and the claim window has not started. Cleared by `confirmPendingAward` (stamps fresh `awarded_at` + `claim_expires_at`, fires winner + non-winner emails) or the row is deleted by `discardPendingAward`. |
| 66 | **System-managed UTM origin tagging**: adds `utm_tags.origin_key TEXT` (non-null only on system rows) plus a partial UNIQUE index `idx_utm_tags_origin_dest ON utm_tags(origin_key, destination_url) WHERE origin_key IS NOT NULL`. Keeps the outbound-links service's auto-generated `(origin_key, destination_url)` rows deduped while letting admin-authored rows freely share UTM tuples. |
| 67 | **Streamer-bot per-seat marker**. Adds `mp_players.is_streamer_bot INTEGER NOT NULL DEFAULT 0` (forward-only — pre-migration rows stay 0). Set to 1 by `roomManager.createRoom` / `joinRoom` when the joining socket carried a valid `X-Streamer-Bot` shared-secret header. Read by `mpRoundEnd`'s bucket classifier (treats the seat as `'skip'`, parallel to labeled bots so leaderboard / `recordMultiplayerGame` / `recordVisitorGamePlay` / `MP_GAME_COMPLETED` all skip together), by `mpRoundStart`'s `MP_GAME_STARTED` filter, and by the `recordDailyPlaysForRoom` + `grantPublicGameBuff` SQL filters (`AND is_streamer_bot = 0`). Distinct from `is_bot` so the streamer-bot keeps driving its own moves rather than triggering server-side AI decisioning. |
| 68 | **Streamer-bot relay persistence**. Adds `streamer_state` (singleton row, id=1) with `stats_json TEXT`, `music_json TEXT`, and per-slot `_updated_at INTEGER` (ms epoch). Replaces the in-memory-only `latestStats` / `latestMusic` cache in `routes/streamer.ts` so the broadcast overlay's W/L/streak + now-playing slots survive a server restart (deploy / OOM / container kill) instead of reverting to zeros until the bot's next POST. `createStreamerRouter` hydrates the in-memory cache from the row at construction time; every successful `POST /api/streamer/{stats,music}` writes through. Hydrate path re-validates JSON through the same `parseStatsPayload` / `parseMusicPayload` the live POST uses, so a corrupt row can't poison the IO emit. JSON columns rather than typed columns so future payload-shape additions don't need another migration. |
| 69 | **Win/Loss/Streak tracker**. Adds cached counters `lifetime_wins`, `lifetime_losses`, `current_streak` (signed), and `best_win_streak` to `users` AND `visitor_attribution` so the in-game HUD chip can read in O(1) for both logged-in users and anonymous guests (keyed on `visitor_id` cookie). Also adds `users.is_bot INTEGER NOT NULL DEFAULT 0` for future bot user accounts (the streamer-bot is also detected per-row via `mp_players.is_streamer_bot`). And adds `user_game_history.is_win INTEGER` (nullable; 0 = loss, 1 = win, NULL = "didn't count" — disconnect, solo MP, bot, excluded) as the append-only source of truth for backfill / per-mode breakdowns. No backfill — counters start at 0 and accumulate forward. Updates happen inside the existing `recordSinglePlayerGame` / `recordMultiplayerGame` / `recordVisitorGamePlay` transactions. The signed `current_streak` flips through zero on direction change (a loss from +5 becomes -1, not 4). `claimVisitorAttribution` folds the visitor's W/L into the new `users` row on first claim; admin `excludeEntry` / `restoreEntry` decrement / re-credit `lifetime_wins` / `lifetime_losses` (the streak is intentionally not rewound — too expensive, too rare). Win classification: SP `score / (perRoundMax × totalRounds) ≥ 0.5`; MP placement === 1. |
| 70 | **Mood-engine v2 persistence**. Adds `streamer_state.mood_json TEXT` + `streamer_state.mood_updated_at INTEGER` columns. Same singleton-row + JSON-column pattern as v68 — extends the existing streamer-bot relay row rather than introducing a new table. Persists Pricey's full `MoodSnapshot` (`{ mood, vibe, morale, streak, updatedAt }`) so a server restart hydrates the engine's hidden axes (vibe + morale) instead of resetting to neutral. Bot writes through every `nextMood` call via `POST /api/streamer/mood`; the route fans out via the new `STREAMER_BOT_MOOD` socket event. Hydrate path re-validates JSON through the same `parseMoodPayload` the live POST uses, so a corrupt row can't poison the IO emit. The legacy `stats_json.mood` field is still mirrored from each snapshot for back-compat with consumers that haven't moved to the richer channel yet. |

**Source**: `apps/server/src/db.ts`

## Streamer-bot learning DB (separate)

The streamer-bot's online-learning subsystem persists to a **separate** SQLite database at `/var/streamer/data/learning.db` inside the streamer container (mounted via the `streamer-data` Docker volume). It does NOT share the main app DB. Built and managed by `packages/bot-streamer/src/learning/persistence.ts`.

| Table | Purpose |
| --- | --- |
| `nn_snapshots` | Active snapshots; one row per `round`. Columns: `round PK`, `arch_hash`, `schema_version`, plus BLOBs for `weights`, `optimizer_state`, `feature_norm`, `replay_buffer`, `teaching_moments`, `ood_blender`, `uncertainty_weights`. The worker keeps the latest 3 (older ones pruned by `pruneSnapshots(3)`). |
| `nn_snapshots_archived` | Created lazily on first arch-hash mismatch — see "Schema versioning" below. Same shape as `nn_snapshots`; the rollback script re-INSERTs from here. |
| `nn_round_log` | Append-only per-round telemetry. `round`, `mode`, `outcome`, `loss`, `grad_norm`, `per_task_losses`, `created_at`. Bounded by NDJSON-side rotation (14 days); used for fast SQL aggregations from the operator runbook. |

Pragmas applied at open: `journal_mode = WAL`, `synchronous = NORMAL`, `wal_autocheckpoint = 1000`. Manual `wal_checkpoint(TRUNCATE)` is run only when the bridge's `lastPredictAt > 2 s ago` to avoid blocking mid-round.

### Schema versioning

`packages/bot-streamer/src/learning/types.ts` declares a frozen `MODEL_SPEC`. Hashing the spec (sha256, `archHash.ts`) yields a stable fingerprint persisted with every snapshot. On worker startup the loader checks the latest snapshot's `arch_hash` against the current spec; on mismatch every row is moved to `nn_snapshots_archived` and the worker starts from scratch. **Bumping the spec must always be paired with a `SCHEMA_VERSION` bump in `persistence.ts`** so the migration is intentional and traceable.

### Rollback

`./scripts/nn-rollback.sh <round>` re-inserts an archived snapshot row into `nn_snapshots` and restarts the streamer container. See `docs/STREAMER.md` for operational procedure.

## Backup & Restore

```bash
npm run backup -w apps/server          # Create database backup
npm run restore -w apps/server         # Restore from backup
npm run backup:status -w apps/server   # Check backup status
```
