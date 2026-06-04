---
title: Admin Guide
status: stable
last_reviewed: 2026-06-03
owner: infra
audience: operator
category: operations
summary: Using the /admin dashboard: products, rewards, banners, content pages, ghost users, 2FA.
related_code:
  - apps/web/src/pages/admin
  - apps/server/src/routes
---
# Admin Guide

The admin panel is accessible at `/admin` and provides analytics, product management, rewards, and configuration tools.

## Initial Setup

Set environment variables for the initial admin account (only used when `admin_users` table is empty):

```bash
ADMIN_INITIAL_USERNAME=admin
ADMIN_INITIAL_PASSWORD=changeme12345   # min 12 characters
```

Navigate to `/admin` to log in. Remove the env vars after first login.

## Security

- **Session-based auth** with httpOnly, SameSite=Strict, Secure cookies
- **Mandatory TOTP 2FA** for all admin accounts (see below)
- **Brute force protection**: IP rate limiting (5/15min), account lockout (5 attempts -> 15min lock), constant-time comparison
- **Session policy**: 8h absolute expiry, 30m idle timeout, periodic cleanup
- **Password hashing**: bcryptjs with configurable cost factor (default 12)
- **Network restriction**: Admin panel blocked on public internet via Caddy, accessible only through Tailscale

## Two-Factor Authentication (2FA)

All admin accounts must enroll in TOTP-based 2FA. Most admin routes are gated by the `require2faEnrolled` middleware.

### Enrollment

