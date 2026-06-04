import { describe, it, expect } from "vitest";
import {
  scoreToTier,
  tierToEmoji,
  getPerRoundMaxScore,
  buildShareText,
  buildShareAccessibleText,
  buildRankSuffix,
  SHARE_TIER_EMOJI,
  SHARE_FOOTER_URL,
  getGameModeName,
  TOTAL_ROUNDS,
  type ShareTier,
  type ShareGridInput,
  type GameMode,
} from "@price-game/shared";

// All 11 game modes, so we can iterate uniformly in some tests.
const ALL_MODES: GameMode[] = [
  "classic",
  "higher-lower",
  "comparison",
  "closest-without-going-over",
  "price-match",
  "riser",
  "odd-one-out",
  "market-basket",
  "sort-it-out",
  "budget-builder",
  "chain-reaction",
];

function makeInput(overrides: Partial<ShareGridInput> = {}): ShareGridInput {
  const gameMode: GameMode = overrides.gameMode ?? "classic";
  const perRoundMax = overrides.perRoundMax ?? getPerRoundMaxScore(gameMode);
  const base: ShareGridInput = {
    gameMode,
    modeName: overrides.modeName ?? getGameModeName(gameMode),
    roundScores: overrides.roundScores ?? Array(TOTAL_ROUNDS).fill(1000),
    totalScore: overrides.totalScore ?? 10000,
    perRoundMax,
  };
  if (overrides.playerRank !== undefined) base.playerRank = overrides.playerRank;
  if (overrides.playerCount !== undefined) base.playerCount = overrides.playerCount;
  return base;
}

describe("getPerRoundMaxScore", () => {
  it("returns 1000 for every non-chain-reaction mode", () => {
    for (const mode of ALL_MODES) {
      if (mode === "chain-reaction") continue;
      expect(getPerRoundMaxScore(mode)).toBe(1000);
    }
  });

  it("returns 1313 for chain-reaction (4 sub-guesses + perfect bonus)", () => {
    // Hand-verified: 100 + 150 + 225 + round(100 * 1.5^3) + 500 = 813 + 500 = 1313
    expect(getPerRoundMaxScore("chain-reaction")).toBe(1313);
  });

  it("is exhaustively defined for every GameMode (no undefined)", () => {
    for (const mode of ALL_MODES) {
      expect(Number.isFinite(getPerRoundMaxScore(mode))).toBe(true);
    }
  });
});

describe("scoreToTier", () => {
  const MAX = 1000;

  it("classifies 0 as miss", () => {
    expect(scoreToTier(0, MAX)).toBe("miss");
  });

  it("classifies negative scores as miss (defensive)", () => {
    expect(scoreToTier(-100, MAX)).toBe("miss");
  });

  it("classifies 1 as ok (any positive non-good score)", () => {
    expect(scoreToTier(1, MAX)).toBe("ok");
  });

  it("classifies 499 as ok (just under good threshold)", () => {
    expect(scoreToTier(499, MAX)).toBe("ok");
  });

  it("classifies 500 as good (exactly 50%)", () => {
    expect(scoreToTier(500, MAX)).toBe("good");
  });

  it("classifies 899 as good (just under great threshold)", () => {
    expect(scoreToTier(899, MAX)).toBe("good");
  });

  it("classifies 900 as great (exactly 90%)", () => {
    expect(scoreToTier(900, MAX)).toBe("great");
  });

  it("classifies 1000 (perfect) as great", () => {
    expect(scoreToTier(1000, MAX)).toBe("great");
  });

  it("defends against zero perRoundMax by returning miss", () => {
    expect(scoreToTier(500, 0)).toBe("miss");
  });

  it("defends against negative perRoundMax by returning miss", () => {
    expect(scoreToTier(500, -1000)).toBe("miss");
  });

  it("scales correctly for chain-reaction's higher max", () => {
    const CR_MAX = 1313;
    expect(scoreToTier(1182, CR_MAX)).toBe("great"); // 1182/1313 ≈ 0.900
    expect(scoreToTier(1181, CR_MAX)).toBe("good");  // ≈ 0.8995 -> good
    expect(scoreToTier(657, CR_MAX)).toBe("good");   // 0.500
    expect(scoreToTier(656, CR_MAX)).toBe("ok");     // just under 0.5
  });
});

