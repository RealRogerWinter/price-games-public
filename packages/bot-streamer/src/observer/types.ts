/**
 * Typed view of the bot's current game state, derived from incoming
 * Socket.IO events. Separate from the wire protocol's payloads so the
 * observer can normalise (e.g. fold optional fields, attach timestamps,
 * replace positional indices with stable IDs) before strategies and the
 * lifecycle controller consume it.
 */

import type {
  GameMode,
  MultiplayerPlayer,
  MultiplayerRoom,
  RoundResultsPayload,
  RoundStartPayload,
  BiddingTurnPayload,
} from "@price-game/shared";

/**
 * High-level phase the bot is in. Strategies use this to decide
 * whether they should be making decisions at all (e.g. don't try to
 * answer when we're in a lobby).
 */
export type BotPhase =
  | "disconnected"
  | "in_lobby"
  | "in_round"
  | "between_rounds"
  | "game_over";

/**
 * Snapshot of the room the bot is currently in. `null` while the bot is
 * unhosted (e.g. between solo REST sessions or while the lifecycle
 * controller is matchmaking).
 */
export interface RoomSnapshot {
  roomCode: string;
  hostId: string | null;
  players: MultiplayerPlayer[];
  gameMode: GameMode;
  totalRounds: number;
  currentRound: number;
  status: MultiplayerRoom["status"];
}

/**
 * Snapshot of the round the bot is being asked to play, if any. The
 * payload is the same shape the server emits via `game:round_start` —
 * we don't reshape it because every strategy needs the raw fields.
 */
export interface RoundSnapshot {
  payload: RoundStartPayload;
  /** When `payload` arrived (ms since epoch). */
  receivedAt: number;
  /** Set when the bot has emitted `game:submit_guess`. */
  submitted: boolean;
}

/**
 * Bidding-only: the current per-turn state. `null` when not in bidding
 * mode or between turns.
 */
export interface BiddingSnapshot {
  turn: BiddingTurnPayload;
  /** When `turn` arrived (ms since epoch). */
  receivedAt: number;
}

/**
 * Result of the most recently completed round. Strategies use this for
 * post-game analytics and the lifecycle controller uses it to drive
 * "ready / continue" emit timing.
 */
export interface LastResultSnapshot {
  payload: RoundResultsPayload;
  /** When `payload` arrived (ms since epoch). */
  receivedAt: number;
}

/**
 * Aggregate observer state. Everything is optional except `phase` so the
 * initial / disconnected snapshot is meaningful without sentinel values.
 */
export interface BotStateSnapshot {
  phase: BotPhase;
  /** The bot's own player ID, when known (assigned on room join). */
  myPlayerId: string | null;
  room: RoomSnapshot | null;
  round: RoundSnapshot | null;
  bidding: BiddingSnapshot | null;
  lastResult: LastResultSnapshot | null;
}

/** Initial snapshot — exported so consumers can seed defaults from one place. */
export const INITIAL_BOT_STATE: BotStateSnapshot = {
  phase: "disconnected",
  myPlayerId: null,
  room: null,
  round: null,
  bidding: null,
  lastResult: null,
};
