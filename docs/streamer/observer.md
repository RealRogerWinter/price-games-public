---
title: Streamer — Observer
status: stable
last_reviewed: 2026-06-03
owner: streamer
audience: contributor
category: streamer
summary: What the bot sees: state snapshots and auto-binding myPlayerId.
related_code:
  - packages/bot-streamer/src/observer
---
# Streamer Bot — Observer

> The "eyes" of the bot. Subscribes to game-server socket events and folds them into a typed state snapshot that strategies and the lifecycle controller read. For the surrounding loop, see [`architecture.md`](./architecture.md).

## What it does

The observer ([`src/observer/observer.ts`](../../packages/bot-streamer/src/observer/observer.ts)) wraps a Socket.IO-like client (or a `fakeSocket` in tests) and:

1. **Listens** for `ROOM_UPDATED`, `GAME_ROUND_START`, `GAME_ROUND_END`, `GAME_OVER`, `BIDDING_TURN`, `PLAYER_LOCKED`, etc.
2. **Folds** each event into a `BotStateSnapshot` (next section).
3. **Notifies** subscribers via `onChange(listener)`.
4. **Auto-binds `myPlayerId`** when a `ROOM_UPDATED` includes a player matching the configured persona name.

The observer is deliberately decoupled from `socket.io-client` — `SocketLike` is the minimum contract it needs:

```typescript
interface SocketLike {
  on(event: string, handler: (payload: unknown) => void): void;
  off(event: string, handler: (payload: unknown) => void): void;
}
```

Real sockets, `fakeSocket`, and plain `EventEmitter` all satisfy it via a thin adapter.

## The snapshot

[`src/observer/types.ts`](../../packages/bot-streamer/src/observer/types.ts):

```typescript
interface BotStateSnapshot {
  phase: BotPhase;                   // disconnected | in_lobby | in_round | between_rounds | game_over
  myPlayerId: string | null;         // assigned on room join
  room: RoomSnapshot | null;         // null when unhosted
  round: RoundSnapshot | null;       // null between rounds
  bidding: BiddingSnapshot | null;   // bidding mode only
  lastResult: LastResultSnapshot | null;
}
```

- `RoomSnapshot` carries the room code, host, players list, current mode, total + current round, status.
- `RoundSnapshot` is the raw `RoundStartPayload` plus `receivedAt` and a `submitted` flag the runner flips when the bot emits `game:submit_guess`.
- `BiddingSnapshot` is set only on bidding rounds — `turn` is the latest `BiddingTurnPayload` with `turnIdx`, `totalPlayers`, `previousBids`, etc.
- `LastResultSnapshot` holds the most recent `RoundResultsPayload` so post-round analytics (mood updates, strategy NN updates) can run.

The shape mirrors the wire protocol (no reshaping) so strategies can read the raw fields they were already designed against in [`packages/shared/src/types.ts`](../../packages/shared/src/types.ts).

## Phase transitions

```
disconnected
     │  (socket connects)
     ▼
in_lobby ──┐
     │     │  (game:round_start)
     ▼     │
  in_round │
     │     │  (game:round_end)
     ▼     │
between_rounds ──┐
     │           │
     │  (next round)│  (game:over)
     └────►       ▼
             game_over
                 │  (host plays again → ROOM_PLAY_AGAIN)
                 ▼
              in_lobby
```

Strategies use `phase` defensively — `candidates()` is only meaningful when `phase === "in_round"` and `round` is non-null.

## Auto-binding `myPlayerId`

The single most important field in the snapshot. Without it:

- The bidding seat-matching wait burns a full 90s on every round before timing out to the latest turn payload (usually turn 0).
- Win attribution (whether the bot won the multiplayer game) silently degrades.
- `onPlayerLocked` callbacks that gate on "is it me?" never fire.

The observer auto-binds when:

- `personaName` was passed at construction time (the runner sets this from `STREAMER_BOT_DISPLAY_NAME`), and
- A `ROOM_UPDATED` arrives whose `players` list contains an entry with `displayName === personaName`.

Once bound, the binding is **sticky** — a subsequent `ROOM_UPDATED` with another player named the same can't rebind. Defends against a real-MP join where two players happened to enter the same name.

The PR #337 fix that landed in this area was about a regression where the binding was clearing too eagerly; the test coverage in [`packages/bot-streamer/tests/observer.test.ts`](../../packages/bot-streamer/tests/observer.test.ts) now pins the sticky behavior.

## Reading state

```typescript
const observer = attachObserver(socket, { personaName: "Pricey", onChange: snapshot => ... });

// One-shot read
const state = observer.getState();

// Subscribe (returns unsubscribe)
const off = observer.onChange(snapshot => {
  if (snapshot.phase === "in_round" && snapshot.round && !snapshot.round.submitted) {
    // bot needs to make a decision
  }
});

// Cleanup
off();
observer.detach();
```

The runner subscribes once at boot, runs the strategy/enact pipeline from `onChange`, and detaches at shutdown.

## Strategy context derivation

The runner doesn't pass the whole snapshot into strategies — it derives a narrower `StrategyContext`:

```typescript
const ctx: StrategyContext = {
  rng: Math.random,
  nnPrediction: await learningBridge.predict(...),
  thompsonDraw,
  exploration,
  turn: snapshot.bidding?.turn,
  opponentPosteriors: opponentTracker?.snapshot(),
  competitiveness: 0.7,
};
```

Keeping the snapshot and the context separate lets strategies stay pure and lets the runner control timing (e.g. enforce the 150ms NN predict budget) before the strategy fires.

## Testing

The observer is the most-tested module in the bot. Patterns at [`packages/bot-streamer/tests/observer.test.ts`](../../packages/bot-streamer/tests/observer.test.ts):

- `fakeSocket` from [`src/test-helpers/`](../../packages/bot-streamer/src/test-helpers/) — programmatically emit events synchronously, inspect listener calls.
- Inject `now` for deterministic `receivedAt` timestamps.
- Assert that `myPlayerId` binds on the first matching `ROOM_UPDATED` and doesn't rebind on subsequent ones.
- Assert that `phase` advances on `GAME_ROUND_START` / `GAME_ROUND_END` / `GAME_OVER` boundaries.
- Assert that `bidding.turn` is set only on `BIDDING_TURN` events and cleared after the round.

A typical test:

```typescript
import { attachObserver } from "../src/observer/observer";
import { fakeSocket } from "../src/test-helpers/fakeSocket";
import { mockRoomUpdated, mockRoundStart } from "../src/test-helpers/fixtures";

const socket = fakeSocket();
const observer = attachObserver(socket, { personaName: "Pricey" });

socket.emit("room:updated", mockRoomUpdated({ players: [{ playerId: "p1", displayName: "Pricey" }] }));
expect(observer.getState().myPlayerId).toBe("p1");

socket.emit("game:round_start", mockRoundStart("classic"));
expect(observer.getState().phase).toBe("in_round");
```

## Defensive folding

The observer treats incoming payloads as `unknown` and narrows them inside its handlers (the local `RoomPlayerJoinedPayload`, `PlayerLockedPayload`, `GameOverPayload` interfaces are intentional subsets of the wire shapes). The server sometimes emits more fields than the bot needs; the observer ignores them rather than failing schema validation. If a critical field is missing, the snapshot's affected field stays at its previous value rather than being clobbered with `undefined`.
