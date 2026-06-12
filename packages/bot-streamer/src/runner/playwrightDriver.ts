/**
 * PlaywrightDriver — implements the `Driver` contract from
 * `lifecycle/runner.ts` using a real Playwright headed Chromium
 * session. This is the bot's actual integration point with the
 * production game.
 *
 * Architecture:
 *   1. Boot Chromium with `--no-sandbox` (we run inside a container
 *      that's already sandboxed by Docker + Pulse).
 *   2. addInitScript order:
 *      - identityInitScript() — seed localStorage before React boots
 *      - PAGE_BRIDGE_INIT_SCRIPT — install the onAny forwarder
 *   3. exposeBinding('__pgBotForwardSocketEvent', bridge.ingest)
 *   4. Navigate to TARGET_URL/?broadcast=1
 *   5. attachObserver(bridge) — wires socket events into BotState
 *   6. For each plan:
 *      - solo: navigate to /play/<mode>, play `rounds` rounds via enactors
 *      - public_join: HTTP `/api/mp/lobbies` → ROOM_JOIN via page socket → play
 *      - host_public: ROOM_CREATE via page socket → wait for opponents → play
 */

import type {
  Browser,
  BrowserContext,
  Page,
  LaunchOptions,
} from "playwright";
import { chromium } from "playwright";
import type { GameMode, RoundStartPayload, PublicLobbyEntry } from "@price-game/shared";
import { SOCKET_EVENTS, isMood, getPerRoundMaxScore, WIN_RATIO_THRESHOLD } from "@price-game/shared";
import { attachObserver, type Observer } from "../observer/observer";
import { strategyFor } from "../strategies/index";
import { softmaxSample } from "../realism/softmax";
import { decisionDelayMs, readingDelayMs } from "../realism/timing";
import { enactorFor, enactorForSinglePlayer } from "./enact/index";
import { buildIdentitySnippet, identityInitScript } from "./identity";
import { createPageBridge, PAGE_BRIDGE_INIT_SCRIPT, type PageBridge } from "./pageBridge";
import { FAKE_CURSOR_INIT_SCRIPT } from "./humanize";
import type { OverlayForwarder } from "./overlay";
import type { Telemetry } from "./telemetry";
import {
  BLOCKING_OVERLAY_SELECTORS,
  observePageState,
  urlMatchesExpected,
} from "./pageStateProbe";
import type { PersonaProfile } from "../persona/profile";
import type { Driver } from "../lifecycle/runner";
import type { LifecyclePlan, PlanOutcome } from "../lifecycle/types";
import { OpponentTracker } from "../strategies/biddingOpponents";
import type { Narrator } from "./narrator";
import { modeChangeEventForMode, type LineEvent } from "../tts/lines";
import { pickNnPredictionThought } from "../tts/thoughts";

/**
 * Polarity ranking for the 8 mood labels. Used to detect mood
 * "shifts" (transitions where the new label sits more/less positive
 * than the previous one). Higher numbers = more positive affect.
 * `focused` lives at 0 because it can be either an upswing-groove or
 * a downswing-groove — neutral by polarity, distinct in tone. The
 * resolver explicitly notes the streak-driven nature of the focused
 * label, so it shouldn't trigger an "up" shift on its own.
 */
/**
 * Re-export the polarity table and the mood-shift decision helper
 * are pulled from `./outcome` (where they're co-located with the
 * other pure decision helpers and unit-tested). Polarity reference
 * kept here as a comment so readers don't have to chase the import:
 * elated=3, happy=2, confident=1, focused=neutral=0, tilted=-1,
 * frustrated=-2, despondent=-3.
 */

/**
 * Per-transition probability that Pricey calls out the mood shift
 * with a `mood_shift_*` reactive line. Tuned low — not every
 * transition deserves a "I feel myself shifting" line, otherwise
 * Pricey would never stop announcing her own internal state. At
 * 0.4, only ~2 in 5 transitions actually surface verbally.
 */
const MOOD_SHIFT_ANNOUNCE_PROB = 0.4;

/**
 * Idle interjection theme bank. Picked uniformly each time the
 * inter-round idle gate fires, so Pricey rotates between random
 * musings, observations about the prompt, direct chat-engagement,
 * self-reflection, and hot takes — instead of always sounding like
 * the same kind of "I'm waiting" line.
 */
const IDLE_EVENT_THEMES: ReadonlyArray<LineEvent> = [
  "idle_chatter",
  "idle_observation",
  "idle_chat_with_viewers",
  "idle_self_reflection",
  "idle_hot_take",
];
import type { RunnerCommandState } from "./chatHandlers";
import {
  deriveRoundOutcome,
  deriveSoloOutcome,
  reactiveLineForOutcome,
  pickOutcomeSpecialEvent,
  computeFinalRankEvent,
  nextMoodShiftEvent,
  parseProbEnv,
} from "./outcome";
import { nextMood, formatMoodTransition, INITIAL_MOOD, type Mood } from "../persona/mood";
import { computeMoodScale } from "../persona/moodScale";
import { createDriverMetrics, type DriverMetrics } from "./metrics";
import type { Watchdog } from "./watchdog";
import { createMotionEngine, type MotionEngine } from "./motionEngine";
import type { LearningBridge } from "../learning/bridge";
import type { ProductLite, RevealedSample } from "../learning/types";
import { deriveRankAndPair, toProductLite } from "./predictRequestInputs";
import { softNavigate } from "./softNavigate";

export interface PlaywrightDriverOptions {
  targetUrl: string;
  persona: PersonaProfile;
  overlay?: OverlayForwarder;
  /**
   * Optional narrator for TTS at lifecycle events. When unset
   * narration is silently skipped — useful for sandbox runs without
   * audio.
   */
  narrator?: Narrator;
  /**
   * Optional Thinker for visual-only thoughts pushed to the broadcast
   * overlay. Counterpart to `narrator` — same kind of fire-and-forget
   * decoration, but never speaks. When unset, every `consider()`
   * callsite in the runner is a no-op via the optional-chaining
   * pattern. Tests can pass a recording fake.
   */
  thinker?: import("./thinker").Thinker;
  /**
   * Optional command state — read for the next-mode override and
   * skill temperature, written with rationale + W/L stats. When
   * unset the runner uses the persona's static skill T and there's
   * no chat→bot integration.
   */
  commandState?: RunnerCommandState;
  /** Inject for tests — defaults to `chromium.launch`. */
  launch?: (opts?: LaunchOptions) => Promise<Browser>;
  /** Optional sleep injection; default uses setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /** Optional viewport. Default 1920×1080 to match the streamer Xvfb. */
  viewport?: { width: number; height: number };
  /**
   * Optional fetch impl for HTTP calls (e.g. `/api/mp/lobbies`).
   * Defaults to `globalThis.fetch`. Tests inject a stub.
   */
  fetchImpl?: typeof fetch;
  /**
   * Optional callback fired once the Chromium page is created, before
   * the first navigation. The runner uses this to install the
   * page-evaluate-based overlay dispatch (page.evaluate(...
   * window.postMessage)).
   */
  onPageReady?: (page: Page) => void | Promise<void>;
  /**
   * Optional timeout overrides. Defaults match production tuning;
   * tests inject smaller values to keep the suite fast. A4 replaces
   * these with rolling-p95 adaptive timeouts.
   */
  timeouts?: Partial<DriverTimeouts>;
  /**
   * Maximum unhealthy rounds before a plan is abandoned. Default 2 —
   * meaning a 5-round plan tolerates 2 result-modal-timeouts/round-
   * start-timeouts before giving up.
   */
  maxUnhealthyRounds?: number;
  /**
   * Wall-clock plan budget. Default 5 minutes. A plan that exceeds
   * this exits the round loop with whatever successes it has so far
   * — protects against a stuck round dragging out beyond the
   * lifecycle's expectations.
   */
  planBudgetMs?: number;
  /**
   * Inject a metrics bag for tests / advanced operators. Production
   * path uses `createDriverMetrics()` and feeds it durations on
   * successful round-start / result-modal observations.
   */
  metrics?: DriverMetrics;
  /**
   * Inject a watchdog for tests / supervisors. When provided, the
   * driver records round-success and activity events into it, and
   * routes `page.on("crash"/"close")` events through
   * `watchdog.triggerPanic()`.
   *
   * In production main.ts wires the watchdog before constructing the
   * driver and passes it here.
   */
  watchdog?: Watchdog;
  /**
   * Inject a MotionEngine for tests / advanced operators. Production
   * builds one in-place. Tests use a no-op or step-interval=0 engine
   * to avoid the 33ms-per-frame waits.
   */
  motionEngine?: MotionEngine;
  /**
   * Optional telemetry sink for structured events (e.g.
   * `state_divergent`, `action_reattempt`). main.ts wires its own
   * Telemetry instance; tests inject `createMemoryTelemetry()` or
   * leave undefined to discard.
   */
  telemetry?: Telemetry;
  /**
   * Optional set of game-mode slugs the bot is allowed to play. When
   * supplied, `executePublicJoin` filters out lobbies whose mode is
   * not in the set; falling back to host_public via `no_match` if no
   * matching lobby is open.
   *
   * Solo and host_public mode picking is already gated by
   * `policy.modeWhitelist` upstream; this option closes the
   * public_join gap so the whitelist is enforced across all three
   * plan kinds.
   */
  modeWhitelist?: ReadonlySet<string>;
  /**
   * Optional learning bridge. When set and `mode !== 'off'`, the
   * driver issues a `predict` before each strategy.candidates() call
   * (with a 150 ms staleness budget — null on timeout falls back to
   * the heuristic) and a fire-and-forget `update` after each round
   * result is observed. The strategy receives `nnPrediction`,
   * `thompsonDraw`, and `exploration` flags via StrategyContext.
   *
   * In production, main.ts builds the bridge from
   * `STREAMER_LEARNING_*` env vars and passes it here. When undefined
   * (default), the bot operates entirely on heuristics + softmax.
   */
  learningBridge?: LearningBridge;
}

export interface DriverTimeouts {
  /** Initial wait for `game:round_start` after navigation. */
  roundStart: number;
  /** Primary wait for the round-result-next modal. */
  resultModalPrimary: number;
  /** Extended wait used on the second attempt before bailing. */
  resultModalExtension: number;
  /** Inter-attempt jitter when the enactor fails — ceiling, in ms. */
  enactorRetryJitterMaxMs: number;
  /**
   * Post-action verification window. After enactor.enact returns
   * (single-action modes only), wait this long for the round-result
   * modal to attach. If the modal doesn't appear within the window
   * we re-run the enactor once. Short by design — the goal is to
   * catch "click never registered" within seconds rather than waiting
   * the full Phase 4 timeout.
   */
  actionVerifyMs: number;
  /**
   * Cadence of the page-state probe that runs concurrently with
   * Phase 1 / Phase 4 long waits. Default 1500ms. Tests may inject a
   * smaller value to drive `state_divergent` detection deterministically.
   */
  probeIntervalMs: number;
}

const DEFAULT_TIMEOUTS: DriverTimeouts = {
  roundStart: 10_000,
  resultModalPrimary: 12_000,
  resultModalExtension: 18_000,
  enactorRetryJitterMaxMs: 700,
  actionVerifyMs: 3_000,
  probeIntervalMs: 1_500,
};

/**
 * Modes whose enactor performs a single, idempotent UI action
 * (one click, or fill-then-submit). These are safe to re-attempt
 * without risk of double-toggling selections or replaying ordered
 * swaps. See Phase 3.5 verify-and-reattempt logic.
 *
 * **Excluded: `bidding`.** In MP bidding war the round-result modal
 * only mounts after every player has bid (4×20s = 80s worst case),
 * so the 3s `actionVerifyMs` window times out for any non-last
 * bidder and reattempts the enactor. The reattempt then blocks the
 * round path waiting for an input that already submitted, which
 * eats the plan budget and strands the bot through `game:over`.
 * Phase 4's primary + extension wait already handles the modal
 * latency without the reattempt cost.
 */
export const SINGLE_ACTION_MODES: ReadonlySet<GameMode> = new Set<GameMode>([
  "classic",
  "comparison",
  "higher-lower",
  "closest-without-going-over",
  "market-basket",
  "odd-one-out",
  "riser",
]);

/**
 * Operator-tunable pace knobs — both expressed in milliseconds and
 * read once at module load. These exist to let the operator deliberately
 * slow the bot's per-round cadence without touching the realism layer's
 * existing distributions:
 *
 *   - `STREAMER_THINKING_PAD_MS`: extra fixed sleep after the decision
 *     beat (Phase 2), before the enactor acts. Adds visible "thinking"
 *     time on stream and rate-limits the bot's submissions.
 *   - `STREAMER_RESULT_LINGER_MS`: extra fixed sleep before clicking
 *     the round-result Next button. Applies to **every** round
 *     transition (including the final one) — keep short, so 12s here
 *     = 12s of dead air per round.
 *   - `STREAMER_FINAL_LINGER_MS`: extra fixed sleep on the dedicated
 *     final-results page (`[data-testid="result-page"]` from
 *     apps/web/src/pages/ResultPage.tsx). Fires AFTER the final round's
 *     Next click navigates off the round modal onto the game-summary
 *     screen — this is where viewers want to dwell on the final score
 *     before the lifecycle picks a new plan. Typically much larger
 *     than the per-round modal dwell (e.g. 12s vs 2.5s).
 *
 * All default to 0 — set in the container env when the operator wants
 * to throttle. Negative or non-numeric values clamp to 0. Each is capped
 * at `MAX_PACE_PAD_MS` to keep a typo'd value (e.g. seconds vs. ms) from
 * adding minutes per round and tripping the watchdog's 4-min no-progress
 * panic between successful rounds.
 */
const MAX_PACE_PAD_MS = 60_000;
const THINKING_PAD_MS = Math.min(MAX_PACE_PAD_MS, Math.max(0, Number(process.env.STREAMER_THINKING_PAD_MS ?? "") || 0));
const RESULT_LINGER_MS = Math.min(MAX_PACE_PAD_MS, Math.max(0, Number(process.env.STREAMER_RESULT_LINGER_MS ?? "") || 0));
const FINAL_LINGER_MS = Math.min(MAX_PACE_PAD_MS, Math.max(0, Number(process.env.STREAMER_FINAL_LINGER_MS ?? "") || 0));

/**
 * Chance per inter-round transition that Pricey drops an
 * `idle_chatter` musing while waiting for the next `game:round_start`.
 * Tuned low so the chatter feels spontaneous instead of constant — at
 * 0.30 a 10-round game averages ~3 interjections. Override via env
 * for tuning on the live stream. Routed through `narrator.reactive()`
 * so it auto-drops if Pricey is still mid-utterance from the prior
 * round's outcome line.
 */
const IDLE_INTERJECTION_PROB = parseProbEnv(process.env.STREAMER_IDLE_INTERJECTION_PROB, 0.3);

// How long the Phase 4.5 dwell waits for the final-results page to
// mount before giving up. ResultPage.tsx is loaded via React.lazy
// (apps/web/src/App.tsx — `lazyWithRetry`), so the chunk fetch is on
// the critical path. 5s comfortably covers a cold chunk + render on
// a healthy network; if the page hasn't mounted by then, something
// has navigated us off-route and the dwell is correctly skipped.
const RESULT_PAGE_WAIT_MS = 5_000;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Final-standings entry shape `decideMpGameWin` consumes. Matches the
 * relevant fields of `RoundResultsPayload.standings` without coupling
 * the helper to the larger payload type — easier to test, easier to
 * reuse if a different data source ever surfaces standings.
 */
export interface MpStandingsEntry {
  playerId: string;
  displayName: string;
  totalScore: number;
}

export interface DecideMpGameWinInput {
  /** Standings from the last `round_end` / `game_over` payload, or undefined. */
  standings: readonly MpStandingsEntry[] | undefined;
  /** Bot's bound playerId, when known. */
  myPlayerId: string | null;
  /** Bot's persona display name (used as a secondary identity match). */
  personaName: string;
  /**
   * Score accumulated locally during the game. Used as the fallback
   * signal when standings are missing entirely (no `round_end` ever
   * arrived in an MP game) — partial signal beats crediting a
   * phantom loss for what was probably a healthy game with a dropped
   * final event.
   */
  fallbackScore: number;
  /**
   * Game mode + rounds-actually-observed. Used by the solo-collapse
   * branches (no standings, or standings collapsed to bot-only) to
   * grade `score / (perRoundMax * roundsObserved)` against
   * `WIN_RATIO_THRESHOLD` — same rule as the per-game solo path in
   * `finalizeGameOutcome`, so the bot's MP-degraded-to-solo verdicts
   * agree with the canonical price.game streak logic.
   */
  mode: GameMode;
  roundsObserved: number;
}

/**
 * Pure helper that decides whether the bot won an MP game from
 * `standings`. Extracted so the rule is unit-testable without
 * spinning up a full plan harness.
 *
 * Identity resolution (in order): explicit `myPlayerId`, then
 * `displayName === personaName`, then `standings[0]`. Opponents are
 * partitioned by `playerId` (not reference equality) so a fresh
 * object reference from the persona-name fallback still partitions
 * correctly.
 *
 * Win rule:
 *   - **Standings missing/empty**: no opponent comparison possible;
 *     grade `fallbackScore` against the solo threshold for parity
 *     with the canonical solo win rule.
 *   - **Bot is the only entry** (everyone else disconnected): same —
 *     grade `me.totalScore` against the solo threshold. Pre-fix this
 *     branch used `me.totalScore > 0`, which credited any sub-50%
 *     score as a win and disagreed with `finalizeGameOutcome`'s
 *     solo branch on the same numbers.
 *   - **Multiple players**: win iff `me.totalScore >= max(opponents)`
 *     and `me.totalScore > 0`. Ties at the top count as wins; a
 *     0-0 tie counts as a loss. Opponent comparison stays placement-
 *     style (matches the price.game UI's MP streak rule of
 *     `placement === 1`).
 */
