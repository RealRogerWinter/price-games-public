/**
 * Extended per-mode marketing copy used by the public `/game-modes` page
 * and the server-side SEO body injector (for the `/play/<mode>` and
 * `/game-modes` landing pages).
 *
 * Kept separate from `GAME_MODES` (which holds the short in-game labels)
 * because these sentences are longer and tuned for search-engine snippets.
 * Single source of truth — rendered identically on client and server so
 * crawlers and JS users see the same copy.
 */

import type { GameMode } from "./types.js";

export interface ModeDetail {
  /** One-paragraph description of how the mode is played. */
  rules: string;
  /** One-paragraph strategy/tip for doing well at the mode. */
  strategy: string;
}

export const MODE_DETAILS: Record<GameMode, ModeDetail> = {
  "classic": {
    rules: "Each round shows one real product. Type your guess — the closer your guess is to the actual price, the more points you score. Five or ten rounds, no timer.",
    strategy: "Start with rough price anchoring: is it a \"cents,\" \"tens,\" or \"hundreds\" item? Then tune. Price Games is forgiving — being within 10% earns most of the available points.",
  },
  "higher-lower": {
    rules: "You see a product with its real price, then a second product. Decide whether the second one costs more or less than the first. Repeat.",
    strategy: "Compare the shelf archetype, not just the photo. Two similar-looking items can have a 10× price gap based on brand or material.",
  },
  "comparison": {
    rules: "Two products, side by side. Pick the more expensive one (or the cheaper one — the prompt flips each round).",
    strategy: "Read the prompt carefully every round — 'which is cheaper?' reversals are the #1 source of missed points.",
  },
  "closest-without-going-over": {
    rules: "Type a guess that's as close to the real price as possible — but if you go over, you score zero for that round.",
    strategy: "Under-bid deliberately. A $1 low is always worth more than a $1 high.",
  },
  "price-match": {
    rules: "Four products and four prices. Drag each price onto the right product before time runs out.",
    strategy: "Anchor the cheapest and most expensive first, then solve the middle two by elimination.",
  },
  "riser": {
    rules: "A single price counter ticks upward. Stop it with a tap — the closer you land to the real price without going over, the more you score.",
    strategy: "Tap slightly before you think the real price is — reaction lag is usually ~100ms.",
  },
  "odd-one-out": {
    rules: "Four products. Three share a price tier (roughly comparable). Pick the outlier — the one that doesn't belong.",
    strategy: "Don't trust size. A small high-end gadget often costs more than a bulky basic one.",
  },
  "market-basket": {
    rules: "A basket of up to six products. Estimate the combined total — no per-item breakdown.",
    strategy: "Sum rough tiers: how many \"$10-ish\" items, how many \"$50-ish\"? Faster than computing per-item prices.",
  },
  "sort-it-out": {
    rules: "Five products. Drag them into a ranked list from cheapest on top to most expensive on bottom.",
    strategy: "Place the extremes first, then place the middle items relative to each other.",
  },
  "budget-builder": {
    rules: "Six products, one budget. Select the combination that fills the budget as fully as possible without going over.",
    strategy: "Knapsack-style: prefer adding cheap items last to fill remainder, rather than starting with a luxury item you can't afford.",
  },
  "chain-reaction": {
    rules: "Five products. Build a chain where each product costs more than the previous one. Each correct step extends the chain.",
    strategy: "When unsure of two middle items, place the one you're most confident on and let the chain constrain the rest.",
  },
  "bidding": {
    rules: "Players bid in turns on a single product's price. Closest under the real price wins — over bids score zero.",
    strategy: "Late bidders should bid $1 over the leading bid when they think the leader was too low.",
  },
};
