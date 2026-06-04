import { describe, it, expect, vi } from "vitest";
import type { ShareGridInput } from "@price-game/shared";
import { getGameModeName, getPerRoundMaxScore } from "@price-game/shared";
import {
  drawBackground,
  drawHeader,
  drawScore,
  drawGrid,
  drawFooter,
  drawShareCard,
  renderShareImage,
  SHARE_CANVAS_WIDTH,
  SHARE_CANVAS_HEIGHT,
  SHARE_COLORS,
  type ShareCanvasContext,
} from "../components/share/shareCanvas";

/**
 * A minimal spy context that records property writes and method calls so each
 * draw function can be asserted in isolation without touching jsdom's canvas.
 */
function createSpyContext(): ShareCanvasContext & {
  fillRect: ReturnType<typeof vi.fn>;
  fillText: ReturnType<typeof vi.fn>;
} {
  return {
    fillStyle: "",
    font: "",
    textAlign: "start" as CanvasTextAlign,
    textBaseline: "alphabetic" as CanvasTextBaseline,
    fillRect: vi.fn(),
    fillText: vi.fn(),
  };
}

function makeInput(overrides: Partial<ShareGridInput> = {}): ShareGridInput {
  const gameMode = overrides.gameMode ?? "classic";
  return {
    gameMode,
    modeName: overrides.modeName ?? getGameModeName(gameMode),
    roundScores:
      overrides.roundScores ??
      [1000, 1000, 750, 1000, 0, 500, 1000, 1000, 300, 950],
    totalScore: overrides.totalScore ?? 7500,
    perRoundMax: overrides.perRoundMax ?? getPerRoundMaxScore(gameMode),
  };
}

describe("drawBackground", () => {
  it("fills the entire canvas with the dark background color", () => {
    const ctx = createSpyContext();
    drawBackground(ctx);
    expect(ctx.fillStyle).toBe(SHARE_COLORS.background);
    expect(ctx.fillRect).toHaveBeenCalledWith(0, 0, SHARE_CANVAS_WIDTH, SHARE_CANVAS_HEIGHT);
  });
});

describe("drawHeader", () => {
  it("writes 'PRICE GAMES' in gold at the top-center", () => {
    const ctx = createSpyContext();
    drawHeader(ctx);
    expect(ctx.fillStyle).toBe(SHARE_COLORS.gold);
    expect(ctx.textAlign).toBe("center");
    expect(ctx.fillText).toHaveBeenCalledWith("PRICE GAMES", SHARE_CANVAS_WIDTH / 2, 40);
  });

  it("uses a bold system font", () => {
    const ctx = createSpyContext();
    drawHeader(ctx);
    expect(ctx.font).toContain("bold");
    expect(ctx.font).toContain("system-ui");
  });
});

describe("drawScore", () => {
  it("draws the mode name and score/max text centered", () => {
    const ctx = createSpyContext();
    drawScore(ctx, makeInput({ totalScore: 7500, modeName: "Precision" }));

    const calls = ctx.fillText.mock.calls.map((c) => c[0]);
    expect(calls).toContain("Precision");
    // Expect a "7,500 / 10,000"-style score string somewhere in the calls.
    const scoreCall = calls.find((s) => /7,500\s*\/\s*10,000/.test(String(s)));
    expect(scoreCall).toBeTruthy();
  });

  it("uses chain-reaction's 13,130 total max when applicable", () => {
    const ctx = createSpyContext();
    drawScore(
      ctx,
      makeInput({
        gameMode: "chain-reaction",
        modeName: "Chain Reaction",
        totalScore: 10000,
        perRoundMax: getPerRoundMaxScore("chain-reaction"),
      })
    );
    const calls = ctx.fillText.mock.calls.map((c) => String(c[0]));
    expect(calls.some((s) => s.includes("13,130"))).toBe(true);
  });
});

