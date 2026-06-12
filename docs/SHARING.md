---
title: Results Sharing
status: stable
last_reviewed: 2026-06-03
owner: growth
audience: contributor
category: features
summary: "Wordle-style results sharing — text, PNG, and shareable URLs."
related_code:
  - apps/web/src
  - apps/server/src/routes
---
# Share Results — Wordle-Style Sharing

End-of-game Wordle-style result sharing for Price Games. Players see a
"Share Results" button on the final results screen (both single-player and
multiplayer); clicking it opens a modal with a copyable text grid and a
branded PNG card.

## Feature at a glance

- Works for **all 11 game modes** and for both **single-player** and
  **multiplayer** games
- **Two output formats**: text (emoji grid, clipboard-friendly) and PNG
  (720×540 branded card, rendered on a hidden `<canvas>`)
- **Five action buttons**, each feature-detected and hidden when the
  platform can't support them: Copy Text, Copy Image, Share… (native
  Web Share), Download Image, Copy Link
- **Shareable `/s/:id` URLs**: opening the share modal POSTs the game
  snapshot to the server, which mints a short URL (`price.games/s/aBcD1234`)
  backed by the new `shared_games` table. Viewers who open the link see a
  rich read-only rendering of the actual game — emoji grid, big score,
  and per-round cards with product images, prices, and mode-specific
  details (higher/lower pick, budget-builder cart, etc.)
- **Graceful degradation**: if the POST fails (offline, rate limit, server
  error), the modal silently falls back to the Phase 1 behavior — footer
  stays `play at price.games` and no URL is minted

## Emoji tier mapping

Each round's score is classified into one of four tiers based on its ratio
against the per-round max (1000 for most modes, 1313 for chain-reaction):

| Tier  | Emoji | Threshold             |
| ----- | ----- | --------------------- |
| great | 🟩    | score ÷ max ≥ 0.90   |
| good  | 🟨    | score ÷ max ≥ 0.50   |
| ok    | 🟧    | score ÷ max > 0      |
| miss  | ⬛    | score ÷ max = 0      |

The 10-round game is displayed as a **2×5 grid** (two rows of five tiles)
that mirrors Wordle's compact aesthetic without sprawling.

## Text output

Without a shareable URL (fallback):

```
Price Games | Precision | 7,500/10,000
🟩🟩🟨🟩⬛
🟨🟩🟩🟧🟩
play at price.games
```

With a shareable URL (the default when the POST succeeds):

```
Price Games | Precision | 7,500/10,000
🟩🟩🟨🟩⬛
🟨🟩🟩🟧🟩
price.games/s/aBcD1234
```

Notes:

- Pipe (`|`) separators are used instead of em-dash to survive clipboard
  encoding quirks.
- No trailing newline.
- For chain-reaction, the total is out of **13,130** (10 × 1313).
- The footer URL is display-only (`<host>/s/<id>` without the scheme). The
  "Copy Link" button copies the full `https://` URL separately.

## Canvas share card

A 720×540 PNG card with:

1. Dark background (`--bg-dark`, `#1a1a2e`)
2. "PRICE GAMES" title in gold (`--accent-gold`, `#f6c90e`)
3. Mode name + score in two lines beneath the title
4. 2×5 emoji grid at fixed tile positions
5. `price.games` footer in secondary text color

The drawing is split into small pure sub-functions (`drawBackground`,
`drawHeader`, `drawScore`, `drawGrid`, `drawFooter`) so each is unit-tested
against a spy `ShareCanvasContext` — no real canvas is required in jsdom.

## Feature detection matrix

| Button         | Requires                                        | Chrome | Edge | Firefox | Safari Desktop | Mobile Safari | Mobile Chrome |
| -------------- | ----------------------------------------------- | :----: | :--: | :-----: | :------------: | :-----------: | :-----------: |
| Copy Text      | `navigator.clipboard.writeText`                 |   ✅   |  ✅  |   ✅    |      ✅        |      ✅       |      ✅       |
| Copy Image     | `navigator.clipboard.write` + `ClipboardItem`   |   ✅   |  ✅  |   ❌¹   |      ✅        |      ❌¹      |      ✅       |
| Share…         | `navigator.share`                               |   ❌²  |  ❌² |   ❌    |      ✅        |      ✅       |      ✅       |
| Download Image | `<a download>` attribute (universal)            |   ✅   |  ✅  |   ✅    |      ✅        |      ✅       |      ✅       |

¹ Firefox and older mobile Safari support `navigator.clipboard.write` but
  not PNG image items. The button is hidden automatically via
  `canCopyImage()` / when the browser lacks `ClipboardItem`.

