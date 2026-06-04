import type { GameMode } from "@price-game/shared";
import classicIcon from "./modes/classic.webp";
import higherLowerIcon from "./modes/higher-lower.webp";
import comparisonIcon from "./modes/comparison.webp";
import underbidIcon from "./modes/underbid.webp";
import priceMatchIcon from "./modes/price-match.webp";
import riserIcon from "./modes/riser.webp";
import oddOneOutIcon from "./modes/odd-one-out.webp";
import marketBasketIcon from "./modes/market-basket.webp";
import sortItOutIcon from "./modes/sort-it-out.webp";
import budgetBuilderIcon from "./modes/budget-builder.webp";
import chainReactionIcon from "./modes/chain-reaction.webp";
import biddingIcon from "./modes/bidding.webp";
import randomIconAsset from "./modes/random.webp";

/**
 * Maps each `GameMode` to its kawaii icon asset. Typed against the
 * exhaustive `GameMode` union so adding a new mode in shared constants
 * becomes a compile error here until a matching icon is registered.
 */
export const MODE_ICONS: Record<GameMode, string> = {
  classic: classicIcon,
  "higher-lower": higherLowerIcon,
  comparison: comparisonIcon,
  "closest-without-going-over": underbidIcon,
  "price-match": priceMatchIcon,
  riser: riserIcon,
  "odd-one-out": oddOneOutIcon,
  "market-basket": marketBasketIcon,
  "sort-it-out": sortItOutIcon,
  "budget-builder": budgetBuilderIcon,
  "chain-reaction": chainReactionIcon,
  bidding: biddingIcon,
};

/** Icon for the "Random" shortcut on HomePage. Not a real `GameMode`. */
export const randomIcon: string = randomIconAsset;
