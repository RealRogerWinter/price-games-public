---
title: Ad Monetization
status: draft
last_reviewed: 2026-09-03
owner: growth
audience: contributor
category: features
summary: "Google AdSense scaffolding — inert until manual account setup: chosen network, the 4 real slot locations, the rejected in-round slot, and the gating invariants that must never regress."
related_code:
  - apps/web/src/components/ads/AdSlot.tsx
  - apps/web/src/broadcast/useBroadcastMode.ts
  - apps/web/src/utils/cookieConsent.ts
---
# Ad Monetization

Display-ad scaffolding for Price Games, built around Google AdSense. Everything described here is **inert in the current codebase** — no ad network script loads and no `AdSlot` renders anything until a human operator completes the manual AdSense account setup (see below) and sets the env vars that flip it on. This doc exists so a future contributor touching any of this code understands *why* it's shaped the way it is before changing it.

## Why AdSense

AdSense was chosen over Ezoic, Raptive, Mediavine, and Playwire because it has **no minimum-traffic gate**. The alternatives all require 25k–500k monthly sessions before they'll even review an application; AdSense will run on a small site from day one. That made it the only option that could actually launch given price.games' current traffic. Revisit this choice once traffic grows — the higher-paying networks may be worth the migration later, but that's a future decision, not this one.

## The 4 real slots (and the one that was rejected)

Ad placements live behind a single reusable component, [`AdSlot`](../apps/web/src/components/ads/AdSlot.tsx), mounted from `App.tsx` at exactly these locations:

| Slot name | Page | Mount point |
|---|---|---|
| `home_below_mode_grid` | Home | Below the game-mode grid, above the Random-mode hero — a static block, not adjacent to any clickable mode button without separation |
| `result_page_after_breakdown` | Result | After the score breakdown, before the leaderboard-rank block |
| `leaderboard_below_table` | Leaderboard | A **static sibling** after both the lifetime and streak tab fragments, outside every `loading`/tab-filter conditional |
| `site_anchor_footer` | All 4 top-level app shells | Immediately before `<SiteFooter />` in each shell |

### Rejected: no in-round / `RoundResult` slot

An earlier draft of this design put an ad inside `RoundResult.tsx`'s result overlay. **That was rejected during review and must stay rejected.** The result overlay is a fixed, full-viewport modal — the same pattern as `GiveawayModal` — and this project's own ad-placement rules ban ads from blocking modals. There is intentionally no `AdSlot` anywhere near `RoundResult.tsx` or `GamePage.tsx`. If you're tempted to add one there because "the result screen gets a lot of eyeballs," re-read this paragraph first — the traffic argument was already considered and overridden by the modal rule.

## Non-negotiable gating invariants

`AdSlot` checks all of the following, in order, before rendering anything. Every one of these exists because a specific bug or review finding demanded it — don't remove or weaken any of them without understanding what breaks:

1. **Broadcast mode is off.** The 24/7 Twitch capture stage (`BroadcastShell`) must never show a live ad to viewers. `useBroadcastMode()` reads a **React Context seeded exactly once by `BroadcastShell`** — not a per-component `useState(() => read URL)`. That distinction matters: the streamer-bot driver navigates the SPA mid-broadcast via `window.__pgBroadcastNav(url)`, and there's no guarantee `?broadcast=1` survives onto the target URL's query string. A component mounting for the first time on a later route (e.g. after the bot navigates to `/leaderboard`) would, under a per-component URL read, independently read the *current* `window.location.search` and could see `broadcast=false` even while the still-mounted `BroadcastShell` is actively rendering the capture stage — i.e. a live ad could leak into the Twitch stream. See [`useBroadcastMode.ts`](../apps/web/src/broadcast/useBroadcastMode.ts) and `BroadcastShell.tsx`.
2. **Not an `/admin/*` route.** Defense in depth — no admin page currently renders `AdSlot`, but the check stays so this remains true even if one later does.
3. **Explicit "Advertising" cookie-consent opt-in.** A dedicated `advertising` category in [`cookieConsent.ts`](../apps/web/src/utils/cookieConsent.ts), separate from `analytics` and `necessary`, defaults to `false`/denied and is wired into Google Consent Mode v2 (`ad_storage`, `ad_user_data`, `ad_personalization`). `AdSlot` reads it via the reactive `useConsentPreferences()` hook, so a slot appears/disappears live as the visitor changes their cookie settings — no page reload needed. EEA/UK visitors who haven't opted in never trigger an ad request.
4. **Always visibly labeled.** Every mounted slot renders inside a bordered `.ad-slot` container with a visible "Advertisement" text label — never bare markup that could visually blend with real game UI. This exists because an earlier draft placed an unlabeled in-feed ad directly above the homepage's "Random" mode button (the highest-traffic tap target on the page), an accidental-click and native-ad-policy risk.
5. **Leaderboard slot is a static mount point.** `LeaderboardPage`'s `adSlot` prop is rendered as a sibling *outside* every `loading`/tab/period-filter conditional block. An earlier draft mounted it inside a fragment that unmounted/remounted on every tab or filter switch (a `loading` flag flips true during refetch), which would have caused ad destroy/re-request churn on ordinary same-page filter clicks, not just navigation.
6. **Master kill switch + credentials, both required.** `VITE_ADS_ENABLED === "true"` gates independently of whether `VITE_ADSENSE_CLIENT_ID` and the slot's own `VITE_ADSENSE_SLOT_<NAME>` are set — so ads can be paused site-wide without touching per-slot config, and a slot with no ad-unit ID yet stays inert even if the kill switch is on.

If you're adding a new ad placement, route it through `AdSlot` and satisfy all six of the above — don't build a second ad-mount mechanism.

## Env vars required to go live

All currently unset in this repo; `AdSlot` renders `null` everywhere until they're filled in. See [`apps/web/.env.example`](../apps/web/.env.example) for the canonical, commented list.

| Var | Purpose |
|---|---|
| `VITE_ADS_ENABLED` | Master kill switch. Must be the literal string `"true"`. |
| `VITE_ADSENSE_CLIENT_ID` | AdSense publisher ID (e.g. `ca-pub-xxxxxxxxxxxxxxxx`). |
| `VITE_ADSENSE_SLOT_HOME` | Ad-unit ID for the homepage slot. |
| `VITE_ADSENSE_SLOT_RESULT` | Ad-unit ID for the result-page slot. |
| `VITE_ADSENSE_SLOT_LEADERBOARD` | Ad-unit ID for the leaderboard slot. |
| `VITE_ADSENSE_SLOT_ANCHOR` | Ad-unit ID for the site-wide footer anchor slot. |

## Manual AdSense setup checklist (human operator, not code)

None of this has happened yet. It's a manual, one-time sequence outside this codebase:

1. Create a Google AdSense publisher account for the site.
2. Submit the site for AdSense review and wait for approval.
3. In the AdSense dashboard, create 4 ad units — one per slot above (home, result, leaderboard, anchor).
4. Copy the publisher client ID and each ad unit's slot ID into the production env vars listed above.
5. Add an `ads.txt` file at the domain root with the exact content AdSense provides for this publisher account.
6. Decide on and configure EEA/UK consent-message certification in the AdSense dashboard (this is separate from — and in addition to — the site's own cookie-consent banner and `advertising` consent category described above).
7. Flip `VITE_ADS_ENABLED=true` in production once the above is verified.

Also see the related legal-doc updates in `apps/server/src/db.ts`'s `DEFAULT_PRIVACY_POLICY`/`DEFAULT_TERMS_OF_SERVICE` constants (Section 5/6 of the Privacy Policy, Section 5 of the Terms) — those are source defaults for a *new* database only; the live site's legal text is a separate database row edited via the admin panel and needs the same wording pasted in as a manual follow-up once AdSense is actually live.