describe("tierToEmoji", () => {
  it("maps each tier to its Wordle-style emoji", () => {
    expect(tierToEmoji("great")).toBe("🟩");
    expect(tierToEmoji("good")).toBe("🟨");
    expect(tierToEmoji("ok")).toBe("🟧");
    expect(tierToEmoji("miss")).toBe("⬛");
  });

  it("exposes the same mapping via SHARE_TIER_EMOJI for direct use", () => {
    const tiers: ShareTier[] = ["great", "good", "ok", "miss"];
    for (const t of tiers) {
      expect(SHARE_TIER_EMOJI[t]).toBe(tierToEmoji(t));
    }
  });
});

describe("buildShareText", () => {
  it("formats a perfect classic game", () => {
    const text = buildShareText(
      makeInput({ roundScores: Array(10).fill(1000), totalScore: 10000 })
    );
    expect(text).toBe(
      [
        "Price Games | Precision | 10,000/10,000",
        "🟩🟩🟩🟩🟩",
        "🟩🟩🟩🟩🟩",
        "play at price.games",
      ].join("\n")
    );
  });

  it("formats a mixed classic game with all four tiers", () => {
    const scores = [1000, 1000, 750, 1000, 0, 500, 1000, 1000, 300, 950];
    const text = buildShareText(makeInput({ roundScores: scores, totalScore: 7500 }));
    const lines = text.split("\n");
    expect(lines[0]).toBe("Price Games | Precision | 7,500/10,000");
    expect(lines[1]).toBe("🟩🟩🟨🟩⬛");
    expect(lines[2]).toBe("🟨🟩🟩🟧🟩");
    expect(lines[3]).toBe("play at price.games");
  });

  it("renders short roundScores without padding (3-round game = 1 row of 3)", () => {
    const text = buildShareText(
      makeInput({ roundScores: [1000, 1000, 1000], totalScore: 3000 })
    );
    const lines = text.split("\n");
    expect(lines[0]).toBe("Price Games | Precision | 3,000/3,000");
    expect(lines[1]).toBe("🟩🟩🟩");
    expect(lines.length).toBe(3); // header + 1 row + footer
  });

  it("truncates roundScores arrays longer than TOTAL_ROUNDS", () => {
    const scores = Array(15).fill(1000);
    const text = buildShareText(makeInput({ roundScores: scores, totalScore: 10000 }));
    const lines = text.split("\n");
    expect(lines[1]).toBe("🟩🟩🟩🟩🟩");
    expect(lines[2]).toBe("🟩🟩🟩🟩🟩");
    // Only 10 tiles (TOTAL_ROUNDS max), so 2 rows + header + footer.
    expect(lines.length).toBe(4);
  });

  it("handles an all-miss game", () => {
    const text = buildShareText(
      makeInput({ roundScores: Array(10).fill(0), totalScore: 0 })
    );
    const lines = text.split("\n");
    expect(lines[0]).toBe("Price Games | Precision | 0/10,000");
    expect(lines[1]).toBe("⬛⬛⬛⬛⬛");
    expect(lines[2]).toBe("⬛⬛⬛⬛⬛");
  });

  it("uses 13,130 as the total max for chain-reaction", () => {
    const text = buildShareText(
      makeInput({
        gameMode: "chain-reaction",
        modeName: "Chain Reaction",
        roundScores: Array(10).fill(1313),
        totalScore: 13130,
      })
    );
    expect(text.split("\n")[0]).toBe("Price Games | Chain Reaction | 13,130/13,130");
  });

  it("formats each game mode with its correct display name", () => {
    for (const mode of ALL_MODES) {
      const text = buildShareText(
        makeInput({
          gameMode: mode,
          modeName: getGameModeName(mode),
          roundScores: Array(10).fill(0),
          totalScore: 0,
        })
      );
      expect(text).toContain(`Price Games | ${getGameModeName(mode)} |`);
    }
  });

  it("uses the SHARE_FOOTER_URL constant in its footer line", () => {
    const text = buildShareText(makeInput());
    expect(text).toContain(`play at ${SHARE_FOOTER_URL}`);
  });

  it("does not emit a trailing newline", () => {
    const text = buildShareText(makeInput());
    expect(text.endsWith("\n")).toBe(false);
  });

  it("uses pipe separators (not em-dash) in the header to survive clipboard encoding", () => {
    const text = buildShareText(makeInput());
    const header = text.split("\n")[0];
    expect(header).toContain(" | ");
    expect(header).not.toContain("—");
  });

  it("uses the shareUrl option verbatim as the footer when provided", () => {
    const text = buildShareText(makeInput(), {
      shareUrl: "price.games/s/aBcD1234",
    });
    const lines = text.split("\n");
    expect(lines[lines.length - 1]).toBe("price.games/s/aBcD1234");
    // No "play at " prefix when a shareUrl is given.
    expect(text).not.toContain("play at");
  });

  it("falls back to the default footer when shareUrl is empty string", () => {
    const text = buildShareText(makeInput(), { shareUrl: "" });
    expect(text).toContain("play at price.games");
  });

  it("falls back to the default footer when options is undefined", () => {
    const text = buildShareText(makeInput(), undefined);
    expect(text).toContain("play at price.games");
  });

  it("omits the footer entirely when omitFooter is true", () => {
    const text = buildShareText(makeInput(), {
      shareUrl: "price.games/s/aBcD1234",
      omitFooter: true,
    });
    expect(text).not.toContain("price.games/s/aBcD1234");
    expect(text).not.toContain("play at price.games");
    // Header + emoji rows only — no footer line means no trailing URL.
    const lines = text.split("\n");
    expect(lines[0]).toContain("Price Games");
    expect(lines[lines.length - 1]).not.toContain("price.games");
  });
});

