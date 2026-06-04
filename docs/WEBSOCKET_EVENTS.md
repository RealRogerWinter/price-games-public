---
title: WebSocket Events
status: stable
last_reviewed: 2026-06-03
owner: core
audience: contributor
category: api
summary: All Socket.IO events with payload schemas and ack error codes.
related_code:
  - apps/server/src/socket
  - packages/shared/src/types.ts
---
# WebSocket Events

Price Games uses **Socket.IO** for real-time multiplayer communication. All event names are defined in `packages/shared/src/constants.ts` under `SOCKET_EVENTS`.

## Connection

The Socket.IO server runs on the same port as the Express server (default 3001). Clients connect to `/socket.io`. User session cookies are extracted at connection time to link authenticated users to their socket.

**Important pattern**: The server never reads `roomCode` from event payloads. Instead, each socket's room association is tracked via `getSocketMeta(socket.id)` after join/create. This means client→server payloads do **not** include `roomCode`.

## Events Reference

### Room Management

#### Client -> Server

| Event | Payload | Description |
|-------|---------|-------------|
| `room:create` | `{ displayName, gameMode?, categories?, password?, totalRounds?, isPublic?, dailyDate?, preferredAvatar? }` | Create a new multiplayer room. Returns room code via ack callback. `dailyDate` (YYYY-MM-DD) flags the room as a daily-challenge room — the server validates daily is enabled, the scheduled mode matches `gameMode`, and the requester hasn't already played that date's daily. `preferredAvatar` is honored only for anonymous users when the value is a valid, enabled, untaken randomizable avatar; logged-in users always get their saved avatar preference, and invalid/taken values fall back to a random sticker. |
| `room:join` | `{ roomCode, displayName, password?, preferredAvatar?, source? }` | Join an existing room by code. If the target room is a daily-challenge room, rejects with `already_played` when the requester has already completed that date's daily. `preferredAvatar` follows the same rules as `room:create`. `source` records how the client got here — one of `'share_link'` (landed via `/<roomCode>` URL), `'browser'` (lobby browser click), `'quickplay'` (matchmaker), `'create'` (host's own arrival path); validated server-side via `asJoinSource()` and persisted on `mp_players.join_source` so v2 analytics can break down room arrivals by acquisition path. Defaults to `'browser'` when omitted or unrecognized. |
| `room:rejoin` | `{ roomCode, playerToken }` | Rejoin after disconnect using stored player token. Ack is either `{ room, playerId, currentRoundData?, guessedPlayerIds? }` on success or `{ error: true, code: RejoinErrorCode }` on failure. See "Rejoin error codes" below. |
| `mp:heartbeat` | `{}` | Client liveness probe. Server acks immediately with `{ t: number }`. Used by the client on tab-resume to detect "zombie" sockets (iOS Safari may report `readyState === OPEN` long after the underlying transport is dead). |
| `room:kick` | `{ playerId }` | Kick a player (host only). Room derived from socket meta. |
| `room:settings` | `{ gameMode?, categories?, totalRounds?, password?, isPublic? }` | Update room settings (host only, lobby only). `categories` is `string[] | null`. `isPublic` toggles public-lobby visibility — explicit `false` is honored, so a host can flip a public room private after creation. |
| `room:bot_config` | `{ botCount: number, botDifficulty: "easy"\|"medium"\|"hard" }` | Configure bots for the room (host only, lobby only). Room derived from socket meta. |
| `room:ready` | `{}` | Mark self as ready in the lobby. Game auto-starts when all humans are ready. Room derived from socket meta. |
| `room:start_round` | `{}` | Start the next round (host only, between rounds). Room derived from socket meta. |
| `room:host_start_countdown` | `{}` | Host clicks "Start Game" in the lobby. Server writes `mp_rooms.countdown_target_at` (10 s ahead) and broadcasts `room:updated` so every client renders the countdown banner. The actual `startRound` fires when the countdown driver tick sees the elapsed timer. Idempotent under double-click; rejects with `Only the host can start the game` for non-hosts. |

#### Server -> Client

| Event | Payload | Description |
|-------|---------|-------------|
| `room:player_joined` | `{ player }` | A player joined. `player` is the new `MultiplayerPlayer` object. |
| `room:player_left` | `{ playerId }` | A player left the room |
| `room:player_reconnected` | `{ playerId }` | A disconnected player reconnected |
| `room:host_changed` | `{ newHostId }` | Host role transferred (previous host left) |
| `room:player_kicked` | `{ playerId }` | A player was kicked by the host |
| `room:settings_updated` | `{ gameMode, categories, totalRounds, hasPassword, isPublic? }` | Room settings changed. `categories` is `string[] | null`. `isPublic` is included on every broadcast so all clients in the room see public-toggle changes; older clients ignore the field. |
| `room:bots_updated` | `{ botCount, botDifficulty, players[] }` | Bot configuration changed (includes updated player list with bots) |
| `room:player_ready` | `{ playerId }` | A player marked themselves as ready |
| `room:updated` | `MultiplayerRoom` | General room state update (bare object, not wrapped) |