describe("drawGrid", () => {
  it("draws 10 tiles (2 rows × 5 columns)", () => {
    const ctx = createSpyContext();
    drawGrid(ctx, makeInput());
    expect(ctx.fillText).toHaveBeenCalledTimes(10);
  });

  it("maps scores to the correct tier emojis", () => {
    const ctx = createSpyContext();
    drawGrid(ctx, makeInput({ roundScores: Array(10).fill(1000) })); // all great
    const emojis = ctx.fillText.mock.calls.map((c) => c[0]);
    expect(emojis.every((e) => e === "🟩")).toBe(true);
  });

  it("pads missing round scores with miss tiles", () => {
    const ctx = createSpyContext();
    drawGrid(ctx, makeInput({ roundScores: [1000, 1000, 1000] }));
    const emojis = ctx.fillText.mock.calls.map((c) => c[0]);
    expect(emojis.slice(0, 3).every((e) => e === "🟩")).toBe(true);
    expect(emojis.slice(3).every((e) => e === "⬛")).toBe(true);
  });

  it("truncates excess round scores beyond TOTAL_ROUNDS", () => {
    const ctx = createSpyContext();
    drawGrid(ctx, makeInput({ roundScores: Array(20).fill(1000) }));
    expect(ctx.fillText).toHaveBeenCalledTimes(10);
  });
});

describe("drawFooter", () => {
  it("draws the default footer URL at the bottom-center", () => {
    const ctx = createSpyContext();
    drawFooter(ctx);
    const [text, x] = ctx.fillText.mock.calls[0];
    expect(text).toBe("price.games");
    expect(x).toBe(SHARE_CANVAS_WIDTH / 2);
    expect(ctx.textAlign).toBe("center");
    expect(ctx.textBaseline).toBe("bottom");
  });

  it("draws the custom shareUrl when provided", () => {
    const ctx = createSpyContext();
    drawFooter(ctx, { shareUrl: "price.games/s/aBcD1234" });
    expect(ctx.fillText.mock.calls[0][0]).toBe("price.games/s/aBcD1234");
  });

  it("falls back to the default when options is undefined", () => {
    const ctx = createSpyContext();
    drawFooter(ctx, undefined);
    expect(ctx.fillText.mock.calls[0][0]).toBe("price.games");
  });
});

describe("drawShareCard", () => {
  it("invokes all five sub-draws in the correct layer order", () => {
    const ctx = createSpyContext();
    drawShareCard(ctx, makeInput());

    // fillRect is only called by drawBackground (1 call).
    expect(ctx.fillRect).toHaveBeenCalledTimes(1);

    // fillText is called by header (1) + score (2) + grid (10) + footer (1) = 14
    expect(ctx.fillText).toHaveBeenCalledTimes(14);

    // First fillText call should be the title.
    expect(ctx.fillText.mock.calls[0][0]).toBe("PRICE GAMES");
    // Last fillText call should be the footer URL.
    expect(ctx.fillText.mock.calls[13][0]).toBe("price.games");
  });

  it("threads the shareUrl option through to the footer", () => {
    const ctx = createSpyContext();
    drawShareCard(ctx, makeInput(), { shareUrl: "price.games/s/Zzzz9999" });
    expect(ctx.fillText.mock.calls[13][0]).toBe("price.games/s/Zzzz9999");
  });
});

describe("renderShareImage", () => {
  it("resolves with a PNG blob using the stubbed canvas in setupTests", async () => {
    const blob = await renderShareImage(makeInput());
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe("image/png");
  });

  it("rejects when the 2D context is unavailable", async () => {
    const originalGetContext = HTMLCanvasElement.prototype.getContext;
    // @ts-expect-error override for test
    HTMLCanvasElement.prototype.getContext = vi.fn(() => null);
    try {
      await expect(renderShareImage(makeInput())).rejects.toThrow(
        /Canvas 2D context is not available/
      );
    } finally {
      HTMLCanvasElement.prototype.getContext = originalGetContext;
    }
  });

  it("rejects when toBlob yields null", async () => {
    const originalToBlob = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = vi.fn((cb: BlobCallback) => {
      cb(null);
    }) as typeof HTMLCanvasElement.prototype.toBlob;
    try {
      await expect(renderShareImage(makeInput())).rejects.toThrow(
        /Failed to encode share card/
      );
    } finally {
      HTMLCanvasElement.prototype.toBlob = originalToBlob;
    }
  });
});
