import { describe, it, expect } from "vitest";
import { renderHook } from "@testing-library/react";
import type { RoundResultsPayload } from "@price-game/shared";
import {
  buildShareData,
  useShareData,
  buildSharedRoundSnapshots,
  buildSPRoundSnapshots,
  buildMPRoundSnapshots,
} from "../hooks/useShareData";

describe("buildShareData (single-player)", () => {
  it("extracts scores from roundResults in order", () => {
    const result = buildShareData({
      variant: "sp",
      gameMode: "classic",
      roundResults: [
        { score: 1000 },
        { score: 750 },
        { score: 500 },
        { score: 250 },
        { score: 0 },
        { score: 900 },
        { score: 800 },
        { score: 700 },
        { score: 600 },
        { score: 100 },
      ],
      totalScore: 5600,
    });
    expect(result.roundScores).toEqual([1000, 750, 500, 250, 0, 900, 800, 700, 600, 100]);
    expect(result.totalScore).toBe(5600);
    expect(result.gameMode).toBe("classic");
    expect(result.modeName).toBe("Precision");
    expect(result.perRoundMax).toBe(1000);
  });

  it("sets perRoundMax to 1313 for chain-reaction mode", () => {
    const result = buildShareData({
      variant: "sp",
      gameMode: "chain-reaction",
      roundResults: [],
      totalScore: 0,
    });
    expect(result.perRoundMax).toBe(1313);
    expect(result.modeName).toBe("Chain Reaction");
  });

  it("handles empty roundResults arrays gracefully", () => {
    const result = buildShareData({
      variant: "sp",
      gameMode: "higher-lower",
      roundResults: [],
      totalScore: 0,
    });
    expect(result.roundScores).toEqual([]);
  });

  it("maps missing per-round score to 0", () => {
    const result = buildShareData({
      variant: "sp",
      gameMode: "classic",
      // deliberately malformed; simulates a defensive read on any[] shapes
      roundResults: [{ score: 900 }, {} as { score: number }, { score: 500 }],
      totalScore: 1400,
    });
    expect(result.roundScores).toEqual([900, 0, 500]);
  });
});

describe("buildShareData (multiplayer)", () => {
  function mkRound(
    roundNumber: number,
    scoresByPid: Record<string, number>
  ): RoundResultsPayload {
    return {
      roundNumber,
      gameMode: "classic",
      // revealData isn't used by buildShareData, cast loosely to avoid a
      // lengthy valid reveal structure per test.
      revealData: { mode: "classic", product: {} as never } as never,
      playerResults: Object.entries(scoresByPid).map(([playerId, score]) => ({
        playerId,
        displayName: playerId,
        avatar: "wizard",
        score,
        guessData: null,
      })),
      standings: [],
    };
  }

  it("extracts the current player's score from each round", () => {
    const all: RoundResultsPayload[] = [
      mkRound(1, { me: 1000, other: 500 }),
      mkRound(2, { me: 500, other: 800 }),
      mkRound(3, { me: 0, other: 1000 }),
    ];
    const result = buildShareData({
      variant: "mp",
      gameMode: "classic",
      allRoundResults: all,
      currentPlayerId: "me",
      totalScore: 1500,
    });
    expect(result.roundScores).toEqual([1000, 500, 0]);
  });

  it("treats a missing currentPlayerId as an empty score array", () => {
    const all: RoundResultsPayload[] = [
      mkRound(1, { me: 1000, other: 500 }),
    ];
    const result = buildShareData({
      variant: "mp",
      gameMode: "classic",
      allRoundResults: all,
      currentPlayerId: null,
      totalScore: 0,
    });
    expect(result.roundScores).toEqual([]);
  });

  it("treats an undefined currentPlayerId as an empty score array", () => {
    const result = buildShareData({
      variant: "mp",
      gameMode: "classic",
      allRoundResults: [mkRound(1, { me: 1000 })],
      currentPlayerId: undefined,
      totalScore: 0,
    });
    expect(result.roundScores).toEqual([]);
  });

  it("defaults a round's score to 0 when the current player is missing (late joiner)", () => {
    const all: RoundResultsPayload[] = [
      mkRound(1, { other: 800 }),                // me wasn't here
      mkRound(2, { me: 750, other: 600 }),       // joined
      mkRound(3, { me: 1000, other: 200 }),
    ];
    const result = buildShareData({
      variant: "mp",
      gameMode: "classic",
      allRoundResults: all,
      currentPlayerId: "me",
      totalScore: 1750,
    });
    expect(result.roundScores).toEqual([0, 750, 1000]);
  });

  it("handles empty allRoundResults array", () => {
    const result = buildShareData({
      variant: "mp",
      gameMode: "classic",
      allRoundResults: [],
      currentPlayerId: "me",
      totalScore: 0,
    });
    expect(result.roundScores).toEqual([]);
  });

  it("sets perRoundMax and modeName from gameMode", () => {
    const result = buildShareData({
      variant: "mp",
      gameMode: "chain-reaction",
      allRoundResults: [],
      currentPlayerId: "me",
      totalScore: 0,
    });
    expect(result.perRoundMax).toBe(1313);
    expect(result.modeName).toBe("Chain Reaction");
  });
});

