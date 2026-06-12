---
title: Game Modes
status: stable
last_reviewed: 2026-06-03
owner: core
audience: all
category: game-design
summary: "All game modes — rules, products per round, timers, multiplayer support, plus a how-to-add-a-mode walkthrough."
related_code:
  - packages/shared/src
  - apps/server/src/socket
---
# Game Modes

Price Games has 12 game modes. All are available in both single-player and multiplayer, except **Bidding War** which is multiplayer-only.

In addition, a **Daily Challenge** mode plays 5 rounds of one of three eligible modes (`classic`, `higher-lower`, `comparison`) on a fixed weekly rotation. See [DAILY_MODE.md](DAILY_MODE.md) for full details.

## Mode Reference

| # | Slug | Display Name | Description | Products/Round | Timer | Max Score/Round |
|---|------|-------------|-------------|----------------|-------|-----------------|
| 1 | `classic` | Precision | Guess the exact price of a product | 1 | 30s | 1000 |
| 2 | `higher-lower` | Higher or Lower | Is the real price higher or lower than the shown reference? | 1 | 30s | 1000 |
| 3 | `comparison` | Comparison | Which of two products costs more (or less)? | 2 | 30s | 1000 |
| 4 | `closest-without-going-over` | Underbid | Guess close to the real price — but stay under it | 1 | 30s | 1000 |
| 5 | `price-match` | Price Match | Match 4 products to their correct prices | 4 | 45s (MP) | 1000 |
| 6 | `riser` | Riser | Stop the rising price before it exceeds the actual price | 1 | 30s | 1000 |
| 7 | `odd-one-out` | Odd One Out | Find the product that doesn't match the price group | 4 | 30s | 1000 |
| 8 | `market-basket` | Market Basket | Estimate the total cost of a basket of products | up to 6 | 45s (MP) | 1000 |
| 9 | `sort-it-out` | Sort It Out | Rank products from cheapest to most expensive | 5 | 30s | 1000 |
| 10 | `budget-builder` | Budget Builder | Pick items that fit within the given budget | 6 | 60s (MP) | 1000 |
| 11 | `chain-reaction` | Chain Reaction | Build a chain of products by ascending price | 5 | 84s total (MP), 10s/sub-round (SP) | 3500 |
| 12 | `bidding` | Bidding War | Bid closest to the real price without going over (multiplayer-only) | 1 | 20s/turn | 1000 |

### Random

The home screen includes a **Random** card that picks a random enabled game mode and starts it. This is a UI-only convenience — there is no "random" game mode on the server. If all modes are admin-disabled, the card is a no-op.

Single-player games default to **5 rounds**. Players can choose **3, 5, or 10** rounds via the Game Options menu. Daily challenge always plays 5 rounds. Multiplayer rounds are configurable by the host (default 10).

## Bidding War

**Slug**: `bidding` | **Multiplayer** + **daily challenge** (single-player)

One product per round. Closest bid without going over the actual price wins. Bids over the actual price score 0.

### Multiplayer

Players bid in sequence (randomized order each round). All bids are scored comparatively after the last bid in the round.

- **Default rounds**: 5 (was 10 for other modes; bidding is slower due to turn-taking)
- **Turn order**: Randomized each round
- **Turn timer**: 20 seconds per player. Auto-bid of $0.01 on timeout.
- **Scoring**: Graduated placement — valid bids ranked by proximity to actual price:

| Placement | Score |
|-----------|-------|
| 1st | 1000 |
| 2nd | 700 |
| 3rd | 400 |
| 4th | 200 |
| 5th/6th | 100 |

- **Exact match bonus**: +500 points
- **Over the price**: 0 points (bid disqualified)

### Single-player (daily challenge only)

Bidding War is daily-eligible as a solo variant: the player gets one bid per round against the real price. There is no turn order and no comparative ranking — each bid is scored on its own via `scoreBiddingSolo`.

- **Scoring**: proximity-based smooth curve with exact-match bonus (not flat-1000 rank). See [SCORING.md](./SCORING.md) for the curve formula.
  - **Exact match**: 1500 points (1000 base + 500 exact-bid bonus)
  - **Under the price**: `round(1000 * (1 - pctOff)^3)` — e.g. 5% under = 857, 25% under = 422, 50% under = 125, 75% under = 16
  - **Over the price**: 0 points
- Previously used rank-based scoring with a single bid, which collapsed every valid underbid to rank 0 = 1000 pts; that made bidding $0.01 on a $30 item an optimal strategy.
- **UI**: reuses `ClosestPage` since the "one product, one price input" surface is identical to Underbid.
- **Routing**: single-player bidding is only reachable via the daily challenge rotation (it remains rejected by `POST /api/game/start` outside the daily flow).

## Multiplayer

