/**
 * Streamer-bot relay endpoints.
 *
 * The 24/7 streamer-bot (`packages/bot-streamer`) drives a Chromium
 * instance that views `https://price.games/?broadcast=1`. It used to
 * publish its current W/L/streak/mood to the broadcast overlay using
 * a same-window `window.postMessage`. That works fine inside the
 * bot's own Chromium tab, but anyone else loading `?broadcast=1` (an
 * operator preview, a co-streamer's overlay, the streamer-bot pointed
 * at a different host than the page is rendered on) sees zeros forever
 * because postMessage is local to a single window.
 *
 * This route makes the server the relay:
 *   - POST /api/streamer/stats      — bot pushes current stats. Auth
 *                                     via the existing X-Streamer-Bot
 *                                     header. Stored in memory + fanned
 *                                     out via Socket.IO STREAMER_BOT_STATS.
 *   - GET  /api/streamer/stats      — returns the most recent payload
 *                                     so a freshly-loaded broadcast
 *                                     page can hydrate immediately
 *                                     instead of waiting for the next
 *                                     emit.
 *   - POST /api/streamer/music      — bot pushes the current "now
 *                                     playing" track (or null when the
 *                                     queue stops). Same auth + fan-out
 *                                     pattern as /stats; emits
 *                                     STREAMER_BOT_MUSIC.
 *   - GET  /api/streamer/music      — returns the most recent music
 *                                     payload for first-mount hydrate.
 *   - POST /api/streamer/mood       — bot pushes the full mood-engine
 *                                     snapshot (label + hidden vibe +
 *                                     morale + signed round streak).
 *                                     Persisted via mood_json (migration
 *                                     v70) so a container restart
 *                                     hydrates Pricey's emotional arc.
 *                                     Emits STREAMER_BOT_MOOD.
 *   - GET  /api/streamer/mood       — returns the most recent snapshot
 *                                     for first-mount hydrate.
 *
 * All three slots are decorative overlay state, not analytics-grade
 * data. They are mirrored to SQLite (see `streamer_state` table /
 * migrations v68 + v70) so a server restart hydrates the cache from
 * the last persisted values instead of reverting to null until the
 * bot's next POST. The in-memory cache is the fast path; the DB
 * row is just for restart durability. When persistence is unset
 * (tests / dev) the slots live in module-level state only and a
 * restart clears them — same as before v68/v70.
 */

import express, { type Router, type Request, type Response } from "express";
import type { Server as SocketIOServer } from "socket.io";
import { SOCKET_EVENTS, isMood, type Mood } from "@price-game/shared";

/**
 * Minimal SQLite handle the router uses. Mirrors the subset of
 * `better-sqlite3` we touch — `prepare(...).get()` / `.run()` —
 * so tests can pass an in-memory database (or skip it entirely)
 * without coupling to the production singleton.
 */
export interface StreamerStatePersistence {
  /** Read the persisted singleton row, if any. */
  load(): {
    stats: StreamerBotStatsPayload | null;
    music: StreamerBotMusicPayload | null;
    mood: StreamerBotMoodPayload | null;
  };
  /** Persist the latest stats payload (null clears it). */
  saveStats(stats: StreamerBotStatsPayload | null): void;
  /** Persist the latest music payload (null clears it). */
  saveMusic(music: StreamerBotMusicPayload | null): void;
  /** Persist the latest mood snapshot (null clears it). */
  saveMood(mood: StreamerBotMoodPayload | null): void;
}

interface PersistenceDb {
  prepare(sql: string): {
    get(...params: unknown[]): unknown;
    run(...params: unknown[]): unknown;
  };
}

/**
 * Wrap a `better-sqlite3` Database in the persistence interface
 * the streamer router expects. Reads and writes go to the
 * `streamer_state` singleton row created by migration v68. Errors
 * during load are logged and swallowed (the cache simply stays
 * empty); errors during save are logged but don't block the POST
 * response — the in-memory cache is still updated.
 *
 * @param database better-sqlite3 Database (or any handle that
 *                 exposes `prepare(sql).get()` / `.run()`).
 */
