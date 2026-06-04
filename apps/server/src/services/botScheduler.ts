/**
 * Bot gameplay scheduler — submits guesses and continue votes with human-like delays.
 *
 * Bot timers are tracked per room so they can be cancelled on room cleanup or timer expiry.
 *
 * @module botScheduler
 */
import type { BotDifficulty, GuessData, RoundStartPayload } from "@price-game/shared";
import type { DbPlayer } from "./dbTypes";
import { generateBotGuess } from "./botGuess";

/** Pending bot timers indexed by room code. */
const botTimers = new Map<string, Set<ReturnType<typeof setTimeout>>>();

function addTimer(roomCode: string, timer: ReturnType<typeof setTimeout>): void {
  let set = botTimers.get(roomCode);
  if (!set) {
    set = new Set();
    botTimers.set(roomCode, set);
  }
  set.add(timer);
}

function removeTimer(roomCode: string, timer: ReturnType<typeof setTimeout>): void {
  const set = botTimers.get(roomCode);
  if (set) {
    set.delete(timer);
    if (set.size === 0) botTimers.delete(roomCode);
  }
}

/**
 * Cancel all pending bot timers for a room.
 *
 * @param roomCode - The room to cancel timers for
 */
export function cancelBotTimers(roomCode: string): void {
  const set = botTimers.get(roomCode);
  if (!set) return;
  for (const timer of set) {
    clearTimeout(timer);
  }
  botTimers.delete(roomCode);
}

/**
 * For a riser-mode bot, compute the delay (ms) at which it should
 * "stop" the rocket given its chosen `stoppedPriceCents`. Mirrors the
 * client RAF loop: the visual price climbs from a 10% floor to
 * `maxPriceCents` over `durationMs`, shaped by `speedPattern`. To
 * make the bot's stop look natural we invert the speed curve and add
 * a small reaction-time jitter on top.
 *
 * Falls back to the legacy 2–6s window if any required round meta is
 * missing — defensive against malformed payloads.
 */
function riserStopDelayMs(
  rp: RoundStartPayload,
  stoppedPriceCents: number,
): number {
  const max = rp.maxPriceCents;
  const duration = rp.durationMs;
  const pattern = rp.speedPattern;
  if (typeof max !== "number" || typeof duration !== "number" || max <= 0 || duration <= 0) {
    return 2000 + Math.floor(Math.random() * 4000);
  }
  const minPrice = Math.round(max * 0.1);
  const range = max - minPrice;
  if (range <= 0) return 2000 + Math.floor(Math.random() * 4000);
  const targetProgress = Math.max(0, Math.min(1, (stoppedPriceCents - minPrice) / range));
  let t: number;
  switch (pattern) {
    case "accelerating":
      // progress = t² → t = sqrt(progress)
      t = Math.sqrt(targetProgress);
      break;
    case "decelerating":
      // progress = 1 - (1 - t)² → t = 1 - sqrt(1 - progress)
      t = 1 - Math.sqrt(Math.max(0, 1 - targetProgress));
      break;
    case "wave":
      // Non-monotonic — small ±5% wobble doesn't justify a Newton solve.
      t = targetProgress;
      break;
    case "linear":
    default:
      t = targetProgress;
      break;
  }
  // Reaction-time jitter (200–600ms) so the bot doesn't stop the
  // millisecond it visually crosses its target — that would look more
  // robotic than a real player. Clamp short of the auto-stop boundary.
  const reactionJitter = 200 + Math.floor(Math.random() * 400);
  const ideal = t * duration + reactionJitter;
  return Math.max(800, Math.min(duration - 200, ideal));
}

/**
 * Schedule bot guesses for a round with staggered human-like delays.
 *
 * Each bot generates a guess using the bot guess engine and submits it
 * after a random delay (2-6 seconds for most modes). Riser is special:
 * the bot's stop time is anchored to its chosen stopped price + the
 * round's flight curve so its rocket visually halts at the right
 * moment instead of always near launch.
 *
 * @param roomCode - The room code
 * @param roundPayload - The RoundStartPayload for the current round
 * @param productPrices - Map of productId → priceCents
 * @param botPlayers - Array of bot DbPlayer rows
 * @param difficulty - Bot difficulty level
 * @param onBotGuess - Callback when a bot guess is ready: { playerId, guessData }
 */
export function scheduleBotGuesses(
  roomCode: string,
  roundPayload: RoundStartPayload,
  productPrices: Map<number, number>,
  botPlayers: DbPlayer[],
  difficulty: BotDifficulty | string,
  onBotGuess: (data: { playerId: string; guessData: GuessData }) => void,
): void {
  const diff = (["easy", "medium", "hard"].includes(difficulty) ? difficulty : "medium") as BotDifficulty;

  const isRiser = roundPayload.gameMode === "riser";
  for (const bot of botPlayers) {
    // Riser is the only mode where the delay depends on the chosen
    // guess — the bot's stop time has to line up visually with the
    // price its `stoppedPriceCents` would correspond to on the curve.
    // For all other modes we keep the legacy lazy generation (guess
    // produced inside the timer callback) so future changes that make
    // generateBotGuess depend on live state — e.g. observing other
    // players' guesses — keep working.
    if (isRiser) {
      const guessData = generateBotGuess(
        roundPayload.gameMode,
        diff,
        roundPayload,
        productPrices,
        { botPlayerId: bot.id, roomCode },
      );
      const stoppedPriceCents =
        "stoppedPriceCents" in guessData &&
        typeof guessData.stoppedPriceCents === "number"
          ? guessData.stoppedPriceCents
          : 0;
      const delay = riserStopDelayMs(roundPayload, stoppedPriceCents);
      const timer = setTimeout(() => {
        removeTimer(roomCode, timer);
        onBotGuess({ playerId: bot.id, guessData });
      }, delay);
      addTimer(roomCode, timer);
    } else {
      const delay = 2000 + Math.floor(Math.random() * 4000); // 2-6 seconds
      const timer = setTimeout(() => {
        removeTimer(roomCode, timer);
        const guessData = generateBotGuess(
          roundPayload.gameMode,
          diff,
          roundPayload,
          productPrices,
          { botPlayerId: bot.id, roomCode },
        );
        onBotGuess({ playerId: bot.id, guessData });
      }, delay);
      addTimer(roomCode, timer);
    }
  }
}

/**
 * Schedule bot continue votes after round end.
 *
 * Bots auto-continue with staggered delays (1-3 seconds).
 *
 * @param roomCode - The room code
 * @param botPlayers - Array of bot DbPlayer rows
 * @param onBotContinue - Callback when a bot continues: { playerId }
 */
export function scheduleBotContinues(
  roomCode: string,
  botPlayers: DbPlayer[],
  onBotContinue: (data: { playerId: string }) => void,
): void {
  for (const bot of botPlayers) {
    const delay = 5000 + Math.floor(Math.random() * 3000); // 5-8 seconds to let players read results
    const timer = setTimeout(() => {
      removeTimer(roomCode, timer);
      onBotContinue({ playerId: bot.id });
    }, delay);
    addTimer(roomCode, timer);
  }
}