describe("useShareData hook", () => {
  it("returns the same ShareGridInput as buildShareData", () => {
    const spInput = {
      variant: "sp" as const,
      gameMode: "classic" as const,
      roundResults: [{ score: 1000 }, { score: 500 }],
      totalScore: 1500,
    };
    const { result } = renderHook(() => useShareData(spInput));
    expect(result.current).toEqual(buildShareData(spInput));
  });

  it("memoizes across renders with the same input reference", () => {
    const spInput = {
      variant: "sp" as const,
      gameMode: "higher-lower" as const,
      roundResults: [{ score: 800 }],
      totalScore: 800,
    };
    const { result, rerender } = renderHook(() => useShareData(spInput));
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });

  it("memoizes across renders even when caller passes an inline object literal", () => {
    // Regression guard: the previous implementation used the whole input
    // object as its single dep, which was always a new reference when the
    // caller passed an inline literal — defeating the memo. The fixed
    // version destructures each field, so the memo survives identity-only
    // parent re-renders.
    const roundResults = [{ score: 1000 }, { score: 500 }];
    const { result, rerender } = renderHook(() =>
      useShareData({
        variant: "sp",
        gameMode: "classic",
        roundResults,
        totalScore: 1500,
      })
    );
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });

  it("invalidates the memo when a dependency field changes", () => {
    let score = 1000;
    const { result, rerender } = renderHook(() =>
      useShareData({
        variant: "sp",
        gameMode: "classic",
        roundResults: [{ score: 1 }],
        totalScore: score,
      })
    );
    const first = result.current;
    score = 2000;
    rerender();
    expect(result.current).not.toBe(first);
    expect(result.current.totalScore).toBe(2000);
  });
});

describe("buildSharedRoundSnapshots (SP)", () => {
  it("maps single-product round results to snapshots with 1-based roundNumber", () => {
    const result = buildSPRoundSnapshots([
      {
        score: 1000,
        product: {
          title: "Widget",
          imageUrl: "https://e.co/w.jpg",
          priceCents: 1999,
          amazonUrl: "https://amz.co/w",
        },
        guessedPriceCents: 1950,
      },
      {
        score: 500,
        product: {
          title: "Gadget",
          imageUrl: "https://e.co/g.jpg",
          priceCents: 2999,
        },
        guessedPriceCents: 3500,
      },
    ]);
    expect(result).toHaveLength(2);
    expect(result[0].roundNumber).toBe(1);
    expect(result[0].score).toBe(1000);
    expect(result[0].products).toEqual([
      {
        title: "Widget",
        imageUrl: "https://e.co/w.jpg",
        priceCents: 1999,
        amazonUrl: "https://amz.co/w",
      },
    ]);
    expect(result[0].guessedPriceCents).toBe(1950);
    expect(result[1].roundNumber).toBe(2);
    expect(result[1].products[0].amazonUrl).toBeUndefined();
  });

  it("maps multi-product round results (comparison/price-match/etc.) with all products", () => {
    const result = buildSPRoundSnapshots([
      {
        score: 600,
        products: [
          { title: "A", imageUrl: "https://e.co/a.jpg", priceCents: 1000 },
          { title: "B", imageUrl: "https://e.co/b.jpg", priceCents: 2000 },
        ],
        guessedProductId: 42,
        correct: true,
      },
    ]);
    expect(result[0].products).toHaveLength(2);
    expect(result[0].guessedProductId).toBe(42);
    expect(result[0].correct).toBe(true);
  });

  it("handles a round with neither product nor products by returning an empty products array", () => {
    const result = buildSPRoundSnapshots([{ score: 0 }]);
    expect(result[0].products).toEqual([]);
  });

  it("carries through every mode-specific optional field when present", () => {
    const result = buildSPRoundSnapshots([
      {
        score: 1000,
        product: { title: "X", imageUrl: "https://e.co/x.jpg", priceCents: 100 },
        guessedPriceCents: 100,
        guess: "higher",
        correct: true,
        correctCount: 3,
        wentOver: false,
        referencePrice: 50,
        actualTotalCents: 200,
        guessedTotalCents: 180,
        budgetCents: 500,
        cartTotalCents: 490,
        outlierProductId: 7,
        guessedProductId: 7,
      },
    ]);
    const s = result[0];
    expect(s.guess).toBe("higher");
    expect(s.correct).toBe(true);
    expect(s.correctCount).toBe(3);
    expect(s.wentOver).toBe(false);
    expect(s.referencePrice).toBe(50);
    expect(s.actualTotalCents).toBe(200);
    expect(s.guessedTotalCents).toBe(180);
    expect(s.budgetCents).toBe(500);
    expect(s.cartTotalCents).toBe(490);
    expect(s.outlierProductId).toBe(7);
    expect(s.guessedProductId).toBe(7);
  });
});