export function createSqlitePersistence(database: PersistenceDb): StreamerStatePersistence {
  return {
    load() {
      try {
        const row = database
          .prepare("SELECT stats_json, music_json, mood_json FROM streamer_state WHERE id = 1")
          .get() as {
            stats_json: string | null;
            music_json: string | null;
            mood_json: string | null;
          } | undefined;
        if (!row) return { stats: null, music: null, mood: null };
        let stats: StreamerBotStatsPayload | null = null;
        let music: StreamerBotMusicPayload | null = null;
        let mood: StreamerBotMoodPayload | null = null;
        if (row.stats_json) {
          // Re-validate on hydrate — the on-disk shape is only as
          // trustworthy as the code that wrote it. A schema bump or a
          // hand-edit shouldn't get a free pass into the IO emit path.
          stats = parseStatsPayload(JSON.parse(row.stats_json));
        }
        if (row.music_json) {
          const parsed = parseMusicPayload(JSON.parse(row.music_json));
          music = parsed?.value ?? null;
        }
        if (row.mood_json) {
          mood = parseMoodPayload(JSON.parse(row.mood_json));
        }
        return { stats, music, mood };
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(`[streamer] failed to load persisted state: ${(err as Error).message}`);
        return { stats: null, music: null, mood: null };
      }
    },
    saveStats(stats) {
      try {
        database
          .prepare("UPDATE streamer_state SET stats_json = ?, stats_updated_at = ? WHERE id = 1")
          .run(stats === null ? null : JSON.stringify(stats), Date.now());
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(`[streamer] failed to persist stats: ${(err as Error).message}`);
      }
    },
    saveMusic(music) {
      try {
        database
          .prepare("UPDATE streamer_state SET music_json = ?, music_updated_at = ? WHERE id = 1")
          .run(music === null ? null : JSON.stringify(music), Date.now());
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(`[streamer] failed to persist music: ${(err as Error).message}`);
      }
    },
    saveMood(mood) {
      try {
        database
          .prepare("UPDATE streamer_state SET mood_json = ?, mood_updated_at = ? WHERE id = 1")
          .run(mood === null ? null : JSON.stringify(mood), Date.now());
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(`[streamer] failed to persist mood: ${(err as Error).message}`);
      }
    },
  };
}

/**
 * Stats payload the bot publishes and the overlay renders. Mirrors
 * the `BotStats` shape in `apps/web/src/broadcast/state/overlayBus.ts`
 * but redeclared here so the server has no dependency on the web
 * package.
 */
export interface StreamerBotStatsPayload {
  wins: number;
  losses: number;
  streak: number;
  /** Mood label from the shared registry (`@price-game/shared`). */
  mood?: Mood;
  /** Optional ratio in [0,1], purely informational. */
  winRate?: number;
}

// Defence-in-depth caps. The whole-body limit is 100kb, but per-field
// caps prevent a single bad field from ballooning into the Socket.IO
// fan-out (which goes to every connected socket). Stats counts cap at
// a wall the bot wouldn't reach in years; music strings cap at a length
// the overlay can render without breaking layout.
const MAX_COUNT = 1_000_000;
const MAX_MUSIC_FIELD_LEN = 200;

/**
 * "Now playing" payload pushed by the bot's mpd music source.
 * Mirrors the `MusicNowPlaying` shape in the web overlay bus.
 * `null` is a valid value — it tells the overlay the queue has
 * stopped (e.g. operator cleared the playlist). Stored in the
 * cache as the literal `null`, distinct from "never published"
 * (which the GET handler reports as `{ music: null }` either way
 * — the wire protocol doesn't distinguish, the overlay treats
 * both as "no track").
 */
export interface StreamerBotMusicPayload {
  title: string;
  artist?: string;
  album?: string;
}

/**
 * Mood-engine snapshot the bot publishes after every `nextMood` call.
 * Mirrors the `MoodState` shape in `packages/bot-streamer/src/persona/mood.ts`
 * but redeclared here so the server has no dependency on the bot
 * package. Carries the full hidden-axis state (vibe + morale + signed
 * round streak) — richer than the `mood` field on the legacy
 * `STREAMER_BOT_STATS` event which only carries the resolved label.
 *
 * The overlay's `MoodIndicator` (and the operator-facing `MoodDebugHud`)
 * consume this for the trend arrow and morale bar; the legacy stats
 * `mood` field stays in place for back-compat so existing reducers
 * keep working without a coordinated cutover.
 */
