/**
 * Cross-mode regression tests.
 *
 * Verifies each of the 11 game modes works correctly through the full
 * multiplayer Socket.IO pipeline: room creation with mode → round start →
 * mode-specific guess → scoring → round end with correct reveal data.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Socket as ClientSocket } from "socket.io-client";
import {
  createTestServer,
  closeTestServer,
  connectClient,
  disconnectClient,
  createRoom,
  joinRoom,
  startRound,
  submitGuess,
  waitForEvent,
  TestServer,
} from "../test/socketHelper";

vi.mock("../db", () => ({ default: null as any }));

let server: TestServer;
let sockets: ClientSocket[] = [];

beforeEach(async () => {
  server = await createTestServer(50);
  sockets = [];
});

afterEach(async () => {
  for (const s of sockets) {
    if (s.connected) await disconnectClient(s);
  }
  sockets = [];
  await closeTestServer(server);
});

async function connect(): Promise<ClientSocket> {
  const s = await connectClient(server.url);
  sockets.push(s);
  return s;
}

async function setupAndStartRound(mode: string) {
  const hostSocket = await connect();
  const joinerSocket = await connect();

  const hostResult = await createRoom(hostSocket, "Host", {
    gameMode: mode,
    totalRounds: 3,
  });
  const joinResult = await joinRoom(joinerSocket, hostResult.room.code, "Joiner");

  const hostRoundP = waitForEvent(hostSocket, "game:round_start");
  const joinerRoundP = waitForEvent(joinerSocket, "game:round_start");
  await startRound(hostSocket);
  const roundData = await hostRoundP;
  await joinerRoundP;

  return { hostSocket, joinerSocket, hostResult, joinResult, roundData };
}

describe("Classic mode — full round", () => {
  it("plays a classic round with price guessing", async () => {
    const { hostSocket, joinerSocket, roundData } = await setupAndStartRound("classic");

    expect(roundData.gameMode).toBe("classic");
    expect(roundData.product).toBeDefined();
    expect(roundData.product.id).toBeDefined();
    expect(roundData.product.title).toBeDefined();
    expect(roundData.product.priceCents).toBeUndefined();

    await submitGuess(hostSocket, { guessedPriceCents: 5000 });
    const endP = waitForEvent(hostSocket, "game:round_end");
    await submitGuess(joinerSocket, { guessedPriceCents: 3000 });
    const roundEnd = await endP;

    expect(roundEnd.gameMode).toBe("classic");
    expect(roundEnd.revealData.product).toBeDefined();
    expect(roundEnd.revealData.product.priceCents).toBeDefined();
    expect(roundEnd.playerResults.length).toBe(2);
    expect(roundEnd.standings.length).toBe(2);
  });
});

describe("Higher-Lower mode — full round", () => {
  it("plays a higher-lower round with reference price", async () => {
    const { hostSocket, joinerSocket, roundData } = await setupAndStartRound("higher-lower");

    expect(roundData.gameMode).toBe("higher-lower");
    expect(roundData.product).toBeDefined();
    expect(roundData.referencePrice).toBeDefined();
    expect(roundData.referencePrice).toBeGreaterThan(0);

    await submitGuess(hostSocket, { guess: "higher" });
    const endP = waitForEvent(hostSocket, "game:round_end");
    await submitGuess(joinerSocket, { guess: "lower" });
    const roundEnd = await endP;

    expect(roundEnd.revealData.product.priceCents).toBeDefined();
    expect(roundEnd.revealData.referencePrice).toBeDefined();
  });
});

describe("Comparison mode — full round", () => {
  it("plays a comparison round with two products", async () => {
    const { hostSocket, joinerSocket, roundData } = await setupAndStartRound("comparison");

    expect(roundData.gameMode).toBe("comparison");
    expect(roundData.products).toBeDefined();
    expect(roundData.products.length).toBe(2);
    expect(roundData.question).toMatch(/^(most-expensive|least-expensive)$/);

    await submitGuess(hostSocket, { guessedProductId: roundData.products[0].id });
    const endP = waitForEvent(hostSocket, "game:round_end");
    await submitGuess(joinerSocket, { guessedProductId: roundData.products[1].id });
    const roundEnd = await endP;

    expect(roundEnd.revealData.products.length).toBe(2);
    expect(roundEnd.revealData.correctProductId).toBeDefined();
    expect(roundEnd.revealData.question).toBeDefined();
    expect(roundEnd.revealData.products[0].priceCents).toBeDefined();
    expect(roundEnd.revealData.products[1].priceCents).toBeDefined();
  });
});

describe("Closest-Without-Going-Over mode — full round", () => {
  it("plays a closest-without-going-over round", async () => {
    const { hostSocket, joinerSocket, roundData } = await setupAndStartRound("closest-without-going-over");

    expect(roundData.gameMode).toBe("closest-without-going-over");
    expect(roundData.product).toBeDefined();

    await submitGuess(hostSocket, { guessedPriceCents: 100 });
    const endP = waitForEvent(hostSocket, "game:round_end");
    await submitGuess(joinerSocket, { guessedPriceCents: 999999 });
    const roundEnd = await endP;

    expect(roundEnd.revealData.product.priceCents).toBeDefined();

    // The player who went way over should get 0
    const joinerResult = roundEnd.playerResults.find(
      (p: any) => p.guessData?.guessedPriceCents === 999999
    );
    expect(joinerResult).toBeDefined();
    expect(joinerResult.score).toBe(0);
  });
});

describe("Price Match mode — full round", () => {
  it("plays a price-match round with 4 products", async () => {
    const { hostSocket, joinerSocket, roundData } = await setupAndStartRound("price-match");

    expect(roundData.gameMode).toBe("price-match");
    expect(roundData.products).toBeDefined();
    expect(roundData.products.length).toBe(4);
    expect(roundData.prices).toBeDefined();
    expect(roundData.prices.length).toBe(4);
    expect(roundData.timerSeconds).toBe(45);

    const assignments: Record<number, number> = {};
    for (let i = 0; i < roundData.products.length; i++) {
      assignments[roundData.products[i].id] = roundData.prices[i];
    }

    await submitGuess(hostSocket, { assignments });
    const endP = waitForEvent(hostSocket, "game:round_end");
    await submitGuess(joinerSocket, { assignments });
    const roundEnd = await endP;

    expect(roundEnd.revealData.products.length).toBe(4);
    for (const p of roundEnd.revealData.products) {
      expect(p.priceCents).toBeDefined();
    }
  });

  it("two players with different assignments get different guessData in results", async () => {
    const { hostSocket, joinerSocket, roundData, hostResult, joinResult } =
      await setupAndStartRound("price-match");

    // Host assigns prices in the given order
    const hostAssignments: Record<number, number> = {};
    for (let i = 0; i < roundData.products.length; i++) {
      hostAssignments[roundData.products[i].id] = roundData.prices[i];
    }

    // Joiner assigns prices in reverse order (different from host)
    const joinerAssignments: Record<number, number> = {};
    const reversedPrices = [...roundData.prices].reverse();
    for (let i = 0; i < roundData.products.length; i++) {
      joinerAssignments[roundData.products[i].id] = reversedPrices[i];
    }

    await submitGuess(hostSocket, { assignments: hostAssignments });

    // Both sockets listen for round_end
    const hostEndP = waitForEvent(hostSocket, "game:round_end");
    const joinerEndP = waitForEvent(joinerSocket, "game:round_end");
    await submitGuess(joinerSocket, { assignments: joinerAssignments });
    const hostRoundEnd = await hostEndP;
    const joinerRoundEnd = await joinerEndP;

    // Both players receive the same broadcast payload
    expect(hostRoundEnd.playerResults.length).toBe(2);
    expect(joinerRoundEnd.playerResults.length).toBe(2);

    // Each player's guessData should reflect their individual assignments
    const hostPlayerResult = hostRoundEnd.playerResults.find(
      (p: any) => p.playerId === hostResult.playerId
    );
    const joinerPlayerResult = hostRoundEnd.playerResults.find(
      (p: any) => p.playerId === joinResult.playerId
    );

    expect(hostPlayerResult).toBeDefined();
    expect(joinerPlayerResult).toBeDefined();
    expect(hostPlayerResult.guessData.assignments).toBeDefined();
    expect(joinerPlayerResult.guessData.assignments).toBeDefined();

    // The two sets of assignments should be different
    const hostData = JSON.stringify(hostPlayerResult.guessData.assignments);
    const joinerData = JSON.stringify(joinerPlayerResult.guessData.assignments);
    expect(hostData).not.toBe(joinerData);

    // Verify each player's assignments match what they submitted
    for (const p of roundData.products) {
      expect(hostPlayerResult.guessData.assignments[String(p.id)]).toBe(hostAssignments[p.id]);
      expect(joinerPlayerResult.guessData.assignments[String(p.id)]).toBe(joinerAssignments[p.id]);
    }
  });
});

describe("Riser mode — full round", () => {
  it("plays a riser round with rising price mechanics", async () => {
    const { hostSocket, joinerSocket, roundData } = await setupAndStartRound("riser");

    expect(roundData.gameMode).toBe("riser");
    expect(roundData.product).toBeDefined();
    expect(roundData.maxPriceCents).toBeDefined();
    expect(roundData.maxPriceCents).toBeGreaterThan(0);
    expect(roundData.speedPattern).toMatch(/^(linear|accelerating|decelerating|wave)$/);
    expect(roundData.durationMs).toBeDefined();
    expect(roundData.durationMs).toBeGreaterThanOrEqual(8000);

    await submitGuess(hostSocket, { stoppedPriceCents: 5000 });
    const endP = waitForEvent(hostSocket, "game:round_end");
    await submitGuess(joinerSocket, { stoppedPriceCents: 3000 });
    const roundEnd = await endP;

    expect(roundEnd.revealData.product.priceCents).toBeDefined();
    expect(roundEnd.revealData.maxPriceCents).toBeDefined();
  });
});

describe("Odd One Out mode — full round", () => {
  it("plays an odd-one-out round with products", async () => {
    const { hostSocket, joinerSocket, roundData } = await setupAndStartRound("odd-one-out");

    expect(roundData.gameMode).toBe("odd-one-out");
    expect(roundData.products).toBeDefined();
    expect(roundData.products.length).toBeGreaterThanOrEqual(3);

    // Host picks first product, joiner picks second (different guesses)
    await submitGuess(hostSocket, { guessedProductId: roundData.products[0].id });
    const endP = waitForEvent(hostSocket, "game:round_end");
    await submitGuess(joinerSocket, { guessedProductId: roundData.products[1].id });
    const roundEnd = await endP;

    expect(roundEnd.revealData.products.length).toBeGreaterThanOrEqual(3);
    expect(roundEnd.revealData.outlierProductId).toBeDefined();
    expect(roundEnd.playerResults.length).toBe(2);
  });
});

describe("Market Basket mode — full round", () => {
  it("plays a market-basket round with total guessing", async () => {
    const { hostSocket, joinerSocket, roundData } = await setupAndStartRound("market-basket");

    expect(roundData.gameMode).toBe("market-basket");
    expect(roundData.products).toBeDefined();
    expect(roundData.products.length).toBeGreaterThanOrEqual(2);

    await submitGuess(hostSocket, { guessedTotalCents: 5000 });
    const endP = waitForEvent(hostSocket, "game:round_end");
    await submitGuess(joinerSocket, { guessedTotalCents: 1 });
    const roundEnd = await endP;

    expect(roundEnd.revealData.products).toBeDefined();
    expect(roundEnd.revealData.actualTotalCents).toBeDefined();
    expect(roundEnd.playerResults.length).toBe(2);

    // Different guesses produce distinct guessData entries
    const p1 = roundEnd.playerResults.find((p: any) => p.guessData?.guessedTotalCents === 5000);
    const p2 = roundEnd.playerResults.find((p: any) => p.guessData?.guessedTotalCents === 1);
    expect(p1).toBeDefined();
    expect(p2).toBeDefined();
    expect(p1.playerId).not.toBe(p2.playerId);
  });
});

describe("Sort It Out mode — full round", () => {
  it("plays a sort-it-out round with ordering", async () => {
    const { hostSocket, joinerSocket, roundData } = await setupAndStartRound("sort-it-out");

    expect(roundData.gameMode).toBe("sort-it-out");
    expect(roundData.products).toBeDefined();
    expect(roundData.products.length).toBeGreaterThanOrEqual(3);

    const productIds = roundData.products.map((p: any) => p.id);
    const reversedIds = [...productIds].reverse();

    await submitGuess(hostSocket, { submittedOrder: productIds });
    const endP = waitForEvent(hostSocket, "game:round_end");
    await submitGuess(joinerSocket, { submittedOrder: reversedIds });
    const roundEnd = await endP;

    expect(roundEnd.revealData.correctOrder).toBeDefined();
    expect(roundEnd.revealData.correctOrder.length).toBe(productIds.length);
    expect(roundEnd.playerResults.length).toBe(2);

    // Players submitted different orders — guessData should differ
    const guessDataStrings = roundEnd.playerResults.map(
      (p: any) => JSON.stringify(p.guessData?.submittedOrder)
    );
    expect(guessDataStrings[0]).not.toBe(guessDataStrings[1]);
  });
});

describe("Budget Builder mode — full round", () => {
  it("plays a budget-builder round with product selection", async () => {
    const { hostSocket, joinerSocket, roundData } = await setupAndStartRound("budget-builder");

    expect(roundData.gameMode).toBe("budget-builder");
    expect(roundData.products).toBeDefined();
    expect(roundData.budgetCents).toBeDefined();

    // Host picks first item, joiner picks last item
    await submitGuess(hostSocket, { selectedProductIds: [roundData.products[0].id] });
    const endP = waitForEvent(hostSocket, "game:round_end");
    await submitGuess(joinerSocket, { selectedProductIds: [roundData.products[roundData.products.length - 1].id] });
    const roundEnd = await endP;

    expect(roundEnd.revealData.products).toBeDefined();
    expect(roundEnd.revealData.budgetCents).toBeDefined();
    expect(roundEnd.playerResults.length).toBe(2);
  });
});

describe("Chain Reaction mode — full round", () => {
  it("plays a chain-reaction round with sequential guessing", async () => {
    const { hostSocket, joinerSocket, roundData } = await setupAndStartRound("chain-reaction");

    expect(roundData.gameMode).toBe("chain-reaction");
    expect(roundData.products).toBeDefined();
    expect(roundData.products.length).toBeGreaterThanOrEqual(2);

    const chainLength = roundData.products.length - 1;
    const hostGuesses = Array(chainLength).fill("more");
    const joinerGuesses = Array(chainLength).fill("less");

    await submitGuess(hostSocket, { chainGuesses: hostGuesses });
    const endP = waitForEvent(hostSocket, "game:round_end");
    await submitGuess(joinerSocket, { chainGuesses: joinerGuesses });
    const roundEnd = await endP;

    expect(roundEnd.revealData.products).toBeDefined();
    expect(roundEnd.playerResults.length).toBe(2);

    // Players submitted different guesses
    const p1 = roundEnd.playerResults.find((p: any) => p.guessData?.chainGuesses?.[0] === "more");
    const p2 = roundEnd.playerResults.find((p: any) => p.guessData?.chainGuesses?.[0] === "less");
    expect(p1).toBeDefined();
    expect(p2).toBeDefined();
  });
});

describe("Cross-mode scoring validation", () => {
  it("two players guessing differently get different scores in classic", async () => {
    const { hostSocket, joinerSocket, roundData } = await setupAndStartRound("classic");

    // Get the actual price from the DB
    const product = server.db
      .prepare("SELECT price_cents FROM products WHERE id = ?")
      .get(roundData.product.id) as { price_cents: number };

    // Host guesses exactly right, joiner guesses way off
    await submitGuess(hostSocket, { guessedPriceCents: product.price_cents });
    const endP = waitForEvent(hostSocket, "game:round_end");
    await submitGuess(joinerSocket, { guessedPriceCents: 1 });
    const roundEnd = await endP;

    const hostResult = roundEnd.playerResults.find(
      (p: any) => p.guessData?.guessedPriceCents === product.price_cents
    );
    const joinerResult = roundEnd.playerResults.find(
      (p: any) => p.guessData?.guessedPriceCents === 1
    );

    expect(hostResult).toBeDefined();
    expect(hostResult.score).toBe(1000);
    expect(joinerResult).toBeDefined();
    expect(joinerResult.score).toBe(0);
  });
});
