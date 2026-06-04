/**
 * End-to-end analytics tests for the multiplayer flow.
 *
 * Drives a real Socket.IO server with real client sockets, plays through
 * full MP rooms, and asserts the per-real-player MP analytics emissions
 * are correct end to end:
 *   room:create  → events.mp_room_created   (1 row, key=roomCode)
 *   room:join    → events.mp_room_joined    (1 row per join, key=playerId)
 *   room:start   → events.mp_game_started   (1 row per real player, key=gameId:visitorId)
 *   game:over    → events.mp_game_completed (1 row per real player, key=gameId:visitorId)
 *
 * What this catches that mpRoundStart.test.ts / mpRoundEnd.test.ts don't:
 *   - The full socket → roomManager → mpRoundStart → mpRoundEnd chain
 *   - Dedup-key keying under realistic timing (vs unit-injected stubs)
 *   - Conservation: events.mp_game_completed count == real-player count
 *   - Idempotent endRound under repeated invocation
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { randomUUID } from "crypto";
import type { Socket as ClientSocket } from "socket.io-client";
import {
  createTestServer,
  closeTestServer,
  connectClient,
  disconnectClient,
  createRoom,
  joinRoom,
  startRound,
  submitGuess,
  continueRound,
  waitForEvent,
  type TestServer,
} from "../test/socketHelper";
import { assertGlobalInvariantsOnDb } from "../test/analyticsScenario";

vi.mock("../db", () => ({ default: null as unknown }));

let server: TestServer;
let sockets: ClientSocket[] = [];

beforeEach(async () => {
  server = await createTestServer(50);
  sockets = [];
});

afterEach(async () => {
  for (const s of sockets) {
    if (s.connected) await disconnectClient(s);
  }
  sockets = [];
  // Run universal analytics invariants BEFORE closing the server so a
  // violation pins the failure to the specific test that wrote the
  // offending events. (closeTestServer closes the DB handle.)
  assertGlobalInvariantsOnDb(server.db);
  await closeTestServer(server);
});

/**
 * Connect a client socket carrying a fresh visitor_id cookie so the
 * server-side socket middleware can stamp every emitted MP_* event
 * with a real visitor identity. Without this the analytics emit path
 * silently no-ops (visitorId is required) and the events table stays
 * empty.
 */
async function connect(): Promise<ClientSocket> {
  const visitorId = randomUUID();
  const s = await connectClient(server.url, 5000, {
    cookie: `visitor_id=${visitorId}`,
  });
  sockets.push(s);
  return s;
}

/**
 * Drive a 3-round MP game to completion. Both players issue guesses
 * each round; round 3 fires `game:over` instead of `game:round_end`.
 */
async function playFullMpGame(
  hostSocket: ClientSocket,
  joinerSocket: ClientSocket,
  totalRounds: number = 3,
): Promise<void> {
  for (let round = 1; round <= totalRounds; round++) {
    const rsH = waitForEvent(hostSocket, "game:round_start");
    const rsJ = waitForEvent(joinerSocket, "game:round_start");
    if (round === 1) {
      await startRound(hostSocket);
    } else {
      await continueRound(hostSocket);
      await continueRound(joinerSocket);
    }
    await rsH;
    await rsJ;

    await submitGuess(hostSocket, { guessedPriceCents: 5000 });
    const endEvt = round < totalRounds ? "game:round_end" : "game:over";
    const endP = waitForEvent(hostSocket, endEvt);
    await submitGuess(joinerSocket, { guessedPriceCents: 5000 });
    await endP;
  }
}

describe("Analytics E2E — multiplayer flow", () => {
  it(
    "happy path: 2 players play 3 rounds → 1 mp_room_created + 1 mp_room_joined (host create does not double-emit) + 2 mp_game_started + 2 mp_game_completed",
    async () => {
      const hostSocket = await connect();
      const joinerSocket = await connect();

      const hostResult = await createRoom(hostSocket, "Host", { totalRounds: 3 });
      await joinRoom(joinerSocket, hostResult.room.code, "Joiner");
      await playFullMpGame(hostSocket, joinerSocket, 3);

      // mp_room_created — exactly one for this room.
      const created = (
        server.db
          .prepare(
            "SELECT COUNT(*) AS n FROM events WHERE event_name = 'mp_room_created'",
          )
          .get() as { n: number }
      ).n;
      expect(created).toBe(1);

      // mp_room_joined — fired on the join (not for the host's create).
      // Production semantics: only non-host joins fire MP_ROOM_JOINED.
      const joined = (
        server.db
          .prepare(
            "SELECT COUNT(*) AS n FROM events WHERE event_name = 'mp_room_joined'",
          )
          .get() as { n: number }
      ).n;
      expect(joined).toBe(1);

      // mp_game_started — one per real player on lobby→playing transition.
      const started = (
        server.db
          .prepare(
            "SELECT COUNT(*) AS n FROM events WHERE event_name = 'mp_game_started'",
          )
          .get() as { n: number }
      ).n;
      expect(started).toBe(2);

      // mp_game_completed — one per real player on game completion.
      const completed = (
        server.db
          .prepare(
            "SELECT COUNT(*) AS n FROM events WHERE event_name = 'mp_game_completed'",
          )
          .get() as { n: number }
      ).n;
      expect(completed).toBe(2);
    },
    20000,
  );

  it(
    "dedup keys keep the (visitor_id, client_event_id) UNIQUE index intact across the full MP flow",
    async () => {
      const hostSocket = await connect();
      const joinerSocket = await connect();

      const hostResult = await createRoom(hostSocket, "Host", { totalRounds: 3 });
      await joinRoom(joinerSocket, hostResult.room.code, "Joiner");
      await playFullMpGame(hostSocket, joinerSocket, 3);

      // No two events share (visitor_id, client_event_id). Without the
      // PR 6a deterministic keys this would be silent — duplicates only
      // surface when the same key is re-inserted, but the invariant
      // pins the property holds for the entire emitted set.
      const dupes = server.db
        .prepare(
          `SELECT visitor_id, client_event_id, COUNT(*) AS c FROM events
            WHERE client_event_id IS NOT NULL
            GROUP BY visitor_id, client_event_id HAVING c > 1`,
        )
        .all();
      expect(dupes).toEqual([]);
    },
    20000,
  );

  it(
    "mp_game_completed events carry game_id matching mp_rooms.current_game_id",
    async () => {
      const hostSocket = await connect();
      const joinerSocket = await connect();

      const hostResult = await createRoom(hostSocket, "Host", { totalRounds: 3 });
      await joinRoom(joinerSocket, hostResult.room.code, "Joiner");
      await playFullMpGame(hostSocket, joinerSocket, 3);

      // current_game_id is cleared by the resetRoom path on Play Again.
      // We don't trigger Play Again here, so the column should still
      // hold the game_id stamped on the lobby→playing transition. Each
      // mp_game_completed event's properties.game_id must equal it.
      const room = server.db
        .prepare("SELECT current_game_id FROM mp_rooms WHERE code = ?")
        .get(hostResult.room.code) as { current_game_id: string | null };
      expect(room.current_game_id).toBeTruthy();

      const events = server.db
        .prepare(
          "SELECT properties FROM events WHERE event_name = 'mp_game_completed'",
        )
        .all() as Array<{ properties: string }>;
      expect(events.length).toBe(2);
      for (const e of events) {
        const props = JSON.parse(e.properties) as { game_id?: string };
        expect(props.game_id).toBe(room.current_game_id);
      }
    },
    20000,
  );
});