export interface StreamerBotMoodPayload {
  mood: Mood;
  vibe: number;
  morale: number;
  streak: number;
  /** Optional ms-since-epoch the bot stamped on the snapshot. */
  updatedAt?: number;
}

/**
 * VisualTick payload schema — shape mirrors `VisualTick` in
 * packages/bot-streamer/src/learning/types.ts but redeclared here so
 * the server has no dependency on the bot-streamer package. Validation
 * is intentionally tolerant — unknown fields are dropped, but the
 * shape of the known fields is enforced so the overlay can't be
 * tricked into reading undefined dot-paths.
 *
 * The payload is bounded by Express's global 100 KB body-parser cap
 * (see apps/server/src/index.ts). Per-array caps below clip
 * individual sub-arrays so a malformed payload can't blow up the
 * JSON.stringify on the fan-out side regardless of body size.
 */
export interface StreamerNnTickPayload {
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
   * softmax (PR #3). Each entry's `cents` is bounded to a finite
   * non-negative integer and `prob` to [0, 1] at the trust boundary
   * (this validator) so a malformed bot payload can't push odd values
   * into the broadcast overlay's render path.
   */
  priceCandidates?: Array<{ cents: number; prob: number }>;
  /**
   * Belief block — slimmed in PR #4 with the multi-task heads' removal.
   * Pre-cleanup the worker shipped topCategory + brandTier softmax
   * argmaxes; both are gone. The optional `sentence` is now confidence-
   * derived from the priceClassHead's softmax rather than category-
   * derived.
   */
  belief: {
    topFeatures: Array<{ name: string; contribution: number }>;
    sentence?: string;
  };
  embedding2d: { x: number; y: number };
  recentLosses: number[];
  recentAccuracy: Array<"within10" | "within25" | "miss">;
  teachingMoment: { triggered: boolean; productTitle?: string };
  /**
   * Optional training/health snapshot — drives the Neural Debug HUD's
   * "training" column. Validated at the trust boundary like every
   * other field on the payload; missing or malformed → undefined and
   * the panel renders "n/a".
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
    snapshotAgeMs: number;
    teachingMomentsCount: number;
    nanRollbacks: number;
    frozen: boolean;
  };
  ageMs: number;
}

const VALID_PHASES = new Set<StreamerNnTickPayload["phase"]>([
  "idle",
  "thinking",
  "guessing",
  "reveal",
  "result",
]);
const VALID_BUCKETS = new Set<"within10" | "within25" | "miss">(["within10", "within25", "miss"]);
const MAX_LAYERS = 8;
const MAX_NEURONS_PER_LAYER = 64;
const MAX_WEIGHT_SAMPLES = 256;
const MAX_HERO_PATH = 16;
const MAX_TOP_FEATURES = 16;
const MAX_RECENT_LOSSES = 60;
const MAX_RECENT_ACCURACY = 16;
const MAX_STRING_FIELD_LEN = 200;
/** Top-K cap for priceCandidates fan-out — bot emits 5; allow up to 16 for headroom. */
const MAX_PRICE_CANDIDATES = 16;
/** Hard ceiling on a single catalog entry (cents). Real Amazon prices are well below this. */
const MAX_PRICE_CANDIDATE_CENTS = 100_000_000; // $1,000,000

let latestStats: StreamerBotStatsPayload | null = null;
let latestMusic: StreamerBotMusicPayload | null = null;
let latestNnTick: StreamerNnTickPayload | null = null;
let latestMood: StreamerBotMoodPayload | null = null;

/**
 * Reset the in-memory cache. Exported for tests; production code
 * never calls this.
 */
export function _resetStreamerStatsForTest(): void {
  latestStats = null;
  latestMusic = null;
  latestNnTick = null;
  latestMood = null;
}

/**
 * Validate + coerce an unknown JSON body into a stats payload. Strict
 * field-by-field — anything unexpected falls back to the previous
 * value rather than poisoning the cache with NaN.
 */
function parseStatsPayload(body: unknown): StreamerBotStatsPayload | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (typeof b.wins !== "number" || !Number.isFinite(b.wins) || b.wins < 0) return null;
  if (typeof b.losses !== "number" || !Number.isFinite(b.losses) || b.losses < 0) return null;
  if (typeof b.streak !== "number" || !Number.isFinite(b.streak)) return null;
  const out: StreamerBotStatsPayload = {
    wins: Math.min(MAX_COUNT, Math.floor(b.wins)),
    losses: Math.min(MAX_COUNT, Math.floor(b.losses)),
    streak: Math.max(-MAX_COUNT, Math.min(MAX_COUNT, Math.floor(b.streak))),
  };
  if (isMood(b.mood)) {
    out.mood = b.mood;
  }
  if (typeof b.winRate === "number" && Number.isFinite(b.winRate)) {
    out.winRate = Math.max(0, Math.min(1, b.winRate));
  }
  return out;
}

/**
 * Validate + coerce a mood-snapshot payload. Strict: rejects any
 * malformed body so a hand-edit / schema drift can't poison the
 * Socket.IO fan-out. Bounds are the same ones the engine uses
 * internally (vibe ∈ [-3, 3], morale ∈ [-1, 1]) — values outside
 * are clamped (rather than rejecting the whole payload) since the
 * engine's own clamp logic could legitimately drift to the boundary.
 */
function parseMoodPayload(body: unknown): StreamerBotMoodPayload | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (!isMood(b.mood)) return null;
  if (typeof b.vibe !== "number" || !Number.isFinite(b.vibe)) return null;
  if (typeof b.morale !== "number" || !Number.isFinite(b.morale)) return null;
  if (typeof b.streak !== "number" || !Number.isFinite(b.streak)) return null;
  const out: StreamerBotMoodPayload = {
    mood: b.mood,
    vibe: Math.max(-3, Math.min(3, b.vibe)),
    morale: Math.max(-1, Math.min(1, b.morale)),
    streak: Math.max(-MAX_COUNT, Math.min(MAX_COUNT, Math.floor(b.streak))),
  };
  if (typeof b.updatedAt === "number" && Number.isFinite(b.updatedAt) && b.updatedAt > 0) {
    out.updatedAt = Math.floor(b.updatedAt);
  }
  return out;
}