- Up to **6 players** per room (increased from 4 to support bidding mode)
- Create or join rooms with a room code
- Optional room passwords (bcrypt-hashed)
- **Public lobbies**: Rooms can be marked public for browsable lobby list
- **Bots**: Host can add 1-5 bots with configurable difficulty (easy/medium/hard)
- **Ready-up**: Players mark themselves as ready in the lobby; game auto-starts when all humans are ready
- Room cleanup rules (all auto-applied by `cleanupStaleRooms`):
  - **Lobby rooms** with 0 connected players: 5 minutes — full purge
  - **Finished rooms**: after 10 minutes, in-memory state is evicted (sockets, timers, bidding machine) but **all DB rows are preserved** — `mp_rooms`, `mp_players`, and `mp_guesses` stay indefinitely so the history recap endpoint can reconstruct a round-by-round breakdown for any prior MP game, even ones whose `share_id` was never stamped proactively
  - **Orphaned "ending" rooms**: 5 minutes — full purge
  - **Abandoned playing/between_rounds rooms** with 0 connected: 5 minutes — full purge
  - **Hard cap**: any non-finished room older than 2 hours — full purge

## Difficulty System (Round Composer)

Products are selected using a **probabilistic difficulty curve** that ramps from easier to harder rounds:

- **Early rounds** (progress < 30%): Mostly easy (70% easy, 25% medium, 5% hard)
- **Mid rounds** (progress 30-70%): Mostly medium (20% easy, 55% medium, 25% hard)
- **Late rounds** (progress > 70%): Mostly hard (5% easy, 25% medium, 70% hard)
- **10% wildcard**: Any round has a 10% chance of pulling from any difficulty tier

The round composer also considers:
- **Manufacturer diversity** — avoids showing too many products from the same brand
- **Per-user product memory** — tracks which products each user has seen to avoid repeats (requires login)
- **Product pairing** (comparison/price-match modes) — rejects variants of the same product and targets meaningful price spreads

## Game Constants

```
TOTAL_ROUNDS = 10          # maximum rounds (share grid layout)
DEFAULT_TOTAL_ROUNDS = 5   # default for single-player
ROUND_COUNT_OPTIONS = [3, 5, 10]  # user-selectable
MIN_ROUNDS = 3             # minimum configurable rounds (multiplayer)
MAX_ROUNDS = 20            # maximum configurable rounds (multiplayer)
DAILY_TOTAL_ROUNDS = 5     # daily challenge (fixed)
ROUND_TIME_SECONDS = 30
MAX_PLAYERS = 6

# Multiplayer-specific timers
MP_ROUND_TIME_SECONDS = 30
MP_PRICE_MATCH_TIME_SECONDS = 45
MP_MARKET_BASKET_TIME_SECONDS = 45
MP_BUDGET_BUILDER_TIME_SECONDS = 60
MP_CHAIN_REACTION_TIME_SECONDS = 84
SP_CHAIN_REACTION_SUB_TIME_SECONDS = 10

# Products per round
COMPARISON_PRODUCTS_PER_ROUND = 2
PRICE_MATCH_PRODUCTS_PER_ROUND = 4
ODD_ONE_OUT_PRODUCTS_PER_ROUND = 4
MARKET_BASKET_MAX_PRODUCTS = 6
SORT_IT_OUT_PRODUCTS_PER_ROUND = 5
BUDGET_BUILDER_PRODUCTS_PER_ROUND = 6
CHAIN_REACTION_PRODUCTS_PER_ROUND = 5
```

## How to Play Each Mode (UX flavor)

For people who haven't played yet, here's what each mode actually *feels* like:

- **Precision** — A product card shows up. You type a price guess in cents-precision and hit Submit. Score scales smoothly with how close you got. Most forgiving mode; good first stop.
- **Higher or Lower** — A product is shown alongside a reference price. You click **Higher** or **Lower**. Snap decision, no typing.
- **Comparison** — Two products side-by-side. Click the more expensive one. Often surprising — premium tokens and brand cues mislead.
- **Underbid** — Like Precision but you score 0 if you go over the actual price. Rewards reading the room.
- **Price Match** — Four products on top, four prices on the bottom. Drag prices to products. Partial credit per correct match. Multiplayer leans on this for chaotic 45-second rounds.
- **Riser** — A bar fills up, the displayed price climbing in real time. Tap STOP before it exceeds the actual price. Equal parts patience and nerve.
- **Odd One Out** — Three products that should belong to the same price cluster, plus one outlier. Spot the outlier. Looks easy. Isn't.
- **Market Basket** — Six products in a basket. You estimate the basket's total. Closer = more points.
- **Sort It Out** — Five products to rank from cheapest to most expensive. Partial credit for adjacent pairs in the right order.
- **Budget Builder** — Six products and a budget. Pick items that fit within the budget — score is the budget you actually consumed (over-budget = 0).
- **Chain Reaction** — A chain of products. For each adjacent pair, predict whether the next is **more** or **less** expensive than the previous. Score grows exponentially with consecutive correct answers (and a +500 perfect bonus).
- **Bidding War (multiplayer)** — Players bid in turn-order. Closest-without-going-over rules — closest bid without going over wins big, going over scores 0. Auction tension built into the timer.
- **Bidding War (daily, solo)** — Same one-bid challenge against the real price, scored on proximity rather than rank.

