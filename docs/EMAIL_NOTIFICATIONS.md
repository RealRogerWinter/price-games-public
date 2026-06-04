---
title: Email Notifications
status: stable
last_reviewed: 2026-06-03
owner: growth
audience: contributor
category: features
summary: Resend integration, transactional templates, unsubscribe.
related_code:
  - apps/server/src/routes
---
# Email Notifications

Marketing / re-engagement email channel, running **in parallel to** — and deliberately at a different cadence than — the push notification system.

See [`docs/NOTIFICATIONS.md`](./NOTIFICATIONS.md) for push. Both channels share user identity, the admin panel pattern, and the Resend transport but have separate tables, schedulers, preferences, and triggers.

## Why a separate system

Push and email have fundamentally different constraints:

- **Push** is instant and can fire several times per day (daily puzzle, streak reminders, multiplayer invites). The push scheduler ticks every 60 seconds.
- **Email** is rarer by necessity — hit a user too often and you'll land in spam. The email scheduler ticks every 15 minutes by default, and the service enforces a **24-hour per-user global cooldown** across all types.

Merging the two into one schema would force one cadence on the other.

## Architecture

```
┌──────────────────────────────────┐
│ apps/server/src/services         │
│   email.ts           ← Resend wrapper (sendEmail)
│   emailNotification.ts  ← CRUD + send + cooldowns + rendering
│   emailScheduler.ts  ← 15-min loop: triggers + queue drain
│   emailUnsubToken.ts ← HMAC-signed one-click unsubscribe
└──────────────────────────────────┘
           │
           ▼
┌──────────────────────────────────┐
│ apps/server/src/routes           │
│   email.ts            ← /api/email/* (user-facing)
│   adminEmail.ts       ← /api/admin/email/* (admin)
└──────────────────────────────────┘
           │
           ▼
┌──────────────────────────────────┐
│ apps/web/src                     │
│   pages/admin/AdminEmailPage     ← 5 tabs: Stats/Send/Templates/Triggers/Log
│   components/EmailSettings       ← per-user opt-in panel
│   api/emailClient.ts             ← /api/email/* client
└──────────────────────────────────┘
```

## Database (migration v42)

Six tables:

| Table | Purpose |
| --- | --- |
| `email_preferences` | Per-user opt-in flags. All default `0` (email is strictly opt-in, unlike push). |
| `email_templates` | Admin-managed templates: subject + HTML + optional plain-text fallback. |
| `email_log` | Every send attempt — status (`queued`/`sent`/`opened`/`clicked`/`bounced`/`complained`/`failed`/`suppressed`), `provider_message_id` for webhook correlation. |
| `scheduled_emails` | Queue for time-delayed sends. Drained by the scheduler. |
| `email_trigger_config` | One row per trigger type, admin-tunable from the panel. |
| `email_unsubscribes` | Append-only audit trail of opt-out events. |

Default rows are seeded in `email_trigger_config` on migration — all `is_enabled=0`.

## Triggers

Admin-tunable via the **Triggers** tab. Each has an enabled flag, a per-user cooldown, a threshold JSON, and a template binding.

| Trigger | Default cooldown | Default threshold | Fires when |
| --- | --- | --- | --- |
| `streak_risk` | 72h | `{"streakMin":3}` | User's streak ≥ N and `last_streak_date = yesterday` (missed today) |
| `streak_save` | 168h | `{"streakMin":7}` | Long-streak last-chance nudge |
| `inactivity_reminder` | 336h | `{"days":7}` | Last session activity falls in the `[days, days+1)` window |
| `weekly_digest` | 144h | `{"weekday":1,"hour":10}` | Scheduler tick matches UTC weekday + hour |
| `promotional` | 720h | — | Admin-driven only (no automatic evaluator) |
| `giveaway_loss` | 0h | — | Fires synchronously from `executeRandomRoll` for every qualifying-but-not-winning player after the admin draws a reward |

All triggers except `giveaway_loss` are OFF by default — enable via **Admin → Emails → Triggers**. `giveaway_loss` is seeded enabled because it is the consolation half of an admin action that already ran. Flipping `giveaway_loss` off in the trigger config drops the post-draw batch entirely (logged as `trigger_disabled`); the per-user opt-in (`email_preferences.giveaway_loss`) and the master `email_enabled` flag are also enforced before each send. The 24h **global** marketing cooldown is intentionally bypassed for this type so a non-winner who happened to receive any other marketing email in the last day still hears the result of the draw they entered.

## Cadence safeguards

Three layers prevent email spam even under buggy triggers or admin misconfiguration:

1. **Master opt-in** — `email_preferences.email_enabled = 0` by default. Users must explicitly opt in.
2. **Per-type opt-in** — every trigger type has its own preference column (`streak_risk`, `streak_save`, `inactivity_reminder`, `weekly_digest`, `promotional`, `giveaway_loss`). All default `0` except `giveaway_loss`, which defaults `1` because it is a transactional follow-up to a giveaway the user already entered by playing.
3. **Global cooldown** — `config.emailGlobalCooldownHours` (default 24) is a hard floor: no user receives marketing email more often than this, regardless of how many triggers fire. Admin sends can bypass it with an explicit `adminOverride: true`.
4. **Per-type cooldown** — `email_trigger_config.cooldown_hours` on top of the global cooldown.

## Unsubscribe

Every marketing email ships with:

- An **unsubscribe link** in the footer.
- A `List-Unsubscribe: <url>` header and `List-Unsubscribe-Post: List-Unsubscribe=One-Click` header (RFC 8058) — this is what renders the native "Unsubscribe" button in Gmail and Apple Mail.

Tokens are **HMAC-signed**, not stored in the DB — they carry `{userId, type, iat}` signed with `config.emailUnsubSecret`. TTL 90 days. This means:

- Unsubscribe links keep working after DB rebuilds / migrations.
- No forged unsubscribe: without the secret, you cannot produce a valid token.
- No DB lookup cost per sent email.

## Bounce / complaint handling

Resend webhook at `POST /api/email/webhook/resend`. Maps events to the matching `email_log` row by `provider_message_id`:

| Event | Action |
| --- | --- |
| `email.opened` | `status=opened`, set `opened_at` |
| `email.clicked` | `status=clicked`, set `clicked_at` |
| `email.bounced` | `status=bounced` + auto unsubscribe-all the user |
| `email.complained` | `status=complained` + auto unsubscribe-all |

**Authentication is mandatory.** Resend signs webhooks with Svix; the endpoint:

1. Returns `503` if `RESEND_WEBHOOK_SECRET` is unset — the default safe state, since an unauthenticated webhook would let anyone guess a `provider_message_id` and force-unsubscribe the matching user.
2. Returns `401` if the request lacks valid `svix-id` / `svix-timestamp` / `svix-signature` headers or the signature fails the HMAC-SHA256 check.
3. Rejects requests with timestamps more than 5 minutes from now to block replay attacks.

Configure the webhook in the Resend dashboard (Settings → Webhooks) and copy the signing secret (format `whsec_<base64>`) into `RESEND_WEBHOOK_SECRET`.

## Configuration

All knobs are env-driven via `apps/server/src/config.ts`:

```
EMAIL_SCHEDULER_INTERVAL_MS=900000   # 15 min tick (vs push's 60 s)
EMAIL_GLOBAL_COOLDOWN_HOURS=24       # hard-floor per-user cooldown
EMAIL_MAX_PER_TICK=50                # batch size per scheduler tick
EMAIL_MAX_ATTEMPTS=3                 # retry cap for scheduled sends
EMAIL_UNSUB_SECRET=<random hex>      # REQUIRED in production
RESEND_WEBHOOK_SECRET=<from Resend>  # optional
```

`RESEND_API_KEY` / `EMAIL_FROM` / `APP_URL` are shared with transactional email (they already exist).

## Admin panel

Mounted at `/admin/email`. Five tabs:

1. **Stats** — sent / open / click / bounce rates, per-type breakdown (last 7/14/30 days).
2. **Send** — ad-hoc or from-template send to a single user or all opted-in users. Live preview iframe.
3. **Templates** — CRUD for `email_templates`.
4. **Triggers** — enable/disable each trigger, tune cooldown, edit threshold JSON, pick template.
5. **Log** — paginated `email_log` with filters by type, status, user id.

## User preferences

User-facing panel is `apps/web/src/components/EmailSettings.tsx`, rendered in `SettingsPage`. Master toggle + per-type toggles + preferred-hour + timezone (auto-detected from `Intl`).

All toggles default OFF — email is strictly opt-in.

## UTM origin tagging

Every URL inside an outgoing email is auto-tagged with UTM parameters that identify which template type sent it. The mapping lives in `packages/shared/src/outboundOrigins.ts` and is applied transparently by the outbound-links service (`apps/server/src/services/outboundLinks.ts`):

- **Static destinations** (e.g. dashboard "Play again" CTA) get substituted for a system-managed short link `https://price.games/go/<code>`. The short code is materialized lazily in `utm_tags` (one row per origin, idempotent across processes) and resolves through the existing `/go/<code>` redirect handler. Click counts roll up on the same `utm_tags.click_count` admins already see in the funnel.
- **Per-recipient tokenized URLs** (`/claim/<token>`, `/verify-email?token=…`, `/reset-password?token=…`) keep their long form with UTM params appended directly. Short-coding these would either explode the table to per-user rows or break the token-to-user binding.

Auto-rewrite is wired in `sendMarketingEmail` at the boundary where the rendered HTML / text body crosses into the transport layer, **before** the unsubscribe footer is appended — the HMAC-signed unsub URL is never tagged because tagging it would distort the per-template click counter (every unsub click would absorb).

Origin → UTM tuple table:

| Origin key | source | medium | campaign | content |
|---|---|---|---|---|
| `email:verify` | email | transactional | verify_email | — |
| `email:password_reset` | email | transactional | password_reset | — |
| `email:reward_awarded` | email | transactional | reward_awarded | — |
| `email:reward_reminder_15d` | email | transactional | reward_reminder | 15d |
| `email:reward_reminder_7d` | email | transactional | reward_reminder | 7d |
| `email:reward_reminder_1d` | email | transactional | reward_reminder | 1d |
| `email:reward_expired` | email | transactional | reward_expired | — |
| `email:giveaway_loss` | email | lifecycle | giveaway_loss | — |
| `email:streak_risk` | email | lifecycle | streak_risk | — |
| `email:streak_save` | email | lifecycle | streak_save | — |
| `email:inactivity_reminder` | email | lifecycle | inactivity_reminder | — |
| `email:weekly_digest` | email | lifecycle | weekly_digest | — |
| `email:leaderboard_placement` | email | lifecycle | leaderboard_placement | — |
| `email:promotional` | email | marketing | promotional | — |
| `email:custom` | email | marketing | custom | — |

Admin-authored templates in `email_templates` need no special wiring — `sendMarketingEmail` runs `rewriteHtmlLinks` / `rewriteTextLinks` over the rendered output, so any `<a href="${appUrl}/...">` anchor (or bare URL in the text body) gets the right tag for the email's `EmailNotificationType`. UTM params already present on author-supplied URLs are preserved (defense in depth — the author's choice wins).

System-managed origin rows are visible in the admin UI under the "System origins" pill on `/admin/utm-tags` but are read-only: deleting one would 404 every link in flight from the corresponding template until the next process restart.
