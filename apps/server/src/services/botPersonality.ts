/**
 * Bot personality system — per-bot archetypes that drive realistic,
 * human-shaped price guesses.
 *
 * Each bot is assigned a stable archetype for the life of a room (deterministic
 * from botId + roomCode). The archetype controls a mixture-of-log-normals
 * error model — producing guesses distributed across accuracy bands rather
 * than tightly clustered around the actual price. This kills the "mimic the
 * bot" exploit where a human player can win by copying the obvious cluster.
 *
 * Error model: guess = actual * exp(ε), where ε is drawn from a per-guess
 * mixture (close / moderate / wild). Log-normal is used because humans estimate
 * price ratios, not absolute dollar differences (Weber-Fechner).
 *
 * @module botPersonality
 */
import type { BotDifficulty } from "@price-game/shared";

/** Archetype identifier — fixed set of human-style guessing profiles. */
export type BotArchetype =
  | "expert"
  | "overbidder"
  | "lowballer"
  | "average-joe"
  | "wild-card"
  | "anchored";

/** Fully resolved personality parameters for a single bot. */
export interface BotPersonality {
  archetype: BotArchetype;
  /** Mean of log-error (multiplicative bias). Positive = overestimates. */
  bias: number;
  /** Std-dev of log-error for the "close" mixture component. */
  sigma: number;
  /** Mixture weights; must sum to ~1. */
  pClose: number;
  pModerate: number;
  pWild: number;
  /** How often to snap output to a human-shaped round/charm price (0–1). */
  snapRate: number;
  /** Bidding-specific: fraction of σ to shade-down in bidding mode. */
  shadeFactor: number;
  /** Bidding-specific: probability of placing +$1 clip if last bidder. */
  clipProb: number;
  /** Bidding-specific: probability of the "$1 gambit" in last position. */
  gambitProb: number;
}

const BASE_PERSONALITIES: Record<BotArchetype, Omit<BotPersonality, "archetype">> = {
  expert: {
    bias: 0.0,
    sigma: 0.08,
    pClose: 0.80, pModerate: 0.18, pWild: 0.02,
    snapRate: 0.6,
    shadeFactor: 0.5, clipProb: 0.6, gambitProb: 0.02,
  },
  overbidder: {
    bias: 0.15,
    sigma: 0.15,
    pClose: 0.60, pModerate: 0.35, pWild: 0.05,
    snapRate: 0.6,
    shadeFactor: 0.8, clipProb: 0.4, gambitProb: 0.02,
  },
  lowballer: {
    bias: -0.18,
    sigma: 0.18,
    pClose: 0.55, pModerate: 0.35, pWild: 0.10,
    snapRate: 0.6,
    shadeFactor: 0.6, clipProb: 0.1, gambitProb: 0.02,
  },
  "average-joe": {
    bias: 0.05,
    sigma: 0.28,
    pClose: 0.45, pModerate: 0.45, pWild: 0.10,
    snapRate: 0.7,
    shadeFactor: 0.6, clipProb: 0.2, gambitProb: 0.02,
  },
  "wild-card": {
    bias: 0.0,
    sigma: 0.60,
    pClose: 0.25, pModerate: 0.40, pWild: 0.35,
    snapRate: 0.3,
    shadeFactor: 0.3, clipProb: 0.05, gambitProb: 0.05,
  },
  anchored: {
    bias: 0.0,
    sigma: 0.20,
    pClose: 0.50, pModerate: 0.40, pWild: 0.10,
    snapRate: 1.0,
    shadeFactor: 0.6, clipProb: 0.2, gambitProb: 0.02,
  },
};