1. After login, go to `/admin/2fa` (or you'll be prompted automatically)
2. Scan the QR code with an authenticator app (Google Authenticator, Authy, etc.)
3. Enter the 6-digit code to verify setup
4. **Save the recovery codes** — 10 single-use codes are generated for account recovery

### Login Flow

1. Enter username and password at `/admin`
2. If 2FA is enabled, you'll be prompted for a TOTP code
3. Enter the 6-digit code from your authenticator app, or use a recovery code

### Management (`/admin/2fa`)

- **View status**: Check if 2FA is enabled
- **Disable**: Requires password + TOTP code
- **Regenerate recovery codes**: Requires password (invalidates all previous codes)

### Technical Details

- TOTP secrets are encrypted at rest with AES-256-GCM (requires `ADMIN_2FA_ENCRYPTION_KEY` env var)
- Recovery codes are hashed with salt (never stored in plain text)
- Pending login tokens are short-lived and hashed
- All 2FA events are logged in `admin_2fa_audit_log` for forensic review
- The Chrome extension login flow also supports 2FA

## Dashboard

KPI cards and charts at `/admin/dashboard`:

- Total games, 24h/7d games, active rooms, avg score, total players
- Games-by-day time-series chart (Recharts) with clickable bars for daily drill-down
- Game mode breakdown with clickable mode filtering
- Player activity trends
- Popular categories by usage
- Active multiplayer rooms (auto-refreshes every 30s)
- Score distribution histogram
- User registrations and retention metrics
- Top players by lifetime score
- Daily summary backfill for historical data

**Timezone.** All dashboard time-series buckets (games-by-day, player
activity, user registrations, user-detail activity) and any displayed
timestamps (active rooms, drill-down game times, admin user game
history) are rendered in **Pacific Time (America/Los_Angeles)**, with
DST handled automatically. SQLite has no DST-aware `DATE()` modifier,
so the server aggregators fetch raw timestamps and bucket by calendar
day in application code via the `tzDateString` helper in
`packages/shared/src/dateBucket.ts` (exported from `@price-game/shared`
as `tzDateString`, `ADMIN_TIMEZONE`, `padDateSeries`, and
`parseTimeZoneQuery`). Every analytics endpoint accepts an optional
`?tz=<IANA>` query param — admin routes pass `ADMIN_TIMEZONE`
explicitly. End-user-facing score/rank history endpoints accept the
viewer's browser IANA timezone so per-user charts match the adjacent
game-history list. Time-series windows are sized by calendar-day
arithmetic (not raw millisecond subtraction), so `length === days` is
invariant across DST transitions. The daily challenge schedule editor
(`/admin/daily`) intentionally stays anchored to UTC because daily
puzzles are keyed by UTC date.

### Daily Drill-Down

Click any bar in the games-by-day chart to open a modal showing every game played that day, including:
- Game type (single-player vs. multiplayer), mode, scores
- SP/MP breakdown for accurate analytics

## User Management

`/admin/users` — view and manage user accounts:

- **List**: Paginated table with search by username/email, sortable columns
- **Detail**: View user account info, game history, stats, recent activity
- **Actions**:
  - **Deactivate**: Prevent a user from logging in (reversible)
  - **Reactivate**: Restore a deactivated account
  - **Reset password**: Force-reset and receive a temporary password (admin must relay it manually — no email is sent)
  - **Delete**: Permanently remove a user account

## Product Management

`/admin/products` — manage the product catalog:

- **List**: Paginated table with search, category filters, active/inactive filter, sortable columns
- **Create**: Add products manually with title, price, ASIN, category, image URL
- **Edit**: Update product details
- **Status**: Toggle individual product active/inactive, or bulk toggle up to 500 at once via `PATCH /api/admin/products/bulk-status`
- **Archive**: Archive products to remove them from the active catalog without deleting. Archiving also deactivates the product. Bulk archive up to 500 via `PATCH /api/admin/products/bulk-archive`. Archived products have a dedicated view at `/admin/products/archived`
- **Manufacturer contacts**: Modal for adding/editing partnership contacts per manufacturer

## Rewards System

`/admin/rewards` — manage gift card rewards:

### Pool Management
- **Create rewards**: Add gift cards with type, amount, code, and description
- **List/filter**: View by status (available, awarded, claimed)
- **Delete**: Remove unclaimed rewards
- **Claim deadline**: A "Claim By" column shows when each awarded reward expires (30 days from confirmation). Rewards not claimed by the deadline auto-revert to `available` and re-enter the pool.

### Awarding (Two-Phase Flow)
The random roll is **two phase** by design — no notification email goes out until you confirm the candidate winner.

1. **Pick criteria**: Mode (points-only / streak-only / and / or), minimum points, and the time period.
   - **Time period** options: rolling windows (last 7d / 30d / 3mo), all-time, OR a specific **calendar month** (e.g. April 2026 — qualifies anyone who scored ≥ minimum points within that calendar month UTC).
   - **Exclude test accounts** (default ON): drops `is_test_account=1` users from the pool automatically.
2. **Preview Qualifying Players**: Shows the full eligible list. Click the × next to any player to **exclude** them from the roll (e.g. friends/family/internal accounts). Excluded players are dropped before the weighted random pick.
3. **Roll winner**: Picks a candidate via CSPRNG-based weighted selection (each credited referral = +1 entry). Writes a "pending review" award row but **sends no emails**.
4. **Review modal**: Shows the candidate winner's username, email, and the # of consolation emails that will fire on confirm. Three actions:
   - **Confirm — send emails**: Notifies the winner with a 30-day claim link, queues the consolation batch for non-winners, and starts the claim window.
   - **Re-roll**: Discards the candidate and rolls again with the same criteria. The discarded user is never notified.
   - **Cancel**: Returns the reward to the pool. No notifications, no audit trail of the draw.
- **Manual award**: Search for a user and assign a specific reward. Sends the winner email immediately (no review step — manual awards are an explicit admin choice).

### Claim Window (30 Days)
- Every awarded reward includes a per-award **claim token** sent in the winner email. Clicking the link opens `/claim/<token>`, which auto-claims and reveals the gift card code.
- Settings → Rewards keeps a deep-link button that routes through the same `/claim/<token>` page if the user lost the email.
- Three reminder emails fire as the deadline approaches: **15 days**, **7 days**, and **1 day** remaining. Idempotent per cadence.
- If unclaimed at 30 days, the sweeper voids the award (preserving audit), returns the reward to the pool as `available`, and sends a final "your reward expired" email. Reward can then be re-rolled.
- Reminder + expiry emails bypass user marketing preferences: they're transactional follow-ups to the original transactional award.

### User Side
- Awarded rewards appear on the user's settings page with codes masked (last 4 chars)
- Users claim rewards via the email link (canonical) or via the deep-link button on `/settings`
- See [USER_ACCOUNTS.md](USER_ACCOUNTS.md) for user-facing reward endpoints

## Promo Banner

`/admin/banner` — dedicated page for configuring the site-wide promotional banner:

### General Settings
- **Enabled**: Toggle banner visibility
- **Audience**: Show to all users or logged-in users only
- **Text**: Banner message (max 500 characters)

### Link Button
- **Show link**: Toggle a custom link button in the banner
- **Link text**: Button label (max 100 characters)
- **Link URL**: Must be a relative path (server-validated, no open redirects)

### Giveaway Settings
- **Show "Giveaway Details" button**: When enabled, the banner includes a button that opens a modal with giveaway rules, registration encouragement, and email verification prompts
- **Qualifying points threshold**: Minimum points a user must earn in a calendar month to qualify for the monthly drawing
- **Show tracker**: Separate toggle to show/hide the reward progress tracker on the home page. When enabled and qualifying points > 0, users see their monthly points toward the goal
- **Qualified message**: Customizable message shown to users who have reached the qualifying threshold (max 500 characters). Supports `{month}` placeholder for the current month name. Default: "You're entered in the {month} drawing! Increase your odds — refer a friend for bonus entries."

### Banner Behavior
All banners automatically show contextual subtext based on the viewer's state:
- **Not logged in**: Prompts to sign up with a link to registration
- **Logged in, email unverified**: Warns that email verification is required
- **Logged in, email verified**: Confirms eligibility for rewards

Public endpoint: `GET /api/settings/banner` (unauthenticated)

## Daily Challenge

`/admin/daily` — manage the daily challenge feature. See [DAILY_MODE.md](DAILY_MODE.md) for the full feature spec.

- **Feature toggle**: Enable/disable the daily challenge via `PUT /api/admin/daily/enabled`
- **Weekly schedule**: Configure which game mode runs on each day of the week (index 0 = Sunday). Editable via `PUT /api/admin/daily/schedule`.
- **Overview**: View upcoming puzzles with product thumbnails and prices, navigate by week
- **Product override**: Override products for a specific date via `PUT /api/admin/daily/:date/products`
- **Regenerate**: Regenerate a puzzle from seed via `POST /api/admin/daily/:date/regenerate`
- **Stats**: View aggregated daily stats and top streaks
- **Support**: Delete a user's daily play for a specific date (e.g., for bug recovery) via `DELETE /api/admin/daily/plays/:userId/:date`

## Notifications

`/admin/notifications` — manage push notifications:

### Templates
- **Create**: Define reusable notification templates with name, type, title/body templates, icon, URL path, TTL, and urgency
- **Edit/Delete**: Update or remove existing templates
- **Types**: `daily_puzzle`, `streak_reminder`, `leaderboard_updates`, `multiplayer_invites`, `promotional`

### Sending
- **Manual send**: Send a notification to a specific user or to all subscribers (from template or ad-hoc)
- **Test send**: Send a test notification to verify delivery

### Analytics
- **Stats**: View aggregate notification stats (sent, clicked, failed counts)
- **Log**: Paginated send log with status, timestamps, and click tracking
- **Subscribers**: Subscriber counts by preference category

### Background Scheduler
The `notificationScheduler` runs a background loop that processes queued notifications (streak reminders, daily puzzle alerts). Configurable via `NOTIF_SCHEDULER_INTERVAL_MS`, `NOTIF_MAX_ATTEMPTS`, and `NOTIF_STREAK_REMINDER_HOURS` env vars.

## Game Modes

`/admin/game-modes` — enable or disable game modes:

- **Toggle**: Disable individual game modes to remove them from the player-facing mode selector
- **Validation**: Only modes in `VALID_GAME_MODES` are accepted
- **API**: `GET /api/admin/game-modes` and `PUT /api/admin/game-modes`
- **Public**: Disabled modes are exposed via `GET /api/settings/game-modes` for the frontend

## UTM Tags

`/admin/utm-tags` — manage UTM tag presets for marketing campaigns. See [API_REFERENCE.md](API_REFERENCE.md#admin--utm-tags) for full endpoint details.

- **CRUD**: Create, edit, archive, and delete UTM tag presets
- **Short links**: Generate short codes for `/go/:code` redirects with click tracking
- **QR codes**: Generate QR code images for short links
- **Funnel stats**: View conversion funnel per tag (clicks → anonymous plays → signups → played → giveaway-eligible → won reward)

### Origin filter (Yours / System / All)

The default list view shows only admin-created tags ("Yours"). The "System origins" pill exposes the system-managed rows that the outbound-links service materializes for each email and push notification template type — one row per `(origin, destination)` pair. (System-managed rows are auto-generated per template type for analytics tracking and cannot be created or edited by hand; only admin-created tags are user-editable.) These rows back the short-link substitution applied to outgoing email body URLs (see [EMAIL_NOTIFICATIONS.md#utm-origin-tagging](EMAIL_NOTIFICATIONS.md#utm-origin-tagging)) and are **read-only**: the Edit / Archive / Delete buttons are suppressed because the in-process short-code cache assumes the row stays stable for the life of the server process. Use the funnel view ("View results →") to see per-template click counts.

## Legal Documents

`/admin/legal` — edit the privacy policy and terms of service:

- **Editor**: Markdown editor for each legal document
- **Documents**: `privacy_policy` and `terms_of_service`
- **Public pages**: Documents are served at `/legal/privacy` and `/legal/terms` via `GET /api/settings/legal/:key`
- **Storage**: Documents are stored in the `site_settings` table as markdown

## Page Visibility

`/admin/pages` — control which of the six public SEO pages are reachable:

- **Pages**: About, FAQ, Contact, Game Modes, Privacy Policy, Terms of Service
- **Default**: every page is **hidden** on a fresh deploy — flip a page on only after its content is populated via `/admin/content` (or `/admin/legal` for privacy/terms)
- **Effect when disabled**: footer link hidden, route returns an in-app 404, public content/legal APIs return 404, URL absent from `/sitemap.xml`, `/robots.txt` adds `Disallow:`, server-injected meta tags force `noindex,nofollow`
- **Storage**: `site_settings.enabled_pages` JSON object — one boolean per page, default all `false`

## Chrome Extension

`/admin/extension` — manage the product import extension:

- **Download**: Download the built extension as a ZIP file
- **Authentication**: Extension uses bearer token auth (`POST /api/admin/extension/login`)
- **Import**: Products imported via `POST /api/admin/extension/import` with ASIN

See [EXTENSION.md](EXTENSION.md) for extension build and usage details.

## Product Pipeline

Command-line tools for bulk product data management:

```bash
npm run pipeline -w apps/server            # Scrape products from Amazon
npm run pipeline:category -w apps/server   # Scrape by category
npm run pipeline:dry-run -w apps/server    # Preview without saving
npm run verify -w apps/server              # Verify product data integrity
npm run verify:fix -w apps/server          # Auto-fix data issues
```

See [API_REFERENCE.md](API_REFERENCE.md) for full admin endpoint details.