/**
 * Validate + coerce a music payload. Accepts either:
 *   - `null` (queue stopped — clears the cache + fans out null).
 *   - `{ title, artist?, album? }` with a non-empty string title.
 * Anything else is rejected.
 */
function parseMusicPayload(body: unknown): { value: StreamerBotMusicPayload | null } | null {
  if (body === null) return { value: null };
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (typeof b.title !== "string" || b.title.length === 0) return null;
  if (b.title.length > MAX_MUSIC_FIELD_LEN) return null;
  const out: StreamerBotMusicPayload = { title: b.title };
  if (typeof b.artist === "string" && b.artist.length > 0 && b.artist.length <= MAX_MUSIC_FIELD_LEN) {
    out.artist = b.artist;
  }
  if (typeof b.album === "string" && b.album.length > 0 && b.album.length <= MAX_MUSIC_FIELD_LEN) {
    out.album = b.album;
  }
  return { value: out };
}

/** Truncate an array to its first `cap` elements, leaving the original alone. */
function clip<T>(arr: T[], cap: number): T[] {
  if (arr.length <= cap) return arr;
  return arr.slice(0, cap);
}

/** Coerce a value to a finite number, or return null. */
function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Coerce a value to a non-empty bounded-length string, or return null. */
function str(v: unknown, maxLen: number): string | null {
  if (typeof v !== "string" || v.length === 0 || v.length > maxLen) return null;
  return v;
}

/**
 * Validate + coerce a JSON body into a StreamerNnTickPayload. Tolerant
 * of missing / extra fields — anything malformed returns null, the
 * route then 400s. On the happy path the returned value is safe to
 * `JSON.stringify` and emit to every connected socket.
 */
