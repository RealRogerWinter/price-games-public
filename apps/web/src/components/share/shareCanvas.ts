import type {
  BuildShareTextOptions,
  ShareGridInput,
  ShareTier,
} from "@price-game/shared";
import {
  SHARE_TIER_EMOJI,
  SHARE_FOOTER_URL,
  scoreToTier,
  normalizeRoundScores,
  buildRankSuffix,
} from "@price-game/shared";

/** Canvas output dimensions. Fixed so the PNG is consistent across devices. */
export const SHARE_CANVAS_WIDTH = 720;
export const SHARE_CANVAS_HEIGHT = 540;

/** Palette lifted from the CSS variables in apps/web/src/index.css. */
export const SHARE_COLORS = {
  background: "#1a1a2e", // --bg-dark
  card: "#16213e",       // --bg-card
  gold: "#f6c90e",       // --accent-gold
  textPrimary: "#eaeaea", // --text-primary
  textSecondary: "#a0a0b8", // --text-secondary
} as const;

/**
 * A narrowed subset of CanvasRenderingContext2D that drawShareCard actually
 * touches. Declaring it explicitly lets us unit-test the pure draw functions
 * with a plain spy object instead of a full jsdom canvas.
 */
export interface ShareCanvasContext {
  fillStyle: string | CanvasGradient | CanvasPattern;
  font: string;
  textAlign: CanvasTextAlign;
  textBaseline: CanvasTextBaseline;
  fillRect(x: number, y: number, w: number, h: number): void;
  fillText(text: string, x: number, y: number): void;
}

/**
 * Paint the card background. Separated into its own function so tests can
 * assert the fill color and full-canvas rect.
 */
export function drawBackground(ctx: ShareCanvasContext): void {
  ctx.fillStyle = SHARE_COLORS.background;
  ctx.fillRect(0, 0, SHARE_CANVAS_WIDTH, SHARE_CANVAS_HEIGHT);
}

/**
 * Draw the "PRICE GAMES" title in gold at the top-center of the card.
 * @param ctx - The 2D context to draw into
 */
export function drawHeader(ctx: ShareCanvasContext): void {
  ctx.fillStyle = SHARE_COLORS.gold;
  ctx.font = "bold 56px system-ui, -apple-system, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.fillText("PRICE GAMES", SHARE_CANVAS_WIDTH / 2, 40);
}

/**
 * Draw the mode name and total score beneath the header.
 * @param ctx - The 2D context to draw into
 * @param input - Share grid input providing modeName and totalScore
 */
export function drawScore(ctx: ShareCanvasContext, input: ShareGridInput): void {
  const roundCount = normalizeRoundScores(input.roundScores).length;
  const totalMax = input.perRoundMax * roundCount;
  ctx.fillStyle = SHARE_COLORS.textPrimary;
  ctx.font = "bold 32px system-ui, -apple-system, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.fillText(input.modeName, SHARE_CANVAS_WIDTH / 2, 120);

  ctx.fillStyle = SHARE_COLORS.gold;
  ctx.font = "bold 48px system-ui, -apple-system, sans-serif";
  // Append the optional finishing-position suffix to keep the canvas image in
  // sync with buildShareText. The shared helper handles validation/empty cases.
  const rankSuffix = buildRankSuffix(input.playerRank, input.playerCount);
  ctx.fillText(
    `${input.totalScore.toLocaleString("en-US")} / ${totalMax.toLocaleString("en-US")}${rankSuffix}`,
    SHARE_CANVAS_WIDTH / 2,
    165
  );
}

/**
 * Draw the emoji grid in the middle of the card, adapting to the actual number
 * of rounds played: rows of up to 5 tiles each (e.g. 3 → 1 row of 3,
 * 5 → 1 row of 5, 10 → 2 rows of 5).
 *
 * @param ctx - The 2D context to draw into
 * @param input - Share grid input (roundScores used for tier classification)
 */