### Gameplay

#### Client -> Server

| Event | Payload | Description |
|-------|---------|-------------|
| `game:submit_guess` | `{ guessData }` | Submit a guess for the current round. `guessData` shape varies by mode — see "guessData shape per mode" below. |
| `game:submit_bid` | `{ bidCents: number }` | Submit a bid in bidding mode (only valid during your turn). Room derived from socket meta. |
| `game:continue` | `{}` | Signal readiness for the next round |
| `room:play_again` | `{}` | Restart the game (returns to lobby) |

#### Server -> Client

| Event | Payload | Description |
|-------|---------|-------------|
| `game:round_start` | `RoundStartPayload` | New round started. Fields: `roundNumber`, `gameMode`, `timerSeconds`, `product?`, `products?`, `referencePrice?`, `question?`, `prices?`, `maxPriceCents?`, `speedPattern?`, `durationMs?`, `budgetCents?` |
| `game:round_end` | `RoundResultsPayload` | Round ended. Fields: `roundNumber`, `gameMode`, `revealData` (mode-specific answers), `playerResults[]`, `standings[]` |
| `game:bidding_turn` | `{ currentPlayerId, turnIndex, totalPlayers, timerSeconds, previousBids[] }` | Whose turn it is to bid (bidding mode only) |
| `game:bid_placed` | `{ playerId, displayName, avatar, bidCents, turnIndex }` | A bid was placed (broadcast to all players in bidding mode) |
| `game:player_locked` | `{ playerId }` | A player submitted their guess (shown as "locked in") |
| `game:player_continued` | `{ playerId }` | A player is ready for the next round |
| `game:over` | `{ results, roomCode }` | Game finished. `results` is `RoundResultsPayload` (same shape as `game:round_end`). |

### Push Notifications

#### Server -> Client

| Event | Payload | Description |
|-------|---------|-------------|
| `notification:received` | `{ type, title, body, url?, icon? }` | In-app notification toast. Emitted to `user:<userId>` room when a push notification is delivered. `type` is one of: `daily_puzzle`, `streak_reminder`, `leaderboard_updates`, `leaderboard_placement`, `multiplayer_invites`, `promotional` (the `NOTIFICATION_TYPES` enum in `packages/shared/src/constants.ts`). |

### Streamer Bot Relay

Server-only emit — driven by `POST /api/streamer/stats` (see `docs/API_REFERENCE.md` § "Streamer Bot Relay"). The broadcast page subscribes via `useStreamerStatsRelay` and dispatches the payload into the overlay bus as a `stats.update` event.

#### Server -> Client

| Event | Payload | Description |
|-------|---------|-------------|
| `streamer:stats` | `{ wins, losses, streak, mood?, winRate? }` | Latest BotCard stats from the 24/7 streamer-bot. Emitted to every connected socket whenever the bot pushes a new payload. Replaces the earlier same-window `window.postMessage` design which only reached the bot's own Chromium tab. |
| `streamer:music` | `{ title, artist?, album? }` or `null` | Latest "now playing" track from the bot's mpd music source. `null` payload means the queue stopped (operator cleared the playlist or mpd died). Emitted to every connected socket. The broadcast page's `useStreamerMusicRelay` hook bridges this into the overlay bus's `music.now` slot so the MusicTicker panel renders identically regardless of transport. |
| `streamer:nn-tick` | `VisualTick` (see below) | Per-round NN visualisation snapshot from the streamer-bot's online-learning subsystem (see `docs/STREAMER.md` § "Online learning subsystem"). Emitted whenever the bot POSTs `/api/streamer/nn-tick`, typically once per round after the result lands. The broadcast page's `useStreamerNNRelay` hook bridges this into the overlay bus's `nn.tick` slot, where the three brain-rail panels (NeuralNet, ConfidenceGauge, RecentAccuracy) plus the bottom-right NeuralDebugHud render against it. The optional `health` block on the tick (training loss, grad-norm p95, effective LR, warmup progress, replay-buffer fill, golden MAE, snapshot age, teaching-moments count, NaN-rollback / frozen state) feeds the debug HUD; when missing or malformed the HUD reads "n/a". The server also persists the latest payload in memory so a freshly-loaded page hydrates from `GET /api/streamer/nn-tick` instead of waiting for the next round. |

