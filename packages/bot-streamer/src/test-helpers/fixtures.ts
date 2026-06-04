/**
 * Canned payloads for testing the observer + strategies. Each builder
 * returns a fresh object so tests can mutate without poisoning siblings.
 */

import type {
  GameMode,
  MultiplayerRoom,
  RoundStartPayload,
  RoundResultsPayload,
  Product,
  ProductWithPrice,
} from "@price-game/shared";
import { DEFAULT_AVATAR } from "@price-game/shared";

const DEFAULT_PRODUCT: ProductWithPrice = {
  id: 100,
  title: "Bluetooth Speaker",
  description: "Mid-range portable speaker",
  imageUrl: "https://example.invalid/speaker.webp",
  category: "Electronics",
  priceCents: 4999,
  amazonUrl: undefined,
};

export function makeProduct(overrides: Partial<Product> = {}): Product {
  return {
    id: DEFAULT_PRODUCT.id,
    title: DEFAULT_PRODUCT.title,
    description: DEFAULT_PRODUCT.description,
    imageUrl: DEFAULT_PRODUCT.imageUrl,
    category: DEFAULT_PRODUCT.category,
    ...overrides,
  };
}

export function makeRoom(overrides: Partial<MultiplayerRoom> = {}): MultiplayerRoom {
  return {
    code: "ABCDEF",
    gameMode: "classic",
    categories: null,
    hasPassword: false,
    status: "lobby",
    currentRound: 0,
    totalRounds: 5,
    players: [],
    hostPlayerId: "host-1",
    isPublic: true,
    botCount: 0,
    botDifficulty: "medium",
    ...overrides,
  };
}

export function makeRoundStart(
  overrides: Partial<RoundStartPayload> = {},
): RoundStartPayload {
  return {
    roundNumber: 1,
    gameMode: "classic",
    timerSeconds: 30,
    product: makeProduct(),
    ...overrides,
  };
}

export function makeRoundResults(
  mode: GameMode = "classic",
  overrides: Partial<RoundResultsPayload> = {},
): RoundResultsPayload {
  return {
    roundNumber: 1,
    gameMode: mode,
    revealData: { mode: "classic", product: { ...DEFAULT_PRODUCT } },
    playerResults: [],
    standings: [],
    ...overrides,
  };
}

export const SAMPLE_AVATAR = DEFAULT_AVATAR;
