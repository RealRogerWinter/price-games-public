/**
 * In-memory timer and state management for multiplayer rounds.
 *
 * Owns the four module-level Maps that track round timers, end flags,
 * start times, and continue votes. All other multiplayer modules access
 * this state through exported functions.
 */
import db from "../db";
import { touchRoomActivity } from "./roomManager";
import { cancelBotTimers } from "./botScheduler";
import { cleanupBiddingState } from "./mpBiddingState";

// In-memory timer tracking
const roundTimers = new Map<string, NodeJS.Timeout>();
const roundEndedFlags = new Map<string, boolean>();
const roundStartTimes = new Map<string, number>();

// In-memory continue tracking for auto-advance
const continueTracker = new Map<string, Set<string>>();

// In-memory ready tracking for lobby ready-up
const readyTracker = new Map<string, Set<string>>();

export function playerContinue(roomCode: string, playerId: string): { allContinued: boolean } {
  let set = continueTracker.get(roomCode);
  if (!set) {
    set = new Set<string>();
    continueTracker.set(roomCode, set);
  }
  set.add(playerId);

  const connectedPlayers = db
    .prepare("SELECT COUNT(*) as count FROM mp_players WHERE room_code = ? AND is_kicked = 0 AND connected = 1")
    .get(roomCode) as { count: number };

  // Touch activity after verifying the room exists (the query above confirms it)
  touchRoomActivity(roomCode);

  return { allContinued: set.size >= connectedPlayers.count };
}

export function clearContinueTracker(roomCode: string): void {
  continueTracker.delete(roomCode);
}

export function clearRoundTimer(roomCode: string): void {
  const timer = roundTimers.get(roomCode);
  if (timer) {
    clearTimeout(timer);
    roundTimers.delete(roomCode);
  }
}

export function setRoundTimer(roomCode: string, timer: NodeJS.Timeout): void {
  roundTimers.set(roomCode, timer);
}

export function hasRoundEnded(roomCode: string): boolean {
  return roundEndedFlags.get(roomCode) || false;
}

export function setRoundEnded(roomCode: string, ended: boolean): void {
  roundEndedFlags.set(roomCode, ended);
}

export function setRoundStartTime(roomCode: string, time: number): void {
  roundStartTimes.set(roomCode, time);
}

export function getRoundStartTime(roomCode: string): number | undefined {
  return roundStartTimes.get(roomCode);
}

/**
 * Mark a player as ready in the lobby.
 * Bots are auto-ready and don't need to call this.
 *
 * @param roomCode - The room code
 * @param playerId - The player's ID
 * @returns { allReady } - true if all connected human players are ready
 */
export function playerReady(roomCode: string, playerId: string): { allReady: boolean } {
  let set = readyTracker.get(roomCode);
  if (!set) {
    set = new Set<string>();
    readyTracker.set(roomCode, set);
  }
  set.add(playerId);

  // Count only connected human players
  const humanCount = db
    .prepare("SELECT COUNT(*) as count FROM mp_players WHERE room_code = ? AND is_kicked = 0 AND connected = 1 AND is_bot = 0")
    .get(roomCode) as { count: number };

  touchRoomActivity(roomCode);

  return { allReady: set.size >= humanCount.count };
}

/**
 * Clear ready state for a room (e.g., when round starts or room resets).
 */
export function clearReadyTracker(roomCode: string): void {
  readyTracker.delete(roomCode);
}

/** Clean up all in-memory state for a room (timers, flags, trackers, bot timers, bidding state). */
export function cleanupRoomMemory(roomCode: string): void {
  clearRoundTimer(roomCode);
  roundEndedFlags.delete(roomCode);
  roundStartTimes.delete(roomCode);
  continueTracker.delete(roomCode);
  readyTracker.delete(roomCode);
  cancelBotTimers(roomCode);
  // Also clean up bidding state so pending turn timers don't fire on a deleted room
  cleanupBiddingState(roomCode);
}