² Desktop Chrome/Edge do not ship `navigator.share` by default (it is a
  PWA/mobile feature). The button is hidden automatically via
  `canShareNative()`.

User cancellation of the native share sheet throws a DOMException with
name `AbortError`; `shareNative` swallows this silently because dismissing
a share sheet is not an error.

## Shareable URL view

When the share modal opens, it POSTs the current game's snapshot to
`POST /api/share` (see [API_REFERENCE.md § Share](API_REFERENCE.md#share)).
The server validates the payload, sanitizes the optional `playerName`,
generates a `nanoid(8)` id, inserts a row into the `shared_games` table
(see [DATABASE.md § Shared Games](DATABASE.md#shared-games-table)), and
returns `{ id, url }`. The client updates the text/PNG footers with the
URL and makes a "Copy Link" button available.

### The read-only view

Opening `price.games/s/<id>` lands on a React page (`SharePage.tsx`) that:

1. Fetches the record via `GET /api/share/:id`.
2. Renders the same Wordle-style emoji grid the modal preview uses.
3. Renders the big total score + per-round max.
4. Renders a per-round card for every round with product image, title,
   actual price, and mode-specific detail lines (higher/lower pick,
   market-basket actual-vs-guessed totals, budget-builder cart-vs-budget,
   correctCount badge, etc.).
5. Shows a prominent "Play your own" CTA that navigates to `/`.
6. Handles loading, 404, and generic-error states with friendly copy.

The view is deliberately standalone — it doesn't reuse the existing
`ResultPage` breakdown components, which require the full `RoundResult`
union shape that the stored snapshot doesn't exactly match.

### `/recap/:historyId` — canonical review URL

`/s/:shareId` is the publishable permalink the user creates when they click
"Share Results" — it's Phase-2 infrastructure. For the **Game History** views
in My Scores (`GameHistoryPanel.tsx`) and the Leaderboard → Player Profile
Modal (`PlayerProfileModal.tsx`), every row must always be clickable and
resolve to the same round-by-round breakdown — whether or not the user ever
clicked "Share". `/recap/:historyId` handles that:

- **Frontend** (`pages/RecapPage.tsx`): mirrors `SharePage`, fetching via
  `GET /api/user/history/:historyId/recap` and rendering through the same
  `SharedGameView` export.
- **Backend** (`routes/user.ts`): serves a `SharedGameRecord` via a two-tier
  lookup. If `user_game_history.share_id` is already stamped (the common
  case — see below) it returns the cached `shared_games` row. If not (legacy
  rows), it synthesizes the snapshot from `game_sessions` + `game_rounds`
  (SP) or `mp_rooms.round_data` + `mp_guesses` (MP) using the builders in
  `services/historyRecap.ts`, inserts the result into `shared_games`, and
  stamps `share_id` in the same transaction. Every subsequent click is O(1).

**Proactive write at record time**: `recordSinglePlayerGame` and
`recordMultiplayerGame` in `services/userGameHistory.ts` now call the same
snapshot builders inside their existing transactions and stamp `share_id`
immediately — so every new game starts life with its recap cached. The
on-demand synthesis in the recap endpoint only ever fires for rows created
before that code was deployed; it's lazy-memoization scoped to the legacy
set, not a hot path.

Both code paths use the shared `createShareRow` helper in
`services/historyRecap.ts`, which also backs `POST /api/share`. A
snapshot-builder failure at record time is intentionally non-fatal: history
recording succeeds, and the recap endpoint retries on first click.

### Privacy

Phase 1 of this feature was client-only; the server never saw anything.
Phase 2 (the shareable URL view) introduces server-side storage. Users
should know:

- **Share links are public.** Anyone with the URL can open it and see the
  game. The modal shows a small advisory caption on open.
- **What's stored**: game mode, total score, per-round scores + products,
  optional display name, and creation timestamp. No user id, no IP, no
  session token, no email, no browser fingerprint.
- **Display names** (when provided) are passed through `sanitizeName(name, 30)`
  on the server — HTML stripping, profanity filter, length cap.
- **Immutable**: records never change after creation.
- **No expiry**: shares live forever for now. This may change in a future
  release if storage becomes a concern.

Sharing is opt-in: the user explicitly clicks "Share Results". Closing
the modal without using any action button still mints a record (the POST
is eager), but without the URL ever leaving the browser, nobody else can
find it — the `nanoid(8)` id space (218 trillion) is unguessable.

### Abuse mitigations

- **Rate limiting**: `POST /api/share` is wired to the existing
  `apiLimiter` middleware (60 requests per minute per IP by default).
- **Payload size cap**: serialized `roundData` must be ≤ 16 KB. Stricter
  than the global `express.json({ limit: "100kb" })`.
- **Input validation**: every field is type-checked and bounded server-side.
  `perRoundMax` is recomputed from the `gameMode` — the client can't
  spoof a higher per-round cap.
- **No free-text fields** aside from the optional sanitized player name.
- **Unguessable ids**: `nanoid(8)` uses `[A-Za-z0-9_-]` (64 chars × 8 = 2⁴⁸).
  Scanning for existing records is infeasible.
- **XSS defense**: `SharePage` renders all user-sourced fields (player
  name, product titles) as React text children. No `dangerouslySetInnerHTML`.

## Accessibility

- The modal is a `role="dialog"` with `aria-modal="true"` and an
  `aria-label`.
- The emoji grid is marked `aria-hidden="true"` (screen readers would
  stumble on raw emoji) and accompanied by a visually-hidden
  `<span className="sr-only">` that contains the prose equivalent:

  > Price Games, Precision. Score 7,500 of 10,000. Row 1: 3 great, 1 good,
  > 1 miss. Row 2: 3 great, 1 good, 1 ok.

  Built by `buildShareAccessibleText` in the shared package so the visual
  and spoken representations cannot drift.
- The close button receives focus automatically on mount.
- Escape key, overlay click, and close button all dismiss the modal.
- Action status (copying, copied, error) is announced via an `aria-live="polite"` `role="status"` region.

## Source map

The feature lives across the monorepo like this:

| Layer          | File                                                           | Responsibility                                               |
| -------------- | -------------------------------------------------------------- | ------------------------------------------------------------ |
| Pure logic     | `packages/shared/src/shareGrid.ts`                             | Tier classification, emoji mapping, text/a11y/footer builders, `SharedGameRecord`/`SharedRoundSnapshot`/`CreateShareRequest` types |
| Canvas         | `apps/web/src/components/share/shareCanvas.ts`                 | PNG drawing + `renderShareImage()` orchestration             |
| Platform APIs  | `apps/web/src/components/share/clipboard.ts`                   | Feature-detecting wrappers for Clipboard + Web Share         |
| API client     | `apps/web/src/api/client.ts`                                   | `createShare()` / `getShare()` wrappers                      |
| Data adapter   | `apps/web/src/hooks/useShareData.ts`                           | Derives `ShareGridInput` + `SharedRoundSnapshot[]` from SP or MP screen state |
| Modal UI       | `apps/web/src/components/share/ShareModal.tsx`                 | Dialog with previews, action buttons, status feedback, eager POST to `/api/share` |
| SharePage      | `apps/web/src/pages/SharePage.tsx`                             | `/s/:id` read-only view — loading/404/error states + `SharedGameView` renderer |
| Modal wiring   | `apps/web/src/pages/ResultPage.tsx` (SP)                       | SP "Share Results" button + data wiring                      |
|                | `apps/web/src/components/multiplayer/MPResultsScreen.tsx` (MP) | MP "Share Results" button + data wiring                      |
| Server route   | `apps/server/src/routes/share.ts`                              | `POST /api/share` + `GET /api/share/:id` with validation, sanitization, nanoid id generation, 16 KB payload cap |
| DB schema      | `apps/server/src/db.ts`                                        | `shared_games` table definition (idempotent) |
| Tests          | `apps/server/src/services/shareGrid.test.ts`                   | Shared-pkg coverage                                          |
|                | `apps/server/src/routes/share.test.ts`                         | Route coverage — every validation branch + GET round-trip    |
|                | `apps/web/src/__tests__/shareCanvas.test.ts`                   | Canvas sub-functions + `renderShareImage` error paths        |
|                | `apps/web/src/__tests__/clipboard.test.ts`                     | Feature detection + wrapper success/failure                  |
|                | `apps/web/src/__tests__/useShareData.test.tsx`                 | SP/MP variants, `buildSharedRoundSnapshots`, defensive branches |
|                | `apps/web/src/__tests__/ShareModal.test.tsx`                   | Dialog + actions + Phase 2 POST-on-mount + Copy Link button  |
|                | `apps/web/src/__tests__/SharePage.test.tsx`                    | `/s/:id` page — loading/404/error/success, round cards, chain-reaction max |

## Daily Challenge Integration

The Daily Challenge mode (see [DAILY_MODE.md](DAILY_MODE.md)) reuses the share infrastructure:

- Daily results share via the same `ShareModal` with a daily-specific text format: `Price Games Daily #N | Mode | Score/Max`
- Daily shares omit the `/s/:id` short link to avoid spoilers
- The `DailyResultPage` renders per-round pip rows, streak display, and countdown to next puzzle