export function drawGrid(ctx: ShareCanvasContext, input: ShareGridInput): void {
  const normalized = normalizeRoundScores(input.roundScores);
  const tiers: ShareTier[] = normalized.map((s) => scoreToTier(s, input.perRoundMax));

  const tileSize = 72;
  const gap = 14;
  const cols = 5;
  const rows = Math.max(1, Math.ceil(tiers.length / cols));
  const tilesInFirstRow = Math.min(tiers.length, cols);
  const gridWidth = tilesInFirstRow * tileSize + (tilesInFirstRow - 1) * gap;
  const startX = (SHARE_CANVAS_WIDTH - gridWidth) / 2 + tileSize / 2;
  const startY = 270;

  ctx.font = `${tileSize}px system-ui, -apple-system, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = SHARE_COLORS.textPrimary;

  for (let r = 0; r < rows; r++) {
    const rowTiles = Math.min(cols, tiers.length - r * cols);
    // Center each row independently
    const rowWidth = rowTiles * tileSize + (rowTiles - 1) * gap;
    const rowStartX = (SHARE_CANVAS_WIDTH - rowWidth) / 2 + tileSize / 2;
    for (let c = 0; c < rowTiles; c++) {
      const idx = r * cols + c;
      const tier = tiers[idx];
      const emoji = SHARE_TIER_EMOJI[tier];
      const x = rowStartX + c * (tileSize + gap);
      const y = startY + r * (tileSize + gap);
      ctx.fillText(emoji, x, y);
    }
  }
}

/**
 * Draw the footer URL at the bottom-center of the card. When a shareUrl is
 * supplied, that URL is drawn instead of the default `price.games` fallback.
 *
 * @param ctx - The 2D context to draw into
 * @param options - Optional footer override (shareUrl)
 */
export function drawFooter(
  ctx: ShareCanvasContext,
  options?: BuildShareTextOptions
): void {
  ctx.fillStyle = SHARE_COLORS.textSecondary;
  ctx.font = "normal 28px system-ui, -apple-system, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "bottom";
  const footerText = options?.shareUrl ?? SHARE_FOOTER_URL;
  ctx.fillText(footerText, SHARE_CANVAS_WIDTH / 2, SHARE_CANVAS_HEIGHT - 30);
}

/**
 * Orchestrate all four sub-draws onto a single canvas context in layer order:
 * background -> header -> score -> grid -> footer. Pure function; accepts a
 * context so it's trivially unit-testable against a spy.
 *
 * @param ctx - The 2D context to draw into
 * @param input - The full share grid input
 * @param options - Optional footer override (shareUrl)
 */
export function drawShareCard(
  ctx: ShareCanvasContext,
  input: ShareGridInput,
  options?: BuildShareTextOptions
): void {
  drawBackground(ctx);
  drawHeader(ctx);
  drawScore(ctx, input);
  drawGrid(ctx, input);
  drawFooter(ctx, options);
}

/**
 * Render a ShareGridInput into a PNG Blob. Creates a hidden `<canvas>`,
 * delegates to drawShareCard, and resolves with the PNG output.
 *
 * Errors:
 *  - Rejects if `canvas.getContext("2d")` returns null (unlikely on modern
 *    browsers; happens in jsdom without canvas polyfills unless mocked).
 *  - Rejects if `canvas.toBlob` produces null (browser ran out of memory).
 *
 * @param input - The share grid input
 * @param options - Optional footer override (shareUrl)
 * @returns Promise resolving to a PNG blob
 */
export function renderShareImage(
  input: ShareGridInput,
  options?: BuildShareTextOptions
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const canvas = document.createElement("canvas");
    canvas.width = SHARE_CANVAS_WIDTH;
    canvas.height = SHARE_CANVAS_HEIGHT;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      reject(new Error("Canvas 2D context is not available in this environment"));
      return;
    }
    drawShareCard(ctx as unknown as ShareCanvasContext, input, options);
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error("Failed to encode share card to PNG blob"));
        return;
      }
      resolve(blob);
    }, "image/png");
  });
}