export function parseNnTickPayload(body: unknown): StreamerNnTickPayload | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const roundId = str(b.roundId, MAX_STRING_FIELD_LEN);
  if (!roundId) return null;
  const phase = typeof b.phase === "string" && VALID_PHASES.has(b.phase as StreamerNnTickPayload["phase"])
    ? (b.phase as StreamerNnTickPayload["phase"])
    : null;
  if (!phase) return null;
  // network — at minimum needs `layers`. weightSamples is optional but defaults to [].
  const networkRaw = b.network as Record<string, unknown> | undefined;
  if (!networkRaw || typeof networkRaw !== "object") return null;
  const layersRaw = Array.isArray(networkRaw.layers) ? networkRaw.layers : [];
  const layers: StreamerNnTickPayload["network"]["layers"] = [];
  for (const L of clip(layersRaw, MAX_LAYERS)) {
    if (!L || typeof L !== "object") continue;
    const Lo = L as Record<string, unknown>;
    const name = str(Lo.name, MAX_STRING_FIELD_LEN);
    const acts = Array.isArray(Lo.activations)
      ? clip(Lo.activations.filter((x) => typeof x === "number" && Number.isFinite(x)) as number[], MAX_NEURONS_PER_LAYER)
      : [];
    const idx = num(Lo.mostActiveIdx) ?? 0;
    const trail = Array.isArray(Lo.mostActiveTrail) && Lo.mostActiveTrail.length === 2
      ? [num(Lo.mostActiveTrail[0]) ?? 0, num(Lo.mostActiveTrail[1]) ?? 0] as [number, number]
      : [0, 0] as [number, number];
    if (!name) continue;
    layers.push({ name, activations: acts, mostActiveIdx: Math.floor(idx), mostActiveTrail: trail });
  }
  const wsRaw = Array.isArray(networkRaw.weightSamples) ? networkRaw.weightSamples : [];
  const weightSamples: StreamerNnTickPayload["network"]["weightSamples"] = [];
  for (const W of clip(wsRaw, MAX_WEIGHT_SAMPLES)) {
    if (!W || typeof W !== "object") continue;
    const Wo = W as Record<string, unknown>;
    const fromLayer = num(Wo.fromLayer);
    const fromIdx = num(Wo.fromIdx);
    const toLayer = num(Wo.toLayer);
    const toIdx = num(Wo.toIdx);
    const weight = num(Wo.weight);
    if (fromLayer === null || fromIdx === null || toLayer === null || toIdx === null || weight === null) continue;
    weightSamples.push({
      fromLayer: Math.floor(fromLayer),
      fromIdx: Math.floor(fromIdx),
      toLayer: Math.floor(toLayer),
      toIdx: Math.floor(toIdx),
      weight,
    });
  }
  let heroPath: StreamerNnTickPayload["network"]["heroPath"];
  if (Array.isArray(networkRaw.heroPath)) {
    heroPath = clip(
      networkRaw.heroPath
        .filter((p): p is { layer: number; idx: number } => {
          if (!p || typeof p !== "object") return false;
          const po = p as Record<string, unknown>;
          return typeof po.layer === "number" && Number.isFinite(po.layer)
            && typeof po.idx === "number" && Number.isFinite(po.idx);
        })
        .map((p) => ({ layer: Math.floor(p.layer), idx: Math.floor(p.idx) })),
      MAX_HERO_PATH,
    );
  }

  // prediction
  const predRaw = b.prediction as Record<string, unknown> | undefined;
  const cents = num(predRaw?.cents) ?? 0;
  const sigma = num(predRaw?.sigma) ?? 0;

  // belief — slimmed in PR #4 to topFeatures + optional sentence.
  const beliefRaw = b.belief as Record<string, unknown> | undefined;
  const topFeaturesRaw = Array.isArray(beliefRaw?.topFeatures) ? beliefRaw.topFeatures : [];
  const topFeatures = clip(
    topFeaturesRaw
      .filter((f): f is { name: string; contribution: number } => {
        if (!f || typeof f !== "object") return false;
        const fo = f as Record<string, unknown>;
        return typeof fo.name === "string" && fo.name.length > 0 && fo.name.length <= MAX_STRING_FIELD_LEN
          && typeof fo.contribution === "number" && Number.isFinite(fo.contribution);
      })
      .map((f) => ({ name: f.name, contribution: f.contribution })),
    MAX_TOP_FEATURES,
  );
  // Optional pre-rendered sentence from the worker (PR 3). Bounded by
  // the same string-field cap to keep socket payloads predictable.
  const sentenceRaw = beliefRaw?.sentence;
  const sentence = typeof sentenceRaw === "string" && sentenceRaw.length > 0 && sentenceRaw.length <= MAX_STRING_FIELD_LEN
    ? sentenceRaw
    : undefined;

  // embedding2d
  const embRaw = b.embedding2d as Record<string, unknown> | undefined;
  const embedding2d = { x: num(embRaw?.x) ?? 0, y: num(embRaw?.y) ?? 0 };

  // sparkline + accuracy
  const recentLosses = clip(
    Array.isArray(b.recentLosses)
      ? (b.recentLosses.filter((x) => typeof x === "number" && Number.isFinite(x)) as number[])
      : [],
    MAX_RECENT_LOSSES,
  );
  const recentAccuracy = clip(
    Array.isArray(b.recentAccuracy)
      ? (b.recentAccuracy.filter((x): x is "within10" | "within25" | "miss" =>
          typeof x === "string" && VALID_BUCKETS.has(x as "within10" | "within25" | "miss")) as Array<"within10" | "within25" | "miss">)
      : [],
    MAX_RECENT_ACCURACY,
  );

  // priceCandidates — bounded list of (cents, prob) pairs from the
  // priceClassHead softmax. Trust-boundary validation: cents must be
  // finite + non-negative + ≤ MAX_PRICE_CANDIDATE_CENTS; prob must be
  // finite + in [0, 1]. Out-of-range entries are dropped (rather than
  // clamped) so a malformed array surfaces as "missing data" to the
  // overlay instead of silently rendering wrong values.
  let priceCandidates: Array<{ cents: number; prob: number }> | undefined;
  if (Array.isArray(b.priceCandidates)) {
    priceCandidates = clip(
      (b.priceCandidates as Array<unknown>)
        .filter((c): c is { cents: number; prob: number } => {
          if (!c || typeof c !== "object") return false;
          const co = c as Record<string, unknown>;
          if (typeof co.cents !== "number" || !Number.isFinite(co.cents)) return false;
          if (co.cents < 0 || co.cents > MAX_PRICE_CANDIDATE_CENTS) return false;
          if (typeof co.prob !== "number" || !Number.isFinite(co.prob)) return false;
          if (co.prob < 0 || co.prob > 1) return false;
          return true;
        })
        .map((c) => ({ cents: c.cents, prob: c.prob })),
      MAX_PRICE_CANDIDATES,
    );
    if (priceCandidates.length === 0) priceCandidates = undefined;
  }

  // teaching moment
  const tmRaw = b.teachingMoment as Record<string, unknown> | undefined;
  const teachingMoment: StreamerNnTickPayload["teachingMoment"] = {
    triggered: tmRaw?.triggered === true,
  };
  const productTitle = str(tmRaw?.productTitle, MAX_STRING_FIELD_LEN);
  if (productTitle) teachingMoment.productTitle = productTitle;

  // Health block — strict validation at the trust boundary. Drop the
  // whole block on any failure so the HUD renders "n/a" rather than a
  // half-populated row. Mirrored on the page side by sanitizeNnHealth.
  let health: StreamerNnTickPayload["health"];
  const healthRaw = b.health as Record<string, unknown> | undefined;
  if (healthRaw && typeof healthRaw === "object") {
    const round = num(healthRaw.round);
    const gradNormP95 = num(healthRaw.gradNormP95);
    const learningRate = num(healthRaw.learningRate);
    const warmupStep = num(healthRaw.warmupStep);
    const warmupTotal = num(healthRaw.warmupTotal);
    const bufferSize = num(healthRaw.bufferSize);
    const bufferCapacity = num(healthRaw.bufferCapacity);
    const batchSize = num(healthRaw.batchSize);
    const stepsPerRound = num(healthRaw.stepsPerRound);
    const snapshotAgeMs = num(healthRaw.snapshotAgeMs);
    const teachingMomentsCount = num(healthRaw.teachingMomentsCount);
    const nanRollbacks = num(healthRaw.nanRollbacks);
    if (
      round !== null && gradNormP95 !== null && learningRate !== null
      && warmupStep !== null && warmupTotal !== null
      && bufferSize !== null && bufferCapacity !== null
      && batchSize !== null && stepsPerRound !== null
      && snapshotAgeMs !== null && teachingMomentsCount !== null
      && nanRollbacks !== null
    ) {
      health = {
        round: Math.max(0, Math.floor(round)),
        // loss is the only nullable field — preserves "no update yet".
        loss: num(healthRaw.loss),
        gradNormP95: Math.max(0, gradNormP95),
        learningRate: Math.max(0, learningRate),
        warmupStep: Math.max(0, Math.floor(warmupStep)),
        warmupTotal: Math.max(0, Math.floor(warmupTotal)),
        bufferSize: Math.max(0, Math.floor(bufferSize)),
        bufferCapacity: Math.max(0, Math.floor(bufferCapacity)),
        batchSize: Math.max(0, Math.floor(batchSize)),
        stepsPerRound: Math.max(0, Math.floor(stepsPerRound)),
        goldenMAE: num(healthRaw.goldenMAE),
        snapshotAgeMs: Math.max(0, Math.floor(snapshotAgeMs)),
        teachingMomentsCount: Math.max(0, Math.floor(teachingMomentsCount)),
        nanRollbacks: Math.max(0, Math.floor(nanRollbacks)),
        frozen: healthRaw.frozen === true,
      };
    }
  }

  return {
    roundId,
    phase,
    network: { layers, weightSamples, ...(heroPath ? { heroPath } : {}) },
    prediction: { cents, sigma },
    ...(priceCandidates ? { priceCandidates } : {}),
    belief: { topFeatures, ...(sentence ? { sentence } : {}) },
    embedding2d,
    recentLosses,
    recentAccuracy,
    teachingMoment,
    ...(health ? { health } : {}),
    ageMs: num(b.ageMs) ?? Date.now(),
  };
}

