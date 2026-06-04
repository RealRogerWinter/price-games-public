/**
 * Overlay bus — receives events from the bot streamer's injected controller
 * via `window.postMessage` and exposes them to the broadcast panels via a
 * single React hook.
 *
 * Wire shape (sender side, posted from bot controller):
 *   window.postMessage({ source: 'pg-bot', kind: '<event>', payload: ... }, '*');
 *
 * Receiver side:
 *   const state = useOverlayState();
 *
 * The bus tolerates:
 *   - Missing fields (panels render placeholder/idle state).
 *   - Out-of-order events (each kind is a state slot; the latest payload wins).
 *   - Foreign messages from other extensions / windows (filtered by `source`).
 *
 * It is intentionally one-way — panels never write to the bot. If a viewer
 * action needs to influence the bot it goes through the chat aggregator,
 * not through this bus.
 */
import { useEffect, useState } from "react";
import { DEFAULT_MOOD, isMood, type Mood } from "@price-game/shared";

const MESSAGE_SOURCE = "pg-bot";
const CHAT_HISTORY_LIMIT = 30;
const RECENT_ROUNDS_LIMIT = 8;
/**
 * Max thoughts kept in the FIFO. The ThoughtFeed panel renders the
 * top N stacked; older entries fall off the bottom. Chosen so the
 * stack stays glanceable on a 1080p stream without dominating the
 * left rail.
 */
const THOUGHT_FEED_LIMIT = 3;
/**
 * Hard cap on per-thought text length, applied at the trust
 * boundary. Mirrors the existing utterance text cap in spirit —
 * thoughts are short by design (one-liners) and a runaway template
 * fill shouldn't be able to inject novella-scale strings into the
 * panel layout.
 */
const THOUGHT_TEXT_MAX = 240;
/** Length cap for `intent` strings on a thought.bubble payload. */
const THOUGHT_INTENT_MAX = 64;
/** Length cap for `id` strings on a thought.bubble payload. */
const THOUGHT_ID_MAX = 128;
/**
 * Monotonic counter for synthetic thought ids generated inside the
 * reducer (round.decision translation, sanitizeThoughtBubble fallback).
 * Two thoughts emitted within the same millisecond would collide on
 * `Date.now()`-only ids; React's reconciler then mis-keys siblings
 * which can swap their TTL animations. The counter guarantees
 * uniqueness without pulling in randomUUID for the bus side.
 */
let synthIdCounter = 0;
function nextSynthId(prefix: string): string {
  synthIdCounter = (synthIdCounter + 1) % Number.MAX_SAFE_INTEGER;
  return `${prefix}-${synthIdCounter}`;
}
// Bumped any time the persisted shape changes incompatibly. The key
// embeds the version so the two can't drift; old entries fail the `v`
// check inside the parsed object and fall through to defaults.
const STORAGE_VERSION = 1;
const STORAGE_KEY = `pg_broadcast_overlay_v${STORAGE_VERSION}`;

export type LifecyclePhase =
  | "idle"
  | "queuing"
  | "in_round"
  | "between"
  | "game_over";

export interface RoundStartEvent {
  mode: string;
  roundIndex: number;
  totalRounds: number;
  productSummary?: string;
}

export interface RoundResultEvent {
  outcome: "correct" | "incorrect" | "partial";
  points: number;
  deltaScore?: number;
  pctOff?: number;
}

export interface RecentRound {
  mode: string;
  outcome: RoundResultEvent["outcome"];
  points: number;
  /** ms since epoch when the result arrived. */
  at: number;
}

export interface BotStats {
  wins: number;
  losses: number;
  streak: number;
  /** Mood label from `@price-game/shared`. Single source of truth for the set. */
  mood?: Mood;
}

/**
 * Full mood snapshot pushed by the bot's `publishMood` after every
 * `nextMood` call. Wider than `BotStats.mood` (which only carries
 * the resolved label): includes the engine's hidden vibe + morale
 * axes so the overlay's MoodWheel (and operator HUD) can render
 * the trend caret + sector highlighting.
 *
 * Stays separate from `BotStats` so the legacy stats payload doesn't
 * have to grow optional fields that not every consumer cares about
 * — and so the overlay reducer can treat the two channels
 * independently (a mood-only update doesn't churn unrelated stats
 * derived state).
 */
export interface MoodSnapshot {
  mood: Mood;
  /** Hidden vibe ∈ [-3, 3]. Engine-side fast axis. */
  vibe: number;
  /** Hidden morale ∈ [-1, 1]. Engine-side slow EMA axis. */
  morale: number;
  /** Signed round streak. Same field as BotStats.streak; mirrored here for convenience. */
  streak: number;
  /** Optional bot-stamped ms-since-epoch for last update. */
  updatedAt?: number;
}

export interface ChatMessage {
  /** Stable client-side id so React keys are stable across re-renders. */
  id: string;
  platform: "twitch" | "youtube" | "kick" | string;
  user: string;
  text: string;
  color?: string;
  /** ms since epoch. */
  at: number;
}

export interface MusicNowPlaying {
  title: string;
  artist?: string;
  album?: string;
}

/**
 * VisualTick — payload of `streamer:nn-tick`. Mirrors the worker's
 * VisualTick type in `packages/bot-streamer/src/learning/types.ts`,
 * redeclared here so the web bundle has no dependency on the
 * bot-streamer package.
 */
export interface NnTick {
  roundId: string;
  phase: "idle" | "thinking" | "guessing" | "reveal" | "result";
  network: {
    layers: Array<{
      name: string;
      activations: number[];
      mostActiveIdx: number;
      mostActiveTrail: [number, number];
    }>;
    weightSamples: Array<{
      fromLayer: number;
      fromIdx: number;
      toLayer: number;
      toIdx: number;
      weight: number;
    }>;
    heroPath?: Array<{ layer: number; idx: number }>;
  };
  prediction: { cents: number; sigma: number };
  /**
   * Top-K canonical-prices catalog candidates from the priceClassHead
   * softmax, sorted by probability descending. Kept on the wire for
   * log/debug; no longer rendered (the "What I See" card was removed
   * in the UI-polish pass). Optional for back-compat with PR-2-era
   * ticks that don't ship this field.
   */
  priceCandidates?: Array<{ cents: number; prob: number }>;
  /**
   * Belief block — slimmed in PR #4. The pre-cleanup category /
   * brand-tier softmaxes are gone with the heads that produced them;
   * only `topFeatures` + an optional pre-rendered worker `sentence`
   * remain. The sentence is now confidence-derived (top
   * priceCandidate's prob) instead of category-derived.
   */
  belief: {
    topFeatures: Array<{ name: string; contribution: number }>;
    sentence?: string;
  };
  embedding2d: { x: number; y: number };
  recentLosses: number[];
  /**
   * Per-round accuracy buckets, one entry per round. Sourced from the
   * game's outcome (correct/partial/incorrect) and mapped to a colour
   * bucket — NOT a per-product price-class re-prediction. Newest at the
   * end. The "Last 10 Guesses" panel renders the last 10.
   */
  recentAccuracy: Array<"within10" | "within25" | "miss">;
  teachingMoment: { triggered: boolean; productTitle?: string };
  /**
   * Optional training/health snapshot — feeds the Neural Debug HUD.
   * Mirrors VisualTick.health on the worker side. Optional for
   * back-compat with PR-2-era ticks; the panel renders an "n/a"
   * placeholder when absent.
   */
  health?: {
    round: number;
    loss: number | null;
    gradNormP95: number;
    learningRate: number;
    warmupStep: number;
    warmupTotal: number;
    bufferSize: number;
    bufferCapacity: number;
    batchSize: number;
    stepsPerRound: number;
    goldenMAE: number | null;
    /**
     * ms since the last successful saveSnapshot at the time the worker
     * built the tick. The HUD adds the local elapsed-since-receive to
     * extrapolate "X s ago" between ticks.
     */
    snapshotAgeMs: number;
    teachingMomentsCount: number;
    nanRollbacks: number;
    frozen: boolean;
  };
  ageMs: number;
}

