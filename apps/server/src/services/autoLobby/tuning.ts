/**
 * Auto-lobby bot tuning — softer skill profile for *disguised* bots so the
 * real player typically wins. Numbers come straight out of the game-design
 * expert review. Two profiles + a ramp interpolating between them on the
 * first ~5 games of a player's session.
 *
 * What's tuned:
 *  - Sigma multiplier on archetype log-error (wider misses = more humanlike).
 *  - Archetype mix shifted away from `expert` toward `average-joe` /
 *    `wild-card`.
 *  - Categorical correctness probabilities (higher-lower, comparison, etc.)
 *    cut a few points below baseline.
 *  - Miss rate (% of rounds where bot submits a deliberately-bad guess at
 *    the last second to read as "ran out of time").
 *
 * Labeled bots are NOT tuned by this module — they keep the baseline
 * personality system. Only disguised bots route through here, so the
 * "honest competition" feel of clearly-marked bots is preserved.
 */

import type { BotArchetype } from "../botPersonality";

/** A complete tuning profile for an auto-lobby disguised bot. */
export interface AutoLobbyTuning {
  /** Multiplier applied to base archetype sigma (1.25x or higher = wider error). */
  sigmaMultiplier: number;
  /** Categorical-mode correctness probability per difficulty. */
  categoricalCorrectness: {
    easy: number;
    medium: number;
    hard: number;
  };
  /** Probability per round of submitting a deliberate timeout-style miss. */
  missRate: number;
  /** Per-archetype draw weights when assigning a personality. Must sum to 1. */
  archetypeMix: Record<BotArchetype, number>;
}

/** Baseline auto-lobby tuning (post-ramp profile, games 5+). */
export const ARCHETYPE_MIX_AUTO: Record<BotArchetype, number> = {
  expert: 0.10,
  "average-joe": 0.25,
  anchored: 0.20,
  overbidder: 0.18,
  lowballer: 0.17,
  "wild-card": 0.10,
};

/** Soft auto-lobby tuning (early-session, games 0-1). */
const ARCHETYPE_MIX_SOFT: Record<BotArchetype, number> = {
  expert: 0.05,
  "average-joe": 0.30,
  anchored: 0.20,
  overbidder: 0.18,
  lowballer: 0.17,
  "wild-card": 0.10,
};

/** Tuning applied to disguised bots once the new-player ramp finishes. */
export const AUTO_LOBBY_BASELINE: AutoLobbyTuning = {
  sigmaMultiplier: 1.25,
  categoricalCorrectness: { easy: 0.48, medium: 0.60, hard: 0.72 },
  missRate: 0.03,
  archetypeMix: ARCHETYPE_MIX_AUTO,
};

/** Tuning applied to disguised bots in a brand-new player's first 1-2 games. */
export const AUTO_LOBBY_SOFT: AutoLobbyTuning = {
  sigmaMultiplier: 1.40,
  categoricalCorrectness: { easy: 0.42, medium: 0.55, hard: 0.65 },
  missRate: 0.03,
  archetypeMix: ARCHETYPE_MIX_SOFT,
};

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function lerpMix(
  a: Record<BotArchetype, number>,
  b: Record<BotArchetype, number>,
  t: number,
): Record<BotArchetype, number> {
  const out = {} as Record<BotArchetype, number>;
  const keys = Object.keys(a) as BotArchetype[];
  for (const k of keys) out[k] = lerp(a[k], b[k], t);
  return out;
}

/**
 * Resolve the tuning profile for a player who has already completed
 * `gamesPlayed` games this session. Returns the soft profile for games 0-1,
 * interpolates 2-4, baseline for 5+.
 *
 * Game count comes from the server-side session record — see
 * `services/multiplayerSession` for the source. Negative values (defensive)
 * are treated as 0.
 *
 * @param gamesPlayed - Number of games this session has already finished.
 */
export function getRampedTuning(gamesPlayed: number): AutoLobbyTuning {
  const g = Math.max(0, Math.floor(gamesPlayed));
  if (g <= 1) return AUTO_LOBBY_SOFT;
  if (g >= 5) return AUTO_LOBBY_BASELINE;
  // 2 → t=0.25, 3 → 0.50, 4 → 0.75
  const t = (g - 1) / 4;
  return {
    sigmaMultiplier: lerp(AUTO_LOBBY_SOFT.sigmaMultiplier, AUTO_LOBBY_BASELINE.sigmaMultiplier, t),
    categoricalCorrectness: {
      easy: lerp(AUTO_LOBBY_SOFT.categoricalCorrectness.easy, AUTO_LOBBY_BASELINE.categoricalCorrectness.easy, t),
      medium: lerp(AUTO_LOBBY_SOFT.categoricalCorrectness.medium, AUTO_LOBBY_BASELINE.categoricalCorrectness.medium, t),
      hard: lerp(AUTO_LOBBY_SOFT.categoricalCorrectness.hard, AUTO_LOBBY_BASELINE.categoricalCorrectness.hard, t),
    },
    missRate: lerp(AUTO_LOBBY_SOFT.missRate, AUTO_LOBBY_BASELINE.missRate, t),
    archetypeMix: lerpMix(AUTO_LOBBY_SOFT.archetypeMix, AUTO_LOBBY_BASELINE.archetypeMix, t),
  };
}

/**
 * Single entry point used by the bot pipeline to decide whether — and how —
 * to soften a bot's behavior in an auto-lobby.
 *
 * Returns `null` when the bot is labeled (non-disguised); the caller then
 * uses the baseline personality system unchanged. Labeled bots in
 * auto-lobbies are intentionally tuned harder, not softer — the player
 * accepts losing to a bot they can see.
 *
 * @param opts.disguised - True if this bot is disguised (`is_disguised=1`).
 * @param opts.gamesPlayed - Games the joining human has completed this session.
 */
export function getDisguisedBotTuning(opts: {
  disguised: boolean;
  gamesPlayed: number;
}): AutoLobbyTuning | null {
  if (!opts.disguised) return null;
  return getRampedTuning(opts.gamesPlayed);
}