export function decideMpGameWin(input: DecideMpGameWinInput): boolean {
  const { standings, myPlayerId, personaName, fallbackScore, mode, roundsObserved } = input;
  const meetsSoloThreshold = (score: number): boolean => {
    const totalMax = getPerRoundMaxScore(mode) * roundsObserved;
    return totalMax > 0 && score / totalMax >= WIN_RATIO_THRESHOLD;
  };
  if (!standings || standings.length === 0) {
    return meetsSoloThreshold(fallbackScore);
  }
  const me = (myPlayerId
    ? standings.find((s) => s.playerId === myPlayerId)
    : undefined)
    ?? standings.find((s) => s.displayName === personaName)
    ?? standings[0];
  const opponents = standings.filter((s) => s.playerId !== me.playerId);
  if (opponents.length === 0) {
    return meetsSoloThreshold(me.totalScore);
  }
  const opponentBest = Math.max(...opponents.map((s) => s.totalScore));
  return me.totalScore >= opponentBest && me.totalScore > 0;
}

/**
 * Pull per-product reveal samples out of a `RoundResultsPayload`'s
 * `revealData` block. Each variant either has a single `product` (with
 * `priceCents`) or an array of `ProductWithPrice`, sometimes plus
 * mode-specific extras (e.g. `actualTotalCents`, `correctOrder`,
 * `outlierProductId`). We surface one sample per revealed product
 * with its actual cents — that's exactly what the learning bridge's
 * `update` call needs.
 *
 * Returns an empty array when revealData is shaped unexpectedly or
 * the products lack `priceCents` — better to silently skip a sample
 * than crash the round path on a malformed payload.
 */
// Phase 3d.2: deriveBudgetOptimalSubset / derivePriceMatchTargetIdx
// removed with the modes themselves. Their callers (post-hoc
// stamping in attemptRound) are also gone.

function extractRevealedSamples(
  reveal: import("@price-game/shared").RevealData | undefined,
  mode: GameMode,
): RevealedSample[] {
  if (!reveal) return [];
  const out: RevealedSample[] = [];
  const pushOne = (p: import("@price-game/shared").ProductWithPrice): void => {
    if (typeof p.priceCents !== "number" || p.priceCents <= 0) return;
    out.push({
      product: toProductLite(p),
      actualCents: p.priceCents,
      mode,
      // Phase 2: persist the per-product priceRange the player saw at
      // predict time. Used by train-time CE masking so the loss
      // landscape matches the decoder's argmax mask. Static product
      // attribute, so reading off the reveal payload is equivalent to
      // reading off RoundStartPayload.
      priceRangeCents: p.priceRange
        ? { min: p.priceRange.min, max: p.priceRange.max }
        : undefined,
    });
  };
  if ("product" in reveal) pushOne(reveal.product);
  if ("products" in reveal) {
    for (const p of reveal.products) pushOne(p);
  }
  // Phase 3d.2: priceMatch + budgetBuilder oracle derivation removed
  // with the modes themselves. The reveal handler is now a straight
  // map of revealed products → RevealedSample; mode-specific oracles
  // are gone.
  return out;
}

const KNOWN_GAME_MODES: ReadonlySet<GameMode> = new Set<GameMode>([
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
  "bidding",
]);

/**
 * Pull per-product reveal samples out of a solo
 * `POST /api/game/:sessionId/guess` response body. Solo rounds don't
 * emit Socket.IO `round_end`, so the multiplayer-side
 * `extractRevealedSamples` returns nothing — but the HTTP response
 * body carries the same `result.product` (single-product modes) or
 * `result.products` (multi-product modes) shape with `priceCents` on
 * each, so the learning bridge can be fed from solo rounds too.
 *
 * The returned samples are tagged with `body.session.gameMode` (the
 * server's authoritative view of which mode the round was). Bodies
 * with a missing/unknown mode, missing `result`, or unparseable
 * products yield an empty array — consistent with the multiplayer
 * helper, we drop bad samples silently rather than crash the round
 * path on a server-side schema change.
 *
 * @param body - The parsed JSON returned by `response.json()` on the
 *               `/guess` POST. Any shape is tolerated; non-objects and
 *               missing fields just yield `[]`.
 * @returns One `RevealedSample` per priced product, or `[]` on a
 *          malformed / mode-unknown body.
 */
export function extractSoloRevealedSamples(body: unknown): RevealedSample[] {
  if (!body || typeof body !== "object" || Array.isArray(body)) return [];
  const session = (body as { session?: unknown }).session;
  if (!session || typeof session !== "object") return [];
  const rawMode = (session as { gameMode?: unknown }).gameMode;
  if (typeof rawMode !== "string" || !KNOWN_GAME_MODES.has(rawMode as GameMode)) return [];
  const mode = rawMode as GameMode;
  const result = (body as { result?: unknown }).result;
  if (!result || typeof result !== "object") return [];
  // Phase 3b: pull budgetCents off the round meta for the
  // budget-builder oracle. The solo /guess response includes the
  // round shape — budget on `body.round?.budgetCents` (server's
  // serialised RoundData).
  const round = (body as { round?: unknown }).round;
  const budgetCents =
    round && typeof round === "object" && "budgetCents" in round
      ? (round as { budgetCents?: unknown }).budgetCents
      : undefined;
  const budgetCentsTyped =
    typeof budgetCents === "number" && Number.isFinite(budgetCents) && budgetCents > 0
      ? budgetCents
      : undefined;
  const out: RevealedSample[] = [];
  const pushOne = (p: unknown): void => {
    if (!p || typeof p !== "object") return;
    const cents = (p as { priceCents?: unknown }).priceCents;
    if (typeof cents !== "number" || !Number.isFinite(cents) || cents <= 0) return;
    const id = (p as { id?: unknown }).id;
    const title = (p as { title?: unknown }).title;
    const category = (p as { category?: unknown }).category;
    if (typeof id !== "number" || typeof title !== "string" || typeof category !== "string") return;
    const description = (p as { description?: unknown }).description;
    const imageUrl = (p as { imageUrl?: unknown }).imageUrl;
    // Phase 2: parse the per-product priceRange out of the solo
    // result body if present. Same shape as multiplayer reveal — the
    // server attaches `Product.priceRange` to every product. Train-
    // time CE masking consumes this (via Sample.priceRangeCents).
    const priceRangeRaw = (p as { priceRange?: unknown }).priceRange;
    let priceRangeCents: { min: number; max: number } | undefined;
    if (priceRangeRaw && typeof priceRangeRaw === "object") {
      const min = (priceRangeRaw as { min?: unknown }).min;
      const max = (priceRangeRaw as { max?: unknown }).max;
      if (
        typeof min === "number"
        && typeof max === "number"
        && Number.isFinite(min)
        && Number.isFinite(max)
        && max > 0
        && max >= min
      ) {
        priceRangeCents = { min, max };
      }
    }
    out.push({
      product: toProductLite({
        id,
        title,
        category,
        description: typeof description === "string" ? description : undefined,
        imageUrl: typeof imageUrl === "string" ? imageUrl : undefined,
      }),
      actualCents: cents,
      mode,
      priceRangeCents,
    });
  };
  const single = (result as { product?: unknown }).product;
  if (single !== undefined) pushOne(single);
  const multi = (result as { products?: unknown }).products;
  if (Array.isArray(multi)) {
    for (const p of multi) pushOne(p);
  }
  // Phase 3d.2: PM/BB oracle derivation removed.
  return out;
}

interface ActiveSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  bridge: PageBridge;
  observer: Observer;
  /**
   * Wall-clock ms (Date.now()) of the most recent in-page console
   * error that looked like a 429 / rate-limit response from the API
   * (e.g. "Failed to submit guess: Error: API error 429: Too many
   * requests"). Phase 4 reads this and short-circuits its result-
   * modal wait when the timestamp is newer than the round attempt
   * start — without it the bot hangs the full adaptive timeout
   * waiting for a modal that the dropped POST will never produce.
   * Stays 0 when no rate-limit error has been seen.
   */
  lastRateLimitAt: number;
}

/**
 * Match for "the API returned 429 to a request the page just made" in
 * a console.error string. Targets the canonical envelope the web
 * client wraps API failures in (e.g.
 * `Failed to submit guess: Error: API error 429: {"error":...}`),
 * so unrelated 429 chatter (third-party widgets, telemetry beacons,
 * static-asset 429s, the bot's own decision-temperature debug lines)
 * doesn't trip the short-circuit and abandon healthy rounds.
 *
 * Exported for unit testing.
 */
export const RATE_LIMIT_CONSOLE_PATTERN = /API error 429\b/;

/**
 * True when a Playwright console message looks like the page surfaced
 * a 429 from the API. Used by the page console handler to flip the
 * session's `lastRateLimitAt` so Phase 4 can short-circuit. Only
 * `error`-level messages are considered — `warn`/`info` 429 chatter
 * is too easy to false-positive on.
 *
 * @param type - Console message level (e.g. `"log"`, `"warn"`, `"error"`).
 * @param text - Console message text.
 * @returns True when the message should signal a rate-limit to the runner.
 */
export function isRateLimitConsoleMessage(type: string, text: string): boolean {
  if (type !== "error") return false;
  return RATE_LIMIT_CONSOLE_PATTERN.test(text);
}

/**
 * Build a Driver. The browser doesn't launch until the first
 * `execute()` call — keeps unit tests cheap.
 */
