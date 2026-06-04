/**
 * Single-player game engine — facade module.
 *
 * Re-exports from focused sub-modules:
 * - gameSession: session lifecycle (start, get)
 * - gameHints: hint system
 * - gameGuess: product fetching and guess submission
 */
export { startGame, getSession } from "./gameSession";
export { getHint } from "./gameHints";
export { getSessionProduct, submitGuess } from "./gameGuess";