#### `VisualTick` payload schema

```ts
{
  roundId: string;
  phase: "idle" | "thinking" | "guessing" | "reveal" | "result";
  network: {
    layers: Array<{ name: string; activations: number[]; mostActiveIdx: number; mostActiveTrail: [number, number] }>;
    weightSamples: Array<{ fromLayer: number; fromIdx: number; toLayer: number; toIdx: number; weight: number }>;
    heroPath?: Array<{ layer: number; idx: number }>;  // present in `reveal` phase
  };
  prediction: { cents: number; sigma: number };
  priceCandidates?: Array<{ cents: number; prob: number }>;  // top-K canonical-price softmax entries; optional (present once the model emits a price-candidate distribution)
  belief: {
    topFeatures: Array<{ name: string; contribution: number }>;
    sentence?: string;  // worker-rendered plain-language belief copy (still emitted for log/debug; no longer rendered)
  };
  embedding2d: { x: number; y: number };
  recentLosses: number[];                                 // last ≤50, capped at 60 server-side
  recentAccuracy: Array<"within10" | "within25" | "miss">;  // last ≤10, ONE entry per round, mapped from the game outcome (correct→within10, partial→within25, incorrect→miss) — see workerCore.outcomeToBucket. Capped at 16 server-side.
  teachingMoment: { triggered: boolean; productTitle?: string };
  // Optional training/health snapshot — feeds NeuralDebugHud's "training" column.
  // Validator drops the whole block on any non-finite required field.
  health?: {
    round: number;
    loss: number | null;          // last training loss; null when no update has run
    gradNormP95: number;
    learningRate: number;          // effective LR with linear warmup
    warmupStep: number;
    warmupTotal: number;
    bufferSize: number;
    bufferCapacity: number;
    batchSize: number;
    stepsPerRound: number;
    goldenMAE: number | null;      // null until first golden eval lands
    snapshotAgeMs: number;          // ms since worker last successfully wrote a snapshot
    teachingMomentsCount: number;
    nanRollbacks: number;
    frozen: boolean;                // true when NaN-storm guard has frozen the network
  };
  ageMs: number;
}
```

The `parseNnTickPayload` helper in `apps/server/src/routes/streamer.ts` validates incoming payloads field-by-field, drops malformed entries, and clips oversized arrays to per-field caps before fan-out — defence-in-depth for the Socket.IO emit path.

### Lobby Invite Rewards

Server-only emits — the client never sends these. See [MULTIPLAYER_INVITES.md](MULTIPLAYER_INVITES.md) for the full reward design.

#### Server -> Client

| Event | Payload | Description |
|-------|---------|-------------|
| `invite:reward_earned` | `InviteRewardEarnedEvent` | Fired to the **inviter's** socket when their attributed joiner completes the trigger round (default: 3 rounds with non-default guesses). Payload includes `multiplier`, `matchesRemaining`, and `joinerDisplayName`. |
| `invite:welcome_bonus` | `InviteWelcomeBonusEvent` | Fired to the **joiner's** socket alongside `invite:reward_earned`. Smaller buff (+10% × 1 match) for the joiner's next match. |
| `invite:buff_consumed` | `InviteBuffConsumedEvent` | Fired at match end when a pending buff is applied to a player's score. Includes `rawScore`, `finalScore`, `multiplier`, and `matchesRemaining` so clients can show "Base 1,200 × 1.25 = 1,500" framing on the results screen. |

### `guessData` shape per mode

`game:submit_guess` carries a `guessData` field whose shape depends on the round's `gameMode`. The canonical wire types live in [`packages/shared/src/types.ts`](../packages/shared/src/types.ts) (the `GuessData` union) and the per-mode scoring functions in [`packages/shared/src/scoring.ts`](../packages/shared/src/scoring.ts); the table below is a quick reference.