export function createPlaywrightDriver(opts: PlaywrightDriverOptions): Driver & {
  /** Tear down the browser. Idempotent. */
  shutdown(): Promise<void>;
  /**
   * Force-close the current session. Next `execute()` call will
   * lazily launch a fresh one. Wired to the watchdog and to
   * page-level crash hooks.
   */
  panic(): Promise<void>;
  /**
   * Restore the bot's MoodState from the server's persisted mood
   * snapshot. Called once by `main.ts` before the lifecycle loop
   * starts so a container restart resumes Pricey's emotional arc
   * instead of resetting to neutral. Best-effort — server-side
   * issues leave INITIAL_MOOD in place.
   */
  hydrateMood(): Promise<void>;
} {
  const launch = opts.launch ?? ((options?: LaunchOptions) => chromium.launch(options));
  const sleep = opts.sleep ?? defaultSleep;
  const viewport = opts.viewport ?? { width: 1920, height: 1080 };
  const fetchImpl = opts.fetchImpl ?? ((globalThis as { fetch?: typeof fetch }).fetch as typeof fetch);
  // Streamer-bot identity header. The server's `streamerBotDetect`
  // middleware (Express) and Socket.IO `io.use()` handshake check both
  // verify this header against `STREAMER_BOT_SECRET`. When matched,
  // analytics record paths skip the bot's traffic so its gameplay does
  // not pollute games-played counters. When the env var is unset the
  // header is omitted entirely so dev/CI runs (which have no secret to
  // match anyway) don't carry an empty header.
  const streamerBotSecret = process.env.STREAMER_BOT_SECRET ?? "";
  const timeouts: DriverTimeouts = { ...DEFAULT_TIMEOUTS, ...opts.timeouts };
  const maxUnhealthyRounds = opts.maxUnhealthyRounds ?? 2;
  const planBudgetMs = opts.planBudgetMs ?? 5 * 60_000;
  // Adaptive timeouts: tracks rolling p95 of successful operations
  // and feeds it back as the next timeout. Tests can override via
  // `opts.timeouts` to keep their suite fast — adaptive metrics
  // only kick in once 10+ samples accumulate, well above what unit
  // tests reach.
  const metrics: DriverMetrics = opts.metrics ?? createDriverMetrics();
  // MotionEngine drives smooth cursor motion before each click.
  // Sleep is shared with the rest of the driver so test stubs apply
  // uniformly. The engine's per-step interval defaults to 33ms in
  // production; tests inject a 0-ms sleep so the engine doesn't
  // wait between waypoints.
  const motionEngine: MotionEngine = opts.motionEngine ?? createMotionEngine({
    sleep: opts.sleep,
    initialPosition: { x: viewport.width / 2, y: viewport.height / 2 },
    onAim: (target) => {
      // Fire-and-forget: the overlay forwarder swallows its own
      // errors and the aim cue is decorative — never block motion
      // on a failed dispatch.
      void opts.overlay?.send("cursor.aim", target);
    },
  });

  function adaptiveRoundStartTimeout(): number {
    // The hard override always wins (test injection).
    if (opts.timeouts?.roundStart) return timeouts.roundStart;
    return metrics.roundStart.timeout();
  }
  function adaptiveResultModalPrimary(): number {
    if (opts.timeouts?.resultModalPrimary) return timeouts.resultModalPrimary;
    return metrics.resultModalPrimary.timeout();
  }
  function adaptiveResultModalExtension(): number {
    if (opts.timeouts?.resultModalExtension) return timeouts.resultModalExtension;
    return metrics.resultModalExtension.timeout();
  }

  let session: ActiveSession | null = null;

  /**
   * Flips to true after the first successful `page.goto` of a session
   * — from that point onwards a document exists in the page, the
   * BroadcastShell has hydrated, and `window.__pgBroadcastNav` is
   * available. `softNavigate` consults this flag to decide whether to
   * use the in-page React Router push (mounts preserved across plan
   * boundaries) or fall back to a full reload. Reset to false on
   * `page.crash` / `page.close` via the session-invalidation hooks.
   */
  let pageLoaded = false;

  /**
   * Most recent mode Pricey announced via `mode_change`. Used to
   * suppress consecutive announcements when the lifecycle picks the
   * same mode twice in a row — viewers don't need "switching to
   * classic!" twice running. `null` means "never announced one"
   * (so the first plan's mode is always announced).
   */
  let lastAnnouncedMode: GameMode | null = null;

  /**
   * Bot's best single-round score within the active plan. Reset to 0
   * at the start of every `playRounds` call. Used to detect
   * `personal_best_round` reactive moments — fires when the current
   * round's score strictly beats the running max (and we're past
   * round 0, since the first round is trivially the best).
   */
  let currentGameBestScore = 0;
  let currentGameRoundIndex = 0;

  /**
   * Last observed player count in the current MP room. Used to fire
   * `opponent_joined` when the count strictly grows. Reset to 0 on
   * every new session (closure rebuilt by the next attachObserver).
   */
  let lastObservedPlayerCount = 0;

  /**
   * One-shot: fired the very first time `execute()` is called for
   * this driver instance. Subsequent plans don't re-trigger
   * `session_start`. Survives plan boundaries; reset only on a
   * driver re-create.
   */
  let sessionStartAnnounced = false;

  /**
   * Proactive browser recycle. The long-lived kiosk Chromium is the
   * host's biggest RSS consumer; renderer + X11-pixmap memory creeps up
   * over hours (the slow leak that OOM-killed Xvfb under the old 2.5g
   * cap). Every `browserRecyclePlans` lifecycle plans, `execute()` tears
   * the session down so the next `ensureSession()` relaunches a fresh,
   * lean browser. Mood/stats live in the runner (and on the server), so
   * a recycle never resets Pricey's emotional arc. Gated by
   * STREAMER_BROWSER_RECYCLE_PLANS (0 disables); the host mem-watchdog
   * (systemd: pricey-mem-watchdog) remains the hard safety net.
   */
  let plansSinceLaunch = 0;
  const browserRecyclePlans = (() => {
    const raw = process.env.STREAMER_BROWSER_RECYCLE_PLANS;
    if (raw === undefined || raw.trim() === "") return 25;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 25;
  })();

  /**
   * Remembers the last hostedRoomCode we narrated so a re-host with
   * a new code fires `hosting_room_created` again, while a no-op
   * re-set of the same code stays silent.
   */
  let lastAnnouncedHostedRoom: string | null = null;

  /**
   * Streak magnitudes that should trigger `streak_milestone`. Hit on
   * the round where `|streak|` crosses each threshold. Picked sparse
   * enough that a typical 10-round game produces 0-2 milestones.
   */
  const STREAK_MILESTONES = new Set([3, 5, 10, 15, 20]);

  /**
   * Bullseye threshold — fraction of per-round max score that counts
   * as a "perfect" guess. 0.95 captures both exact bullseyes and
   * near-misses where the score lands on the same display rung; the
   * special line lands as celebratory either way.
   */
  const BULLSEYE_FRACTION = 0.95;

  /**
   * After every `softNavigate` to a `?broadcast=1` URL, wait for the
   * page to set `window.__pgBroadcastReady = true` — set by Avatar's
   * mount useEffect once both the bus's postMessage listener and
   * Avatar's `pcmEvents` chunk listener are attached. This eliminates
   * the cold-start race where the runner starts emitting `tts.line` /
   * `tts.audio_chunk` before the page is hydrated, causing the very
   * first utterance of a session to play with no mouth animation.
   *
   * The wait is bounded (5s default). On timeout we proceed anyway —
   * the page-side replay buffer in `apps/web/src/broadcast/state/
   * overlayBus.ts` is the safety net for any envelopes that fire before
   * the listener is live, so there's no value in stalling the runner
   * indefinitely if the page never signals ready (e.g. broadcast=0
   * deployment, lazy chunk fetch failure).
   *
   * Errors are intentionally swallowed at the navigation level (the
   * replay buffer is the safety net), but a real Playwright timeout is
   * a production signal worth surfacing — without telemetry, a
   * regression that detaches Avatar's mount effect would silently
   * regress the cold-start guarantee. We log a `broadcast_ready_timeout`
   * event so an operator tailing logs sees the breadcrumb without
   * breaking the lifecycle. The unit-test fake's lack of
   * `waitForFunction` produces a synchronous TypeError that does NOT
   * land in the timeout branch, so tests stay quiet.
   */
  async function awaitBroadcastReady(page: Page, timeoutMs = 5_000): Promise<void> {
    const startedAt = Date.now();
    try {
      await page.waitForFunction(
        () => (window as { __pgBroadcastReady?: boolean }).__pgBroadcastReady === true,
        undefined,
        { timeout: timeoutMs },
      );
    } catch (err) {
      // Distinguish "method missing on fake" (TypeError) from a real
      // Playwright timeout. Only the latter is operationally
      // interesting; the former is unit-test noise.
      const msg = err instanceof Error ? err.message : String(err);
      const isTimeout = msg.includes("Timeout") || msg.includes("timeout");
      if (isTimeout) {
        let url = "";
        try { url = page.url(); } catch { /* fake page */ }
        opts.telemetry?.log({
          evt: "broadcast_ready_timeout",
          url,
          elapsedMs: Date.now() - startedAt,
          timeoutMs,
        });
      }
      // Continue — the page-side replay buffer absorbs the early
      // envelopes either way.
    }
  }

  function effectiveTemperature(): number {
    const base = opts.commandState?.skillTemperature ?? opts.persona.skillTemperature;
    // Mood-conditioned temperature scaling: each of the 8 moods has a
    // base multiplier (focused tightens, despondent widens, etc.),
    // smoothed by tanh(|vibe|/2) so high-magnitude vibe amplifies the
    // effect. Provably inert at moodInfluence=0 — tempScale = 1
    // exactly, so the function returns the unmodified base. See
    // `moodScale.ts` for the per-mood table and bounds.
    const state = opts.commandState?.moodState ?? INITIAL_MOOD;
    const { tempScale } = computeMoodScale(state, opts.persona.moodInfluence);
    return base * tempScale;
  }

  async function ensureSession(): Promise<ActiveSession> {
    if (session) return session;
    // The streamer container ships the system Chromium (apt) at
    // /usr/bin/chromium and skips Playwright's bundled-browser
    // download. Setting the env-var alone isn't enough — Playwright
    // requires the path on the `launch()` options to actually use
    // it. Fall back to no override (Playwright's default lookup)
    // when the env is unset, so unit tests keep working.
    const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ?? undefined;
    // Playwright defaults to headless: true. The streamer needs the
    // browser window rendered onto Xvfb so ffmpeg's x11grab can
    // capture it — anything else captures a black screen. Fall back
    // to true when no DISPLAY is set (unit tests / sandbox previews).
    const headless = !process.env.DISPLAY;
    // slowMo defaults to 0 since the MotionEngine (B2) drives cursor
    // motion at a 33ms-per-step cadence directly. The legacy 80ms
    // throttle was added to make CDP hover/click pairs visible —
    // with the MotionEngine each waypoint is its own visible frame
    // and slowMo would just inflate path duration without adding
    // visible motion. Tuneable via env for ops experimentation.
    const slowMoEnv = Number(process.env.STREAMER_SLOWMO_MS ?? "");
    const slowMo = Number.isFinite(slowMoEnv) && slowMoEnv >= 0
      ? slowMoEnv
      : 0;
    const browser = await launch({
      executablePath,
      headless,
      slowMo,
      args: [
        "--no-sandbox",
        "--disable-dev-shm-usage",
        // Memory hardening (2026-06): the bot soft-navigates constantly;
        // BackForwardCache would pin whole prior game pages in renderer
        // memory, feeding the renderer/X11-pixmap creep that OOM-killed
        // Xvfb. Paired with the proactive browser recycle below and the
        // host mem-watchdog (infra/streamer/pricey-mem-watchdog.*).
        "--disable-features=BackForwardCache",
        "--autoplay-policy=no-user-gesture-required",
        // Playwright forces `--enable-automation` which makes
        // Chromium show the address/tab bar (~80px tall) under any
        // mode incl. --kiosk on an unmanaged X server. We can't
        // strip that flag, so instead we position the window above
        // the Xvfb viewport so the chrome bars sit off-screen and
        // ffmpeg captures only the page content. The window is
        // height + 80 tall: 80px of chrome above y=0 (off-screen),
        // then `viewport.height` of page content fitting the
        // capture rect exactly.
        "--window-position=0,-80",
        `--window-size=${viewport.width},${viewport.height + 80}`,
      ],
    });
    const extraHTTPHeaders = streamerBotSecret
      ? { "x-streamer-bot": streamerBotSecret }
      : undefined;
    const context = await browser.newContext({ viewport, extraHTTPHeaders });
    const bridge = createPageBridge();
    await context.addInitScript({
      content: identityInitScript(buildIdentitySnippet(opts.persona)),
    });
    await context.addInitScript({ content: PAGE_BRIDGE_INIT_SCRIPT });
    // Render a software cursor that follows synthetic mouse events
    // — without it the X11 framebuffer never shows the bot's mouse
    // because Playwright dispatches via CDP, not the OS.
    await context.addInitScript({ content: FAKE_CURSOR_INIT_SCRIPT });
    const page = await context.newPage();
    // Forward in-page console messages + errors to Node stdout so
    // operators can see what the bot's browser is doing without
    // attaching a remote-debug session.
    page.on("console", (msg) => {
      const text = msg.text();
      // eslint-disable-next-line no-console
      console.log(`[browser:${msg.type()}] ${text}`);
      // Capture rate-limit responses so Phase 4 can short-circuit. The
      // browser's submit POST may have been silently 429'd — without
      // this signal the bot would wait the full Phase 4 adaptive
      // timeout for a result modal that the dropped POST will never
      // produce.
      if (isRateLimitConsoleMessage(msg.type(), text)) {
        if (session?.page === page) {
          session.lastRateLimitAt = Date.now();
        }
      }
    });
    page.on("pageerror", (err) => {
      // eslint-disable-next-line no-console
      console.error(`[browser:pageerror] ${err.message}`);
    });
    // Page-level failure hooks. A crash or close event means our
    // current page handle is dead — null out the session so the next
    // ensureSession() relaunches fresh, and let the watchdog
    // (if attached) increment its panic counter.
    //
    // Both handlers gate on `session?.page === page` so a stale
    // event from a previously-killed page (still in the GC queue)
    // can't null out a freshly-launched session that immediately
    // followed it.
    page.on("crash", () => {
      if (session?.page !== page) return;
      // eslint-disable-next-line no-console
      console.error("[runner] page.on(crash) fired — invalidating session");
      session = null;
      pageLoaded = false;
      void opts.watchdog?.triggerPanic("page_crashed");
    });
    page.on("close", () => {
      // Closes happen during clean shutdown too; only treat as a
      // panic when we still believed the session was active.
      if (session?.page !== page) return;
      // eslint-disable-next-line no-console
      console.warn("[runner] page.on(close) fired unexpectedly — invalidating session");
      session = null;
      pageLoaded = false;
      // NOTE: do NOT trigger watchdog panic here. Chromium fires
      // `close` for various transient reasons (e.g. an SPA's
      // navigation flow that briefly tears down the page object,
      // a mid-round Chromium GC reset, a detached frame). Watchdog
      // panic kills the browser AND can cascade into Xvfb death.
      // The session is already nulled out — the next ensureSession()
      // will lazily relaunch. If progress genuinely stalls, the
      // watchdog's no-progress timer fires panic on its own schedule.
    });
    // Solo round-result capture. Solo plays submit guesses via HTTP
    // (`POST /api/game/:sessionId/guess`) and the score lands in the
    // response body — there is no Socket.IO `round_end` event for
    // solo. Without this hook, `attemptRound`'s outcome derivation
    // can never observe the result and `commandState.wins` /
    // `losses` stay at 0 forever for solo plays. The handler stamps
    // `soloOutcomeRef.current` with `{ score, receivedAt }`;
    // `attemptRound` reads it as a fallback when `observer.lastResult`
    // is null (the solo case) and gates on
    // `receivedAt >= attemptStartedAt` so a delayed previous-round
    // response can't be mis-credited to the current round. (We don't
    // null the ref between rounds — the wall-clock gate is enough,
    // and explicit nulls would race against in-flight `response.json()`
    // promises that resolve after the next round starts.)
    page.on("response", (response) => {
      try {
        const url = response.url();
        // Match the solo-mode submission endpoint specifically. The
        // `/guess` suffix is the same across every solo mode (see
        // `apps/web/src/api/client.ts`); MP submissions go through
        // Socket.IO and never hit this URL.
        if (!/\/api\/game\/[^/?#]+\/guess(?:\?|#|$)/.test(url)) return;
        // Only POST submissions land scoring data in the body; GET
        // /:sessionId is the session-state probe and has no result.
        if (response.request().method() !== "POST") return;
        // Discard non-2xx — score field will be missing anyway, but
        // skipping the JSON parse on errors avoids a noisy throw.
        const status = response.status();
        if (status < 200 || status >= 300) return;
        // Body parse is async; ignore any throw (response can be
        // already-consumed on tear-down, body can be empty, etc.).
        // The W/L counter is decorative — never block the page on it.
        void response.json().then((body: unknown) => {
          if (!body || typeof body !== "object") return;
          const result = (body as { result?: { score?: unknown } }).result;
          const score = result?.score;
          if (typeof score !== "number" || !Number.isFinite(score)) return;
          // Pull revealed product+price out of the same body for the
          // learning bridge — solo rounds don't emit a Socket.IO
          // `round_end` so this is the only reveal channel they have.
          // Empty array when the body is shaped unexpectedly; the
          // consumer at the learning-update site already handles that.
          const revealedSamples = extractSoloRevealedSamples(body);
          soloOutcomeRef.current = { score, receivedAt: Date.now(), revealedSamples };
        }).catch(() => { /* decorative — ignore. */ });
      } catch {
        // The response object can throw on `.url()` / `.request()` if
        // the underlying request was cancelled mid-flight. Same
        // policy: decorative, swallow.
      }
    });
    await page.exposeBinding("__pgBotForwardSocketEvent", (_source, kind: string, payload: unknown) => {
      // eslint-disable-next-line no-console
      console.log(`[bridge] ${kind}`);
      bridge.ingest(kind, payload);
    });
    // Pass personaName so the observer auto-binds myPlayerId on the
    // first ROOM_UPDATED that names us. Without this binding the
    // bidding seat-matching wait at line ~1510 burns a full 90s on
    // every round (myPlayerId is null → isOurTurn always returns
    // false → wait elapses to its timer fall-through path), turning
    // 5-round quickplay_bidding plans into ~330s+ no_match outcomes.
    const observer = attachObserver(bridge, {
      personaName: opts.persona.name,
      onChange: (state) => {
        // Detect opponent joins by watching the room.players count
        // grow. The bot's own seat counts toward the count, so the
        // first-time delta from 0 → 1 is usually ourselves entering
        // — guarded by `lastObservedPlayerCount > 0` so we only fire
        // for actual joiners, not the bot's seat-bind. Subsequent
        // increases are real new players.
        const playerCount = state.room?.players.length ?? 0;
        if (playerCount > lastObservedPlayerCount && lastObservedPlayerCount > 0) {
          void opts.narrator?.reactive("opponent_joined", opts.commandState?.moodState.mood);
        }
        lastObservedPlayerCount = playerCount;
      },
    });
    // Reset the per-session player-count counter — a fresh observer
    // means a new room context, even if the closure variable was
    // populated by a previous session.
    lastObservedPlayerCount = 0;
    session = { browser, context, page, bridge, observer, lastRateLimitAt: 0 };
    if (opts.onPageReady) {
      try {
        await opts.onPageReady(page);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(`[runner] onPageReady failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return session;
  }

  /**
   * Fire a client→server socket.io event from the page side via
   * `page.evaluate`. The init script puts the socket on
   * `window.__pgBotSocket`; we wait for it to be both attached and
   * connected before firing — without that wait, an emit can land
   * during the handshake gap and the server drops it silently.
   */
  async function pageEmit(page: Page, event: string, payload: unknown): Promise<void> {
    try {
      await page.waitForFunction(
        () => {
          const sock = (window as { __pgBotSocket?: { connected?: boolean } }).__pgBotSocket;
          return !!sock && sock.connected === true;
        },
        undefined,
        { timeout: 10_000 },
      );
    } catch {
      // Socket never connected — emit is best-effort. The caller
      // observes the missing follow-up event (e.g. ROOM_UPDATED) via
      // its own timeout and returns no_match upstream.
      return;
    }
    await page.evaluate(
      ({ event, payload }) => {
        const sock = (window as { __pgBotSocket?: { emit: (e: string, p?: unknown) => void } }).__pgBotSocket;
        if (sock) sock.emit(event, payload);
      },
      { event, payload },
    );
  }

  /**
   * Build a short text summary of the round prompt that the overlay
   * can show in the HeaderBar / current-round panel without needing
   * to know per-mode payload shapes.
   */
  function summarisePrompt(round: RoundStartPayload): string | undefined {
    if (round.product?.title) return round.product.title;
    const first = round.products?.[0];
    if (first?.title) {
      const total = round.products?.length ?? 0;
      return total > 1 ? `${first.title} (+${total - 1} more)` : first.title;
    }
    return undefined;
  }

  /**
   * Push a stats.update envelope reflecting the current commandState
   * + mood. The overlay BotCard reduces from this.
   *
   * Two delivery paths in parallel:
   *   1. `overlay.send` → `window.postMessage` into the bot's own
   *      Chromium tab. Same-window only — invisible to any other
   *      `?broadcast=1` viewer.
   *   2. POST `/api/streamer/stats` → server stores latest + fans
   *      out via Socket.IO. Reaches every connected `?broadcast=1`
   *      page, including the bot's own (which now also subscribes
   *      to the socket event), so wins/losses/streak surface even
   *      if the bot's runner and the rendered Chromium are on
   *      different machines, or React's mount races the postMessage.
   *
   * Both are best-effort — overlay updates are decorative; failures
   * are swallowed so the lifecycle never blocks on a stat publish.
   */
  async function publishStats(): Promise<void> {
    if (!opts.commandState) return;
    const total = opts.commandState.wins + opts.commandState.losses;
    const winRate = total > 0 ? opts.commandState.wins / total : 0;
    const payload = {
      wins: opts.commandState.wins,
      losses: opts.commandState.losses,
      streak: opts.commandState.streak,
      mood: opts.commandState.moodState.mood,
      winRate,
    };
    await opts.overlay?.send("stats.update", payload);
    // Server relay — best-effort. Skipped when the secret is unset
    // (dev / unit tests) because the server-side endpoint refuses
    // anything without a valid X-Streamer-Bot header. Bounded with a
    // 5s timeout so a slow / unhealthy server can't stall the round
    // loop indefinitely on what's purely decorative state.
    if (streamerBotSecret) {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 5_000);
      try {
        await fetchImpl(`${opts.targetUrl}/api/streamer/stats`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-streamer-bot": streamerBotSecret,
          },
          body: JSON.stringify(payload),
          signal: ac.signal,
        });
      } catch {
        // Decorative — ignore.
      } finally {
        clearTimeout(timer);
      }
    }
  }

  /**
   * Publish the full mood snapshot (label + hidden vibe + morale +
   * signed round streak) to the broadcast overlay.
   *
   * Two delivery paths in parallel — same dual-channel pattern as
   * `publishStats`, so the bot's own Chromium tab and remote
   * `?broadcast=1` viewers all see the same MoodWheel state at the
   * same time:
   *
   *   1. `overlay.send` → `window.postMessage` into the bot's own
   *      Chromium tab. Synchronous on the bot's tab. Without this leg
   *      the wheel had to wait for the server-side socket round-trip
   *      while `stats.update` (which goes through both legs) had
   *      already updated the Avatar's mood — visible to viewers as
   *      Pricey's face changing while the wheel froze on the previous
   *      mood. PR #345 unwedged this.
   *   2. POST `/api/streamer/mood` → server stores latest in the
   *      streamer_state.mood_json column (migration v70) + fans out
   *      via STREAMER_BOT_MOOD socket event. Reaches every connected
   *      `?broadcast=1` page (and survives a server restart).
   *
   * Both are best-effort — overlay updates are decorative; failures
   * are swallowed so the lifecycle never blocks on a mood publish.
   * The server POST is skipped when the secret is unset (dev / unit
   * tests); the postMessage path always runs when an overlay is
   * configured so the bot's own tab still sees mood updates in
   * sandbox / local dev.
   */
  async function publishMood(): Promise<void> {
    if (!opts.commandState) return;
    const m = opts.commandState.moodState;
    const payload = {
      mood: m.mood,
      vibe: m.vibe,
      morale: m.morale,
      streak: m.streak,
      updatedAt: Date.now(),
    };
    await opts.overlay?.send("mood.snapshot", payload);
    if (!streamerBotSecret) return;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 5_000);
    try {
      await fetchImpl(`${opts.targetUrl}/api/streamer/mood`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-streamer-bot": streamerBotSecret,
        },
        body: JSON.stringify(payload),
        signal: ac.signal,
      });
    } catch {
      // Decorative — ignore.
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Hydrate the bot's MoodState from the server's persisted snapshot
   * on runner startup. Called once by `main.ts` before the lifecycle
   * loop starts so a container restart doesn't reset Pricey's
   * emotional arc to neutral. Best-effort: any failure (server
   * unreachable, GET 404, malformed body) leaves the existing
   * INITIAL_MOOD in place and the bot resumes "neutral".
   */
  async function hydrateMoodFromServer(): Promise<void> {
    if (!opts.commandState || !streamerBotSecret) return;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 5_000);
    try {
      const res = await fetchImpl(`${opts.targetUrl}/api/streamer/mood`, {
        method: "GET",
        headers: { "x-streamer-bot": streamerBotSecret },
        signal: ac.signal,
      });
      if (!res.ok) return;
      const body = await res.json() as { mood?: { mood?: string; vibe?: number; morale?: number; streak?: number } };
      const m = body?.mood;
      // Re-validate locally — same guard the server applies. The
      // hydrate path only restores when every required field is the
      // expected shape; otherwise we keep the in-memory INITIAL_MOOD.
      if (
        m
        && typeof m.vibe === "number" && Number.isFinite(m.vibe)
        && typeof m.morale === "number" && Number.isFinite(m.morale)
        && typeof m.streak === "number" && Number.isFinite(m.streak)
        && isMood(m.mood)
      ) {
        // `isMood` is the shared registry guard — staying coupled to
        // it (rather than an inline Set of labels) means a future
        // mood added to `MOOD_LABELS` is automatically accepted on
        // hydrate. An inline Set would silently drop unknown labels
        // and force the bot back to INITIAL_MOOD on restart.
        opts.commandState.moodState = {
          mood: m.mood,
          vibe: Math.max(-3, Math.min(3, m.vibe)),
          morale: Math.max(-1, Math.min(1, m.morale)),
          streak: Math.floor(m.streak),
        };
        // eslint-disable-next-line no-console
        console.log(`[mood] hydrated from server: ${opts.commandState.moodState.mood} (vibe=${opts.commandState.moodState.vibe.toFixed(2)} morale=${opts.commandState.moodState.morale.toFixed(2)} streak=${opts.commandState.moodState.streak})`);
      }
    } catch {
      // Best-effort: server unreachable / DNS down at boot is fine,
      // we just resume from INITIAL_MOOD.
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Phase-scoped attempt-result for a single round. Used by playRounds
   * to drive skip-and-continue semantics — a single failure no longer
   * aborts the rest of the plan.
   *
   * `state_divergent` is a stronger signal than `page_unhealthy`: the
   * page navigated out from under the bot (URL no longer matches the
   * expected `/play/<mode>` or `/<roomCode>` prefix). The lifecycle
   * should bail the entire plan rather than burn the rest of the
   * round budget on a wrong page — `playRounds` breaks immediately
   * on this status.
   */
  type RoundAttemptStatus = "success" | "skipped" | "page_unhealthy" | "state_divergent";
  interface RoundAttemptResult {
    status: RoundAttemptStatus;
    /** Human-readable reason for non-success outcomes (logged + telemetry-friendly). */
    reason?: string;
    /**
     * The roundNumber the bot consumed (when known). Used by the
     * outer playRounds loop to gate the next waitForRoundStart so a
     * stale round payload — left behind by a dropped `game:round_end`
     * — can't be replayed as a new round.
     */
    roundNumber?: number;
  }

  /**
   * Track the URL prefix the bot expects to be on for the current
   * plan. `executeSolo` / `executePublicJoin` / `executeHostPublic`
   * set this immediately after `page.goto` so the page-state probe
   * can compare against ground truth. Cleared between plans.
   */
  let expectedPathPrefix: string | null = null;

  /**
   * Latest score captured from a `POST /api/game/:sessionId/guess`
   * HTTP response. Solo plays don't emit Socket.IO `round_end`
   * events (those are MP-only) — the score comes back in the HTTP
   * response body. The page-side `page.on("response")` handler in
   * `ensureSession` parses the response and overwrites this on every
   * solo `/guess` POST; the `attemptRound` outcome derivation reads
   * it as a fallback when `observer.lastResult` is empty (the solo
   * case) and gates on `receivedAt >= attemptStartedAt` so a delayed
   * previous-round response can't be mis-credited to the current
   * round.
   *
   * Wrapped in a `.current` ref so the response listener's escaping
   * write (asynchronous, via the closure) survives TS's flow-narrowing
   * inside `attemptRound`. The ref is intentionally NOT nulled
   * between rounds — that would race against in-flight
   * `response.json()` promises that may not have resolved yet, and
   * the wall-clock gate already handles staleness.
   */
  const soloOutcomeRef: {
    current: { score: number; receivedAt: number; revealedSamples: RevealedSample[] } | null;
  } = { current: null };

  /**
   * Poll-and-wait helper: races a long-running `waiter` Promise
   * against a periodic page-state probe. If the probe detects the
   * URL has navigated off the expected prefix, the wait aborts early
   * with `null` and the caller routes to a `state_divergent` result.
   *
   * The probe runs every `probeIntervalMs` (default 1500ms). When the
   * waiter is still pending and the URL is fine, the loop polls
   * again. When the waiter resolves first (the round_start payload
   * lands, or the result modal attaches), that value is returned
   * unchanged.
   *
   * Optional `extraSignal` lets a caller fold an additional abort
   * signal into the same race — invoked on each probe tick, returning
   * truthy aborts the wait with `{ kind: "signaled", reason }`. Phase 4
   * uses this to short-circuit when a 429 lands on the bot's submit
   * POST after the round's enactor finished. Importantly the signal
   * shares the same `stopped` flag and timer cleanup as the rest of
   * the loop, so it can never accidentally beat a settling
   * `ok` / `diverged` result to the resolution.
   *
   * Returns:
   *   - `{ kind: "ok", value }` — the original waiter resolved.
   *   - `{ kind: "diverged", url }` — page-state probe tripped first.
   *   - `{ kind: "signaled", reason }` — `extraSignal` returned truthy.
   *   - `{ kind: "timed_out" }` — full timeout elapsed without either.
   */
  async function waitWithProbe<T>(
    waiter: Promise<T | null>,
    timeoutMs: number,
    options: {
      probeIntervalMs?: number;
      extraSignal?: () => string | null;
    } = {},
  ): Promise<
    | { kind: "ok"; value: T }
    | { kind: "diverged"; url: string }
    | { kind: "signaled"; reason: string }
    | { kind: "timed_out" }
  > {
    const probeIntervalMs = options.probeIntervalMs ?? timeouts.probeIntervalMs;
    const extraSignal = options.extraSignal;
    let waiterDone = false;
    let waiterValue: T | null | undefined = undefined;
    let divergedUrl: string | null = null;
    let signaledReason: string | null = null;
    let stopped = false;
    const trackedWaiter = waiter.then((v) => { waiterValue = v; waiterDone = true; return v; });

    // Real-clock deadline: deliberately uses native setTimeout so that
    // a test injecting `sleep: async () => {}` for fast unit tests
    // doesn't collapse the deadline along with the probe cadence.
    let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
    const deadlinePromise = new Promise<"deadline">((resolve) => {
      deadlineTimer = setTimeout(() => resolve("deadline"), timeoutMs);
      deadlineTimer.unref?.();
    });

    // Probe loop runs concurrently with the waiter. Exits as soon as
    // `stopped` flips true (set in the cleanup below) so the function
    // doesn't leak a long-running background promise on return.
    //
    // Uses a real-clock setTimeout for cadence (NOT the injected
    // `sleep`) so a unit test that injects `sleep: async () => {}`
    // doesn't turn this into a tight microtask loop that starves the
    // waiter's setTimeout-based timeout.
    const realSleep = (ms: number) => new Promise<void>((r) => {
      const t = setTimeout(r, ms);
      t.unref?.();
    });
    const probeLoop = (async () => {
      while (!stopped && !waiterDone && divergedUrl === null && signaledReason === null) {
        await realSleep(probeIntervalMs);
        if (stopped || waiterDone || divergedUrl !== null || signaledReason !== null) return;
        if (extraSignal) {
          const reason = extraSignal();
          if (reason) {
            signaledReason = reason;
            return;
          }
        }
        try {
          const session = await ensureSession();
          const snapshot = await observePageState(session.page);
          if (!urlMatchesExpected(snapshot.url, expectedPathPrefix)) {
            divergedUrl = snapshot.url;
            return;
          }
        } catch {
          // Probe error → ignore. The waiter or deadline still arbitrate.
        }
      }
    })();

    try {
      await Promise.race([trackedWaiter, deadlinePromise, probeLoop]);
    } finally {
      stopped = true;
      if (deadlineTimer) clearTimeout(deadlineTimer);
    }

    // Resolution priority: a settled waiter wins over a probe signal
    // that fired on the same tick. Without this gate, a `signaled`
    // probe loop and a successful `ok` waiter racing to resolution
    // could both be true, and we'd silently swallow the success.
    if (waiterDone) {
      return waiterValue !== null && waiterValue !== undefined
        ? { kind: "ok", value: waiterValue }
        : { kind: "timed_out" };
    }
    if (divergedUrl !== null) return { kind: "diverged", url: divergedUrl };
    if (signaledReason !== null) return { kind: "signaled", reason: signaledReason };
    return { kind: "timed_out" };
  }

  /**
   * Try to play one round. Phases:
   *  1. WAITING_FOR_ROUND  — observe game:round_start (with one
   *     reload-and-retry on miss). On second miss → page_unhealthy.
   *  2. THINKING           — strategy + reading/decision delays.
   *     A strategy throw is "skipped" (one round only); the next
   *     round can still proceed.
   *  3. ACTING             — enactor with one retry on throw.
   *     Two failed attempts → "skipped".
   *  4. REVIEWING          — wait for round-result-next with primary
   *     timeout, then a 1.5x extension on the second attempt. Both
   *     missing → page_unhealthy.
   *
   * Outcome derivation (round.result + stats.update + mood) happens
   * only on the success path; skipped/unhealthy rounds emit a
   * placeholder result so the overlay's recent-rounds strip still
   * records the round.
   */
  async function attemptRound(
    mode: GameMode,
    roundIndex: number,
    totalRounds: number,
    /**
     * RoundNumber of the most recently consumed round (or null on
     * the first attempt of a plan). Forwarded to `waitForRoundStart`
     * so a stale payload from a previous round — left in the
     * observer because round_end was dropped — can't be replayed.
     */
    minRoundNumber: number | null,
  ): Promise<RoundAttemptResult> {
    const { page, observer } = await ensureSession();

    // Wall-clock for this attempt — used to gate the solo-outcome
    // fallback below. The page-level `response` listener stamps
    // `soloOutcomeRef.current` with the receipt time; only outcomes
    // captured during this attempt's window are credited to this
    // round, so a delayed previous-round response can't be
    // mis-credited if it lands here.
    const attemptStartedAt = Date.now();
    /**
     * Predicted cents from this round's NN call, captured for the
     * post-outcome `outcome_prediction_error` thought. `null` when
     * the bridge wasn't called or returned nothing — the thought is
     * skipped silently in that case (no actionable signal to share).
     */
    let lastNnPredictedCents: number | null = null;

    // ---- Phase 0: dismiss any blocking overlays from a prior round ----
    // The product image on result screens is clickable to zoom (see
    // apps/web/src/components/ImageModal.tsx). If a prior round's
    // motion path or page-relayout drift triggered the zoom, the
    // modal sits at z-index 300 and intercepts clicks the bot needs
    // to reach the "Next" button — every subsequent round then
    // page_unhealthy's. Pressing Escape is idempotent: when no
    // modal is open the keystroke is harmless.
    await dismissBlockingOverlays(page);

    // Inter-round idle chatter. Skipped on the first round of a plan
    // (no prior context to muse about) and probabilistically gated so
    // it feels spontaneous, not constant. `reactive()` auto-drops if
    // Pricey is still finishing the prior round's outcome line — that
    // case is fine, we'll get another chance next round. Theme is
    // picked uniformly from `IDLE_EVENT_THEMES` so Pricey rotates
    // between observations, viewer chat, self-reflection, hot takes,
    // and the catch-all idle_chatter pool.
    if (
      roundIndex > 0
      && opts.narrator
      && Math.random() < IDLE_INTERJECTION_PROB
    ) {
      const theme = IDLE_EVENT_THEMES[Math.floor(Math.random() * IDLE_EVENT_THEMES.length)];
      void opts.narrator.reactive(theme, opts.commandState?.moodState.mood);
    }

    // ---- Phase 1: WAITING_FOR_ROUND ----
    // Wrapped in `waitWithProbe` so that if the page navigates off
    // the expected `/play/<mode>` (or `/<roomCode>`) path mid-wait,
    // we abort early and route to `state_divergent` rather than
    // burning the full 10–15s timeout on a page that will never emit
    // `game:round_start`.
    const roundStartT0 = Date.now();
    const probeResult1 = await waitWithProbe(
      waitForRoundStart(observer, mode, adaptiveRoundStartTimeout(), minRoundNumber ?? undefined),
      adaptiveRoundStartTimeout(),
    );
    if (probeResult1.kind === "diverged") {
      opts.telemetry?.log({ evt: "state_divergent", phase: "waiting_for_round", mode, observedUrl: probeResult1.url, expected: expectedPathPrefix });
      return { status: "state_divergent", reason: "url_mismatch_phase1" };
    }
    let round: RoundStartPayload | null = probeResult1.kind === "ok" ? probeResult1.value : null;
    if (!round) {
      // First-miss recovery: reload the page once and try again. On
      // a stuck React render this knocks loose any pending state and
      // re-establishes the socket; on a network hiccup it gives us a
      // second 10s window to receive the event.
      try {
        await page.reload({ waitUntil: "domcontentloaded" });
      } catch { /* reload may fail in tests / closed pages — fall through */ }
      round = await waitForRoundStart(
        observer,
        mode,
        adaptiveRoundStartTimeout(),
        minRoundNumber ?? undefined,
      );
    }
    if (!round) {
      // Critical: do NOT record this duration in the rolling metric.
      // Timeout observations would feedback-loop into ever-growing
      // adaptive timeouts.
      return { status: "page_unhealthy", reason: "round_start_timeout" };
    }
    metrics.roundStart.observe(Date.now() - roundStartT0);

    // Surface round metadata the overlay HeaderBar / current-round
    // panel needs. roundIndex is 0-based; the overlay reducer
    // renders it as `${roundIndex + 1}/${totalRounds}`.
    await opts.overlay?.send("round.start", {
      mode,
      roundIndex,
      totalRounds,
      productSummary: summarisePrompt(round),
    });

    // Narrator speak is fire-and-forget so slow piper synthesis
    // doesn't extend the round path. Pass current mood so the picker
    // can surface mood-tagged variants instead of always drawing
    // from the untagged default pool.
    void opts.narrator?.speak("round_start", opts.commandState?.moodState.mood);

    // ---- Phase 2: THINKING ----
    let choicePayload: import("@price-game/shared").GuessData;
    let rationale: string;
    let nnRoundId = "";
    try {
      const promptLen = (round.product?.title?.length ?? 0) + (round.products?.[0]?.title?.length ?? 0);
      await sleep(readingDelayMs(promptLen));
      const strategy = strategyFor(mode);

      // Optional NN prediction. Resolves to null on timeout / mode=off;
      // strategies fall back to their heuristic centerpoint. Each call
      // also feeds the strategy a `thompsonDraw` and `exploration` flag
      // so it can widen its candidate spread on uncertain rounds.
      let nnPrediction: import("../learning/types").PredictRes | null = null;
      let thompsonDraw: number | undefined;
      let exploration = false;
      if (opts.learningBridge) {
        const product = round.product ?? round.products?.[0];
        if (product) {
          nnRoundId = `${round.roundNumber}-${Date.now()}`;
          // Phase 3e.0: rank populated for length >= 2 (was > 2). The
          // 2-product comparison case used to leave `rankProducts`
          // undefined, which collapsed comparison's strategy fallback
          // onto a single shared centerpoint. See `predictRequestInputs.ts`.
          const { pair: pairProducts, rank: rankProducts } = deriveRankAndPair(round.products);
          // Round-context payload — budget + target-prices feed the
          // trunk's round-context features when the active mode has
          // them (budget-builder / price-match). The bot's "rules
          // awareness" depends on these reaching the model.
          const targetPricesCents = round.prices && round.prices.length > 0
            ? [...round.prices].sort((a, b) => a - b)
            : undefined;
          // Mood snapshot threaded into PredictReq for the FiLM
          // head. Worker skips the FiLM forward when the persona's
          // moodInfluence is 0 (the default), so this is a no-op
          // until env-config ramps it up.
          const moodForPredict = opts.commandState?.moodState
            ? {
                vibe: opts.commandState.moodState.vibe,
                morale: opts.commandState.moodState.morale,
                streak: opts.commandState.moodState.streak,
              }
            : undefined;
          // Phase 2: bound plumbing. The server's RoundStartPayload
          // ships `Product.priceRange` on every single-product round
          // and per-element on multi-product rounds; the bot was
          // dropping these on the floor. Pass them through so the
          // decoder can mask out-of-range catalog classes and the
          // train-time CE can match.
          const priceRangeCents = product.priceRange
            ? { min: product.priceRange.min, max: product.priceRange.max }
            : undefined;
          const rankPriceRangesCents = rankProducts && round.products
            ? round.products.map((p) =>
                p.priceRange
                  ? { min: p.priceRange.min, max: p.priceRange.max }
                  : undefined,
              )
            : undefined;
          nnPrediction = await opts.learningBridge.predict({
            roundId: nnRoundId,
            mode,
            product: toProductLite(product),
            referencePrice: round.referencePrice,
            pairProducts,
            rankProducts,
            budgetCents: round.budgetCents,
            targetPricesCents,
            priceRangeCents,
            rankPriceRangesCents,
            maxPriceCapCents: round.maxPriceCents,
            mood: moodForPredict,
          });
          thompsonDraw = nnPrediction?.explorationDraw;
          // Adaptive ε is computed by the worker and surfaced in
          // `nnPrediction.epsilon` (so the strategy widens spread on
          // uncertain / high-entropy rounds). On timeout (nnPrediction
          // null) we keep a flat 5% so the bot still occasionally
          // explores even without a model signal. Mood adds an extra
          // corrective bump on negative-valence labels (tilted /
          // frustrated / despondent) — `epsilonBump` is 0 elsewhere
          // and 0 at moodInfluence=0, so the existing behaviour is
          // preserved by default.
          const moodScale = computeMoodScale(
            opts.commandState?.moodState ?? INITIAL_MOOD,
            opts.persona.moodInfluence,
          );
          const eps = (nnPrediction?.epsilon ?? 0.05) + moodScale.epsilonBump;
          exploration = Math.random() < eps;
          // Capture for the post-outcome prediction-error thought.
          if (nnPrediction) lastNnPredictedCents = nnPrediction.predictedCents;
          // Visual-only thought derived from the NN prediction.
          // The decision logic (which event + payload to emit, given
          // the prediction shape) lives in `pickNnPredictionThought`
          // alongside the template library so it's unit-testable
          // without standing up the driver. The Thinker's TTS-active
          // + min-interval gates decide whether the considered
          // thought actually surfaces — this callsite just supplies
          // the data.
          if (nnPrediction) {
            const decision = pickNnPredictionThought({
              predictedCents: nnPrediction.predictedCents,
              sigmaCents: nnPrediction.predictedSigmaCents,
              topFeatureName: nnPrediction.topFeatures[0]?.name,
              exploration: { active: exploration, drawCents: nnPrediction.explorationDraw },
            });
            if (decision) {
              opts.thinker?.consider(
                decision.event,
                opts.commandState?.moodState.mood,
                decision.payload,
              );
            }
          }
        }
      }

      // Phase 3d.2: thread BiddingTurnPayload + opponent posteriors
      // into the strategy on bidding rounds. The bidding decoder
      // simulates expected rank-score across position-conditional
      // candidates; without `ctx.turn` it can't tell first / last /
      // middle and falls back to a single-bid heuristic.
      //
      // Code-review fix (PR #329): the observer's `bidding.turn` at
      // round-start time reflects whichever turn payload the server
      // emitted FIRST — usually `turnIndex=0`, NOT the bot's seat.
      // Sizing candidates against turn 0 produces a first-bidder
      // bid even when the bot is bidder #3/#4. Wait for the
      // BiddingTurnPayload whose `currentPlayerId` matches our own
      // before computing candidates. 90s budget covers the worst
      // case (bot seated last, 4×20s).
      let turnPayload = mode === "bidding"
        ? observer.getState().bidding?.turn
        : undefined;
      if (mode === "bidding") {
        const myPlayerId = observer.getState().myPlayerId;
        const isOurTurn = (t: typeof turnPayload): boolean =>
          !!t && (myPlayerId ? t.currentPlayerId === myPlayerId : false);
        const seatWaitT0 = Date.now();
        let seatWaitOutcome: "matched_existing" | "matched_via_listener" | "timed_out_with_turn" | "timed_out_no_turn";
        if (isOurTurn(turnPayload)) {
          seatWaitOutcome = "matched_existing";
        } else {
          turnPayload = await new Promise<typeof turnPayload>((resolve) => {
            const timer = setTimeout(() => {
              unsubscribe();
              // Fall through to whatever the observer currently has
              // (likely turn 0). Strategy will still produce a bid;
              // the enactor's 5s waitForSelector for the price input
              // then bails fast if our turn never arrives, so the
              // round resolves as `skipped` rather than wedging.
              resolve(observer.getState().bidding?.turn);
            }, 90_000);
            const unsubscribe = observer.onChange((state) => {
              const t = state.bidding?.turn;
              if (isOurTurn(t)) {
                clearTimeout(timer);
                unsubscribe();
                seatWaitOutcome = "matched_via_listener";
                resolve(t);
              }
            });
            // Race the timer/listener against an existing match —
            // if the observer flipped between our last read and
            // attaching the listener (extremely unlikely but
            // possible under high event throughput).
            const current = observer.getState().bidding?.turn;
            if (isOurTurn(current)) {
              clearTimeout(timer);
              unsubscribe();
              seatWaitOutcome = "matched_via_listener";
              resolve(current);
            }
          });
          // If the listener never resolved with our turn, the timer's
          // fall-through fires — turnPayload is whatever turn was last
          // broadcast. seatWaitOutcome was unset by the matched_via_listener
          // branch, so default to one of the timed_out_* labels here.
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
          seatWaitOutcome ??= turnPayload ? "timed_out_with_turn" : "timed_out_no_turn";
        }
        opts.telemetry?.log({
          evt: "bidding.seat_match",
          roundNumber: round.roundNumber,
          outcome: seatWaitOutcome,
          waitMs: Date.now() - seatWaitT0,
          myPlayerIdBound: myPlayerId !== null,
          turnCurrentPlayerId: turnPayload?.currentPlayerId ?? null,
        });
      }
      // Later opponents = players who haven't bid YET this round.
      // = room.players − {already-bid in previousBids} − {me}.
      // Pre-fix sliced `previousBids.slice(turnIndex)` which always
      // returned [] (previousBids.length === turnIndex), so the
      // decoder never simulated future bidders.
      const opponentPosteriors = (() => {
        if (mode !== "bidding" || !turnPayload || !opts.commandState?.opponentTracker) return undefined;
        const room = observer.getState().room;
        const myPlayerId = observer.getState().myPlayerId;
        if (!room) return [];
        const alreadyBid = new Set(turnPayload.previousBids.map((b) => b.playerId));
        const laterIds = room.players
          .map((p) => p.id)
          .filter((id) => id !== myPlayerId && !alreadyBid.has(id));
        return opts.commandState.opponentTracker.snapshot(laterIds);
      })();
      const candidates = strategy.candidates(round, {
        nnPrediction,
        thompsonDraw,
        exploration,
        turn: turnPayload,
        opponentPosteriors,
        competitiveness: opts.persona.competitiveness ?? 0.7,
      });
      const choice = softmaxSample(candidates, { temperature: effectiveTemperature() });
      choicePayload = choice.payload;
      rationale = choice.rationale ?? "";
    } catch (err) {
      // Strategy throws when the round payload is missing fields it
      // needs (e.g. higher-lower without referencePrice). Skip THIS
      // round only — the next round can still proceed.
      // eslint-disable-next-line no-console
      console.warn(`[runner] strategy ${mode} threw: ${err instanceof Error ? err.message : String(err)}`);
      return { status: "skipped", reason: "strategy_threw", roundNumber: round.roundNumber };
    }
    if (opts.commandState) opts.commandState.lastRationale = rationale;
    await opts.overlay?.send("round.decision", { rationale });
    void opts.narrator?.speak("decision_announce", opts.commandState?.moodState.mood);
    await sleep(decisionDelayMs());
    if (THINKING_PAD_MS > 0) await sleep(THINKING_PAD_MS);

    // ---- Phase 3: ACTING (with one retry) ----
    // Defensive: dismiss any open ImageModal before acting. A stray
    // zoom modal — whether left over from a misclick on an as-yet-
    // unfixed enactor, an operator preview, or a UI regression —
    // sits at z-index above the game cards and silently swallows
    // every subsequent click. The modal's overlay div has
    // `onClick={onClose}`, so dispatching a synthetic click on it
    // closes the modal without depending on Escape-key delivery
    // through Playwright's keyboard surface.
    try {
      const overlay = page.locator(".image-modal-overlay");
      if ((await overlay.count()) > 0) {
        await overlay.dispatchEvent("click");
      }
    } catch {
      /* best-effort recovery; never block the round on this. */
    }
    // Phase 3d.2 (post-review fix): only fall back to the single-
    // player bidding enactor when the round is genuinely single-
    // player (no BiddingTurnPayload in the observer). MP bidding
    // rounds emit GAME_BIDDING_TURN, the strategy returns `bidCents`
    // (matching multiplayerBiddingEnactor), and the single-player
    // enactor expects `guessedPriceCents` — the previous unconditional
    // ternary threw on every MP bidding turn.
    const isMpBidding = mode === "bidding" && observer.getState().bidding?.turn !== undefined;
    const enactor = mode === "bidding" && !isMpBidding
      ? enactorForSinglePlayer(mode)
      : enactorFor(mode);
    // Pass `sleep` + `rng` into the enactor so its inter-action
    // delays (B6 — price-match / sort-it-out / etc.) can be both
    // sped up in tests (via injected sleep) AND deterministic
    // (via injected rng). The driver doesn't currently inject an
    // rng — production uses Math.random — but this leaves the
    // hook in place for future seeded-RNG integration tests.
    const enactorCtx = { sleep };
    let actSucceeded = false;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await enactor.enact(choicePayload, page, enactorCtx);
        actSucceeded = true;
        break;
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(`[runner] enactor attempt ${attempt}/2 failed for mode=${mode}: ${err instanceof Error ? err.message : String(err)}`);
        if (attempt < 2) {
          // Inter-attempt jitter — gives any pending React render or
          // animation a chance to settle before we try the same
          // selectors again.
          await sleep(200 + Math.floor(Math.random() * timeouts.enactorRetryJitterMaxMs));
        }
      }
    }
    if (!actSucceeded) {
      return { status: "skipped", reason: "enactor_failed", roundNumber: round.roundNumber };
    }
    // Mark the moment the bot's submit POST went out. The Phase 4
    // wait short-circuits if a 429 console error arrives after this
    // timestamp — meaning the submit itself was rate-limited and the
    // result modal will never mount no matter how long we wait.
    const postEnactorAt = Date.now();

    // ---- Phase 3.5: VERIFY ----
    // Single-action modes (one click or one fill-and-submit) are safe
    // to re-attempt: re-clicking the same target after the result
    // modal has opened is a no-op, and re-clicking when the first
    // click never landed gets the bot back on track within seconds
    // instead of waiting the full Phase 4 timeout. Multi-action
    // modes (budget-builder, sort-it-out, price-match,
    // chain-reaction) are intentionally excluded — re-attempting
    // mid-stream could double-toggle selections or replay swaps.
    if (SINGLE_ACTION_MODES.has(mode)) {
      // MP modes (bidding) use `.mp-result-continue`; solo modes
      // use the testid. Race both.
      const verified = await page
        .waitForSelector('[data-testid="round-result-next"], button.mp-result-continue', { timeout: timeouts.actionVerifyMs })
        .then(() => true)
        .catch(() => false);
      if (!verified) {
        opts.telemetry?.log({ evt: "action_reattempt", mode, roundNumber: round.roundNumber, reason: "no_result_modal_within_verify_window" });
        try {
          await enactor.enact(choicePayload, page, enactorCtx);
        } catch (err) {
          // Re-attempt threw — Phase 4 will detect the missing modal
          // and surface page_unhealthy as before. The re-attempt
          // failure isn't itself fatal.
          // eslint-disable-next-line no-console
          console.warn(`[runner] action re-attempt failed for ${mode}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    // ---- Phase 4: REVIEWING (with 1.5x extension) ----
    let reviewOk = false;
    let reviewAttempt = 0;
    let phase4Diverged = false;
    let phase4DivergedUrl = "";
    let phase4RateLimited = false;
    const reviewT0 = Date.now();
    for (let attempt = 1; attempt <= 2; attempt++) {
      const timeout = attempt === 1 ? adaptiveResultModalPrimary() : adaptiveResultModalExtension();
      // Defensive: dismiss the image-zoom modal if a stray click
      // during ACTING opened it. Without this the result-modal
      // selector below never resolves because ImageModal sits on
      // top of the round-result UI at z-index 300.
      await dismissBlockingOverlays(page);
      // Wrapped in waitWithProbe so that if the page navigates off
      // the expected `/play/<mode>` path mid-wait (e.g. server
      // shoved us to /game-over, or a viewer-triggered redirect),
      // we abort early and route to state_divergent rather than
      // burning the full 30–45s timeout on a wrong page.
      //
      // The `extraSignal` folds in 429 detection: when the server
      // rate-limits the submit POST, the round-result modal never
      // mounts no matter how long we wait. Without this signal the
      // bot would burn the full primary + extension timeouts
      // (~75–105s) on a request that's already lost — meanwhile the
      // server's round timer expires and emits round_start events
      // that the bot can't act on (still hung in Phase 4 of the
      // dropped round). Sharing the same probe loop (rather than a
      // separately-raced promise) means a settled `ok` waiter cannot
      // be silently swallowed by an idle signal that ticked at the
      // same time.
      // The MP round-result modal uses a different button (web's
      // MPRoundResultOverlay renders `.mp-result-continue` without
      // the solo modes' `data-testid`). Race both selectors.
      const nextSelector = '[data-testid="round-result-next"], button.mp-result-continue';
      const probeResult4 = await waitWithProbe(
        page.waitForSelector(nextSelector, { timeout }).then(() => true).catch(() => null),
        timeout,
        {
          extraSignal: () =>
            session && session.lastRateLimitAt > postEnactorAt ? "rate_limited" : null,
        },
      );
      if (probeResult4.kind === "signaled") {
        phase4RateLimited = true;
        break;
      }
      if (probeResult4.kind === "diverged") {
        phase4Diverged = true;
        phase4DivergedUrl = probeResult4.url;
        break;
      }
      if (probeResult4.kind !== "ok") {
        // eslint-disable-next-line no-console
        console.warn(`[runner] round-result-next not found (attempt ${attempt}/2) in mode=${mode}`);
        continue;
      }
      try {
        // Per-round modal dwell. Uniform across all rounds — the
        // longer "final results page" dwell happens AFTER this Next
        // click takes us off the round modal onto the result-page DOM.
        await sleep(decisionDelayMs() + RESULT_LINGER_MS);
        // The two selectors in nextSelector are mutually exclusive
        // (solo pages render testid; MPRoundResultOverlay renders
        // the class) — only one is in the DOM at any time, so a
        // bare `locator(...)` resolves uniquely without strict-mode
        // ambiguity.
        const next = page.locator(nextSelector);
        // Motion-driven click: the cursor traces a humanlike path
        // from its last position to the modal's "Next" button. This
        // is the single most-visible per-round transition; smooth
        // motion here changes how the stream "feels" between rounds
        // more than any other click in the loop.
        await motionEngine.moveAndClick(page, next);
        reviewOk = true;
        reviewAttempt = attempt;
        break;
      } catch {
        // eslint-disable-next-line no-console
        console.warn(`[runner] round-result-next click failed (attempt ${attempt}/2) in mode=${mode}`);
      }
    }
    if (phase4Diverged) {
      opts.telemetry?.log({ evt: "state_divergent", phase: "reviewing", mode, observedUrl: phase4DivergedUrl, expected: expectedPathPrefix });
      return { status: "state_divergent", reason: "url_mismatch_phase4", roundNumber: round.roundNumber };
    }
    if (phase4RateLimited) {
      // eslint-disable-next-line no-console
      console.warn(`[runner] phase 4 short-circuited: server 429'd the submit (mode=${mode})`);
      opts.telemetry?.log({ evt: "rate_limited", phase: "reviewing", mode, roundNumber: round.roundNumber });
      return { status: "page_unhealthy", reason: "rate_limited", roundNumber: round.roundNumber };
    }
    if (!reviewOk) {
      return { status: "page_unhealthy", reason: "result_modal_timeout", roundNumber: round.roundNumber };
    }
    // Only record the primary-attempt duration; extension durations
    // skew the rolling p95 toward the worst case and would inflate
    // future timeouts even on healthy networks.
    if (reviewAttempt === 1) {
      metrics.resultModalPrimary.observe(Date.now() - reviewT0);
    }

    // ---- Phase 4.5: FINAL RESULTS dwell ----
    // After the final round's Next click, the page navigates from the
    // round-result modal to the dedicated final-results screen
    // (apps/web/src/pages/ResultPage.tsx, root `[data-testid="result-page"]`).
    // Hold here so viewers can absorb the game-summary / final score
    // before the lifecycle moves on to the next plan. Skipped silently
    // if the result page never mounts within the wait window — that
    // means the page transitioned somewhere unexpected, in which case
    // the lifecycle's next plan navigation will fix it.
    if (FINAL_LINGER_MS > 0 && roundIndex === totalRounds - 1) {
      const resultPageReady = await page
        .waitForSelector('[data-testid="result-page"]', { timeout: RESULT_PAGE_WAIT_MS })
        .then(() => true)
        .catch(() => false);
      if (resultPageReady) {
        await sleep(FINAL_LINGER_MS);
      }
    }

    // ---- Outcome derivation ----
    // MP path first: gate the lastResult read on roundNumber match —
    // a delayed or dropped round_end could leave the previous round's
    // payload sitting in observer.lastResult, and we'd otherwise bump
    // wins/losses against the wrong round. When the numbers don't
    // match (or lastResult is null), fall through to the solo path
    // and finally to the placeholder.
    const lastResultPayload = observer.getState().lastResult?.payload;
    const matchedResult = lastResultPayload && lastResultPayload.roundNumber === round.roundNumber
      ? lastResultPayload
      : null;
    const myPlayerId = observer.getState().myPlayerId;
    let view: ReturnType<typeof deriveRoundOutcome> = matchedResult
      ? deriveRoundOutcome(matchedResult, myPlayerId, opts.persona.name)
      : null;
    // Solo fallback. Solo modes don't emit Socket.IO `round_end` —
    // the score arrives in the HTTP response to the `/guess` POST,
    // captured by the page-level `response` listener into
    // `soloOutcomeRef.current`. Only used when the MP path produced
    // no view; for MP rounds the matched payload always wins because
    // it carries opponent scores.
    const soloOutcome = soloOutcomeRef.current;
    if (!view && soloOutcome && soloOutcome.receivedAt >= attemptStartedAt) {
      view = deriveSoloOutcome(soloOutcome.score, mode);
    }
    if (view) {
      // Captured here so the outcome-special picker below can read
      // the pre-update streak even when commandState is null at the
      // call site (defensive — picker re-checks commandState too).
      let prevStreakSnapshot = 0;
      if (opts.commandState) {
        // Per-round bookkeeping: feed mood (still per-round, drives
        // the emoji on BotCard) and accumulate the bot's running
        // game score. Wins/losses/streak are NOT bumped here — those
        // are decided once per *game* in `finalizeGameOutcome()`,
        // called by the plan executors after `playRounds` completes.
        const roundOutcome = view.outcome === "correct" ? "win"
          : view.outcome === "partial" ? "soft_loss"
          : "loss";
        const moodInput = { kind: "round_outcome", outcome: roundOutcome } as const;
        const prevMoodState = opts.commandState.moodState;
        prevStreakSnapshot = prevMoodState.streak;
        opts.commandState.moodState = nextMood(prevMoodState, moodInput);
        // Diagnostic — one line per transition so an operator tailing
        // the streamer container's stdout can confirm the engine is
        // moving (vibe + morale + mood label).
        // eslint-disable-next-line no-console
        console.log(formatMoodTransition(prevMoodState, opts.commandState.moodState, moodInput));
        // Mood-shift narration — only fires when the resolved label
        // changed AND the polarity bucket moved. reactive() drops if
        // Pricey is still on the outcome line, so the shift line
        // queues for the next quiet moment instead of stomping it.
        maybeAnnounceMoodShift(prevMoodState, opts.commandState.moodState);
        opts.commandState.currentGameScore += view.points;
        opts.commandState.currentGameRoundsObserved++;
      }
      await opts.overlay?.send("round.result", { outcome: view.outcome, points: view.points });
      // Reactive narration with priority ordering. Decision logic
      // lives in `pickOutcomeSpecialEvent` (outcome.ts) so the
      // priority + gating contract can be unit-tested without
      // standing up the driver. Returns the highest-priority special
      // event when one applies, else `null` and the caller falls
      // back to the default outcome line.
      // `narrator.reactive()` still drops silently if Pricey is mid-
      // utterance from the earlier `decision_announce`.
      const specialEvent = opts.commandState
        ? pickOutcomeSpecialEvent({
            roundPoints: view.points,
            perRoundMaxScore: getPerRoundMaxScore(mode),
            bullseyeFraction: BULLSEYE_FRACTION,
            prevStreak: prevStreakSnapshot,
            nextStreak: opts.commandState.moodState.streak,
            streakMilestones: STREAK_MILESTONES,
            currentGameBestScore,
            currentGameRoundIndex,
          })
        : null;
      if (view.points > currentGameBestScore) currentGameBestScore = view.points;
      currentGameRoundIndex++;
      void opts.narrator?.reactive(
        specialEvent ?? reactiveLineForOutcome(view.outcome),
        opts.commandState?.moodState.mood,
      );
    } else {
      await opts.overlay?.send("round.result", { outcome: "incorrect", points: 0 });
    }
    // Learning bridge update — fire-and-forget, never blocks the round
    // path. The worker takes the revealedSamples (one per priced
    // product) and updates the model. Skipped silently when the bridge
    // wasn't enabled or no samples were revealed (e.g. malformed
    // payload, MP timeout fallback).
    if (opts.learningBridge && nnRoundId) {
      let samples = extractRevealedSamples(matchedResult?.revealData, mode);
      // Solo fallback. MP rounds carry reveal data on the `round_end`
      // socket payload; solo rounds don't, but the same products +
      // priceCents land in the body of the `/guess` POST response,
      // which the page-level response handler stashed on
      // `soloOutcomeRef.current.revealedSamples`. Reuse the same
      // wall-clock gate as the score fallback so a delayed previous-
      // round response can't be mis-credited to the current round, and
      // require the response's own gameMode tag to match this round —
      // a mismatch would mean a handler race during a mode transition.
      if (
        samples.length === 0
        && soloOutcomeRef.current
        && soloOutcomeRef.current.receivedAt >= attemptStartedAt
        && soloOutcomeRef.current.revealedSamples.length > 0
        && soloOutcomeRef.current.revealedSamples[0].mode === mode
      ) {
        samples = soloOutcomeRef.current.revealedSamples;
      }
      // Visual-only outcome reflection: pair the predicted cents
      // captured pre-decision against the first revealed sample's
      // actual price. Only fires when both are known — solo modes
      // without a working bridge skip this silently. The Thinker's
      // gates (TTS-active, min-interval) decide whether it actually
      // surfaces; this callsite just supplies the data.
      if (lastNnPredictedCents !== null && samples.length > 0) {
        const actualCents = samples[0].actualCents;
        opts.thinker?.consider("outcome_prediction_error", opts.commandState?.moodState.mood, {
          predictedCents: lastNnPredictedCents,
          actualCents,
          errorCents: Math.abs(actualCents - lastNnPredictedCents),
        });
      }
      // Phase 3d.2: PM/BB post-hoc oracle stamping removed with the modes.

      // Phase 3d.2: thread the bidding-turn snapshot onto each
      // bidding-mode sample so train-time forward sees the same
      // opponent-bid context as predict. The runner has the live
      // BiddingTurnPayload from the observer.
      if (mode === "bidding" && samples.length > 0) {
        const turn = observer.getState().bidding?.turn;
        if (turn) {
          const biddingContext = {
            turnIdx: turn.turnIndex,
            totalPlayers: turn.totalPlayers,
            previousBidsCents: turn.previousBids.map((b) => b.bidCents),
          };
          for (const s of samples) {
            if (s.mode === "bidding") s.biddingContext = biddingContext;
          }
        }
      }

      // Phase 3d.2 (post-review fix): fold revealed (bid, actual)
      // pairs into the per-room OpponentTracker so the next round's
      // decoder can simulate later opponents under the inferred
      // archetype posterior. Without this the tracker stays at the
      // per-difficulty prior for the entire game and the Bayes
      // update is dead code. Skip the streamer-bot's own playerId
      // (it's tracked via persona.name; the bot's bid isn't an
      // opponent observation).
      if (
        mode === "bidding"
        && opts.commandState?.opponentTracker
        && matchedResult?.revealData
        && "bids" in matchedResult.revealData
        && "product" in matchedResult.revealData
      ) {
        const reveal = matchedResult.revealData;
        const actual = reveal.product?.priceCents ?? 0;
        if (actual > 0) {
          const ourName = opts.persona.name.toLowerCase();
          for (const b of reveal.bids) {
            if (b.displayName.toLowerCase() === ourName) continue;
            opts.commandState.opponentTracker.noteBid({
              playerId: b.playerId,
              bidCents: b.bidCents,
              actualCents: actual,
            });
          }
        }
      }
      if (samples.length > 0) {
        // Stamp every Sample added to the replay buffer with the
        // bot's mood at update time (vibe + morale only — streak
        // is per-round and doesn't generalise to a historical
        // sample). The trainer reads sample.mood when it later
        // draws the sample for FiLM-conditioned forward + arousal-
        // gated importance reweighting; absent → identity FiLM.
        const moodForUpdate = opts.commandState?.moodState
          ? {
              vibe: opts.commandState.moodState.vibe,
              morale: opts.commandState.moodState.morale,
            }
          : undefined;
        opts.learningBridge.update({
          roundId: nnRoundId,
          revealedSamples: samples,
          primaryMode: mode,
          chosenGuess: choicePayload,
          outcome: view?.outcome ?? "incorrect",
          // Phase 2: round-level constraints. The pre-Phase-2 train-time
          // RoundContext was always 0 for these — predict-time saw the
          // real budget/target list, train-time saw zeros. Same fix
          // applies to the new `maxPriceCapCents`. `round` is non-null
          // at this point (waitForRoundStart resolved successfully).
          budgetCents: round.budgetCents,
          targetPricesCents: round.prices && round.prices.length > 0
            ? [...round.prices].sort((a, b) => a - b)
            : undefined,
          maxPriceCapCents: round.maxPriceCents,
          mood: moodForUpdate,
        });
      }
      // Phase 2 visualisation tick. After update returns we ask the
      // worker for a freshly-built VisualTick and ship it through
      // BOTH transports:
      //   - postMessage into the bot's own Chromium tab so the
      //     embedded broadcast page reacts even when no operator
      //     preview is attached;
      //   - HTTP POST to /api/streamer/nn-tick, which the server
      //     fans out via Socket.IO to every other ?broadcast=1 viewer.
      //
      // Both paths are best-effort. Failures are silent — a missing
      // visual on a single round doesn't change game outcomes.
      void (async () => {
        try {
          const tickBuffer = await opts.learningBridge!.getVisual(nnRoundId);
          if (!tickBuffer) return;
          const tickJson = tickBuffer.toString("utf8");
          let parsed: unknown;
          try {
            parsed = JSON.parse(tickJson);
          } catch {
            return;
          }
          // Same-window: dispatch through the overlay forwarder so the
          // broadcast page's reducer treats it identically to the
          // socket-relayed copy.
          await opts.overlay?.send("nn.tick", parsed);
          // Server relay — only when STREAMER_BOT_SECRET is set
          // (production). On dev / sandbox without the secret the
          // POST would 403; skip silently.
          if (streamerBotSecret) {
            void fetchImpl(`${opts.targetUrl}/api/streamer/nn-tick`, {
              method: "POST",
              headers: {
                "content-type": "application/json",
                "x-streamer-bot": streamerBotSecret,
              },
              body: tickJson,
            }).catch(() => { /* best-effort */ });
          }
        } catch {
          /* visual generation can race with shutdown; swallow */
        }
      })();
    }
    await publishStats();
    // Push the full mood snapshot too. Awaited (not fire-and-forget)
    // so it lands on the wire in the same arrival order as
    // publishStats above — without the await, two consecutive rounds
    // could interleave their stats + snapshot POSTs on the bot's
    // single fetch agent, opening a brief eventual-consistency
    // window where STREAMER_BOT_STATS shows mood A while
    // STREAMER_BOT_MOOD shows mood B for the same round. The
    // additional latency is one HTTP RTT to the local server (~1ms
    // on the same Hetzner host). Errors are swallowed inside
    // publishMood — the await never rejects.
    await publishMood();
    // Tell the watchdog we made progress — resets its no-progress
    // panic timer.
    opts.watchdog?.recordRoundSuccess();

    return { status: "success", roundNumber: round.roundNumber };
  }

  /**
   * Run the per-round loop while the bot is on a gameplay page (solo
   * or MP). Returns the per-round outcome counts so the caller can
   * apply a "≥50% successes" plan-completion threshold instead of
   * the old 100% gate.
   *
   * Tolerates `maxUnhealthyRounds` page_unhealthy attempts before
   * abandoning the plan, and bails after `planBudgetMs` wall-clock
   * to keep a single stuck round from dragging the lifecycle past
   * its expected boundary.
   */
  async function playRounds(mode: GameMode, maxRounds: number): Promise<{ successes: number; total: number }> {
    const { observer } = await ensureSession();
    // Drop any round/lastResult/bidding payload left over from the
    // previous plan. Solo modes never emit `game:round_end`, so without
    // this reset `waitForRoundStart` would return the last plan's
    // round_start payload immediately (gameMode matches, no
    // minRoundNumber gate on the first attempt) and the strategy would
    // try to act on stale product IDs that aren't in the new DOM.
    observer.resetGameplayState();
    // Reset per-game outcome-special state so personal_best_round
    // doesn't leak the previous game's high-water mark.
    currentGameBestScore = 0;
    currentGameRoundIndex = 0;
    // Reset the opponent-joined player-count baseline. A long-lived
    // session (the same observer instance played multiple plans /
    // rooms in a row) would otherwise carry the prior room's count
    // forward and either (a) suppress the first real join in the
    // new lobby when it had fewer players, or (b) fire opponent_joined
    // spuriously when a fresh, larger room snapshot lands.
    lastObservedPlayerCount = 0;
    let successes = 0;
    let unhealthy = 0;
    let lastConsumedRoundNumber: number | null = null;
    const planDeadline = Date.now() + planBudgetMs;

    for (let r = 0; r < maxRounds; r++) {
      if (Date.now() > planDeadline) {
        // eslint-disable-next-line no-console
        console.warn(`[runner] plan budget (${planBudgetMs}ms) exceeded after ${r}/${maxRounds} rounds`);
        break;
      }
      const result = await attemptRound(mode, r, maxRounds, lastConsumedRoundNumber);
      // Track the consumed roundNumber regardless of status — even a
      // skipped round bumps the counter so the next iteration's
      // waitForRoundStart filters out the same stale payload.
      if (result.roundNumber !== undefined) {
        lastConsumedRoundNumber = result.roundNumber;
      }
      if (result.status === "success") {
        successes++;
        continue;
      }
      if (result.status === "state_divergent") {
        // The page navigated off the expected URL prefix. Burning
        // the remaining round budget on a wrong page is wasted time;
        // bail and let the lifecycle pick a fresh plan. The plan's
        // outcome will be `no_match` (successes < ceil(total/2)).
        // eslint-disable-next-line no-console
        console.warn(`[runner] plan abandoned: state_divergent at round ${r + 1}/${maxRounds} (${result.reason})`);
        break;
      }
      if (result.status === "page_unhealthy") {
        unhealthy++;
        if (unhealthy > maxUnhealthyRounds) {
          // eslint-disable-next-line no-console
          console.warn(`[runner] plan abandoned: ${unhealthy} unhealthy rounds exceeded budget`);
          break;
        }
        // Narrate the recovery so silent reloads don't leave viewers
        // wondering why the bot is staring at a blank page. reactive()
        // keeps it from compounding when Pricey is mid-utterance.
        void opts.narrator?.reactive("retry_after_unhealthy", opts.commandState?.moodState.mood);
        // Try to recover the page in place; the next iteration's
        // waitForRoundStart will re-attempt from a clean DOM.
        try {
          const { page } = await ensureSession();
          await page.reload({ waitUntil: "domcontentloaded" });
        } catch { /* best-effort */ }
      }
      // "skipped" — fall through to next round.
    }

    return { successes, total: maxRounds };
  }

  /**
   * Decide the W/L for a completed game and bump the running
   * counters + streak on `commandState`. Called once per plan, at
   * the end of `executeSolo` / `executePublicJoin` / `executeHostPublic`,
   * AFTER `playRounds` has returned. Resets the per-game accumulators
   * regardless of outcome.
   *
   * Two gates suppress the W/L credit (returning silently after
   * resetting accumulators):
   *
   *   1. `currentGameRoundsObserved === 0` — every round dropped
   *      its outcome (placeholder fallbacks all the way, or the
   *      plan exited before any round completed). Crediting a loss
   *      here would punish the bot for a transport failure.
   *   2. `planCompleted === false` — `playRounds` bailed early
   *      (state_divergent, budget exhaustion, too many unhealthy
   *      rounds). Stale standings in the observer would grade a
   *      partially-played game as if it had finished; skip instead.
   *
   * Decision rule (decided by `planKind`, NOT by sniffing standings
   * length — opponents who disconnected before final results would
   * otherwise collapse a real MP game into the solo branch):
   *
   *   - **MP** (`planKind === "host_public"` or `"public_join"`):
   *     bot wins iff its `totalScore` is `>= max(opponents' totalScore)`
   *     and positive. Ties at the top count as wins.
   *   - **Solo** (`planKind === "solo"`): bot wins iff its total
   *     score reaches `WIN_RATIO_THRESHOLD` (0.5) of the per-mode max
   *     across the rounds actually observed. This is the same rule
   *     `winRecord.ts:computeIsWin` applies for non-bot players, so
   *     the bot's per-game streak agrees with the price.game UI's
   *     streak indicator at the same final score.
   *
   * Bot identity in standings: prefer `myPlayerId` (currently never
   * bound by the runner — but tests do, and a future binding is
   * cheap), then persona-name match, then standings[0]. Opponent
   * filter compares by `playerId` (not reference equality) so a
   * persona-name fallback that returns a fresh object reference
   * still partitions correctly.
   *
   * Streak update (independent of `moodState.streak`):
   *   - win after non-negative streak  → streak + 1
   *   - win after negative streak       → 1
   *   - loss after non-positive streak  → streak - 1
   *   - loss after positive streak      → -1
   */
  async function finalizeGameOutcome(
    planKind: LifecyclePlan["kind"],
    mode: GameMode,
    planCompleted: boolean,
  ): Promise<void> {
    const cs = opts.commandState;
    if (!cs) return;
    const reset = (): void => {
      cs.currentGameScore = 0;
      cs.currentGameRoundsObserved = 0;
    };
    if (cs.currentGameRoundsObserved === 0 || !planCompleted) {
      // Narrate the abandoned plan so the audience hears why the bot
      // pivots away from a stuck game. Quiet for solo plans where
      // a zero-round outcome is usually a transport blip; only narrate
      // when at least one round was attempted (matches the criterion
      // for "the viewer noticed a game was happening").
      if (cs.currentGameRoundsObserved > 0 || !planCompleted) {
        void opts.narrator?.reactive("plan_failed", cs.moodState.mood);
      }
      reset();
      return;
    }

    const isMp = planKind === "host_public" || planKind === "public_join";
    let isWin: boolean;
    // Denominator note: `currentGameRoundsObserved` (rounds with a
    // real outcome), not `plan.rounds`. `currentGameScore` only sums
    // observed rounds, so the ratio stays consistent if a transport
    // hiccup dropped a couple of round_end payloads. This is a
    // deliberate divergence from `winRecord.ts:computeIsWin`, which
    // assumes a complete game with all rounds scored.
    if (isMp) {
      const standings = session?.observer.getState().lastResult?.payload.standings;
      const myPlayerId = session?.observer.getState().myPlayerId ?? null;
      isWin = decideMpGameWin({
        standings,
        myPlayerId,
        personaName: opts.persona.name,
        fallbackScore: cs.currentGameScore,
        mode,
        roundsObserved: cs.currentGameRoundsObserved,
      });
    } else {
      // Solo: grade total score against the per-mode max times rounds
      // observed, gated by `WIN_RATIO_THRESHOLD`. Mirrors the canonical
      // single-player win rule in `winRecord.ts:computeIsWin` so the
      // bot's per-game streak agrees with what the price.game UI would
      // record for a non-bot player at the same final score. Pre-fix
      // used `score > 0`, which credited a win for any non-zero solo
      // game — the bot scores >0 on virtually every round, so streak
      // grew monotonically positive and morale never tipped negative.
      const totalMax = getPerRoundMaxScore(mode) * cs.currentGameRoundsObserved;
      isWin = totalMax > 0 && cs.currentGameScore / totalMax >= WIN_RATIO_THRESHOLD;
    }

    if (isWin) {
      cs.wins++;
      cs.streak = cs.streak >= 0 ? cs.streak + 1 : 1;
    } else {
      cs.losses++;
      cs.streak = cs.streak <= 0 ? cs.streak - 1 : -1;
    }
    // Feed the game outcome into the morale EMA. nextMood handles
    // the morale axis on its own when given a `game_outcome` input;
    // vibe + streak (the per-round axes) are unchanged here.
    const gameInput = { kind: "game_outcome", win: isWin } as const;
    const prevMoodState = cs.moodState;
    cs.moodState = nextMood(prevMoodState, gameInput);
    // eslint-disable-next-line no-console
    console.log(formatMoodTransition(prevMoodState, cs.moodState, gameInput));
    // Game-end mood shift announcement — morale moved by the EMA
    // could have flipped the resolved label across a polarity bucket
    // even though vibe+streak didn't change. The reactive() gate
    // sequences this after the game_win/game_loss line below.
    maybeAnnounceMoodShift(prevMoodState, cs.moodState);
    // Reactive game-end narration. Same rate-limit contract as the
    // per-round line: drops silently if Pricey is mid-utterance from
    // the final round_start / decision_announce / win_correct chain.
    // Mood read picks up the just-resolved label — morale moved the
    // bucket if the cumulative arc crossed a threshold.
    void opts.narrator?.reactive(isWin ? "game_win" : "game_loss", cs.moodState.mood);
    // MP-only: queue a `final_rank_*` follow-up via speak() so it
    // plays AFTER the game_win/game_loss line lands. speak() (rather
    // than reactive()) is intentional — we want this to play even
    // though the prior reactive marked Pricey as in-flight. Solo
    // games skip this; the rank concept doesn't apply.
    if (isMp) {
      const standings = session?.observer.getState().lastResult?.payload.standings;
      const myPlayerId = session?.observer.getState().myPlayerId ?? null;
      const rankEvent = computeFinalRankEvent(standings, myPlayerId, opts.persona.name);
      if (rankEvent) {
        void opts.narrator?.speak(rankEvent, cs.moodState.mood);
      }
    }
    // Persist the morale-updated snapshot. Per-round publishes hit
    // the same endpoint via attemptRound, but morale only moves on
    // game_outcome — without this push the persisted snapshot would
    // lag the real engine state by an entire game on a streak break.
    //
    // Awaited (was fire-and-forget) so the snapshot lands before each
    // executor's subsequent `publishStats()`. The previous
    // `void publishMood()` raced the next `publishStats()` and
    // sometimes lost — `stats.update`'s same-tab postMessage delivery
    // arrived first with the new mood label, the wheel was still
    // reading the snapshot's prior label, and viewers saw Pricey's
    // face flip while the wheel froze. Awaiting here closes the race
    // at the cost of one HTTP RTT (≈1ms to the local server) at plan
    // boundaries.
    await publishMood();
    reset();
  }

  function planStatusFromSuccesses(successes: number, total: number): PlanOutcome["status"] {
    // Plan is "completed" when at least half its rounds succeeded.
    // Old behaviour was strict equality (5/5 only); a 4/5 reported
    // no_match and triggered backoff for an essentially-healthy
    // plan. Half-success matches the rotation's tolerance for
    // single-round flakes.
    return successes >= Math.ceil(total / 2) ? "completed" : "no_match";
  }

  async function executeSolo(plan: Extract<LifecyclePlan, { kind: "solo" }>): Promise<PlanOutcome> {
    const { page } = await ensureSession();
    // Honour a chat-driven mode override.
    const mode = opts.commandState?.nextModeOverride ?? plan.mode;
    if (opts.commandState) opts.commandState.nextModeOverride = null;
    const url = `${opts.targetUrl}/play/${mode}?broadcast=1`;
    await softNavigate(page, url, { pageLoaded });
    pageLoaded = true;
    await awaitBroadcastReady(page);
    // Tell the page-state probe what URL prefix we expect to be on
    // for the duration of this plan. The probe compares this against
    // page.url() during long Phase 1 / Phase 4 waits and aborts
    // early if the page has navigated away.
    expectedPathPrefix = `/play/${mode}`;
    // Re-emit cumulative stats after the plan-boundary navigation.
    // Soft-nav preserves the BroadcastShell so the overlayBus state
    // survives, but the hard-fallback path (first plan, missing helper)
    // still tears down React — the publish keeps the BotCard's running
    // wins/losses/streak intact in either case. Same pattern as
    // `executePublicJoin` / `executeHostPublic` below.
    await publishStats();
    await opts.overlay?.send("lifecycle.phase", { phase: "in_round" });
    const { successes, total } = await playRounds(mode, plan.rounds);
    const status = planStatusFromSuccesses(successes, total);
    await finalizeGameOutcome(plan.kind, mode, status === "completed");
    await publishStats();
    await opts.overlay?.send("lifecycle.phase", { phase: "between" });
    expectedPathPrefix = null;
    return { plan, status };
  }

  async function executePublicJoin(plan: Extract<LifecyclePlan, { kind: "public_join" }>): Promise<PlanOutcome> {
    const { page } = await ensureSession();
    let lobbyCode: string | null = null;
    try {
      const lobbiesRes = await fetchImpl(`${opts.targetUrl}/api/mp/lobbies`, {
        headers: {
          accept: "application/json",
          // Mirror the Playwright context's identity header on out-of-band
          // fetches so the server treats this lobby probe as bot traffic too.
          // The header is only attached when STREAMER_BOT_SECRET is set —
          // matches the conditional on `extraHTTPHeaders` above.
          ...(streamerBotSecret ? { "x-streamer-bot": streamerBotSecret } : {}),
        },
      });
      if (lobbiesRes.ok) {
        const data = (await lobbiesRes.json()) as { lobbies?: PublicLobbyEntry[] };
        const whitelist = opts.modeWhitelist;
        const lobby = data.lobbies?.find((l) =>
          l.playerCount < l.maxPlayers
          && !l.hasPassword
          && (!whitelist || whitelist.has(l.gameMode)),
        );
        lobbyCode = lobby?.code ?? null;
      }
    } catch {
      lobbyCode = null;
    }
    if (!lobbyCode) {
      // Lifecycle's policy emits `fallbackToHost: true` so the
      // rotation will pick host_public next; a no_match here lets
      // the runner advance.
      return { plan, status: "no_match" };
    }

    await softNavigate(page, `${opts.targetUrl}/${lobbyCode}?broadcast=1`, { pageLoaded });
    pageLoaded = true;
    await awaitBroadcastReady(page);
    // Tell the page-state probe to expect this lobby's URL.
    expectedPathPrefix = `/${lobbyCode}`;
    // Re-emit cumulative stats after navigation (see executeSolo).
    await publishStats();
    await opts.overlay?.send("lifecycle.phase", { phase: "queuing" });
    // The MP page handles join handshake itself once the URL renders.
    // Wait for the observer to surface a room snapshot rather than
    // sleeping a fixed amount — that's brittle on slow networks.
    const { observer } = await ensureSession();
    const code = await waitForRoom(observer, 10_000);
    if (!code) {
      expectedPathPrefix = null;
      return { plan, status: "no_match" };
    }
    await opts.overlay?.send("lifecycle.phase", { phase: "in_round" });
    const mode = observer.getState().room?.gameMode;
    if (!mode) {
      expectedPathPrefix = null;
      return { plan, status: "no_match" };
    }
    // Late mode-change announcement for public_join: the mode wasn't
    // known at execute() dispatch (we joined whatever lobby was open),
    // so announce now if it differs from the last one we said.
    announceModeChangeIfNew(mode);
    const { successes, total } = await playRounds(mode, 5);
    const status = planStatusFromSuccesses(successes, total);
    // `mode` here comes from the joined room's `gameMode` (read from
    // the observer above), NOT from a plan field — public_join doesn't
    // pick the mode, it accepts whatever the lobby is hosting. The
    // other two executors (executeSolo, executeHostPublic) take it
    // from the plan / chat override.
    await finalizeGameOutcome(plan.kind, mode, status === "completed");
    await publishStats();
    await opts.overlay?.send("lifecycle.phase", { phase: "between" });
    expectedPathPrefix = null;
    return { plan, status };
  }

  async function executeHostPublic(plan: Extract<LifecyclePlan, { kind: "host_public" }>): Promise<PlanOutcome> {
    const { page, observer } = await ensureSession();
    // Honour the chat-driven mode override.
    const mode = opts.commandState?.nextModeOverride ?? plan.mode;
    if (opts.commandState) opts.commandState.nextModeOverride = null;
    // Navigate to /mp first so the page is connected; then emit
    // ROOM_CREATE via the socket bridge.
    await softNavigate(page, `${opts.targetUrl}/mp?broadcast=1`, { pageLoaded });
    pageLoaded = true;
    await awaitBroadcastReady(page);
    // Re-emit cumulative stats after navigation (see executeSolo).
    await publishStats();
    await opts.overlay?.send("lifecycle.phase", { phase: "queuing" });
    await sleep(1_000);
    await pageEmit(page, SOCKET_EVENTS.ROOM_CREATE, {
      displayName: opts.persona.name,
      gameMode: mode,
      isPublic: true,
      totalRounds: plan.rounds,
      preferredAvatar: opts.persona.avatar,
    });

    const ourRoomCode = await waitForRoom(observer, 10_000);
    if (!ourRoomCode) return { plan, status: "no_match" };
    if (opts.commandState) opts.commandState.hostedRoomCode = ourRoomCode;
    // Announce the new hosted room — but skip if we're re-hosting
    // with the same code (no viewer-visible change).
    if (ourRoomCode !== lastAnnouncedHostedRoom) {
      lastAnnouncedHostedRoom = ourRoomCode;
      void opts.narrator?.speak("hosting_room_created", opts.commandState?.moodState.mood);
    }

    // Opponent-aware shortening: instead of unconditionally sleeping
    // `waitForOpponentsSeconds` (90s in legacy), watch the room
    // snapshot for joiners and proceed early when they show up.
    //
    // Behaviour:
    //  - 1 opponent → 15s grace period, then start.
    //  - 2+ opponents → start within 5s.
    //  - 0 opponents at the configured ceiling → return no_match
    //    so the lifecycle picks a solo plan instead of standing
    //    in an empty room.
    //
    // Emits `mp.lobby_countdown` every ~10s so the broadcast HUD
    // can show a "looking for opponents" state instead of dead air.
    const startedWaitAt = Date.now();
    const totalWaitMs = plan.waitForOpponentsSeconds * 1_000;
    let countdownTimer: ReturnType<typeof setInterval> | null = setInterval(() => {
      const elapsedSec = Math.floor((Date.now() - startedWaitAt) / 1000);
      const remainingSec = Math.max(0, plan.waitForOpponentsSeconds - elapsedSec);
      const playerCount = observer.getState().room?.players.length ?? 1;
      void opts.overlay?.send("mp.lobby_countdown", {
        elapsedSec,
        remainingSec,
        playerCount,
        roomCode: ourRoomCode,
      });
    }, 10_000);
    try {
      const result = await waitForOpponents(observer, totalWaitMs);
      const opponents = result.players.length - 1; // subtract the bot itself
      if (opponents === 0) {
        // No takers — bail out and let the lifecycle pick a solo
        // plan next. Better than standing in an empty room.
        // eslint-disable-next-line no-console
        console.warn(`[runner] host_public: no opponents after ${totalWaitMs}ms; falling back to solo`);
        return { plan, status: "no_match" };
      }
      // Grace period after the first opponent arrives so others
      // can still join. 1 opp → 15s, 2+ opp → 5s.
      const graceMs = opponents >= 2 ? 5_000 : 15_000;
      const elapsedSinceStart = Date.now() - startedWaitAt;
      const remainingBudget = Math.max(0, totalWaitMs - elapsedSinceStart);
      await sleep(Math.min(graceMs, remainingBudget));
    } finally {
      if (countdownTimer) clearInterval(countdownTimer);
      countdownTimer = null;
    }

    // Host clicks "Ready" by emitting ROOM_READY then ROOM_START_ROUND.
    // Wait for the server's state-machine transition between the two
    // emits — firing them back-to-back can race the lobby→playing
    // transition and the server silently rejects the out-of-order
    // start.
    await pageEmit(page, SOCKET_EVENTS.ROOM_READY, undefined);
    await waitForRoomStatus(observer, ["playing"], 5_000);
    await pageEmit(page, SOCKET_EVENTS.ROOM_START_ROUND, undefined);

    // Tell the page-state probe to expect the room URL during the
    // round loop. Set after waitForRoomStatus so we don't false-
    // alarm during the "playing" transition.
    expectedPathPrefix = `/${ourRoomCode}`;
    await opts.overlay?.send("lifecycle.phase", { phase: "in_round" });
    const { successes, total } = await playRounds(mode, plan.rounds);
    const status = planStatusFromSuccesses(successes, total);
    await finalizeGameOutcome(plan.kind, mode, status === "completed");
    await publishStats();
    if (opts.commandState) opts.commandState.hostedRoomCode = null;
    await opts.overlay?.send("lifecycle.phase", { phase: "between" });
    expectedPathPrefix = null;
    return { plan, status };
  }

  /**
   * Phase 3d.2: Quick Play bidding executor.
   *
   * Always **creates** a fresh bidding lobby and seats 3 NPC bots —
   * never joins an existing public lobby. Joining could land the
   * streamer-bot in a real-MP room with humans, which contradicts
   * the user's spec ("never play in real multiplayer; just use the
   * single-play version of bidding war with bots"). The
   * /api/mp/quickplay POST is bypassed entirely; we go straight to
   * the create flow so the resulting room has the deterministic
   * 1-bot + 3-NPC composition the OpponentTracker is calibrated
   * against.
   *
   * Quick Play room start triggers `playRounds("bidding", N)` —
   * existing single-mode loop with the bidding strategy. The
   * runner instantiates an `OpponentTracker` for the room and
   * threads it through the StrategyContext so the bidding decoder
   * simulates later opponents under their inferred archetypes.
   */
  async function executeQuickplayBidding(
    plan: Extract<LifecyclePlan, { kind: "quickplay_bidding" }>,
  ): Promise<PlanOutcome> {
    const { page, observer } = await ensureSession();
    // Instantiate per-room OpponentTracker — used by the bidding
    // strategy via `ctx.opponentPosteriors`. Lifetime: this plan only.
    if (opts.commandState) {
      opts.commandState.opponentTracker = new OpponentTracker(plan.botDifficulty);
    }
    let resultStatus: PlanOutcome["status"];
    try {
      // Phase 3d.2: trigger Quick Play via the web app's
      // window-scoped `__pgBotCreateBiddingRoom` hook. The hook
      // calls `actions.createRoom(name, "bidding", { autoStart })`
      // directly — bypassing /api/mp/quickplay entirely so the
      // bot never lands in a real-MP human lobby (per user spec).
      // The hook is registered on every `?broadcast=1` mount of
      // MultiplayerPage; falls through to no_match if the prod
      // web hasn't shipped this revision yet.
      await softNavigate(page, `${opts.targetUrl}/mp?broadcast=1`, { pageLoaded });
      pageLoaded = true;
      await awaitBroadcastReady(page);
      await publishStats();
      await opts.overlay?.send("lifecycle.phase", { phase: "queuing" });
      // The hook is registered inside an effect with `actions` /
      // `handlers` deps that re-instantiate every React render —
      // there's a sub-millisecond window between a `waitForFunction`
      // resolving and a separate `evaluate` reading the property
      // where the hook can vanish during a re-render. Roll the
      // wait + call into a single `page.evaluate` polling loop so
      // there's no gap. Returns true on successful call, false on
      // timeout. (Code-review finding from PR #329.)
      const hookCalled = await page.evaluate(
        async ({ name, diff }) => {
          const deadline = Date.now() + 10_000;
          while (Date.now() < deadline) {
            const fn = (window as unknown as {
              __pgBotCreateBiddingRoom?: (opts: { displayName: string; botCount?: number; botDifficulty?: string }) => void;
            }).__pgBotCreateBiddingRoom;
            if (typeof fn === "function") {
              fn({ displayName: name, botCount: 3, botDifficulty: diff });
              return true;
            }
            await new Promise((r) => setTimeout(r, 50));
          }
          return false;
        },
        { name: opts.persona.name, diff: plan.botDifficulty },
      );
      if (!hookCalled) {
        // eslint-disable-next-line no-console
        console.warn("[runner] quickplay_bidding: __pgBotCreateBiddingRoom hook never registered or vanished mid-call (prod web older than PR #327?)");
        return { plan, status: "no_match" };
      }
      // Wait for the URL to settle on /<roomCode>. The web
      // client's createRoom callback writes
      // `replaceState("/<code>")` after the server's ack lands.
      // 15s is generous — autoStart sequence typically completes
      // in <1s.
      let code: string | null = null;
      try {
        await page.waitForFunction(
          () => {
            const path = window.location.pathname;
            return path !== "/mp" && path !== "/" && /^\/[A-Za-z0-9_-]{3,16}$/.test(path);
          },
          undefined,
          { timeout: 15_000, polling: 200 },
        );
        code = await page.evaluate(() => window.location.pathname.replace(/^\//, ""));
      } catch {
        // eslint-disable-next-line no-console
        console.warn("[runner] quickplay_bidding: room URL never settled after __pgBotCreateBiddingRoom");
        return { plan, status: "no_match" };
      }
      if (!code) return { plan, status: "no_match" };
      if (opts.commandState) opts.commandState.hostedRoomCode = code;
      // Quickplay-bidding host announcement — same de-dup gate as
      // executeHostPublic so a re-host with a fresh code fires
      // again but a no-op stay-on-same-code is silent.
      if (code !== lastAnnouncedHostedRoom) {
        lastAnnouncedHostedRoom = code;
        void opts.narrator?.speak("hosting_room_created", opts.commandState?.moodState.mood);
      }
      expectedPathPrefix = `/${code}`;
      // Re-add `?broadcast=1` to the URL — actions.createRoom's
      // replaceState wipes the query string, which would unmount
      // the broadcast overlay on any subsequent page.reload()
      // (the unhealthy-round recovery path triggers reload).
      // history.replaceState preserves React Router's view (which
      // matched /mp at softNavigate time) — we only fix the URL.
      await page.evaluate((c) => {
        try {
          window.history.replaceState(null, "", `/${c}?broadcast=1`);
        } catch {
          /* sandboxed eval — let the round-recovery hard-reload do its thing */
        }
      }, code);
      // Bind myPlayerId from the page's localStorage. The server returns
      // playerId via a socket *callback* response (not an event), so the
      // bridge's socket.onAny() never sees it; the observer's listeners
      // are structurally blind to this value. The web client writes it
      // to localStorage["mp_session_v2"] inside the same callback, BEFORE
      // window.history.replaceState (see `apps/web/src/hooks/
      // useMultiplayerSocket.ts:545-554`), so by the time we get here
      // the entry is reliably populated. Without this binding, the
      // bidding seat-matching wait at attemptRound burns a full 90s
      // every round and falls through to whatever turn-0 payload is
      // current — bot's strategy runs on the wrong seat, the input
      // isn't mounted by enactor time, and the server auto-defaults
      // the bot's bid (the "Pricey isn't bidding" symptom).
      try {
        const playerIdFromStorage = await page.evaluate(() => {
          try {
            const raw = localStorage.getItem("mp_session_v2");
            if (!raw) return null;
            const parsed = JSON.parse(raw) as { playerId?: unknown };
            return typeof parsed.playerId === "string" ? parsed.playerId : null;
          } catch {
            return null;
          }
        });
        if (playerIdFromStorage) {
          observer.setMyPlayerId(playerIdFromStorage);
          opts.telemetry?.log({
            evt: "myPlayerId.bound",
            source: "quickplay_localStorage",
            playerId: playerIdFromStorage,
          });
        } else {
          opts.telemetry?.log({
            evt: "myPlayerId.bound",
            source: "quickplay_localStorage",
            playerId: null,
            note: "localStorage mp_session_v2 missing or unparseable",
          });
        }
      } catch (err) {
        opts.telemetry?.log({
          evt: "myPlayerId.bound",
          source: "quickplay_localStorage",
          playerId: null,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      await opts.overlay?.send("lifecycle.phase", { phase: "in_round" });
      const { successes, total } = await playRounds("bidding", plan.rounds);
      resultStatus = planStatusFromSuccesses(successes, total);
      await finalizeGameOutcome(plan.kind, "bidding", resultStatus === "completed");
      await publishStats();
      await opts.overlay?.send("lifecycle.phase", { phase: "between" });
      expectedPathPrefix = null;
    } finally {
      // Always clear room-scoped state — even when bailing from a
      // join/create error path.
      if (opts.commandState) {
        opts.commandState.hostedRoomCode = null;
        opts.commandState.opponentTracker = null;
      }
    }
    return { plan, status: resultStatus };
  }

  // Guard against re-entrant panic calls. Two simultaneous triggers
  // (e.g. watchdog tick + page.on("crash") firing in the same window)
  // could both pass the `if (!session)` check before either of them
  // null'd it out, double-closing the browser and racing on disposal.
  let cleaningUp = false;
  async function panicCleanup(): Promise<void> {
    if (cleaningUp) return;
    if (!session) return;
    cleaningUp = true;
    const old = session;
    session = null;
    try {
      try { old.observer.dispose(); } catch { /* noop */ }
      try { await old.context.close(); } catch { /* noop */ }
      try { await old.browser.close(); } catch { /* noop */ }
    } finally {
      cleaningUp = false;
    }
  }

  /**
   * Compute the `final_rank_*` event for an MP game's standings, or
   * `null` when standings are missing / the bot can't be located in
   * them. Identity match: prefer playerId, fall back to displayName,
   * fall back to first-seat (matches the same precedence
   * `decideMpGameWin` uses for win attribution).
   *
   * Returns:
   *   - "final_rank_first"  when the bot's totalScore is strictly
   *                         greater than every opponent (ties at the
   *                         top still count as first — same call as
   *                         the win rule).
   *   - "final_rank_last"   when every opponent has a strictly higher
   *                         totalScore.
   *   - "final_rank_middle" otherwise (≥1 above, ≥1 below).
   *   - null               when standings are empty or the bot isn't
   *                         identifiable in them.
   */
  /**
   * Fire a `mood_shift_*` or `mood_extreme` reactive line when the
   * mood label changes meaningfully between two states. No-op when
   * the label is unchanged or the new label has equal polarity to
   * the old one (e.g., neutral ↔ focused — same polarity bucket).
   *
   * Probabilistic gate (`MOOD_SHIFT_ANNOUNCE_PROB`) keeps this from
   * firing on every transition. `narrator.reactive()` further drops
   * if Pricey is mid-utterance from the outcome line that triggered
   * the shift — the per-round outcome reactive takes priority and
   * the shift line gets the next opportunity.
   */
  function maybeAnnounceMoodShift(prev: { mood: Mood }, next: { mood: Mood }): void {
    if (!opts.narrator) return;
    if (Math.random() >= MOOD_SHIFT_ANNOUNCE_PROB) return;
    // Decision logic (which event, or none) lives in `nextMoodShiftEvent`
    // alongside the polarity table — keeps the runner method to a
    // probability gate + side-effect dispatch, and the tested logic
    // stays in outcome.ts.
    const event = nextMoodShiftEvent(prev.mood, next.mood);
    if (!event) return;
    void opts.narrator.reactive(event, next.mood);
  }

  /**
   * Fire `mode_change` (mode-specific flavor when defined, generic
   * otherwise) when the upcoming plan's mode differs from the last
   * one we announced. Suppressed on consecutive same-mode plans so
   * viewers don't hear "switching to classic!" twice in a row.
   *
   * `public_join` plans don't know the mode until the lobby is
   * found, so we don't call this for them — those announcements
   * land later from inside `executePublicJoin` once `gameMode` is
   * known.
   */
  function announceModeChangeIfNew(mode: GameMode): void {
    if (mode === lastAnnouncedMode) return;
    lastAnnouncedMode = mode;
    const specific = modeChangeEventForMode(mode);
    // 80% specific (when defined) / 20% generic mood-tagged for
    // variety — keeps mode flavor dominant without ever feeling
    // scripted on a long session.
    const event = specific && Math.random() < 0.8 ? specific : "mode_change";
    void opts.narrator?.speak(event, opts.commandState?.moodState.mood);
  }

  return {
    async execute(plan: LifecyclePlan, signal: AbortSignal): Promise<PlanOutcome> {
      if (signal.aborted) return { plan, status: "no_match" };
      // Proactive browser recycle (see `browserRecyclePlans` above):
      // discard the long-lived Chromium every N plans so accumulated
      // renderer/X11-pixmap memory is released. panicCleanup() nulls the
      // session; the executeXxx() calls below relaunch via ensureSession.
      // Nothing between here and those calls needs a live session.
      if (browserRecyclePlans > 0 && session && plansSinceLaunch >= browserRecyclePlans) {
        // eslint-disable-next-line no-console
        console.warn(`[runner] proactive browser recycle after ${plansSinceLaunch} plans (STREAMER_BROWSER_RECYCLE_PLANS=${browserRecyclePlans})`);
        await panicCleanup();
        plansSinceLaunch = 0;
      }
      plansSinceLaunch += 1;
      // One-shot session_start — announced on the first plan execute
      // for this driver instance only. Pricey says hi to chat once
      // per process boot; subsequent plans roll into mode_change.
      if (!sessionStartAnnounced) {
        sessionStartAnnounced = true;
        void opts.narrator?.speak("session_start");
      }
      // Announce mode change up front for plans where the mode is
      // known at dispatch time. `public_join` discovers its mode
      // mid-flight (executePublicJoin handles the announcement
      // after the lobby snapshot lands).
      if (plan.kind === "solo") announceModeChangeIfNew(plan.mode);
      else if (plan.kind === "host_public") announceModeChangeIfNew(opts.commandState?.nextModeOverride ?? plan.mode);
      else if (plan.kind === "quickplay_bidding") announceModeChangeIfNew("bidding");
      const planSummary =
        plan.kind === "solo"
          ? `solo:${plan.mode} x${plan.rounds}`
          : plan.kind === "host_public"
          ? `host_public:${plan.mode} x${plan.rounds} wait=${plan.waitForOpponentsSeconds}s`
          : plan.kind === "quickplay_bidding"
          ? `quickplay_bidding x${plan.rounds} difficulty=${plan.botDifficulty}`
          : `public_join (fallback=${plan.fallbackToHost})`;
      // eslint-disable-next-line no-console
      console.log(`[runner] plan ${planSummary}`);
      // Mark the watchdog: we're alive and starting work. The
      // no-progress timer rolls forward off this even if no rounds
      // succeed (e.g. lobby search returns empty for a while).
      opts.watchdog?.recordActivity();
      let outcome: PlanOutcome;
      switch (plan.kind) {
        case "solo":
          outcome = await executeSolo(plan);
          break;
        case "public_join":
          outcome = await executePublicJoin(plan);
          break;
        case "host_public":
          outcome = await executeHostPublic(plan);
          break;
        case "quickplay_bidding":
          outcome = await executeQuickplayBidding(plan);
          break;
      }
      // eslint-disable-next-line no-console
      console.log(`[runner] plan complete: ${planSummary} → ${outcome.status}`);
      return outcome;
    },
    /**
     * Tear down the current browser/session so the next ensureSession()
     * relaunches fresh. Idempotent; safe to call from the watchdog,
     * page.on hooks, or shutdown.
     */
    async panic(): Promise<void> {
      // eslint-disable-next-line no-console
      console.warn("[runner] driver.panic() — closing session for fresh relaunch");
      await panicCleanup();
    },
    async shutdown() {
      await panicCleanup();
    },
    async hydrateMood() {
      await hydrateMoodFromServer();
    },
  };
}

/**
 * Block until the observer reports a round_start payload for `mode`,
 * or `timeoutMs` elapses. Returns the payload (or null on timeout).
 *
 * `minRoundNumber` gates against stale round payloads. Without it, a
 * dropped `game:round_end` would leave the previous round's payload
 * in `observer.state.round`, and the next call to this function
 * would return the old payload instantly — causing the bot to "play"
 * the new round with the previous round's products. Pass the
 * roundNumber of the most recently consumed round so any payload
 * with the same or older number is ignored.
 */
/**
 * If a blocking overlay is open on the page, dismiss it by pressing
 * Escape. Currently covers:
 *   - `.image-modal-overlay` — ImageModal (product image zoom viewer)
 *   - `.product-tooltip` — ProductTooltip (hover popover that
 *     occasionally lingers and overlaps result-page UI when the
 *     bot's cursor brushes a product title)
 *
 * Both components listen for Escape on `window` and dismiss
 * themselves. Idempotent: when nothing is open the keystroke is
 * harmless. Errors are swallowed — a stuck dismiss shouldn't block
 * the round attempt.
 *
 * Returns true when at least one overlay was detected and dismissed,
 * false otherwise.
 */

async function dismissBlockingOverlays(page: Page): Promise<boolean> {
  try {
    const visibleSelectors: string[] = [];
    for (const sel of BLOCKING_OVERLAY_SELECTORS) {
      const visible = await page.locator(sel).first().isVisible().catch(() => false);
      if (visible) visibleSelectors.push(sel);
    }
    if (visibleSelectors.length === 0) return false;
    await page.keyboard.press("Escape").catch(() => { /* swallow */ });
    // Give React a tick to unmount before the caller proceeds.
    for (const sel of visibleSelectors) {
      await page.waitForSelector(sel, { state: "detached", timeout: 1000 }).catch(() => { /* swallow */ });
    }
    // eslint-disable-next-line no-console
    console.warn(`[runner] dismissed blocking overlay(s): ${visibleSelectors.join(", ")}`);
    return true;
  } catch {
    return false;
  }
}

async function waitForRoundStart(
  observer: Observer,
  mode: GameMode,
  timeoutMs: number,
  minRoundNumber?: number,
): Promise<RoundStartPayload | null> {
  function isFreshPayload(payload: RoundStartPayload | undefined): boolean {
    if (!payload) return false;
    if (payload.gameMode !== mode) return false;
    if (minRoundNumber !== undefined && payload.roundNumber <= minRoundNumber) return false;
    return true;
  }
  const existing = observer.getState().round;
  if (existing && isFreshPayload(existing.payload)) {
    return existing.payload;
  }
  return new Promise<RoundStartPayload | null>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      unsubscribe();
      resolve(null);
    }, timeoutMs);
    const unsubscribe = observer.onChange((state) => {
      if (settled) return;
      if (state.round && isFreshPayload(state.round.payload)) {
        settled = true;
        clearTimeout(timer);
        unsubscribe();
        resolve(state.round.payload);
      }
    });
  });
}

/**
 * Block until the observer's room snapshot reaches one of the given
 * statuses, or `timeoutMs` elapses. Returns the matched status (or
 * null on timeout). Used to synchronise on lobby→playing transitions
 * before firing the next emit.
 */
async function waitForRoomStatus(
  observer: Observer,
  statuses: readonly ("lobby" | "playing" | "ending" | "between_rounds" | "finished")[],
  timeoutMs: number,
): Promise<string | null> {
  const targets = new Set<string>(statuses);
  const existing = observer.getState().room?.status;
  if (existing && targets.has(existing)) return existing;
  return new Promise<string | null>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      unsubscribe();
      resolve(null);
    }, timeoutMs);
    const unsubscribe = observer.onChange((state) => {
      if (settled) return;
      const status = state.room?.status;
      if (status && targets.has(status)) {
        settled = true;
        clearTimeout(timer);
        unsubscribe();
        resolve(status);
      }
    });
  });
}

/**
 * Watch the room snapshot for joiners. Resolves when the deadline
 * elapses; the result reflects the player list at that moment so
 * the caller can decide whether to start, grace-period, or bail.
 *
 * The host itself counts as one player, so `result.players.length
 * - 1` is the opponent count.
 */
async function waitForOpponents(
  observer: Observer,
  timeoutMs: number,
): Promise<{ players: { id: string }[] }> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      unsubscribe();
      const players = observer.getState().room?.players ?? [];
      resolve({ players: players.map((p) => ({ id: p.id })) });
    }, timeoutMs);
    const unsubscribe = observer.onChange((state) => {
      if (settled) return;
      const players = state.room?.players ?? [];
      // 2+ players means the bot has at least one opponent.
      if (players.length >= 2) {
        settled = true;
        clearTimeout(timer);
        unsubscribe();
        resolve({ players: players.map((p) => ({ id: p.id })) });
      }
    });
  });
}

/**
 * Block until the observer surfaces a non-null room snapshot, or
 * `timeoutMs` elapses. Returns the room code (or null on timeout).
 */
async function waitForRoom(observer: Observer, timeoutMs: number): Promise<string | null> {
  const existing = observer.getState().room;
  if (existing) return existing.roomCode;
  return new Promise<string | null>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      unsubscribe();
      resolve(null);
    }, timeoutMs);
    const unsubscribe = observer.onChange((state) => {
      if (settled) return;
      if (state.room) {
        settled = true;
        clearTimeout(timer);
        unsubscribe();
        resolve(state.room.roomCode);
      }
    });
  });
}

// Re-export so consumers don't have to know the SOCKET_EVENTS path.
export { SOCKET_EVENTS };
