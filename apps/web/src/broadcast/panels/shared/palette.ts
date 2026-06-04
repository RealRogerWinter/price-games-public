/**
 * Shared palette + easings used by the streamer-bot NN broadcast panels.
 *
 * Picked for OBS h264 + Twitch overlay readability:
 *   - No pure black (encoder smear); base sits at #0a0e1a.
 *   - Cool/warm contrast pair for weight signs (cyan/coral) survives the
 *     1080p → 720p downscale that bandwidth-capped Twitch viewers see.
 *   - Warm yellow glow rather than pure white so chroma subsampling
 *     doesn't smear the most-active-neuron halo into the background.
 *
 * Easings are CSS cubic-bezier strings — drop them straight into
 * `transition`/`animation` properties or read them via the helper in
 * Canvas-rendering code.
 */

export const PALETTE = {
  bg: "#0a0e1a",
  weightPositive: "#ff8c5a",
  weightNegative: "#4dd0ff",
  glow: "#ffe066",
  success: "#4ade80",
  miss: "#f43f5e",
  within25: "#fbbf24",
  textPrimary: "#e8eef7",
  textSecondary: "#7a8599",
} as const;

export type PaletteKey = keyof typeof PALETTE;

/**
 * CSS cubic-bezier easings, named for their use site:
 *   - `edgeAlphaPulse` — back-out style for breathing weight edges.
 *   - `haloSettle`     — smooth ease-out for confidence-gauge halo growth.
 *   - `scatterFadeIn`  — 3-pulse glow on a new scatter dot.
 *   - `cardSlide`      — BeliefCard slide-in from the right.
 *   - `tickSlam`       — confidence-gauge tick mark "slam" with a subtle
 *                        backwash overshoot to read on stream.
 */
export const EASINGS = {
  edgeAlphaPulse: "cubic-bezier(0.34, 1.56, 0.64, 1)",
  haloSettle: "cubic-bezier(0.16, 1, 0.3, 1)",
  scatterFadeIn: "cubic-bezier(0.25, 0.46, 0.45, 0.94)",
  cardSlide: "cubic-bezier(0.4, 0, 0.2, 1)",
  tickSlam: "cubic-bezier(0.68, -0.55, 0.27, 1.55)",
} as const;

/**
 * Compute a hex color for a within10/within25/miss bucket — used by
 * RecentAccuracy dots and the gradient connecting line.
 */
export function bucketColor(b: "within10" | "within25" | "miss"): string {
  return b === "within10" ? PALETTE.success : b === "within25" ? PALETTE.within25 : PALETTE.miss;
}

/**
 * Compute alpha 0..1 for a most-active trail position. The current
 * frame is at index 0 (full alpha), the previous round at 1 (40%),
 * and the round before at 2 (15%).
 */
export function trailAlpha(index: 0 | 1 | 2): number {
  return index === 0 ? 1 : index === 1 ? 0.4 : 0.15;
}