export interface CursorAim {
  /** ms-since-epoch when the aim event arrived (used to expire stale aims). */
  at: number;
  /** Target bounding box, in viewport pixels. */
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Single source of truth for "what is Pricey saying right now". Reduced
 * from the runner's `tts.utterance.*` envelope stream — `start` mints
 * the slot, `audio_started` populates `audioStartedAt`, `audio_ended`
 * populates `audioEndedAt`, `cancelled` marks it ended-now. Subtitle
 * visibility, speaking flag, and Avatar mouth-snap-closed are all
 * DERIVED from this one slot so the three subsystems can never drift
 * out of sync the way the legacy three-independent-timelines design
 * (estimate-based subtitle hide / first-PCM-chunk speaking flag /
 * quiescence-driven false) did. PR 4 cutover removed the legacy
 * `subtitle` / `tts` state slots and `tts.line` / `tts.state` /
 * `tts.audio_chunk` envelope kinds — both transports lived in parallel
 * for one release (PR 2 emit / PR 3 reduce) before this retirement.
 */
export interface CurrentUtterance {
  id: string;
  text: string;
  intent: string;
  /** Mood at time of decision (when narrator picked the line). */
  mood: Mood;
  /** Estimated duration in ms — the narrator's text-length-based guess. */
  estimatedDurationMs: number;
  /** ms-since-epoch when `tts.utterance.start` arrived. */
  startedAt: number;
  /** ms-since-epoch when `tts.utterance.audio_started` arrived (first PCM chunk). */
  audioStartedAt: number | null;
  /** ms-since-epoch when `tts.utterance.audio_ended` arrived (real aplay.exit). */
  audioEndedAt: number | null;
}

/**
 * True if the page should currently render the subtitle bubble for
 * `currentUtterance`. Hides on REAL audio-end (not on estimated
 * duration), with a `MIN_VISIBLE_MS` floor so very short lines stay
 * readable. Pure function; consumers re-evaluate on a `setTimeout`
 * triggered by the audio-end transition.
 *
 * @param state Current overlay state.
 * @param now Reference time. Defaults to Date.now() — injectable for
 *            deterministic tests.
 */
export function subtitleVisible(state: { currentUtterance: CurrentUtterance | null }, now: number = Date.now()): boolean {
  const cu = state.currentUtterance;
  if (cu == null) return false;
  if (cu.audioEndedAt == null) return true;
  return now - cu.startedAt < SUBTITLE_MIN_VISIBLE_MS;
}

/**
 * True between `audio_started` and `audio_ended` for the active
 * utterance. Drives Avatar's mouth-snap-closed effect and any future
 * speaking-cue UI.
 */
export function isSpeaking(state: { currentUtterance: CurrentUtterance | null }): boolean {
  const cu = state.currentUtterance;
  if (cu == null) return false;
  return cu.audioStartedAt != null && cu.audioEndedAt == null;
}

/**
 * Subtitle floor — keeps short utterances on screen long enough to
 * read even when audio ends near-instantly (e.g. an ack line that
 * Piper renders in 200ms). Anchored to `startedAt`, not to
 * `audioEndedAt`, so a long subtitle that ends naturally doesn't get
 * an extra MIN tail.
 */
export const SUBTITLE_MIN_VISIBLE_MS = 1500;

export interface LobbyCountdown {
  /** ms-since-epoch of the latest countdown event. */
  at: number;
  elapsedSec: number;
  remainingSec: number;
  playerCount: number;
  roomCode: string;
}

/**
 * Single rendered thought in the visual feed. Replaces the legacy
 * one-at-a-time `rationale` slot — the new ThoughtFeed panel keeps
 * the most recent THOUGHT_FEED_LIMIT entries stacked, with the
 * existing strategy rationale flowing through here as one of the
 * thought intents.
 */
export interface ThoughtEntry {
  /** Stable id for React list keying — preserved across re-renders. */
  id: string;
  /** Pre-filled, ready-to-render text. The runner already substituted
   * NN data into the template before sending. */
  text: string;
  /** Discriminator; lets the panel style different intents (e.g.,
   * strategy_rationale gets a different background than nn_*). */
  intent: string;
  /** Mood at thought-time. Drives mood-color accents. */
  mood: Mood;
  /** ms-since-epoch the thought was emitted; drives fade animation. */
  at: number;
}

interface OverlayState {
  phase: LifecyclePhase;
  currentRound: RoundStartEvent | null;
  /**
   * Most recent thoughts the bot emitted, newest first. Capped at
   * THOUGHT_FEED_LIMIT — older entries fall off the end. Replaces
   * the legacy single-slot `rationale` / `rationaleAt` pair; the
   * strategy rationale flows in here as a `strategy_rationale`-
   * intent thought, alongside ambient NN-flavored thoughts emitted
   * by the runner's Thinker module.
   */
  thoughts: ThoughtEntry[];
  stats: BotStats;
  recentRounds: RecentRound[];
  chat: ChatMessage[];
  music: MusicNowPlaying | null;
  cursorAim: CursorAim | null;
  /**
   * Single source of truth for the active utterance. PR 4 cutover
   * retired the legacy `subtitle` and `tts` slots — components read
   * directly from this slot via the `subtitleVisible` / `isSpeaking`
   * selectors.
   */
  currentUtterance: CurrentUtterance | null;
  lobbyCountdown: LobbyCountdown | null;
  /**
   * Latest NN visualisation tick (null until the first round lands).
   * Updated by the streamer:nn-tick socket relay; the broadcast NN
   * panels read from this slot.
   */
  nnTick: NnTick | null;
  /**
   * Latest full mood snapshot (label + hidden vibe + morale + signed
   * round streak). Carried by the `mood.snapshot` envelope, which the
   * `useStreamerMoodRelay` hook bridges from the server's
   * `STREAMER_BOT_MOOD` socket event. Richer than the legacy
   * `stats.mood` field — the indicator uses the hidden axes for trend
   * arrows / morale bars. Null until the first snapshot lands.
   */
  moodSnapshot: MoodSnapshot | null;
}

const INITIAL_STATE: OverlayState = {
  phase: "idle",
  currentRound: null,
  thoughts: [],
  stats: { wins: 0, losses: 0, streak: 0, mood: DEFAULT_MOOD },
  recentRounds: [],
  chat: [],
  music: null,
  cursorAim: null,
  currentUtterance: null,
  lobbyCountdown: null,
  nnTick: null,
  moodSnapshot: null,
};

interface BusEnvelope {
  source: typeof MESSAGE_SOURCE;
  kind: string;
  payload?: unknown;
}

function isBusEnvelope(value: unknown): value is BusEnvelope {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return v.source === MESSAGE_SOURCE && typeof v.kind === "string";
}

/**
 * PCM-chunk sidechannel — `tts.audio_chunk` events from the runner do
 * NOT flow through `reduceOverlayEvent` because their cadence (~25
 * dispatches/sec while speaking) would re-render every overlay panel
 * on every frame for no benefit. Instead, the page-side message
 * listener decodes them once and re-dispatches on this EventTarget;
 * only consumers that actually need per-chunk samples (the Avatar
 * panel's lipsync) subscribe.
 *
 * The detail payload carries an Int16Array view over fresh storage —
 * consumers can retain it without worrying about subsequent overwrites.
 */
export interface PcmChunkDetail {
  samples: Int16Array;
  ts: number;
}

export const pcmEvents: EventTarget =
  typeof EventTarget !== "undefined" ? new EventTarget() : ({} as EventTarget);

/**
 * Maximum number of decoded PCM chunks held in the replay queue. Sized
 * to ~2 seconds of audio at the runner's 25Hz dispatch rate. Sized so a
 * cold-start Avatar (`lazy()` chunk fetch + parse) can mount within ~2s
 * and still backfill an opening utterance's mouth animation. Excess
 * chunks drop oldest-first.
 */
const PCM_REPLAY_MAX = 50;

/**
 * Maximum number of pending bus envelopes captured by the module-load-
 * time listener before useOverlayState's first mount drains them. Sized
 * for a worst-case ~10 seconds of PCM (250 chunks) plus headroom for
 * non-audio envelopes. Drops oldest-first when overflowing — newer events
 * win, so a slow page hydration that misses the start of a stream still
 * lands the most recent state for every slot.
 */
const PENDING_ENVELOPES_MAX = 500;

let pcmReplayQueue: PcmChunkDetail[] = [];
let pendingEnvelopes: BusEnvelope[] = [];
let busListenerAttached = false;

/**
 * Drain the PCM replay queue. Returns every decoded chunk that arrived
 * since the queue was last drained (or since process start). Avatar
 * calls this on its `useEffect` mount so chunks dispatched before its
 * `pcmEvents` listener attached are still applied to the envelope —
 * otherwise the cold-start window between bus-mount and Avatar-mount
 * (lazy chunk + Suspense) silently drops the opening 100-500ms of mouth
 * animation.
 *
 * Subsequent calls return an empty array until new chunks are pushed.
 */
export function drainPcmReplayQueue(): PcmChunkDetail[] {
  const out = pcmReplayQueue;
  pcmReplayQueue = [];
  return out;
}

/**
 * Test-only reset hook for the module-scoped replay buffers. Vitest
 * shares modules across tests in a single worker, so accumulated state
 * from one test would otherwise contaminate the next. Production code
 * never calls this.
 */
export function __resetReplayBuffersForTests(): void {
  pcmReplayQueue = [];
  pendingEnvelopes = [];
  busListenerAttached = false;
  if (typeof window !== "undefined") {
    const w = window as unknown as { __pgPcmStats?: PcmDiagStats; __pgBroadcastReady?: boolean };
    if (w.__pgPcmStats) {
      w.__pgPcmStats.received = 0;
      w.__pgPcmStats.decoded = 0;
      w.__pgPcmStats.dispatched = 0;
      w.__pgPcmStats.lastDecodeError = null;
      w.__pgPcmStats.firstReceivedAt = null;
      w.__pgPcmStats.lastReceivedAt = null;
      w.__pgPcmStats.synthesizedAudioStartedCount = 0;
    }
    if ("__pgBroadcastReady" in w) {
      delete w.__pgBroadcastReady;
    }
  }
}

/**
 * Module-load-time fallback listener. Captures any `pg-bot` envelopes
 * that arrive before the first `useOverlayState` mounts — the runner's
 * narrator can fire `tts.line`, `tts.state`, and `tts.audio_chunk`
 * envelopes the moment Playwright's first navigation lands, which is
 * before React has hydrated and even longer before the bus's React
 * useEffect message listener has attached. Without this fallback, every
 * envelope of the first utterance is silently lost and the mouth never
 * animates on the opening line of a session.
 *
 * Once a useOverlayState consumer mounts, `busListenerAttached` flips
 * true and this fallback no-ops; the React listener handles everything
 * live thereafter.
 */
if (typeof window !== "undefined") {
  window.addEventListener("message", (ev: MessageEvent<unknown>) => {
    if (busListenerAttached) return;
    if (!isBusEnvelope(ev.data)) return;
    if (pendingEnvelopes.length >= PENDING_ENVELOPES_MAX) {
      pendingEnvelopes.shift();
    }
    pendingEnvelopes.push(ev.data as BusEnvelope);
  });
}

/**
 * Diagnostic counters for the PCM-chunk pipeline. Exposed on
 * `window.__pgPcmStats` so the streamer container's Chromium and
 * sandbox/dev sessions can report whether `tts.audio_chunk` events
 * arrive, decode, and dispatch onto `pcmEvents`. Lipsync mouth
 * animation depends on all three counters incrementing together
 * during speech; a stuck `received` reveals the runner's
 * `page.evaluate` path is failing, a stuck `decoded` reveals the
 * envelope shape changed, and a stuck `dispatched` reveals an
 * EventTarget plumbing regression.
 */
export interface PcmDiagStats {
  received: number;
  decoded: number;
  dispatched: number;
  /** Tag set when decodePcmEnvelope rejects a payload. Cleared on next success. */
  lastDecodeError: string | null;
  firstReceivedAt: number | null;
  lastReceivedAt: number | null;
  /**
   * Bumped when the `tts.utterance.audio_ended` reducer synthesises a
   * missing `audioStartedAt` (Piper crashed before producing audio, OR
   * the `audio_started` envelope was dropped on the wire). The HUD
   * surfaces this with a warn-tone row so an operator can distinguish
   * "this happens occasionally" (Piper edge case) from "this is
   * happening every utterance" (envelope transport regression).
   */
  synthesizedAudioStartedCount: number;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/consistent-type-definitions, no-var
  var __pgPcmStats: PcmDiagStats | undefined;
  /**
   * Set to true by Avatar's mount useEffect once it has attached its
   * `pcmEvents` chunk listener and the bus's postMessage listener is
   * known to be live. The streamer-bot driver awaits this flag via
   * `page.waitForFunction` immediately after each `softNavigate` so it
   * never starts emitting TTS into a window with no consumers — the
   * primary defence against the "first-utterance silent mouth" race.
   * The replay buffers in this module are the secondary defence.
   */
  // eslint-disable-next-line @typescript-eslint/consistent-type-definitions, no-var
  var __pgBroadcastReady: boolean | undefined;
}

function ensurePcmStats(): PcmDiagStats {
  if (typeof window === "undefined") {
    return { received: 0, decoded: 0, dispatched: 0, lastDecodeError: null, firstReceivedAt: null, lastReceivedAt: null, synthesizedAudioStartedCount: 0 };
  }
  const w = window as unknown as { __pgPcmStats?: PcmDiagStats };
  if (!w.__pgPcmStats) {
    w.__pgPcmStats = { received: 0, decoded: 0, dispatched: 0, lastDecodeError: null, firstReceivedAt: null, lastReceivedAt: null, synthesizedAudioStartedCount: 0 };
  }
  return w.__pgPcmStats;
}

/**
 * Maximum decoded chunk size (bytes) the page will accept on a single
 * `tts.audio_chunk` envelope. The runner pins chunk size at 1764 bytes
 * (~40ms at 22050 Hz). This cap is 4× that — comfortable headroom for
 * a future bump to 50ms / 8 kHz / etc., while bounding the worst case
 * an in-page postMessage spoofer could trigger to a few KB per message
 * regardless of how the payload's base64 length grew.
 */
const PCM_CHUNK_MAX_BYTES = 8192;

/**
 * Per-envelope structural caps for `tts.utterance.*` reducers. The
 * runner produces values well below these in normal operation
 * (narrator's longest line ≈ 130 chars, intent strings are
 * compile-time literals, ids are crypto.randomUUID() = 36 chars). The
 * caps exist as defence against a same-origin postMessage spoofer
 * writing megabyte-length strings into `currentUtterance` (which would
 * persist to sessionStorage) or stuffing 100k chunks into a single
 * `audio_batch` to slow the page's main thread. PCM_BATCH_MAX_CHUNKS
 * mirrors `PCM_REPLAY_MAX = 50` — a single batch can't outpace the
 * downstream replay queue.
 */
const UTTERANCE_TEXT_MAX_LEN = 2000;
const UTTERANCE_ID_MAX_LEN = 128;
const UTTERANCE_INTENT_MAX_LEN = 64;
const PCM_BATCH_MAX_CHUNKS = 50;

/**
 * Decode a `tts.audio_chunk` payload into an Int16Array, or null if the
 * envelope is malformed or oversized. Exported for tests; the listener
 * consumes it inline.
 */
export function decodePcmEnvelope(payload: unknown): Int16Array | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as { samples?: unknown };
  if (typeof p.samples !== "string") return null;
  // base64 expands to roughly 3/4 of its decoded byte length; reject
  // before we even call atob so a multi-MB string can't allocate. The
  // exact decoded-length check below is the authoritative bound.
  if (p.samples.length > Math.ceil(PCM_CHUNK_MAX_BYTES * 4 / 3) + 4) return null;
  try {
    // atob → binary string → Uint8Array → Int16Array view (little-endian
    // by default on every browser we ship to). The runner encodes the
    // raw S16_LE bytes as base64; the round-trip preserves them.
    const bin = atob(p.samples);
    const len = bin.length;
    if (len === 0 || len % 2 !== 0) return null;
    if (len > PCM_CHUNK_MAX_BYTES) return null;
    const u8 = new Uint8Array(len);
    for (let i = 0; i < len; i++) u8[i] = bin.charCodeAt(i);
    return new Int16Array(u8.buffer, u8.byteOffset, len / 2);
  } catch {
    return null;
  }
}