## How to Add a New Game Mode

Adding a 13th mode is a six-step pattern. The example below walks through "Order of Magnitude" — players are shown a product and pick which 10× bucket the price falls into.

### 1. Register the mode slug

```typescript
// packages/shared/src/constants.ts
export const VALID_GAME_MODES = new Set<GameMode>([
  // ... existing 12
  "order-of-magnitude",
]);

// packages/shared/src/types.ts — add to the GameMode union
export type GameMode =
  | "classic"
  // ... existing
  | "order-of-magnitude";
```

If your mode is multiplayer-only, also add it to `MULTIPLAYER_ONLY_MODES`.

### 2. Define the wire types

```typescript
// packages/shared/src/types.ts — extend the GuessData union
export type GuessData =
  | { guessedPriceCents: number }
  // ... existing
  | { magnitudeIdx: number };
```

Update [`docs/WEBSOCKET_EVENTS.md`](./WEBSOCKET_EVENTS.md) `guessData` table.

### 3. Write the scoring function

```typescript
// packages/shared/src/scoring.ts
export function scoreOrderOfMagnitude(
  guessIdx: number,
  actualCents: number,
): { score: number } {
  const actualIdx = Math.floor(Math.log10(actualCents / 100));
  const diff = Math.abs(guessIdx - actualIdx);
  return { score: diff === 0 ? 1000 : Math.max(0, 1000 - diff * 400) };
}
```

Hook it into the `scoreGuessForMode` dispatcher in `apps/server/src/services/guessScoring.ts`, which validates each mode's `guessData` shape and calls the matching scoring function. Add unit tests in `apps/server/src/services/guessScoring.test.ts`. Update [`docs/SCORING.md`](./SCORING.md).

### 4. Wire the round composer

```typescript
// apps/server/src/services/roundComposer.ts
// Add a case for "order-of-magnitude" that picks the right number/shape of products.
```

If your mode needs special round metadata (a reference price, a budget, etc.), extend `RoundStartPayload` in `packages/shared/src/types.ts` and emit those fields from the composer.

### 5. Add a Page component + route

```typescript
// apps/web/src/pages/OrderOfMagnitudePage.tsx — new file
// apps/web/src/App.tsx — register the route /play/order-of-magnitude
```

The page reads round state from `useGame` (single-player) or `useMultiplayerGame` (multiplayer), renders the prompt, and calls the submit-guess action with a `{ mode: "order-of-magnitude", magnitudeIdx }` payload.

### 6. Add the constants and visibility

```typescript
// packages/shared/src/constants.ts — add to MODE_DISPLAY_NAMES
// apps/web/src/pages/HomePage.tsx — add the mode card (or rely on the existing iteration over VALID_GAME_MODES)
```

If you need a custom timer, add the constant to the multiplayer timer block in `constants.ts`. Streamer-bot teams: also add a strategy (see [`streamer/strategies.md`](./streamer/strategies.md) "How to add a new strategy") and an enactor.

### 7. Tests & docs

- Add unit tests for the scoring function.
- Add an integration test for the round composer.
- Add a frontend test for the Page component (rendering, submit flow).
- Update [`docs/GAME_MODES.md`](./GAME_MODES.md) (the mode table + UX paragraph above).
- Update [`docs/SCORING.md`](./SCORING.md), [`docs/API_REFERENCE.md`](./API_REFERENCE.md), [`docs/WEBSOCKET_EVENTS.md`](./WEBSOCKET_EVENTS.md) per the [`CONTRIBUTING.md`](../CONTRIBUTING.md) doc checklist.

## Game Mode Availability

Admins can enable or disable individual game modes via the admin panel (**Admin > Game Modes**).

- **Disabled modes are hidden** from mode selectors on the home page, multiplayer room creation, and the multiplayer lobby settings panel.
- **Server-side enforcement**: Disabled modes are rejected at game start (`POST /api/game/start`), room creation (`room:create`), and room settings changes (`room:settings`). This prevents circumvention via direct API or WebSocket calls.
- **Storage**: The list of disabled mode slugs is persisted in the `site_settings` table under the key `disabled_game_modes` (JSON string array).
- **Public endpoint**: `GET /api/settings/game-modes` returns the current `disabledModes` list without requiring authentication, so the frontend can hide disabled modes before the user attempts to start a game.

**Source**: `packages/shared/src/constants.ts`
