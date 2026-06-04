import { describe, it, expect, afterEach } from "vitest";
import {
  initBiddingRound,
  getBiddingState,
  getCurrentBidder,
  recordBid,
  cleanupBiddingState,
} from "./mpBiddingState";

afterEach(() => {
  cleanupBiddingState("test-room");
});

const players = [
  { playerId: "p1", displayName: "Alice", avatar: "wizard" },
  { playerId: "p2", displayName: "Bob", avatar: "yeti" },
  { playerId: "p3", displayName: "Charlie", avatar: "fancy-ghost" },
];

describe("initBiddingRound", () => {
  it("stores state and returns a shuffled order", () => {
    const order = initBiddingRound("test-room", players, 42);
    expect(order).toHaveLength(3);
    // All players present
    const ids = order.map((o) => o.playerId).sort();
    expect(ids).toEqual(["p1", "p2", "p3"]);

    const state = getBiddingState("test-room");
    expect(state).toBeDefined();
    expect(state!.currentTurnIndex).toBe(0);
    expect(state!.bids).toEqual([]);
    expect(state!.productId).toBe(42);
  });
});

describe("getCurrentBidder", () => {
  it("returns the current player in the order", () => {
    const order = initBiddingRound("test-room", players, 1);
    const bidder = getCurrentBidder("test-room");
    expect(bidder).toBeDefined();
    expect(bidder!.playerId).toBe(order[0].playerId);
  });

  it("returns undefined for unknown room", () => {
    expect(getCurrentBidder("nonexistent")).toBeUndefined();
  });
});

describe("recordBid", () => {
  it("records a bid and advances the turn", () => {
    const order = initBiddingRound("test-room", players, 1);
    const firstBidderId = order[0].playerId;

    const result = recordBid("test-room", firstBidderId, 5000);
    expect(result).toBeDefined();
    expect(result!.allBidsIn).toBe(false);
    expect(result!.bid.playerId).toBe(firstBidderId);
    expect(result!.bid.bidCents).toBe(5000);
    expect(result!.bid.turnIndex).toBe(0);

    const state = getBiddingState("test-room");
    expect(state!.currentTurnIndex).toBe(1);
    expect(state!.bids).toHaveLength(1);
  });

  it("rejects out-of-turn bids", () => {
    const order = initBiddingRound("test-room", players, 1);
    const secondBidderId = order[1].playerId;
    const result = recordBid("test-room", secondBidderId, 5000);
    expect(result).toBeNull();
  });

  it("returns allBidsIn after last player bids", () => {
    const order = initBiddingRound("test-room", players, 1);
    recordBid("test-room", order[0].playerId, 5000);
    recordBid("test-room", order[1].playerId, 4000);
    const result = recordBid("test-room", order[2].playerId, 3000);
    expect(result!.allBidsIn).toBe(true);
  });

  it("returns null for unknown room", () => {
    expect(recordBid("nonexistent", "p1", 5000)).toBeNull();
  });
});

describe("cleanupBiddingState", () => {
  it("removes all state for a room", () => {
    initBiddingRound("test-room", players, 1);
    cleanupBiddingState("test-room");
    expect(getBiddingState("test-room")).toBeUndefined();
  });

  it("is safe to call for unknown room", () => {
    expect(() => cleanupBiddingState("nonexistent")).not.toThrow();
  });
});