/**
 * Reduces an incoming bus event into the next overlay state. Pure function
 * so it can be tested in isolation without the postMessage harness.
 *
 * @param state Previous state.
 * @param env   Bus envelope received from the bot controller.
 * @returns Next state, or the same reference if the event was unrecognised.
 */
export function reduceOverlayEvent(
  state: OverlayState,
  env: BusEnvelope,
): OverlayState {
  switch (env.kind) {
    case "lifecycle.phase": {
      const p = env.payload as { phase?: LifecyclePhase } | undefined;
      if (!p?.phase) return state;
      // Leaving the queuing phase clears the lobby countdown — the
      // radar overlay should disappear as soon as the bot starts
      // playing rounds, regardless of whether the bot remembered to
      // emit a final mp.lobby_countdown event with remaining=0.
      const nextLobbyCountdown = p.phase === "queuing" ? state.lobbyCountdown : null;
      return { ...state, phase: p.phase, lobbyCountdown: nextLobbyCountdown };
    }
    case "round.start": {
      const p = env.payload as RoundStartEvent | undefined;
      if (!p?.mode) return state;
      return { ...state, currentRound: p };
    }
    case "round.decision": {
      // Backward-compat translation: the runner still emits this for
      // the per-round strategy rationale. Translate it into a
      // `strategy_rationale`-intent thought so the unified ThoughtFeed
      // panel surfaces it alongside ambient NN thoughts. The Thinker
      // path (`thought.bubble`) is the canonical sender for everything
      // else.
      const p = env.payload as { rationale?: string } | undefined;
      const text = sanitizeThoughtText(p?.rationale);
      if (!text) return state;
      const entry: ThoughtEntry = {
        id: nextSynthId("rationale"),
        text,
        intent: "strategy_rationale",
        mood: state.stats.mood ?? DEFAULT_MOOD,
        at: Date.now(),
      };
      return {
        ...state,
        thoughts: [entry, ...state.thoughts].slice(0, THOUGHT_FEED_LIMIT),
      };
    }
    case "thought.bubble": {
      const entry = sanitizeThoughtBubble(env.payload, state.stats.mood ?? DEFAULT_MOOD);
      if (!entry) return state;
      return {
        ...state,
        thoughts: [entry, ...state.thoughts].slice(0, THOUGHT_FEED_LIMIT),
      };
    }
    case "round.result": {
      const p = env.payload as RoundResultEvent | undefined;
      if (!p) return state;
      const recent: RecentRound = {
        mode: state.currentRound?.mode ?? "unknown",
        outcome: p.outcome,
        points: p.points ?? 0,
        at: Date.now(),
      };
      return {
        ...state,
        recentRounds: [recent, ...state.recentRounds].slice(0, RECENT_ROUNDS_LIMIT),
      };
    }
    case "mp.lobby_countdown": {
      const p = env.payload as { elapsedSec?: number; remainingSec?: number; playerCount?: number; roomCode?: string } | undefined;
      if (!p || typeof p.elapsedSec !== "number" || typeof p.remainingSec !== "number") {
        return state;
      }
      return {
        ...state,
        lobbyCountdown: {
          at: Date.now(),
          elapsedSec: p.elapsedSec,
          remainingSec: p.remainingSec,
          playerCount: typeof p.playerCount === "number" ? p.playerCount : 1,
          roomCode: typeof p.roomCode === "string" ? p.roomCode : "",
        },
      };
    }
    case "tts.utterance.start": {
      const p = env.payload as {
        id?: unknown;
        text?: unknown;
        intent?: unknown;
        mood?: unknown;
        estimatedDurationMs?: unknown;
        at?: unknown;
      } | undefined;
      if (
        !p
        || typeof p.id !== "string" || p.id.length === 0 || p.id.length > UTTERANCE_ID_MAX_LEN
        || typeof p.text !== "string" || p.text.length > UTTERANCE_TEXT_MAX_LEN
        || typeof p.intent !== "string" || p.intent.length > UTTERANCE_INTENT_MAX_LEN
        || typeof p.estimatedDurationMs !== "number"
      ) {
        return state;
      }
      // Allowlist mood the same way stats.update does — defence in
      // depth against an in-page postMessage spoofer.
      const mood: Mood = isMood(p.mood) ? p.mood : DEFAULT_MOOD;
      const startedAt = typeof p.at === "number" ? p.at : Date.now();
      return {
        ...state,
        currentUtterance: {
          id: p.id,
          text: p.text,
          intent: p.intent,
          mood,
          estimatedDurationMs: p.estimatedDurationMs,
          startedAt,
          audioStartedAt: null,
          audioEndedAt: null,
        },
      };
    }
    case "tts.utterance.audio_started": {
      const p = env.payload as { id?: unknown; at?: unknown } | undefined;
      if (!p || typeof p.id !== "string") return state;
      const cu = state.currentUtterance;
      // Only update when the envelope's id matches the active
      // utterance — guards against an out-of-order or stale-id
      // envelope clobbering a freshly-started slot. Under normal
      // sequencing this is never reached, but if a future refactor
      // re-orders envelope dispatch the silent drop would lose
      // isSpeaking=true for the entire utterance — log a warning so
      // a regression is at least debuggable.
      if (cu == null) {
        // eslint-disable-next-line no-console
        console.warn(`[overlayBus] tts.utterance.audio_started for id=${p.id} arrived with no currentUtterance — out-of-order envelope`);
        return state;
      }
      if (cu.id !== p.id) return state;
      // Idempotent: if already set, no-op (don't shift the timestamp
      // backward on a redelivered envelope).
      if (cu.audioStartedAt != null) return state;
      const at = typeof p.at === "number" ? p.at : Date.now();
      return { ...state, currentUtterance: { ...cu, audioStartedAt: at } };
    }
    case "tts.utterance.audio_ended": {
      const p = env.payload as { id?: unknown; at?: unknown } | undefined;
      if (!p || typeof p.id !== "string") return state;
      const cu = state.currentUtterance;
      if (cu == null) {
        // eslint-disable-next-line no-console
        console.warn(`[overlayBus] tts.utterance.audio_ended for id=${p.id} arrived with no currentUtterance — out-of-order envelope`);
        return state;
      }
      if (cu.id !== p.id) return state;
      if (cu.audioEndedAt != null) return state;
      const at = typeof p.at === "number" ? p.at : Date.now();
      // Synthesize an audioStartedAt when missing — covers the
      // pathological case where Piper crashed before any chunk fired
      // (audio_started never sent) but aplay still exited; downstream
      // selectors expect audioStartedAt <= audioEndedAt for coherent
      // rendering. Bump the diagnostic counter so the HUD can surface
      // when this happens — distinguishes "Piper edge case" from
      // "envelope transport regression".
      const synthesized = cu.audioStartedAt == null;
      const audioStartedAt = cu.audioStartedAt ?? at;
      if (synthesized) {
        try { ensurePcmStats().synthesizedAudioStartedCount += 1; } catch { /* SSR */ }
      }
      return { ...state, currentUtterance: { ...cu, audioStartedAt, audioEndedAt: at } };
    }
    case "tts.utterance.cancelled": {
      const p = env.payload as { id?: unknown } | undefined;
      if (!p || typeof p.id !== "string") return state;
      const cu = state.currentUtterance;
      if (cu == null) {
        // eslint-disable-next-line no-console
        console.warn(`[overlayBus] tts.utterance.cancelled for id=${p.id} arrived with no currentUtterance — out-of-order envelope`);
        return state;
      }
      if (cu.id !== p.id) return state;
      // Treat cancel as "audio ended now" so the same selectors
      // (subtitleVisible / isSpeaking) hide the UI without needing a
      // separate cancellation branch. Anchored to NOW since cancel
      // doesn't carry an authoritative audio end timestamp. The slot
      // remains populated until the next `start` arrives (the HUD's
      // "last thing Pricey said" view); subtitleVisible's
      // SUBTITLE_MIN_VISIBLE_MS floor will hide the subtitle.
      const at = Date.now();
      const audioStartedAt = cu.audioStartedAt ?? at;
      return { ...state, currentUtterance: { ...cu, audioStartedAt, audioEndedAt: at } };
    }
    case "cursor.aim": {
      const p = env.payload as { x?: number; y?: number; width?: number; height?: number } | undefined;
      if (
        !p
        || typeof p.x !== "number"
        || typeof p.y !== "number"
        || typeof p.width !== "number"
        || typeof p.height !== "number"
      ) {
        return state;
      }
      return {
        ...state,
        cursorAim: { at: Date.now(), x: p.x, y: p.y, width: p.width, height: p.height },
      };
    }
    case "stats.update": {
      const p = env.payload as Partial<BotStats> | undefined;
      if (!p) return state;
      // Allowlist `mood` via the shared `isMood` guard so a future
      // spoofed postMessage can't put an arbitrary string onto
      // `data-mood`. Phase 1C keys dynamic class / sprite selection
      // off this attribute. Single source of truth lives in
      // packages/shared/src/moods.ts — adding a mood there doesn't
      // require editing this allowlist.
      const sanitized: Partial<BotStats> = { ...p };
      if (sanitized.mood !== undefined && !isMood(sanitized.mood)) {
        delete sanitized.mood;
      }
      // Mirror a fresh mood label into the snapshot when one exists.
      // The MoodWheel reads moodSnapshot.mood as authoritative once a
      // snapshot has landed; without this mirror, a stats.update that
      // arrives before the matching mood.snapshot (the bot publishes
      // stats via instant postMessage and mood via a slower
      // socket-fan-out path) would update the Avatar but leave the
      // wheel pointing at the stale snapshot mood until the snapshot
      // catches up — visible to viewers as the wheel "freezing" while
      // Pricey's face changes. Cold-start (snapshot null) deliberately
      // doesn't synthesise a snapshot here: vibe / morale / streak
      // would have to be defaulted to 0, which would feed false
      // direction-caret signals into MoodWheel before any real
      // mood-engine state is known.
      const nextSnapshot = sanitized.mood !== undefined && state.moodSnapshot
        ? { ...state.moodSnapshot, mood: sanitized.mood }
        : state.moodSnapshot;
      return {
        ...state,
        stats: { ...state.stats, ...sanitized },
        moodSnapshot: nextSnapshot,
      };
    }
    case "mood.snapshot": {
      // Full mood snapshot from the server's STREAMER_BOT_MOOD relay
      // (see useStreamerMoodRelay). Validate every field at the trust
      // boundary — same allowlist + numeric finite-check the server
      // applies — so a spoofed postMessage can't push a malformed
      // snapshot into the indicator's render path.
      const p = env.payload as Partial<MoodSnapshot> | undefined;
      if (!p || !isMood(p.mood)) return state;
      if (typeof p.vibe !== "number" || !Number.isFinite(p.vibe)) return state;
      if (typeof p.morale !== "number" || !Number.isFinite(p.morale)) return state;
      if (typeof p.streak !== "number" || !Number.isFinite(p.streak)) return state;
      const snapshot: MoodSnapshot = {
        mood: p.mood,
        vibe: Math.max(-3, Math.min(3, p.vibe)),
        morale: Math.max(-1, Math.min(1, p.morale)),
        streak: Math.floor(p.streak),
      };
      if (typeof p.updatedAt === "number" && Number.isFinite(p.updatedAt) && p.updatedAt > 0) {
        snapshot.updatedAt = Math.floor(p.updatedAt);
      }
      // Dual-writer pattern, deliberate:
      //   - `mood.snapshot` (this case) — authoritative for mood. Writes
      //     `state.moodSnapshot` AND mirrors `mood` into `state.stats.mood`.
      //   - `stats.update` — legacy back-compat path. Still writes
      //     `state.stats.mood` for the rare flow where the bot pushes
      //     a `stats.update` envelope without the full snapshot
      //     (older clients, partial updates).
      // Today the bot publishes both events for every round, so the
      // mirror keeps existing consumers (`Avatar`'s `data-mood`,
      // `MoodWheel`'s legacy stats fallback) in sync without
      // waiting for the next /stats POST. When the older `stats.update`
      // flow is fully retired (a future PR can drop the `mood` field
      // from the stats payload), this mirror collapses naturally — the
      // snapshot becomes the only writer.
      return {
        ...state,
        moodSnapshot: snapshot,
        stats: { ...state.stats, mood: snapshot.mood },
      };
    }
    case "chat.message": {
      const p = env.payload as Omit<ChatMessage, "id" | "at"> & { id?: string; at?: number } | undefined;
      if (!p?.text) return state;
      const msg: ChatMessage = {
        id: p.id ?? `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        platform: p.platform ?? "unknown",
        user: p.user ?? "anon",
        text: p.text,
        color: p.color,
        at: p.at ?? Date.now(),
      };
      return { ...state, chat: [...state.chat, msg].slice(-CHAT_HISTORY_LIMIT) };
    }
    case "music.now": {
      const p = env.payload as MusicNowPlaying | null | undefined;
      return { ...state, music: p ?? null };
    }
    case "nn.tick": {
      const tick = sanitizeNnTick(env.payload);
      if (!tick) return state;
      return { ...state, nnTick: tick };
    }
    default:
      return state;
  }
}

/**
 * Strict validator for the optional `health` block. Drops the entire
 * block when any required numeric field is missing or non-finite, so
 * the HUD reads "n/a" rather than a half-populated row of zeros.
 * Mirrors the server's `parseNnTickPayload` contract on the same
 * fields. Exported for tests.
 */
/**
 * Trim + cap a thought-text candidate at the trust boundary.
 * Returns the cleaned string, or `null` when the input is missing,
 * non-string, or empty after trim. The cap is `THOUGHT_TEXT_MAX`
 * — runaway template fills can't inject novella-scale strings into
 * the panel layout. Exported for tests.
 */
export function sanitizeThoughtText(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return trimmed.length > THOUGHT_TEXT_MAX ? trimmed.slice(0, THOUGHT_TEXT_MAX) : trimmed;
}

/**
 * Validate + normalise a `thought.bubble` payload at the trust
 * boundary. Returns a `ThoughtEntry` ready for FIFO insertion, or
 * `null` if the payload is malformed.
 *
 * Required: a non-empty `text` string. Optional with defaults:
 *   - `id`     → generated from `at` if missing
 *   - `intent` → "ambient" if missing/non-string
 *   - `mood`   → falls back to the supplied current mood
 *   - `at`     → Date.now() if missing/non-finite
 *
 * Exported for tests.
 */
export function sanitizeThoughtBubble(raw: unknown, currentMood: Mood): ThoughtEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const text = sanitizeThoughtText(r.text);
  if (!text) return null;
  const at = typeof r.at === "number" && Number.isFinite(r.at) ? r.at : Date.now();
  const intent = typeof r.intent === "string" && r.intent.length > 0 && r.intent.length <= THOUGHT_INTENT_MAX
    ? r.intent
    : "ambient";
  const mood = typeof r.mood === "string" && isMood(r.mood) ? r.mood : currentMood;
  // Synthesise a unique id when the sender omits one (or supplies
  // an over-long / empty id). Using a monotonic counter rather than
  // a timestamp suffix avoids React-key collisions when two thought
  // bubbles arrive within the same millisecond.
  const id = typeof r.id === "string" && r.id.length > 0 && r.id.length <= THOUGHT_ID_MAX
    ? r.id
    : nextSynthId("thought");
  return { id, text, intent, mood, at };
}

export function sanitizeNnHealth(raw: unknown): NnTick["health"] {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const finite = (x: unknown): number | null =>
    typeof x === "number" && Number.isFinite(x) ? x : null;
  // Required numeric fields — null any of them and the whole block goes.
  const round = finite(r.round);
  const gradNormP95 = finite(r.gradNormP95);
  const learningRate = finite(r.learningRate);
  const warmupStep = finite(r.warmupStep);
  const warmupTotal = finite(r.warmupTotal);
  const bufferSize = finite(r.bufferSize);
  const bufferCapacity = finite(r.bufferCapacity);
  const batchSize = finite(r.batchSize);
  const stepsPerRound = finite(r.stepsPerRound);
  const snapshotAgeMs = finite(r.snapshotAgeMs);
  const teachingMomentsCount = finite(r.teachingMomentsCount);
  const nanRollbacks = finite(r.nanRollbacks);
  if (
    round === null || gradNormP95 === null || learningRate === null
    || warmupStep === null || warmupTotal === null
    || bufferSize === null || bufferCapacity === null
    || batchSize === null || stepsPerRound === null
    || snapshotAgeMs === null || teachingMomentsCount === null
    || nanRollbacks === null
  ) {
    return undefined;
  }
  return {
    round: Math.max(0, Math.floor(round)),
    // loss is the only nullable field on the wire — preserves the
    // worker-side "no update has run yet" signal.
    loss: finite(r.loss),
    gradNormP95: Math.max(0, gradNormP95),
    learningRate: Math.max(0, learningRate),
    warmupStep: Math.max(0, Math.floor(warmupStep)),
    warmupTotal: Math.max(0, Math.floor(warmupTotal)),
    bufferSize: Math.max(0, Math.floor(bufferSize)),
    bufferCapacity: Math.max(0, Math.floor(bufferCapacity)),
    batchSize: Math.max(0, Math.floor(batchSize)),
    stepsPerRound: Math.max(0, Math.floor(stepsPerRound)),
    goldenMAE: finite(r.goldenMAE),
    snapshotAgeMs: Math.max(0, Math.floor(snapshotAgeMs)),
    teachingMomentsCount: Math.max(0, Math.floor(teachingMomentsCount)),
    nanRollbacks: Math.max(0, Math.floor(nanRollbacks)),
    frozen: r.frozen === true,
  };
}

/**
 * Validate AND normalize an `nn.tick` payload before storing. The
 * server's `parseNnTickPayload` is already strict for the
 * socket-relayed path, but a postMessage spoofer inside the bot's
 * own Chromium tab can push directly to the bus — so the reducer
 * must independently guarantee the panels' dot-paths are safe.
 *
 * Strategy: reject on missing structural fields (`roundId`, `phase`,
 * `network.layers`); fill safe defaults for every scalar / sub-object
 * the panels read (`prediction.cents`, `belief.*`, `embedding2d.x`,
 * `recentLosses[]`, `recentAccuracy[]`, `teachingMoment.triggered`).
 * The optional `health` block uses strict validation (see
 * {@link sanitizeNnHealth}) — invalid payloads drop the block, not
 * substitute zeros. Returns the normalized tick (so panels can trust
 * the shape) or null when the envelope is structurally broken.
 */
export function sanitizeNnTick(value: unknown): NnTick | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.roundId !== "string" || v.roundId.length === 0) return null;
  const phaseOk = ["idle", "thinking", "guessing", "reveal", "result"].includes(v.phase as string);
  if (!phaseOk) return null;
  const network = v.network as { layers?: unknown; weightSamples?: unknown; heroPath?: unknown } | undefined;
  if (!network || !Array.isArray(network.layers)) return null;

  const num = (x: unknown, fallback = 0): number =>
    typeof x === "number" && Number.isFinite(x) ? x : fallback;
  const arrOf = <T>(x: unknown, predicate: (v: unknown) => v is T): T[] =>
    Array.isArray(x) ? x.filter(predicate) : [];

  const layers = arrOf(network.layers, (l): l is { name?: unknown; activations?: unknown; mostActiveIdx?: unknown; mostActiveTrail?: unknown } => !!l && typeof l === "object")
    .map((l) => ({
      name: typeof l.name === "string" ? l.name : "",
      activations: arrOf(l.activations, (n): n is number => typeof n === "number" && Number.isFinite(n)),
      mostActiveIdx: Math.floor(num(l.mostActiveIdx)),
      mostActiveTrail: (Array.isArray(l.mostActiveTrail) && l.mostActiveTrail.length === 2
        ? [num(l.mostActiveTrail[0]), num(l.mostActiveTrail[1])]
        : [0, 0]) as [number, number],
    }));
  const weightSamples = arrOf(
    network.weightSamples,
    (w): w is { fromLayer: unknown; fromIdx: unknown; toLayer: unknown; toIdx: unknown; weight: unknown } => !!w && typeof w === "object",
  )
    .map((w) => ({
      fromLayer: Math.floor(num(w.fromLayer)),
      fromIdx: Math.floor(num(w.fromIdx)),
      toLayer: Math.floor(num(w.toLayer)),
      toIdx: Math.floor(num(w.toIdx)),
      weight: num(w.weight),
    }));
  const heroPathRaw = network.heroPath;
  const heroPath = Array.isArray(heroPathRaw)
    ? arrOf(heroPathRaw, (h): h is { layer: unknown; idx: unknown } => !!h && typeof h === "object")
      .map((h) => ({ layer: Math.floor(num(h.layer)), idx: Math.floor(num(h.idx)) }))
    : undefined;

  const pred = v.prediction as { cents?: unknown; sigma?: unknown } | undefined;
  const prediction = { cents: num(pred?.cents), sigma: num(pred?.sigma) };

  const beliefRaw = v.belief as Record<string, unknown> | undefined;
  const belief: NnTick["belief"] = {
    topFeatures: arrOf(
      beliefRaw?.topFeatures,
      (f): f is { name: unknown; contribution: unknown } => !!f && typeof f === "object",
    ).map((f) => ({
      name: typeof f.name === "string" ? f.name : "",
      contribution: num(f.contribution),
    })),
    // Defence-in-depth: server's parseNnTickPayload caps at 200 chars
    // before fan-out, but the same-window postMessage path bypasses
    // that gate. Match the server cap here so any path produces
    // consistently-bounded strings before they reach the panels.
    ...(typeof beliefRaw?.sentence === "string"
      && beliefRaw.sentence.length > 0
      && beliefRaw.sentence.length <= 200
      ? { sentence: beliefRaw.sentence }
      : {}),
  };

  const embRaw = v.embedding2d as Record<string, unknown> | undefined;
  const embedding2d = { x: num(embRaw?.x), y: num(embRaw?.y) };

  const recentLosses = arrOf(v.recentLosses, (n): n is number => typeof n === "number" && Number.isFinite(n));
  const recentAccuracy = arrOf(v.recentAccuracy, (s): s is "within10" | "within25" | "miss" =>
    typeof s === "string" && ["within10", "within25", "miss"].includes(s));

  const tmRaw = v.teachingMoment as Record<string, unknown> | undefined;
  const teachingMoment: NnTick["teachingMoment"] = {
    triggered: tmRaw?.triggered === true,
  };
  if (typeof tmRaw?.productTitle === "string" && tmRaw.productTitle.length > 0) {
    teachingMoment.productTitle = tmRaw.productTitle;
  }

  // Health block — strict shape, optional. Drop the whole block when
  // any required field is missing or non-finite so the panel reads "n/a"
  // instead of a half-populated row substituted with zeros. Mirrors the
  // server's parseNnTickPayload contract so the two trust boundaries
  // (Socket.IO relay path + same-window postMessage spoofer) agree on
  // what a valid health block looks like.
  const healthRaw = v.health as Record<string, unknown> | undefined;
  const health = sanitizeNnHealth(healthRaw);

  return {
    roundId: v.roundId,
    phase: v.phase as NnTick["phase"],
    network: { layers, weightSamples, ...(heroPath ? { heroPath } : {}) },
    prediction,
    belief,
    embedding2d,
    recentLosses,
    recentAccuracy,
    teachingMoment,
    ...(health ? { health } : {}),
    ageMs: num(v.ageMs),
  };
}

/**
 * Persisted slice — survives same-tab page reloads via sessionStorage so
 * the runner's `page.goto` between plan boundaries doesn't wipe the
 * stats / chat / recent-rounds the viewer just saw.
 *
 * Transient slots (phase, currentRound, cursorAim, subtitle, tts,
 * lobbyCountdown, music) are intentionally NOT persisted —
 * they reflect right-now state and a stale carry-over would mislead.
 *
 * Why sessionStorage and not localStorage: same-origin navigation in
 * the same tab keeps it; a Chromium restart (= container restart)
 * drops it, which is the right semantic for an operator restart.
 */
interface PersistedState {
  v: typeof STORAGE_VERSION;
  stats: BotStats;
  recentRounds: RecentRound[];
  chat: ChatMessage[];
}

function readPersistedState(): Partial<OverlayState> | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PersistedState>;
    if (!parsed || parsed.v !== STORAGE_VERSION) return null;
    const stats = parsed.stats && typeof parsed.stats === "object"
      ? { ...INITIAL_STATE.stats, ...parsed.stats }
      : INITIAL_STATE.stats;
    const validOutcomes: ReadonlySet<RoundResultEvent["outcome"]> = new Set(["correct", "incorrect", "partial"] as const);
    // Defensive: filter for shape AND clamp to the in-memory limits, so
    // a persisted entry written by an older version with different
    // (larger) caps can't grow the live arrays past today's bounds.
    const recentRounds = Array.isArray(parsed.recentRounds)
      ? parsed.recentRounds.filter((r): r is RecentRound =>
          !!r && typeof r === "object" && typeof (r as RecentRound).mode === "string"
            && typeof (r as RecentRound).at === "number"
            && validOutcomes.has((r as RecentRound).outcome),
        ).slice(0, RECENT_ROUNDS_LIMIT)
      : INITIAL_STATE.recentRounds;
    const chat = Array.isArray(parsed.chat)
      ? parsed.chat.filter((m): m is ChatMessage =>
          !!m && typeof m === "object" && typeof (m as ChatMessage).text === "string"
            && typeof (m as ChatMessage).id === "string",
        ).slice(-CHAT_HISTORY_LIMIT)
      : INITIAL_STATE.chat;
    return { stats, recentRounds, chat };
  } catch {
    // Corrupt JSON or storage access throws (private mode, quota, etc.)
    // — fall through to defaults.
    return null;
  }
}

function writePersistedState(state: OverlayState): void {
  if (typeof window === "undefined") return;
  try {
    const payload: PersistedState = {
      v: STORAGE_VERSION,
      stats: state.stats,
      recentRounds: state.recentRounds,
      chat: state.chat,
    };
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // Quota exceeded or storage disabled — overlay still works in
    // memory; persistence is a best-effort enhancement.
  }
}

/**
 * React hook that subscribes to bus events on `window` and returns the
 * current overlay state. Multiple consumers each maintain their own state
 * copy; that's fine because reductions are pure and message events are
 * delivered to every listener.
 *
 * @returns Current overlay state. Updates as events arrive.
 */
export function useOverlayState(): OverlayState {
  const [state, setState] = useState<OverlayState>(() => {
    const persisted = readPersistedState();
    return persisted ? { ...INITIAL_STATE, ...persisted } : INITIAL_STATE;
  });

  useEffect(() => {
    function processEnvelope(env: BusEnvelope): void {
      // PCM audio batches bypass React state entirely — they arrive at
      // ~5 envelopes/sec during speech (each carrying ~5 chunks =
      // ~200ms of audio) and would thrash the reducer. Iterate the
      // batch, decode each chunk via decodePcmEnvelope, dispatch on
      // the module-scoped EventTarget so the Avatar panel can subscribe
      // with its own throttling, AND push to the pcm replay queue so
      // an Avatar that mounts AFTER the batch arrives (lazy chunk
      // fetch + Suspense + parent-after-child effect order) can still
      // backfill the missed chunks on its own mount.
      if (env.kind === "tts.utterance.audio_batch") {
        const p = env.payload as { id?: unknown; sampleRate?: unknown; chunks?: unknown } | undefined;
        if (!p || !Array.isArray(p.chunks)) return;
        // Defence against a postMessage spoofer batching 100k chunks
        // into a single envelope — the legitimate runner's batch is
        // capped at PCM_BATCH_SIZE (5). Mirrors PCM_REPLAY_MAX so a
        // single batch can't outpace the downstream replay queue.
        if (p.chunks.length > PCM_BATCH_MAX_CHUNKS) return;
        const stats = ensurePcmStats();
        const now = Date.now();
        for (const chunk of p.chunks) {
          if (!chunk || typeof chunk !== "object") continue;
          stats.received += 1;
          if (stats.firstReceivedAt === null) stats.firstReceivedAt = now;
          stats.lastReceivedAt = now;
          const samples = decodePcmEnvelope(chunk);
          if (samples) {
            stats.decoded += 1;
            stats.lastDecodeError = null;
            const detail: PcmChunkDetail = { samples, ts: now };
            pcmEvents.dispatchEvent(new CustomEvent<PcmChunkDetail>("chunk", { detail }));
            stats.dispatched += 1;
            if (pcmReplayQueue.length >= PCM_REPLAY_MAX) pcmReplayQueue.shift();
            pcmReplayQueue.push(detail);
          } else {
            stats.lastDecodeError = "decodePcmEnvelope returned null";
          }
        }
        return;
      }
      // Back-compat for the singular per-chunk envelope. PR #301 introduced
      // `tts.utterance.audio_chunk` with one chunk per envelope; PR #305
      // replaced it with `tts.utterance.audio_batch`. Streamer images are
      // built and tagged out-of-band (`infra/streamer/Dockerfile`) — there's
      // no CI hook that rebuilds them when the page protocol changes — so
      // an operator who deployed an app build from main while still running
      // a streamer image cut between PR #301 and PR #305 sees subtitles
      // (start envelope is unchanged) but no mouth animation (singular
      // chunks fall through to `default`). Handling both shapes here means
      // a streamer-image vs. app-build skew can't take lipsync down.
      // Trust boundary parity: same `isBusEnvelope`-source-string gate as
      // the rest of `processEnvelope` (an in-page postMessage spoofer can
      // forge any envelope; the worst case is decorative overlay corruption
      // — see the comment block in `handleMessage` below for the full
      // rationale). Per-envelope size is bounded by `decodePcmEnvelope`'s
      // PCM_CHUNK_MAX_BYTES guard.
      // TODO(claude, 2026-05-07): drop this case once every deployed
      // streamer is known to be at PR #305 or later (i.e. the
      // `infra/streamer` image has been rebuilt + redeployed everywhere
      // and the operator has confirmed via the lipsync HUD that the
      // batched path works in production).
      if (env.kind === "tts.utterance.audio_chunk") {
        const p = env.payload as { id?: unknown; samples?: unknown; sampleRate?: unknown; ts?: unknown } | undefined;
        if (!p) return;
        const stats = ensurePcmStats();
        const now = Date.now();
        stats.received += 1;
        if (stats.firstReceivedAt === null) stats.firstReceivedAt = now;
        stats.lastReceivedAt = now;
        const samples = decodePcmEnvelope(p);
        if (samples) {
          stats.decoded += 1;
          stats.lastDecodeError = null;
          const detail: PcmChunkDetail = { samples, ts: now };
          pcmEvents.dispatchEvent(new CustomEvent<PcmChunkDetail>("chunk", { detail }));
          stats.dispatched += 1;
          if (pcmReplayQueue.length >= PCM_REPLAY_MAX) pcmReplayQueue.shift();
          pcmReplayQueue.push(detail);
        } else {
          stats.lastDecodeError = "decodePcmEnvelope returned null";
        }
        return;
      }
      setState((prev) => reduceOverlayEvent(prev, env));
    }

    function handleMessage(ev: MessageEvent<unknown>) {
      // Intentionally no `ev.origin` check: the bot controller is injected
      // via Playwright's `addInitScript` into the same Chromium that
      // renders this page, so its postMessage events have the same
      // origin as the page. The source-string guard inside
      // `isBusEnvelope` is the trust boundary. Worst-case spoofing by an
      // in-page attacker corrupts the overlay panels (visual only) — no
      // exfiltration or RCE surface, since payloads only flow into UI
      // state rendered as React text nodes.
      if (!isBusEnvelope(ev.data)) return;
      processEnvelope(ev.data as BusEnvelope);
    }

    // Drain the pre-mount fallback buffer FIRST so any envelopes that
    // arrived before this mount are applied in the order they were
    // received. Then mark the listener attached so the fallback
    // listener stops buffering. Finally attach the live listener for
    // everything that arrives going forward.
    busListenerAttached = true;
    const drained = pendingEnvelopes.splice(0, pendingEnvelopes.length);
    for (const env of drained) processEnvelope(env);
    window.addEventListener("message", handleMessage);
    return () => {
      window.removeEventListener("message", handleMessage);
      // Re-arm the fallback so a remount (HMR, route change) still
      // captures envelopes that arrive between unmount and remount.
      busListenerAttached = false;
    };
  }, []);

  // Persist whenever the persisted slices change. Write volume is
  // bounded (chat capped at 30, recentRounds at 8) so per-event writes
  // don't need debouncing.
  useEffect(() => {
    writePersistedState(state);
  }, [state.stats, state.recentRounds, state.chat]);

  return state;
}

/**
 * Dispatch a bus event by re-emitting it through `window.postMessage`
 * with the canonical envelope. Used by:
 *   - tests, to drive the reducer through its real listener path;
 *   - the streamer-stats / streamer-music server relay hooks
 *     (`useStreamerStatsRelay`, `useStreamerMusicRelay`), which
 *     receive Socket.IO payloads and want them to flow through the
 *     same reducer that the bot's local postMessage path uses.
 */
export function dispatchOverlayEvent(kind: string, payload?: unknown): void {
  window.postMessage({ source: MESSAGE_SOURCE, kind, payload }, "*");
}

export const __overlayBusInternals = {
  MESSAGE_SOURCE,
  CHAT_HISTORY_LIMIT,
  RECENT_ROUNDS_LIMIT,
  THOUGHT_FEED_LIMIT,
  THOUGHT_TEXT_MAX,
  INITIAL_STATE,
  STORAGE_KEY,
  STORAGE_VERSION,
};
