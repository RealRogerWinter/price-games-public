/**
 * Multiplayer game engine — facade module.
 *
 * Re-exports from focused sub-modules:
 * - mpTimerState: timer/flag/continue state management
 * - mpRoundStart: round initialization and payload building
 * - mpGuess: guess submission and scoring
 * - mpRoundEnd: round finalization and results
 * - mpReconnect: reconnection and query helpers
 */
export { playerContinue, clearContinueTracker, clearRoundTimer, hasRoundEnded, cleanupRoomMemory, playerReady, clearReadyTracker } from "./mpTimerState";
export { startRound, getActivePlayers } from "./mpRoundStart";
export { submitGuess } from "./mpGuess";
export { endRound } from "./mpRoundEnd";
export { getCurrentRoundPayload, getGuessedPlayerIds, checkAllConnectedPlayersGuessed, getRoundGuessCount } from "./mpReconnect";