/** Per-difficulty weighted archetype draw. Difficulty modulates the mix. */
const ARCHETYPE_WEIGHTS: Record<BotDifficulty, Record<BotArchetype, number>> = {
  hard: {
    "expert": 0.50, "average-joe": 0.20, "overbidder": 0.15,
    "lowballer": 0.10, "anchored": 0.05, "wild-card": 0.00,
  },
  medium: {
    "expert": 0.20, "average-joe": 0.30, "overbidder": 0.20,
    "lowballer": 0.15, "anchored": 0.10, "wild-card": 0.05,
  },
  easy: {
    "expert": 0.05, "average-joe": 0.25, "overbidder": 0.15,
    "lowballer": 0.15, "anchored": 0.15, "wild-card": 0.25,
  },
};

/** FNV-1a 32-bit string hash — tiny and dependency-free. */
function hashString(s: string): number {
  // Cap input length defensively. Callers pass DB-origin IDs (short), but a
  // future caller threading untrusted data through should not be able to
  // push this loop into a pathological runtime.
  const capped = s.length > 256 ? s.slice(0, 256) : s;
  let h = 0x811c9dc5;
  for (let i = 0; i < capped.length; i++) {
    h ^= capped.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Seeded mulberry32 PRNG — deterministic float in [0,1). */
function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = t;
    r = Math.imul(r ^ (r >>> 15), r | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Pick an archetype using a deterministic RNG seeded by the bot + room.
 *
 * Personality stays stable for the life of a room — the same bot in the same
 * room always gets the same archetype (no re-rolling between rounds).
 *
 * @param botPlayerId - stable bot identifier
 * @param roomCode - room identifier (or any per-game salt)
 * @param difficulty - bot difficulty tier
 * @returns the chosen archetype
 */
export function assignArchetype(
  botPlayerId: string,
  roomCode: string,
  difficulty: BotDifficulty,
): BotArchetype {
  const seed = hashString(`${botPlayerId}|${roomCode}|${difficulty}`);
  const rand = mulberry32(seed)();
  const weights = ARCHETYPE_WEIGHTS[difficulty];
  let acc = 0;
  for (const [arch, w] of Object.entries(weights) as Array<[BotArchetype, number]>) {
    acc += w;
    if (rand < acc) return arch;
  }
  return "average-joe";
}

/**
 * Resolve a fully-configured personality for a bot.
 *
 * @param botPlayerId - stable bot identifier; falls back to a random archetype
 *                     drawn from the difficulty mix if omitted
 * @param roomCode - per-game salt; ignored when botPlayerId is omitted
 * @param difficulty - bot difficulty tier
 */
export function resolvePersonality(
  botPlayerId: string | undefined,
  roomCode: string | undefined,
  difficulty: BotDifficulty,
): BotPersonality {
  const archetype = botPlayerId && roomCode
    ? assignArchetype(botPlayerId, roomCode, difficulty)
    : weightedRandomArchetype(difficulty);
  return { archetype, ...BASE_PERSONALITIES[archetype] };
}

function weightedRandomArchetype(difficulty: BotDifficulty): BotArchetype {
  const weights = ARCHETYPE_WEIGHTS[difficulty];
  const r = Math.random();
  let acc = 0;
  for (const [arch, w] of Object.entries(weights) as Array<[BotArchetype, number]>) {
    acc += w;
    if (r < acc) return arch;
  }
  return "average-joe";
}

/** Box-Muller standard Gaussian. */
function gauss(): number {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

/** Floor σ to prevent "oracle" behavior even on hardest setting. */
const MIN_SIGMA = 0.05;

/**
 * Draw a single log-error ε from the personality's mixture.
 *
 * - close: N(bias, σ)           — bot feels confident
 * - moderate: N(bias, σ·2.5)    — bot is guessing
 * - wild: Uniform[-1.5, +1.5]   — bot has no idea (spans ~0.22× to ~4.5×)
 */
function sampleLogError(personality: BotPersonality): number {
  const r = Math.random();
  const effectiveSigma = Math.max(MIN_SIGMA, personality.sigma);
  if (r < personality.pClose) {
    return personality.bias + gauss() * effectiveSigma;
  }
  if (r < personality.pClose + personality.pModerate) {
    return personality.bias + gauss() * effectiveSigma * 2.5;
  }
  return (Math.random() * 3) - 1.5;
}

/**
 * Snap a price in cents to a human-shaped round/charm value.
 *
 * Sub-$20 → $X.99
 * $20-$100 → nearest $5 (or $X9.99 half the time)
 * $100-$500 → nearest $10 (or $X9)
 * >$500 → nearest $25
 */
export function snapToHumanPrice(cents: number): number {
  if (cents < 2000) {
    const dollars = Math.max(1, Math.ceil(cents / 100));
    return dollars * 100 - 1;
  }
  if (cents < 10000) {
    if (Math.random() < 0.5) {
      const tens = Math.max(1, Math.ceil(cents / 1000));
      return tens * 1000 - 1;
    }
    return Math.max(500, Math.round(cents / 500) * 500);
  }
  if (cents < 50000) {
    if (Math.random() < 0.5) {
      const tens = Math.max(1, Math.ceil(cents / 1000));
      return tens * 1000 - 100;
    }
    return Math.round(cents / 1000) * 1000;
  }
  return Math.round(cents / 2500) * 2500;
}

/**
 * Sample a bot's price guess (in cents).
 *
 * Core entry point for all price-based modes. Uses the personality's
 * log-normal mixture and then probabilistically snaps to a human-shaped
 * round/charm price.
 *
 * @param actualCents - the true price in cents
 * @param personality - resolved personality
 * @returns a positive integer price in cents
 */
export function sampleBotPrice(actualCents: number, personality: BotPersonality): number {
  const epsilon = sampleLogError(personality);
  const raw = actualCents * Math.exp(epsilon);
  const floored = Math.max(1, Math.round(raw));
  if (Math.random() < personality.snapRate) {
    return Math.max(1, snapToHumanPrice(floored));
  }
  return floored;
}

/** Context for bidding-mode wrapper. */
export interface BiddingContext {
  /** Previous bids in the round (by other players, in order). */
  previousBids?: Array<{ playerId: string; bidCents: number }>;
  /** True if this bot is the final bidder (can see all opponents). */
  isLastBidder?: boolean;
}

/**
 * Sample a bid for bidding mode.
 *
 * Adds bidding-specific behaviors on top of the generic price sampler:
 * - Rational shade-down below estimate (going over = 0 points)
 * - Occasional +$1 clip when last bidder
 * - Rare $1 "everyone overbid" gambit
 *
 * @param actualCents - true price in cents
 * @param personality - resolved personality
 * @param ctx - bidding context (previous bids, position)
 * @returns bid in cents (always ≥ 1)
 */
export function sampleBotBid(
  actualCents: number,
  personality: BotPersonality,
  ctx: BiddingContext = {},
): number {
  const estimate = sampleBotPrice(actualCents, personality);

  if (ctx.isLastBidder && ctx.previousBids && ctx.previousBids.length > 0) {
    if (Math.random() < personality.gambitProb) {
      return 1;
    }
    if (Math.random() < personality.clipProb) {
      const maxOther = Math.max(...ctx.previousBids.map((b) => b.bidCents));
      // +$1 in cents — the classic "bid one dollar more" clip gesture.
      const clip = maxOther + 100;
      if (clip <= estimate) {
        return Math.max(1, clip);
      }
    }
  }

  // Shade in log-space so it composes correctly with the multiplicative bias
  // baked into `estimate`. Offsetting any positive bias ensures biased-high
  // bots still shade below truth most of the time; shadeFactor·σ adds the
  // rational safety margin on top.
  const shadeSigma = Math.max(MIN_SIGMA, personality.sigma);
  const shadeLog = Math.max(0, personality.bias) + personality.shadeFactor * shadeSigma;
  const shaded = Math.round(estimate * Math.exp(-shadeLog));
  return Math.max(1, shaded);
}