| Mode | `guessData` shape | Notes |
|---|---|---|
| `classic` | `{ guessedPriceCents: number }` | User's price guess in cents. |
| `higher-lower` | `{ guess: "higher" \| "lower" }` | Comparison vs. reference price. |
| `comparison` | `{ guessedProductId: number }` | Product id of the more expensive product. |
| `closest-without-going-over` | `{ guessedPriceCents: number }` | Bid; over-bids score 0. |
| `price-match` | `{ assignments: Record<string, number> }` | Maps each product id to a guessed price in cents. |
| `bidding` | `{ bidCents: number }` | Multiplayer bidding is turn-based and uses the dedicated `game:submit_bid` event. The scorer (`scoreGuessForMode`) also accepts `{ guessedPriceCents: number }` as a fallback for single-product UIs that reuse the price-entry component. |
| `riser` | `{ stoppedPriceCents: number }` | Price at which the rising bar was stopped. |
| `odd-one-out` | `{ guessedProductId: number }` | Product id of the outlier product. |
| `market-basket` | `{ guessedTotalCents: number }` | Estimated total cost of all products in the basket. |
| `sort-it-out` | `{ submittedOrder: number[] }` | Product ids ordered low → high. |
| `budget-builder` | `{ selectedProductIds: number[] }` | Product ids selected to fit within the given budget. |
| `chain-reaction` | `{ chainGuesses: ("more" \| "less")[] }` | One "more"/"less" guess per link in the chain. Use `scoreChainSubGuess` per link, `scoreChainReaction` for the aggregate. |

For the actual TypeScript discriminated union of `GuessData`, see [`packages/shared/src/types.ts`](../packages/shared/src/types.ts).

## Reconnection lifecycle

Socket.IO's built-in client reconnection is augmented with two mechanisms to survive mobile-browser backgrounding, where the OS aggressively freezes tabs and silently kills WebSocket connections.

### Server-side 15 s disconnect grace period

When a socket drops, the server does **not** immediately flip the player's `connected` flag or broadcast `room:player_left`. Both actions are deferred by `MP_DISCONNECT_GRACE_MS` (default 15 s, configurable via the test-only `setDisconnectGraceMs()` export in `apps/server/src/socket/socketState.ts`). If a new socket arrives with a valid `playerToken` inside the window, the pending timer is cancelled and the rest of the room never sees a leave — a transient mobile background is invisible to other players. `room:player_reconnected` is skipped for sub-grace rejoins for the same reason. Tests exercise this via `createTestServer(50, { disconnectGraceMs: 500 })`.

### `connectionStateRecovery`

Socket.IO's built-in packet buffering is enabled with `maxDisconnectionDuration: 2 * 60 * 1000` (see `apps/server/src/index.ts`). This replays events the server emitted while the socket was disconnected — a cheap belt-and-suspenders layer on top of the `ROOM_REJOIN` full-state snapshot. The adapter is in-memory; moving to a horizontally-scaled deployment would require a compatible adapter (Redis Streams, MongoDB ≥ 0.3, etc.).

### Rejoin error codes

Failed `room:rejoin` acks include a typed `code` so the client can render specific, user-facing messages instead of silently navigating away. Codes are defined by `RejoinErrorCode` in `packages/shared/src/constants.ts`:

| Code | Meaning | Client behavior |
|---|---|---|
| `room_expired` | Room no longer exists | Clear saved session; show "Game ended" with a [Back to home] button. |
| `kicked` | Player's `is_kicked` flag is set | Clear saved session; "You were removed from this room". |
| `invalid_token` | Token doesn't match any player in that room | Clear saved session; "Session expired". |
| `unknown` | Unexpected server error | Keep session; offer [Try again]. |

There is deliberately no `room_full` code — a disconnected player's `mp_players` row persists, so their slot can't be taken by someone else while they're away.

Timeout (no ack in 8 s) is surfaced client-side as a `"timeout"` reason with a [Try again] button.

## Rate Limiting

Socket events are rate-limited per connection. Clients that exceed the rate limit are automatically disconnected.

## Room Lifecycle

```
room:create -> lobby
  -> room:join (other players)
  -> room:settings (host configures)
  -> room:bot_config (host adds bots, optional)
  -> room:ready (each human player)
  -> room:start_round (host starts, or auto-start when all humans ready)
    -> game:round_start (all players)
    -> game:submit_guess (each player)        # standard modes
    -> game:player_locked (broadcast)
    -> timer expires OR all players guessed
    -> game:round_end (all players)
    -> game:continue (each player)
    -> [repeat for remaining rounds]
  -> game:over (all players)
  -> room:play_again -> back to lobby
```

### Bidding Mode Lifecycle

```
room:start_round (host starts)
  -> game:round_start (all players, includes product)
  -> game:bidding_turn (1st player notified)
    -> game:submit_bid (player bids) OR timeout (auto-bid $0.01)
    -> game:bid_placed (broadcast)
    -> game:bidding_turn (next player)
    -> [repeat until all players have bid]
  -> game:round_end (comparative scoring, all bids revealed)
  -> game:continue (each player)
  -> [repeat for remaining rounds]
```

**Source**: `packages/shared/src/constants.ts`, `packages/shared/src/types.ts` (payload types), `apps/server/src/socket/*.ts`, `apps/web/src/hooks/useMultiplayerSocket.ts`
