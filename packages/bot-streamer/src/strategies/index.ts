/**
 * Strategy registry — maps a GameMode to its handler. Lookups for modes
 * that don't yet have a strategy throw rather than returning undefined,
 * so the lifecycle controller fails fast on a config that targets a
 * mode the bot doesn't support yet.
 */

import type { GameMode } from "@price-game/shared";
import type { ModeStrategy } from "./types";
import { classicStrategy } from "./classic";
import { higherLowerStrategy } from "./higher-lower";
import { comparisonStrategy } from "./comparison";
import { closestStrategy } from "./closest";
import { riserStrategy } from "./riser";
import { oddOneOutStrategy } from "./odd-one-out";
import { marketBasketStrategy } from "./market-basket";
import { sortItOutStrategy } from "./sort-it-out";
import { chainReactionStrategy } from "./chain-reaction";
import { biddingStrategy } from "./bidding";

// Phase 3d.2: price-match and budget-builder strategies are gone with
// the modes themselves. The bot's Core 4 rotation is classic /
// higher-lower / comparison / bidding; the registry retains every
// other VALID_GAME_MODE strategy for back-compat (chat-driven mode
// override remains usable for closest / riser / etc. on demand).
const REGISTRY: Partial<Record<GameMode, ModeStrategy>> = {
  classic: classicStrategy,
  "higher-lower": higherLowerStrategy,
  comparison: comparisonStrategy,
  "closest-without-going-over": closestStrategy,
  // The bidding strategy reads BiddingTurnPayload from
  // StrategyContext.turn (set by the runner from observer state) to
  // pick its bid amount based on turn order. For single-player
  // Bidding War the turn context is absent and the strategy degrades
  // to the closest-style safe-bid pattern.
  bidding: biddingStrategy,
  riser: riserStrategy,
  "odd-one-out": oddOneOutStrategy,
  "market-basket": marketBasketStrategy,
  "sort-it-out": sortItOutStrategy,
  "chain-reaction": chainReactionStrategy,
};

/**
 * Look up the strategy for a mode. Throws when the mode isn't yet
 * supported so the runner fails loudly instead of silently no-opping.
 */
export function strategyFor(mode: GameMode): ModeStrategy {
  const s = REGISTRY[mode];
  if (!s) {
    throw new Error(`strategyFor: no strategy registered for mode '${mode}'`);
  }
  return s;
}

/** True if a strategy exists for `mode`. Useful for filtering rotations. */
export function hasStrategy(mode: GameMode): boolean {
  return REGISTRY[mode] !== undefined;
}

export {
  classicStrategy,
  higherLowerStrategy,
  comparisonStrategy,
  closestStrategy,
  riserStrategy,
  oddOneOutStrategy,
  marketBasketStrategy,
  sortItOutStrategy,
  chainReactionStrategy,
  biddingStrategy,
};
export { biddingCandidates } from "./bidding";
export { decideBid as decideBiddingBid } from "./biddingDecoder";
export { OpponentTracker } from "./biddingOpponents";
export { singlePlayerBiddingStrategy } from "./closest";
export type { ModeStrategy, StrategyCandidate, StrategyContext } from "./types";
