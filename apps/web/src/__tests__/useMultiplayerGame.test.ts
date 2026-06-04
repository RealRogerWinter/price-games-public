import { describe, it, expect } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useMultiplayerGame } from "../hooks/useMultiplayerGame";
import {
  makePlayer,
  makeRoom,
  makeRoundStartPayload,
  makeRoundResultsPayload,
} from "./testUtils";

describe("useMultiplayerGame", () => {
  function renderMPHook() {
    return renderHook(() => useMultiplayerGame());
  }

  describe("initial state", () => {
    it("starts on join screen with no room or player", () => {
      const { result } = renderMPHook();
      expect(result.current.state.screen).toBe("join");
      expect(result.current.state.room).toBeNull();
      expect(result.current.state.playerId).toBeNull();
      expect(result.current.state.error).toBeNull();
      expect(result.current.state.loading).toBe(false);
    });
  });

  describe("basic setters", () => {
    it("setScreen changes screen", () => {
      const { result } = renderMPHook();
      act(() => result.current.handlers.setScreen("lobby"));
      expect(result.current.state.screen).toBe("lobby");
    });

    it("setPlayerId updates playerId and getPlayerId", () => {
      const { result } = renderMPHook();
      act(() => result.current.handlers.setPlayerId("p-42"));
      expect(result.current.state.playerId).toBe("p-42");
      expect(result.current.handlers.getPlayerId()).toBe("p-42");
    });

    it("setError updates error", () => {
      const { result } = renderMPHook();
      act(() => result.current.handlers.setError("Something went wrong"));
      expect(result.current.state.error).toBe("Something went wrong");
    });

    it("setLoading updates loading", () => {
      const { result } = renderMPHook();
      act(() => result.current.handlers.setLoading(true));
      expect(result.current.state.loading).toBe(true);
    });
  });

  describe("handlePlayerJoined", () => {
    it("adds a new player to the room", () => {
      const { result } = renderMPHook();
      act(() => result.current.handlers.setRoom(makeRoom()));

      const newPlayer = makePlayer({ id: "player-2", displayName: "Bob" });
      act(() => result.current.handlers.handlePlayerJoined(newPlayer));

      expect(result.current.state.room!.players).toHaveLength(2);
      expect(result.current.state.room!.players[1].displayName).toBe("Bob");
    });

    it("replaces an existing player with same id", () => {
      const { result } = renderMPHook();
      act(() =>
        result.current.handlers.setRoom(
          makeRoom({
            players: [
              makePlayer({ id: "player-1", displayName: "Alice" }),
              makePlayer({ id: "player-2", displayName: "Bob" }),
            ],
          })
        )
      );

      const updatedPlayer = makePlayer({ id: "player-2", displayName: "Robert" });
      act(() => result.current.handlers.handlePlayerJoined(updatedPlayer));

      expect(result.current.state.room!.players).toHaveLength(2);
      expect(result.current.state.room!.players[1].displayName).toBe("Robert");
    });
  });

  describe("handlePlayerLeft", () => {
    it("marks the player as disconnected", () => {
      const { result } = renderMPHook();
      act(() =>
        result.current.handlers.setRoom(
          makeRoom({
            players: [
              makePlayer({ id: "player-1" }),
              makePlayer({ id: "player-2", isConnected: true }),
            ],
          })
        )
      );

      act(() => result.current.handlers.handlePlayerLeft("player-2"));

      const p2 = result.current.state.room!.players.find((p) => p.id === "player-2");
      expect(p2!.isConnected).toBe(false);
    });
  });

  describe("handlePlayerReconnected", () => {
    it("marks the player as connected", () => {
      const { result } = renderMPHook();
      act(() =>
        result.current.handlers.setRoom(
          makeRoom({
            players: [makePlayer({ id: "player-1", isConnected: false })],
          })
        )
      );

      act(() => result.current.handlers.handlePlayerReconnected("player-1"));

      expect(result.current.state.room!.players[0].isConnected).toBe(true);
    });
  });

  describe("handlePlayerKicked", () => {
    it("removes the player from the room", () => {
      const { result } = renderMPHook();
      act(() =>
        result.current.handlers.setRoom(
          makeRoom({
            players: [
              makePlayer({ id: "player-1" }),
              makePlayer({ id: "player-2" }),
            ],
          })
        )
      );

      act(() => result.current.handlers.handlePlayerKicked("player-2"));

      expect(result.current.state.room!.players).toHaveLength(1);
      expect(result.current.state.room!.players[0].id).toBe("player-1");
    });
  });

  describe("handleHostChanged", () => {
    it("updates hostPlayerId and player isHost flags", () => {
      const { result } = renderMPHook();
      act(() =>
        result.current.handlers.setRoom(
          makeRoom({
            hostPlayerId: "player-1",
            players: [
              makePlayer({ id: "player-1", isHost: true }),
              makePlayer({ id: "player-2", isHost: false }),
            ],
          })
        )
      );

      act(() => result.current.handlers.handleHostChanged("player-2"));

      expect(result.current.state.room!.hostPlayerId).toBe("player-2");
      expect(result.current.state.room!.players[0].isHost).toBe(false);
      expect(result.current.state.room!.players[1].isHost).toBe(true);
    });
  });

  describe("handleSettingsUpdated", () => {
    it("updates room settings", () => {
      const { result } = renderMPHook();
      act(() => result.current.handlers.setRoom(makeRoom()));

      act(() =>
        result.current.handlers.handleSettingsUpdated({
          gameMode: "higher-lower",
          categories: ["Electronics"],
          totalRounds: 5,
          hasPassword: true,
        })
      );

      expect(result.current.state.room!.gameMode).toBe("higher-lower");
      expect(result.current.state.room!.categories).toEqual(["Electronics"]);
      expect(result.current.state.room!.totalRounds).toBe(5);
      expect(result.current.state.room!.hasPassword).toBe(true);
    });
  });

  describe("handleRoomUpdated", () => {
    it("replaces the entire room state", () => {
      const { result } = renderMPHook();
      act(() => result.current.handlers.setRoom(makeRoom()));

      const newRoom = makeRoom({ code: "WXYZ", totalRounds: 20 });
      act(() => result.current.handlers.handleRoomUpdated(newRoom));

      expect(result.current.state.room!.code).toBe("WXYZ");
      expect(result.current.state.room!.totalRounds).toBe(20);
    });

    it("resets to lobby screen when room status is lobby", () => {
      const { result } = renderMPHook();
      act(() => result.current.handlers.setScreen("playing"));
      act(() => result.current.handlers.setRoom(makeRoom({ status: "playing" })));

      act(() =>
        result.current.handlers.handleRoomUpdated(makeRoom({ status: "lobby" }))
      );

      expect(result.current.state.screen).toBe("lobby");
      expect(result.current.state.isGameOver).toBe(false);
    });
  });

  describe("handleRoundStart", () => {
    it("transitions to playing screen with round data", () => {
      const { result } = renderMPHook();
      act(() => result.current.handlers.setRoom(makeRoom()));

      const payload = makeRoundStartPayload({ roundNumber: 1 });
      act(() => result.current.handlers.handleRoundStart(payload));

      expect(result.current.state.screen).toBe("playing");
      expect(result.current.state.roundData).toEqual(payload);
      expect(result.current.state.hasGuessed).toBe(false);
      expect(result.current.state.lockedPlayerIds.size).toBe(0);
      expect(result.current.state.room!.status).toBe("playing");
      expect(result.current.state.room!.currentRound).toBe(1);
    });

    it("resets continued state for new round", () => {
      const { result } = renderMPHook();
      act(() => result.current.handlers.setRoom(makeRoom()));
      act(() => result.current.handlers.setHasContinued(true));

      act(() => result.current.handlers.handleRoundStart(makeRoundStartPayload()));

      expect(result.current.state.hasContinued).toBe(false);
      expect(result.current.state.continuedPlayerIds.size).toBe(0);
    });
  });

  describe("handlePlayerLocked", () => {
    it("adds player to locked set", () => {
      const { result } = renderMPHook();
      act(() => result.current.handlers.handlePlayerLocked("player-1"));
      expect(result.current.state.lockedPlayerIds.has("player-1")).toBe(true);

      act(() => result.current.handlers.handlePlayerLocked("player-2"));
      expect(result.current.state.lockedPlayerIds.size).toBe(2);
    });
  });

  describe("handlePlayerContinued", () => {
    it("adds player to continued set", () => {
      const { result } = renderMPHook();
      act(() => result.current.handlers.handlePlayerContinued("player-1"));
      expect(result.current.state.continuedPlayerIds.has("player-1")).toBe(true);
    });
  });

  describe("handleRoundEnd", () => {
    it("transitions to round_result screen", () => {
      const { result } = renderMPHook();
      act(() =>
        result.current.handlers.setRoom(
          makeRoom({
            status: "playing",
            players: [makePlayer({ id: "player-1", totalScore: 0 })],
          })
        )
      );

      const results = makeRoundResultsPayload();
      act(() => result.current.handlers.handleRoundEnd(results));

      expect(result.current.state.screen).toBe("round_result");
      expect(result.current.state.roundResults).toEqual(results);
      expect(result.current.state.allRoundResults).toHaveLength(1);
      expect(result.current.state.room!.status).toBe("between_rounds");
    });

    it("updates player scores from standings", () => {
      const { result } = renderMPHook();
      act(() =>
        result.current.handlers.setRoom(
          makeRoom({
            players: [makePlayer({ id: "player-1", totalScore: 0 })],
          })
        )
      );

      const results = makeRoundResultsPayload({
        standings: [
          { playerId: "player-1", displayName: "Alice", avatar: "wizard" as const, totalScore: 500 },
        ],
      });
      act(() => result.current.handlers.handleRoundEnd(results));

      expect(result.current.state.room!.players[0].totalScore).toBe(500);
    });
  });

  describe("handleGameOver", () => {
    it("sets isGameOver and room status to finished", () => {
      const { result } = renderMPHook();
      act(() =>
        result.current.handlers.setRoom(
          makeRoom({
            players: [makePlayer({ id: "player-1" })],
          })
        )
      );

      const results = makeRoundResultsPayload();
      act(() => result.current.handlers.handleGameOver(results));

      expect(result.current.state.isGameOver).toBe(true);
      expect(result.current.state.screen).toBe("round_result");
      expect(result.current.state.room!.status).toBe("finished");
      expect(result.current.state.allRoundResults).toHaveLength(1);
    });
  });

  describe("handleContinueFromResults", () => {
    it("sets hasContinued and returns shouldEmitContinue when not game over", () => {
      const { result } = renderMPHook();

      let response: { shouldEmitContinue: boolean };
      act(() => {
        response = result.current.handlers.handleContinueFromResults();
      });

      expect(response!.shouldEmitContinue).toBe(true);
      expect(result.current.state.hasContinued).toBe(true);
    });

    it("transitions to game_over screen when game is over", () => {
      const { result } = renderMPHook();
      act(() =>
        result.current.handlers.setRoom(
          makeRoom({ players: [makePlayer({ id: "player-1" })] })
        )
      );

      // Trigger game over
      act(() => result.current.handlers.handleGameOver(makeRoundResultsPayload()));

      let response: { shouldEmitContinue: boolean };
      act(() => {
        response = result.current.handlers.handleContinueFromResults();
      });

      expect(response!.shouldEmitContinue).toBe(false);
      expect(result.current.state.screen).toBe("game_over");
    });
  });

  describe("handlePlayAgainLocal", () => {
    it("resets state and returns to lobby", () => {
      const { result } = renderMPHook();
      act(() =>
        result.current.handlers.setRoom(
          makeRoom({
            status: "finished",
            players: [makePlayer({ id: "player-1", totalScore: 5000 })],
          })
        )
      );
      act(() => result.current.handlers.handleGameOver(makeRoundResultsPayload()));

      act(() => result.current.handlers.handlePlayAgainLocal());

      expect(result.current.state.screen).toBe("lobby");
      expect(result.current.state.isGameOver).toBe(false);
      expect(result.current.state.allRoundResults).toHaveLength(0);
      expect(result.current.state.room!.status).toBe("lobby");
      expect(result.current.state.room!.players[0].totalScore).toBe(0);
    });
  });

  describe("restoreScreenFromRoomState", () => {
    it("restores lobby screen for lobby status", () => {
      const { result } = renderMPHook();
      const room = makeRoom({ status: "lobby" });

      let response: { shouldEmitContinue: boolean };
      act(() => {
        response = result.current.handlers.restoreScreenFromRoomState(room, "player-1");
      });

      expect(result.current.state.screen).toBe("lobby");
      expect(response!.shouldEmitContinue).toBe(false);
    });

    it("restores playing screen with round data", () => {
      const { result } = renderMPHook();
      const room = makeRoom({ status: "playing" });
      const roundData = makeRoundStartPayload();

      act(() => {
        result.current.handlers.restoreScreenFromRoomState(room, "player-1", roundData);
      });

      expect(result.current.state.screen).toBe("playing");
      expect(result.current.state.roundData).toEqual(roundData);
    });

    it("sets hasGuessed if player already guessed", () => {
      const { result } = renderMPHook();
      const room = makeRoom({ status: "playing" });
      const roundData = makeRoundStartPayload();

      act(() => {
        result.current.handlers.restoreScreenFromRoomState(
          room,
          "player-1",
          roundData,
          ["player-1", "player-2"]
        );
      });

      expect(result.current.state.hasGuessed).toBe(true);
      expect(result.current.state.lockedPlayerIds.has("player-1")).toBe(true);
      expect(result.current.state.lockedPlayerIds.has("player-2")).toBe(true);
    });

    it("restores between_rounds and signals continue", () => {
      const { result } = renderMPHook();
      const room = makeRoom({ status: "between_rounds" });

      let response: { shouldEmitContinue: boolean };
      act(() => {
        response = result.current.handlers.restoreScreenFromRoomState(room, "player-1");
      });

      expect(result.current.state.screen).toBe("round_result");
      expect(result.current.state.hasContinued).toBe(true);
      expect(response!.shouldEmitContinue).toBe(true);
    });

    it("restores game_over screen for finished status", () => {
      const { result } = renderMPHook();
      const room = makeRoom({ status: "finished" });

      act(() => {
        result.current.handlers.restoreScreenFromRoomState(room, "player-1");
      });

      expect(result.current.state.screen).toBe("game_over");
    });
  });

  describe("null room safety", () => {
    it("handlers do not crash when room is null", () => {
      const { result } = renderMPHook();
      // All these should be no-ops when room is null
      expect(() => {
        act(() => result.current.handlers.handlePlayerJoined(makePlayer({ id: "p-2" })));
        act(() => result.current.handlers.handlePlayerLeft("p-1"));
        act(() => result.current.handlers.handlePlayerReconnected("p-1"));
        act(() => result.current.handlers.handlePlayerKicked("p-1"));
        act(() => result.current.handlers.handleHostChanged("p-2"));
        act(() =>
          result.current.handlers.handleSettingsUpdated({
            gameMode: "classic",
            categories: null,
            totalRounds: 10,
            hasPassword: false,
          })
        );
        act(() => result.current.handlers.handleRoundStart(makeRoundStartPayload()));
        act(() => result.current.handlers.handleRoundEnd(makeRoundResultsPayload()));
        act(() => result.current.handlers.handleGameOver(makeRoundResultsPayload()));
      }).not.toThrow();
    });
  });
});
