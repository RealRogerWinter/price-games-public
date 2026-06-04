/**
 * Enactor registry — one Enactor per GameMode. Two distinct enactor
 * instances exist for `bidding`: the single-player closest-style
 * fallback (`singlePlayerBiddingEnactor`) and the MP turn-aware
 * variant (`multiplayerBiddingEnactor`). The runner picks between
 * them based on whether a BiddingTurnPayload is in flight; the
 * default registry entry is the MP one because that's the more
 * common rotation case once the streamer is in a public room.
 */

import type { GameMode } from "@price-game/shared";
import type { Enactor } from "./types";
import { classicEnactor, closestEnactor, singlePlayerBiddingEnactor } from "./classic";
import { higherLowerEnactor } from "./higher-lower";
import { comparisonEnactor, oddOneOutEnactor } from "./comparison";
import { riserEnactor } from "./riser";
import { marketBasketEnactor } from "./market-basket";
import { sortItOutEnactor } from "./sort-it-out";
import { chainReactionEnactor } from "./chain-reaction";
import { multiplayerBiddingEnactor } from "./bidding";

// Phase 3d.2: priceMatch + budgetBuilder enactors deleted with their modes.
const REGISTRY: Partial<Record<GameMode, Enactor>> = {
  classic: classicEnactor,
  "higher-lower": higherLowerEnactor,
  comparison: comparisonEnactor,
  "closest-without-going-over": closestEnactor,
  bidding: multiplayerBiddingEnactor,
  riser: riserEnactor,
  "odd-one-out": oddOneOutEnactor,
  "market-basket": marketBasketEnactor,
  "sort-it-out": sortItOutEnactor,
  "chain-reaction": chainReactionEnactor,
};

/**
 * Look up the enactor for a mode. Throws on a missing registration
 * so the runner fails loudly instead of silently no-opping.
 */
export function enactorFor(mode: GameMode): Enactor {
  const e = REGISTRY[mode];
  if (!e) {
    throw new Error(`enactorFor: no enactor registered for mode '${mode}'`);
  }
  return e;
}

/**
 * Variant lookup: returns `singlePlayerBiddingEnactor` for
 * `bidding`. The Driver calls this in single-player mode where the
 * Multiplayer-bidding UI isn't mounted.
 */
export function enactorForSinglePlayer(mode: GameMode): Enactor {
  if (mode === "bidding") return singlePlayerBiddingEnactor;
  return enactorFor(mode);
}

export type { Enactor, EnactorContext } from "./types";