describe("buildShareAccessibleText", () => {
  it("describes a perfect game in prose", () => {
    const text = buildShareAccessibleText(
      makeInput({ roundScores: Array(10).fill(1000), totalScore: 10000 })
    );
    expect(text).toBe(
      "Price Games, Precision. Score 10,000 of 10,000. Row 1: 5 great. Row 2: 5 great."
    );
  });

  it("describes a mixed game with all four tier categories", () => {
    const scores = [1000, 1000, 750, 1000, 0, 500, 1000, 1000, 300, 950];
    const text = buildShareAccessibleText(makeInput({ roundScores: scores, totalScore: 7500 }));
    expect(text).toBe(
      "Price Games, Precision. Score 7,500 of 10,000. Row 1: 3 great, 1 good, 1 miss. Row 2: 3 great, 1 good, 1 ok."
    );
  });

  it("describes an all-miss game", () => {
    const text = buildShareAccessibleText(
      makeInput({ roundScores: Array(10).fill(0), totalScore: 0 })
    );
    expect(text).toContain("Row 1: 5 miss. Row 2: 5 miss.");
  });

  it("handles empty roundScores gracefully (no rounds to describe)", () => {
    const text = buildShareAccessibleText(makeInput({ roundScores: [], totalScore: 0 }));
    expect(text).toContain("Score 0 of 0");
    expect(text).toContain("Row 1: no rounds.");
  });

  it("matches the visual grid exactly (no drift between visual and a11y representations)", () => {
    // Spot-check: same input must produce tier descriptions consistent with buildShareText tiles.
    const scores = [900, 500, 1, 0, 1000, 450, 499, 501, 899, 1313];
    const input = makeInput({ roundScores: scores, totalScore: 5663 });
    const visualRows = buildShareText(input).split("\n").slice(1, 3);
    const row1Tiles = Array.from(visualRows[0]);
    const row2Tiles = Array.from(visualRows[1]);
    // Count visual tiles per tier.
    function countTiles(tiles: string[]): Record<ShareTier, number> {
      const counts: Record<ShareTier, number> = { great: 0, good: 0, ok: 0, miss: 0 };
      const reverse = new Map<string, ShareTier>(
        (Object.entries(SHARE_TIER_EMOJI) as [ShareTier, string][]).map(([t, e]) => [e, t])
      );
      for (const tile of tiles) {
        const t = reverse.get(tile);
        if (t) counts[t]++;
      }
      return counts;
    }
    const visualCounts = [countTiles(row1Tiles), countTiles(row2Tiles)];
    const a11y = buildShareAccessibleText(input);
    // The a11y text should mention each non-zero visual bucket.
    for (let i = 0; i < 2; i++) {
      for (const tier of ["great", "good", "ok", "miss"] as ShareTier[]) {
        if (visualCounts[i][tier] > 0) {
          expect(a11y).toContain(`${visualCounts[i][tier]} ${tier}`);
        }
      }
    }
  });
});

