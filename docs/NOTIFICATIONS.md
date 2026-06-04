---
title: Web Push Notifications
status: stable
last_reviewed: 2026-06-03
owner: core
audience: contributor
category: features
summary: Web-push: VAPID, urgency, badge format, Chrome quirks.
related_code:
  - apps/server/src/routes
  - apps/web/src
---
# Push Notifications

Web-push (VAPID) delivers Daily-Puzzle and streak reminders to subscribed users across Chrome, Firefox, Edge, and (with limitations) Safari/iOS.

This doc covers the parts that are easy to get wrong and that have caused real issues — everything else is in the code.

## Architecture at a glance

| Piece | Location | Responsibility |
|---|---|---|
| Client hook | `apps/web/src/hooks/usePushNotifications.ts` | SW registration, permission request, subscription CRUD |
| Soft-ask dialog | `apps/web/src/components/NotificationPrompt.tsx` | In-app prompt before the native permission prompt |
| Service worker | `apps/web/public/sw.js` | Renders incoming push payloads; routes clicks |
| Send service | `apps/server/src/services/pushNotification.ts` | `web-push` VAPID send; preference + quiet-hours gates |
| Scheduler | `apps/server/src/services/notificationScheduler.ts` | 60s tick; evaluates daily + streak triggers |
| Admin routes | `apps/server/src/routes/adminNotifications.ts` | Template CRUD + manual sends |

## The badge asset is special

The **badge** (`options.badge` on `showNotification`) is the small icon shown in the Android status bar when the full notification can't fit. It's also the icon that appears on the lock screen and in the notification shade header.

**Critical rule**: Android strips all RGB from the badge and renders only the alpha channel as white-on-transparent. A colored PNG will render as a blurry silhouette that doesn't read at 24×24.

The badge must be:

- **Pure white** (`R=255, G=255, B=255`) where visible
- **Fully transparent** elsewhere
- **96×96 PNG** (Android's preferred size)

Our badge is `apps/web/public/badge-96.png` — a price-tag silhouette. The bundled asset already satisfies the rules below, so the regeneration and verification snippets here are only needed if you customize the badge for your own deployment. To regenerate or modify:

```python
from PIL import Image, ImageDraw
im = Image.new("RGBA", (96, 96), (0, 0, 0, 0))
# ... draw with fill=(255, 255, 255, 255) only ...
im.save("apps/web/public/badge-96.png", "PNG")
```

To verify:

```bash
python3 -c "from PIL import Image; im = Image.open('apps/web/public/badge-96.png').convert('RGBA'); print(all(r==g==b==255 for (r,g,b,a) in im.getdata() if a>0))"
# must print: True
```

The badge that ships with the app lives in the repo at `apps/web/public/badge-96.png` (above); that committed file is the source of truth and no extra setup is required to use it. Operators who maintain a separate image archive may also keep a copy under their archive root (`$IMAGE_ARCHIVE_ROOT/images/notification-badges/`), but that archive is not part of a standard deployment.

## Why notifications don't carry a hero image by default

Chrome mobile's abusive-notification classifier (as of 2026) weights heavy, image-forward notifications negatively — especially when the user's engagement with the site is low. Previously our SW set `image: "/notif/notif-default.png"` on every push. It looked nice but contributed to spam-score noise.

Current behavior: the SW passes `image` through only when the server sets one explicitly. The Daily Puzzle and streak reminders set their own type-specific heroes (`/notif/notif-daily.png`, `/notif/notif-streak.png`). Admin ad-hoc sends use type-specific heroes where available and skip the hero otherwise.

## `urgency` and `topic`

Both are RFC 8030 headers forwarded to the push service (FCM on Chrome, Autopush on Firefox):

| Field | Purpose |
|---|---|
| `urgency` | Hint to the push service + Android about how aggressively to wake the device. Valid: `very-low`, `low`, `normal`, `high`. |
| `topic` | Replacement key at the push service. If a device is offline and two messages with the same `topic` arrive, only the most recent is delivered. Max 32 URL-safe chars (RFC 8030). |

`getSendOptionsForType` in `notificationScheduler.ts` maps each notification type to its defaults:

| Type | Urgency | Topic |
|---|---|---|
| `streak_reminder` | `high` | `streak-<userid-18>` |
| `daily_puzzle` | `normal` | `daily-puzzle` |
| `multiplayer_invites` | `high` | `invite-<userid-18>` |
| `leaderboard_updates` | `low` | `leaderboard` |
| `promotional` | `low` | `promo` |

All scheduled sends (queue processor + direct evaluators) pass through this helper so consumers never have to think about it.

## Streak reminder dispatch + audit

Streak reminders are evaluated by `evaluateStreakReminders` in `notificationScheduler.ts` against `users.daily_streak_current > 0`, but that column only refreshes on completion — a user who simply stops playing keeps a non-zero stored value until a sweep clears it. To keep stale reminders from going out:

1. **`decayStaleStreaks`** (in `dailyStreak.ts`) runs at the top of each scheduler tick and zeros `daily_streak_current` for every user whose `daily_streak_last_date` is older than yesterday. Cheap (single indexed UPDATE), idempotent, and cuts off the source of stale reminders.
2. **Last-mile re-check** in `processScheduledNotifications` re-reads the user's streak snapshot at dispatch time and suppresses the reminder if either:
   - the user has already completed today's daily (`suppression_reason='already_played'`), or
   - the streak is dead (`daily_streak_current === 0` OR `daily_streak_last_date < yesterday`) — `suppression_reason='streak_broken'`.
3. **Suppression audit** — every suppressed dispatch writes a row to `notification_log` with `status='suppressed'` and the reason set. The `scheduled_notifications` row's `error_message` carries `suppressed: <reason>` so both halves of the pipeline have a trail. The admin Notifications log surfaces the `suppressed` status as a filterable option.

Anonymous (logged-out) sessions never have a `users` row, so `evaluateStreakReminders` excludes them by JOIN. The web hook (`useDaily.ts`) also returns `streak: null` for anonymous responses — the home card renders the "Start a streak!" prompt instead of a localStorage counter.

## `renotify` policy

Default is `false`. Setting `renotify: true` re-alerts the user (sound/vibration) when a tagged notification replaces an earlier one with the same tag — this is a spam-classifier signal on Chrome mobile when combined with frequent sends. Only opt in when the replacement genuinely represents new information the user needs to act on.

## Manifest requirements

`apps/web/public/manifest.json` must carry:

- Both 192×192 and 512×512 icons with `"purpose": "any"`
- Both sizes with `"purpose": "maskable"` (padded ~10% for Android's adaptive icon safe zone)
- `"id"` and `"scope"` (site-quality signal)

The maskable variants are generated by padding the base logos onto the theme-color background. There is no committed generator script for these; regenerate them with an image library such as PIL (pad the base icon ~10% onto the theme-color background, then export at 192×192 and 512×512).

## Testing

- Unit: `apps/server/src/services/pushNotification.test.ts`, `notificationScheduler.test.ts`, `apps/web/src/__tests__/sw.test.ts`
- Manual: admin panel → "Send test notification" → verify on real Chrome Android that the status-bar icon is a crisp price-tag silhouette, not a muddy blob.

## UTM origin tagging

Push payload URLs are pre-tagged with UTM params before the existing click-tracker wraps them. The mapping comes from `originForNotificationType()` in `packages/shared/src/outboundOrigins.ts`:

| Origin key | source | medium | campaign |
|---|---|---|---|
| `push:daily_puzzle` | push | web_push | daily_puzzle |
| `push:streak_reminder` | push | web_push | streak_reminder |
| `push:leaderboard_updates` | push | web_push | leaderboard_updates |
| `push:leaderboard_placement` | push | web_push | leaderboard_placement |
| `push:multiplayer_invites` | push | web_push | multiplayer_invites |
| `push:promotional` | push | web_push | promotional |

Click flow on a tap:

1. Service worker navigates to `/api/push/click/<logId>?r=<encoded-tagged-url>`.
2. Server marks `notification_log.status = 'clicked'` and 302-redirects to the tagged URL.
3. Landing page's `captureUtmFromUrl()` (in `apps/web/src/utils/attribution.ts`) records first-touch attribution to `sessionStorage` and `/api/attribution/track`.

Push URLs intentionally **do not** use the `/go/<code>` short-link layer that emails use:
- Push URLs are never user-visible (the SW navigates directly), so short-link aesthetics buy nothing.
- The existing `notification_log` already provides per-template click attribution — adding `utm_tags.click_count` would double-count.
- Skipping the extra hop keeps the redirect chain at one (push tracker → final URL) instead of two (push tracker → `/go/<code>` → final URL).

The same tagged URL is mirrored onto the Socket.IO `NOTIFICATION_RECEIVED` payload so an in-app toast click counts toward the same origin as a native push tap.