/**
 * Build the streamer router. Takes the Socket.IO server so the POST
 * handler can fan out to connected clients, and an optional
 * persistence handle so the in-memory cache survives a server
 * restart (deploy / OOM / container kill). Without persistence the
 * cache is purely in-memory — fine for dev and unit tests; in
 * production the bot would have to land another POST after every
 * restart before the broadcast panel reflects reality.
 *
 * Hydration runs synchronously at router-creation time so the
 * first GET after startup already sees the persisted values.
 *
 * @param io Socket.IO server, or null when fan-out is disabled
 *           (tests, scripts).
 * @param persistence Optional persistence layer. When provided,
 *                    POST handlers also write through; on restart
 *                    the cache hydrates from it.
 */
export function createStreamerRouter(
  io: SocketIOServer | null,
  persistence?: StreamerStatePersistence,
): Router {
  const router = express.Router();

  // Hydrate the in-memory cache from persistence on startup so a
  // freshly-restarted server already has the bot's last-known state
  // before any POST has landed.
  if (persistence) {
    const loaded = persistence.load();
    if (loaded.stats) latestStats = loaded.stats;
    if (loaded.music) latestMusic = loaded.music;
    if (loaded.mood) latestMood = loaded.mood;
  }

  router.get("/stats", (_req: Request, res: Response) => {
    res.json({ stats: latestStats });
  });

  router.post("/stats", (req: Request, res: Response) => {
    // Auth: only the bot may push. The streamerBotDetect middleware
    // upstream stamps `req.isStreamerBot = true` when the secret
    // matches. When the secret is unset (dev) the middleware is a
    // no-op — refuse anyway so a forgotten secret can't accidentally
    // expose this write surface to the public.
    if (!req.isStreamerBot) {
      res.status(403).json({ error: "forbidden" });
      return;
    }
    const parsed = parseStatsPayload(req.body);
    if (!parsed) {
      res.status(400).json({ error: "invalid_payload" });
      return;
    }
    // Diagnostic — when STREAMER_MOOD_DEBUG=1 is set, log only when
    // the bot's reported mood changes between consecutive POSTs.
    // Logging every push (multiple per round) would flood prod stdout
    // for a decorative field; logging only on transitions gives an
    // operator the same signal at ~1 line per minute. Removed (or
    // routed through structured telemetry) once mood v2 ships.
    if (process.env.STREAMER_MOOD_DEBUG === "1") {
      const prevMood = latestStats?.mood ?? null;
      const nextMood = parsed.mood ?? null;
      if (prevMood !== nextMood) {
        // eslint-disable-next-line no-console
        console.log(
          `[streamer/stats] mood transition: ${prevMood ?? "null"} → ${nextMood ?? "null"}`
          + ` (wins=${parsed.wins} losses=${parsed.losses} streak=${parsed.streak})`,
        );
      }
    }
    latestStats = parsed;
    persistence?.saveStats(parsed);
    if (io) {
      // Fan out to every connected socket. Broadcast pages filter
      // for the event on their own; non-broadcast viewers ignore it
      // (no listener registered).
      io.emit(SOCKET_EVENTS.STREAMER_BOT_STATS, parsed);
    }
    res.json({ ok: true });
  });

  router.get("/music", (_req: Request, res: Response) => {
    res.json({ music: latestMusic });
  });

  router.post("/music", (req: Request, res: Response) => {
    if (!req.isStreamerBot) {
      res.status(403).json({ error: "forbidden" });
      return;
    }
    const parsed = parseMusicPayload(req.body);
    if (!parsed) {
      res.status(400).json({ error: "invalid_payload" });
      return;
    }
    latestMusic = parsed.value;
    persistence?.saveMusic(parsed.value);
    if (io) {
      io.emit(SOCKET_EVENTS.STREAMER_BOT_MUSIC, parsed.value);
    }
    res.json({ ok: true });
  });

  // GET /mood — first-mount hydrate of the full mood snapshot
  // (label + hidden vibe + morale + streak). The legacy
  // STREAMER_BOT_STATS payload also carries the mood label for
  // back-compat; this richer endpoint surfaces the hidden axes the
  // overlay's MoodIndicator (and operator HUD) want for the trend
  // arrow + morale bar. Returns `{ mood: null }` until the bot's
  // first POST after a fresh container.
  router.get("/mood", (_req: Request, res: Response) => {
    res.json({ mood: latestMood });
  });

  // POST /mood — bot pushes the latest snapshot. Same auth + fan-out
  // pattern as /stats. Persisted to the streamer_state row's
  // mood_json column (migration v70) so a server restart hydrates
  // Pricey's emotional arc instead of resetting to neutral. The bot
  // also pushes the resolved label inside the legacy /stats payload
  // so existing consumers keep working — this PR adds the richer
  // channel without retiring the old one.
  router.post("/mood", (req: Request, res: Response) => {
    if (!req.isStreamerBot) {
      res.status(403).json({ error: "forbidden" });
      return;
    }
    const parsed = parseMoodPayload(req.body);
    if (!parsed) {
      res.status(400).json({ error: "invalid_payload" });
      return;
    }
    latestMood = parsed;
    persistence?.saveMood(parsed);
    if (io) {
      io.emit(SOCKET_EVENTS.STREAMER_BOT_MOOD, parsed);
    }
    res.json({ ok: true });
  });

  // GET /nn-tick — first-mount hydrate so a freshly-loaded broadcast
  // page sees the latest VisualTick immediately instead of waiting
  // for the next round to fire.
  router.get("/nn-tick", (_req: Request, res: Response) => {
    res.json({ tick: latestNnTick });
  });

  // POST /reset-learning — operator-only. Clears the latest cached
  // tick and emits a `streamer:nn-tick` null fan-out so the broadcast
  // panels reset to "idle" state. The actual NN reset happens
  // bot-side via the bridge → worker `reset` message; this server
  // route's job is to mirror that operator intent into the overlay
  // state. Auth is the same X-Streamer-Bot shared secret as
  // /stats/music/nn-tick — operators issue the request from the bot
  // host where the secret already lives.
  router.post("/reset-learning", (req: Request, res: Response) => {
    if (!req.isStreamerBot) {
      res.status(403).json({ error: "forbidden" });
      return;
    }
    latestNnTick = null;
    if (io) {
      io.emit(SOCKET_EVENTS.STREAMER_BOT_NN_TICK, null);
    }
    res.json({ ok: true });
  });

  // POST /nn-tick — bot pushes a fresh VisualTick. NOT persisted to
  // SQLite (unlike stats/music) — the visualisation is purely
  // ephemeral; a server restart makes the panels go idle until the
  // next round, which is fine.
  router.post("/nn-tick", (req: Request, res: Response) => {
    if (!req.isStreamerBot) {
      res.status(403).json({ error: "forbidden" });
      return;
    }
    const parsed = parseNnTickPayload(req.body);
    if (!parsed) {
      res.status(400).json({ error: "invalid_payload" });
      return;
    }
    latestNnTick = parsed;
    if (io) {
      io.emit(SOCKET_EVENTS.STREAMER_BOT_NN_TICK, parsed);
    }
    res.json({ ok: true });
  });

  return router;
}
