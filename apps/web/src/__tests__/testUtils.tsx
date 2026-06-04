import React from "react";
import { render, type RenderOptions, act } from "@testing-library/react";
import { CurrencyProvider } from "../context/CurrencyContext";
import { UserAuthProvider } from "../context/UserAuthContext";
import type {
  Product,
  ProductWithPrice,
  Avatar,
  GameSession,
  MultiplayerRoom,
  RoundStartPayload,
  RoundResultsPayload,
  UserAccount,
  GameHistoryEntry,
  BiddingTurnPayload,
  BidPlacedPayload,
} from "@price-game/shared";

/** Flush only microtasks without advancing timers. */
export async function flushMicrotasks() {
  await act(async () => {});
}

/**
 * Render wrapper that provides CurrencyContext + UserAuthProvider (required
 * by any component tree that reaches a context-consuming child).
 * UserAuthProvider's initial `userGetMe()` fetch is swallowed by its own
 * `.catch`, so tests that do not mock userClient simply see a
 * `user: null`, `loading: false` state.
 */
export function renderWithProviders(
  ui: React.ReactElement,
  options?: Omit<RenderOptions, "wrapper">
) {
  function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <CurrencyProvider>
        <UserAuthProvider>{children}</UserAuthProvider>
      </CurrencyProvider>
    );
  }
  return render(ui, { wrapper: Wrapper, ...options });
}

/** Creates a minimal Product object for tests. */
export function makeProduct(overrides: Partial<Product> = {}): Product {
  return {
    id: 1,
    title: "Test Widget",
    imageUrl: "https://example.com/widget.jpg",
    description: "A test product",
    category: "Electronics",
    ...overrides,
  };
}

/** Creates a minimal MultiplayerPlayer for tests. */
export function makePlayer(overrides: Partial<{
  id: string;
  displayName: string;
  avatar: Avatar;
  isHost: boolean;
  isConnected: boolean;
  totalScore: number;
  isBot: boolean;
}> = {}) {
  return {
    id: "player-1",
    displayName: "Alice",
    avatar: "wizard" as const,
    isHost: false,
    isConnected: true,
    totalScore: 0,
    isBot: false,
    ...overrides,
  };
}

/** Creates a minimal GameSession for tests. */
export function makeSession(overrides: Partial<GameSession> = {}): GameSession {
  return {
    id: "session-1",
    currentRound: 1,
    totalRounds: 10,
    totalScore: 0,
    completed: false,
    gameMode: "classic",
    ...overrides,
  };
}

/** Creates a minimal ProductWithPrice for tests. */
export function makeProductWithPrice(overrides: Partial<ProductWithPrice> = {}): ProductWithPrice {
  return {
    id: 1,
    title: "Test Widget",
    imageUrl: "https://example.com/widget.jpg",
    description: "A test product",
    category: "Electronics",
    priceCents: 2000,
    ...overrides,
  };
}

/** Creates a minimal MultiplayerRoom for tests. */
export function makeRoom(overrides: Partial<MultiplayerRoom> = {}): MultiplayerRoom {
  return {
    code: "ABCD",
    gameMode: "classic",
    categories: null,
    hasPassword: false,
    status: "lobby",
    currentRound: 0,
    totalRounds: 10,
    players: [makePlayer({ isHost: true })],
    hostPlayerId: "player-1",
    isPublic: false,
    botCount: 0,
    botDifficulty: "medium",
    ...overrides,
  };
}

/** Creates a minimal RoundStartPayload for tests. */
export function makeRoundStartPayload(overrides: Partial<RoundStartPayload> = {}): RoundStartPayload {
  return {
    roundNumber: 1,
    gameMode: "classic",
    timerSeconds: 30,
    product: makeProduct(),
    ...overrides,
  };
}

/** Creates a minimal RoundResultsPayload for tests. */
export function makeRoundResultsPayload(overrides: Partial<RoundResultsPayload> = {}): RoundResultsPayload {
  return {
    roundNumber: 1,
    gameMode: "classic",
    revealData: { mode: "classic", product: makeProductWithPrice() },
    playerResults: [
      {
        playerId: "player-1",
        displayName: "Alice",
        avatar: "wizard" as const,
        score: 500,
        guessData: { guessedPriceCents: 2200 },
      },
    ],
    standings: [
      {
        playerId: "player-1",
        displayName: "Alice",
        avatar: "wizard" as const,
        totalScore: 500,
      },
    ],
    ...overrides,
  };
}

/** Creates a minimal UserAccount object for tests. */
export function makeUser(overrides: Partial<UserAccount> = {}): UserAccount {
  return {
    id: "user-1",
    username: "testuser",
    email: "test@example.com",
    emailVerified: true,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    lastLoginAt: null,
    isActive: true,
    lifetimeScore: 5000,
    referralCode: "TEST1234",
    usernamePending: false,
    avatar: null,
    ...overrides,
  };
}

/** Creates a minimal GameHistoryEntry object for tests. */
export function makeGameHistoryEntry(overrides: Partial<GameHistoryEntry> = {}): GameHistoryEntry {
  return {
    id: 1,
    gameType: "single",
    gameMode: "classic",
    score: 500,
    placement: null,
    playersCount: null,
    playedAt: "2026-03-10T12:00:00Z",
    ...overrides,
  };
}

/** Creates a minimal BiddingTurnPayload for tests. */
export function makeBiddingTurnPayload(overrides: Partial<BiddingTurnPayload> = {}): BiddingTurnPayload {
  return {
    currentPlayerId: "player-1",
    turnIndex: 0,
    totalPlayers: 2,
    timerSeconds: 20,
    previousBids: [],
    ...overrides,
  };
}

/** Creates a minimal BidPlacedPayload for tests. */
export function makeBidPlacedPayload(overrides: Partial<BidPlacedPayload> = {}): BidPlacedPayload {
  return {
    playerId: "player-1",
    displayName: "Alice",
    avatar: "wizard",
    bidCents: 1500,
    turnIndex: 0,
    ...overrides,
  };
}

/**
 * Render wrapper that provides CurrencyContext + UserAuthProvider.
 * Useful for components that need both providers.
 */
export function renderWithAllProviders(
  ui: React.ReactElement,
  options?: Omit<RenderOptions, "wrapper">
) {
  function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <CurrencyProvider>
        <UserAuthProvider>{children}</UserAuthProvider>
      </CurrencyProvider>
    );
  }
  return render(ui, { wrapper: Wrapper, ...options });
}