describe("buildSharedRoundSnapshots (MP)", () => {
  function mkReveal(mode: string, products: Array<{ title: string; imageUrl: string; priceCents: number }>) {
    if (mode === "classic") {
      return { mode: "classic", product: products[0] } as never;
    }
    return { mode, products } as never;
  }
  function mkRound(
    roundNumber: number,
    gameMode: "classic" | "comparison",
    scoresByPid: Record<string, number>,
    products: Array<{ title: string; imageUrl: string; priceCents: number }>
  ): RoundResultsPayload {
    return {
      roundNumber,
      gameMode,
      revealData: mkReveal(gameMode, products),
      playerResults: Object.entries(scoresByPid).map(([playerId, score]) => ({
        playerId,
        displayName: playerId,
        avatar: "wizard",
        score,
        guessData: null,
      })),
      standings: [],
    };
  }

  it("extracts the current player's score and the round's product for each entry", () => {
    const rounds: RoundResultsPayload[] = [
      mkRound(1, "classic", { me: 1000, other: 500 }, [
        { title: "P1", imageUrl: "https://e.co/p1.jpg", priceCents: 100 },
      ]),
      mkRound(2, "classic", { me: 0, other: 900 }, [
        { title: "P2", imageUrl: "https://e.co/p2.jpg", priceCents: 200 },
      ]),
    ];
    const result = buildMPRoundSnapshots(rounds, "me");
    expect(result).toHaveLength(2);
    expect(result[0].score).toBe(1000);
    expect(result[0].products[0].title).toBe("P1");
    expect(result[1].score).toBe(0);
    expect(result[1].products[0].title).toBe("P2");
  });

  it("handles multi-product reveal modes (comparison) by returning all products", () => {
    const rounds: RoundResultsPayload[] = [
      mkRound(1, "comparison", { me: 800 }, [
        { title: "A", imageUrl: "https://e.co/a.jpg", priceCents: 100 },
        { title: "B", imageUrl: "https://e.co/b.jpg", priceCents: 200 },
      ]),
    ];
    const result = buildMPRoundSnapshots(rounds, "me");
    expect(result[0].products).toHaveLength(2);
  });

  it("defaults the score to 0 when the player didn't play the round (late joiner)", () => {
    const rounds: RoundResultsPayload[] = [
      mkRound(1, "classic", { other: 800 }, [
        { title: "A", imageUrl: "https://e.co/a.jpg", priceCents: 100 },
      ]),
    ];
    const result = buildMPRoundSnapshots(rounds, "me");
    expect(result[0].score).toBe(0);
  });

  it("returns an empty array when currentPlayerId is nullish", () => {
    const rounds: RoundResultsPayload[] = [
      mkRound(1, "classic", { me: 800 }, [
        { title: "A", imageUrl: "https://e.co/a.jpg", priceCents: 100 },
      ]),
    ];
    expect(buildMPRoundSnapshots(rounds, null)).toEqual([]);
    expect(buildMPRoundSnapshots(rounds, undefined)).toEqual([]);
  });
});

describe("buildSharedRoundSnapshots (dispatcher)", () => {
  it("dispatches to the SP builder for variant='sp'", () => {
    const result = buildSharedRoundSnapshots({
      variant: "sp",
      gameMode: "classic",
      roundResults: [
        { score: 500, product: { title: "X", imageUrl: "https://e.co/x.jpg", priceCents: 100 } },
      ],
      totalScore: 500,
    });
    expect(result).toHaveLength(1);
    expect(result[0].products[0].title).toBe("X");
  });

  it("dispatches to the MP builder for variant='mp'", () => {
    const rounds: RoundResultsPayload[] = [
      {
        roundNumber: 1,
        gameMode: "classic",
        revealData: {
          mode: "classic",
          product: {
            id: 1,
            title: "Y",
            imageUrl: "https://e.co/y.jpg",
            description: "",
            category: "",
            priceCents: 300,
          },
        } as never,
        playerResults: [
          { playerId: "me", displayName: "Me", avatar: "wizard", score: 700, guessData: null },
        ],
        standings: [],
      },
    ];
    const result = buildSharedRoundSnapshots({
      variant: "mp",
      gameMode: "classic",
      allRoundResults: rounds,
      currentPlayerId: "me",
      totalScore: 700,
    });
    expect(result).toHaveLength(1);
    expect(result[0].score).toBe(700);
    expect(result[0].products[0].title).toBe("Y");
  });
});