describe("buildRankSuffix", () => {
  it("returns empty string when both rank and count are missing", () => {
    expect(buildRankSuffix()).toBe("");
    expect(buildRankSuffix(undefined, undefined)).toBe("");
  });

  it("returns empty string when only rank is provided", () => {
    expect(buildRankSuffix(2, undefined)).toBe("");
  });

  it("returns empty string when only count is provided", () => {
    expect(buildRankSuffix(undefined, 5)).toBe("");
  });

  it("renders ' · #N of M' when both inputs are valid", () => {
    expect(buildRankSuffix(1, 4)).toBe(" · #1 of 4");
    expect(buildRankSuffix(3, 6)).toBe(" · #3 of 6");
  });

  it("returns empty when rank exceeds count (defensive)", () => {
    expect(buildRankSuffix(5, 4)).toBe("");
  });

  it("returns empty when rank or count are non-positive", () => {
    expect(buildRankSuffix(0, 4)).toBe("");
    expect(buildRankSuffix(2, 0)).toBe("");
    expect(buildRankSuffix(-1, 4)).toBe("");
  });

  it("returns empty for non-finite numbers", () => {
    expect(buildRankSuffix(Number.NaN, 4)).toBe("");
    expect(buildRankSuffix(2, Number.POSITIVE_INFINITY)).toBe("");
  });

  it("floors fractional inputs so the rendered numbers stay integer", () => {
    expect(buildRankSuffix(1.7, 4.9)).toBe(" · #1 of 4");
  });
});

describe("buildShareText (finishing position suffix)", () => {
  it("appends ' · #N of M' to the header when rank+count are provided", () => {
    const text = buildShareText(
      makeInput({
        roundScores: [1000, 500, 200],
        totalScore: 1700,
        playerRank: 2,
        playerCount: 5,
      })
    );
    const header = text.split("\n")[0];
    expect(header).toBe("Price Games | Precision | 1,700/3,000 · #2 of 5");
  });

  it("omits the suffix when rank+count are missing", () => {
    const text = buildShareText(
      makeInput({
        roundScores: [1000, 500, 200],
        totalScore: 1700,
      })
    );
    const header = text.split("\n")[0];
    expect(header).toBe("Price Games | Precision | 1,700/3,000");
    expect(header).not.toContain(" · #");
    expect(header).not.toContain(" of ");
  });

  it("omits the suffix when rank+count are invalid (rank > count)", () => {
    const text = buildShareText(
      makeInput({
        roundScores: [1000],
        totalScore: 1000,
        playerRank: 9,
        playerCount: 4,
      })
    );
    const header = text.split("\n")[0];
    expect(header).not.toContain("#");
    expect(header).not.toContain(" of ");
  });

  it("renders the suffix alongside a custom shareUrl footer", () => {
    const text = buildShareText(
      makeInput({
        roundScores: [1000],
        totalScore: 1000,
        playerRank: 1,
        playerCount: 3,
      }),
      { shareUrl: "price.games/s/aBcD1234" }
    );
    const lines = text.split("\n");
    expect(lines[0]).toContain("· #1 of 3");
    expect(lines[lines.length - 1]).toBe("price.games/s/aBcD1234");
  });
});

describe("buildShareAccessibleText (finishing position)", () => {
  it("adds 'Finished #N of M.' when rank+count are provided", () => {
    const text = buildShareAccessibleText(
      makeInput({
        roundScores: [1000, 500, 200],
        totalScore: 1700,
        playerRank: 2,
        playerCount: 5,
      })
    );
    expect(text).toContain("Finished #2 of 5.");
  });

  it("omits the placement sentence when rank+count are missing", () => {
    const text = buildShareAccessibleText(
      makeInput({
        roundScores: [1000, 500, 200],
        totalScore: 1700,
      })
    );
    expect(text).not.toContain("Finished");
  });
});
