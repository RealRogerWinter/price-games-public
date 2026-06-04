/**
 * Production runner entrypoint. Wires every layer of the bot:
 *
 *   1. Persona from env (validated at the boundary).
 *   2. Piper TTS engine + line-picker narrator (when voice model
 *      configured) or null engine fallback.
 *   3. Twitch chat aggregator + command router (when channel
 *      configured) wired to a mutable RunnerCommandState.
 *   4. Overlay forwarder.
 *   5. PlaywrightDriver: headed Chromium, identity seeded, socket
 *      bridge attached, observer running.
 *   6. Lifecycle loop, plan-by-plan, soft-aborting on SIGTERM/SIGINT.
 *   7. Health server on `/healthz`.
 *
 * All wiring degrades gracefully — missing env vars (no Twitch
 * channel, no voice model) fall back to null implementations rather
 * than refusing to boot.
 */

import { createServer } from "node:http";
import { loadPersonaFromEnv } from "../persona/profile";
import { runLifecycle } from "../lifecycle/runner";
import { createPlaywrightDriver } from "./playwrightDriver";
import { createThinker, type Thinker } from "./thinker";
import { createOverlayForwarder, type OverlayForwarder } from "./overlay";
import { createUtteranceController, type UtteranceController } from "./utterance";
import { createPcmBatcher } from "./pcmBatcher";
import { createChunkThrottle } from "./chunkThrottle";
import { nullEngine } from "../tts/engine";
import { piperEngine } from "../tts/piperEngine";
import { createNarrator, type LineMeta } from "./narrator";
import { createCommandRouter } from "../chat/router";
import { createChatAggregator } from "../chat/aggregator";
import { createTwitchSource } from "../chat/sources/twitch";
import { chatPipelineSubscriber } from "./chatPipeline";
import { createMusicSource, type MusicSource } from "./musicSource";
import { registerChatCommands, createInitialCommandState } from "./chatHandlers";
import { parseRotation, parseModeWhitelist, parseBiddingBotDifficulty } from "./runtimeConfig";
import { createWatchdog, type Watchdog } from "./watchdog";
import { createTelemetry } from "./telemetry";
import { LearningBridge, type LearningMode } from "../learning/bridge";
import { resolveTargetUrl } from "./targetUrl";

const HEALTH_PORT = Number(process.env.STREAMER_HEALTH_PORT ?? "9101");
const TARGET_URL = resolveTargetUrl(process.env.STREAMER_TARGET_URL);
const VOICE_MODEL = process.env.STREAMER_TTS_VOICE_MODEL ?? "";
const TWITCH_CHANNEL = process.env.STREAMER_TWITCH_CHANNEL ?? "";

const LEARNING_ENABLED = (process.env.STREAMER_LEARNING_ENABLED ?? "false").toLowerCase() === "true";
const LEARNING_MODE = ((process.env.STREAMER_LEARNING_MODE ?? "off").toLowerCase()) as LearningMode;
const LEARNING_DATA_DIR = process.env.STREAMER_LEARNING_DATA_DIR ?? "/var/streamer/data";
/**
 * Phase 3d.2 production kill-switch. Setting `LEARNING_FORCE_HEURISTIC=1`
 * bypasses the worker entirely — the bot streams on heuristics with
 * no NN training and no learning-bridge boot. Same effect as
 * STREAMER_LEARNING_ENABLED=false but takes precedence over it, so
 * an operator paging in mid-incident can flip a single env var
 * without re-checking the existing bridge config. Recovery procedure
 * (PLAN.md §9) leads with this.
 */
const LEARNING_FORCE_HEURISTIC = (process.env.LEARNING_FORCE_HEURISTIC ?? "")
  .trim()
  .toLowerCase();
const LEARNING_KILL_SWITCH = LEARNING_FORCE_HEURISTIC === "1"
  || LEARNING_FORCE_HEURISTIC === "true"
  || LEARNING_FORCE_HEURISTIC === "yes";
// Security review LOW finding: warn if the env var is set to an
// unrecognised value — silent no-op is dangerous during incident
// response when an operator may have typed `on` / `enable` / `y`
// instead of one of the accepted truthy forms.
if (LEARNING_FORCE_HEURISTIC && !LEARNING_KILL_SWITCH) {
  // eslint-disable-next-line no-console
  console.warn(
    `[runner] LEARNING_FORCE_HEURISTIC="${LEARNING_FORCE_HEURISTIC}" not recognised — accepted: "1" / "true" / "yes". Kill-switch NOT active.`,
  );
}

interface RunnerHealth {
  startedAt: number;
  lastLifecycleTick: number | null;
}

/**
 * Build the /healthz + /status HTTP server.
 *
 * /healthz (Docker healthcheck binary):
 *   - 200 only when the watchdog reports a successful round in the
 *     last 5 minutes AND `panicCount < 5`.
 *   - 503 otherwise — Docker's healthcheck restarts the container
 *     after 4 consecutive failures (~2 minutes).
 *
 * /status (verbose dashboard view):
 *   - Always returns 200 with the full health payload — even when
 *     the bot is stalled — so post-incident inspection still works.
 */
function startHealthServer(
  state: RunnerHealth,
  watchdog: Watchdog,
  learningBridge: LearningBridge | null,
  getOverlayPage: () => import("playwright").Page | null,
): { close: () => void } {
  const HEALTHY_FRESHNESS_MS = 5 * 60_000;
  const PANIC_LIMIT_FOR_HEALTHY = 5;
  const server = createServer((req, res) => {
    if (req.url === "/healthz") {
      const wd = watchdog.getHealth();
      const lastSuccess = wd.lastSuccessfulRoundAt;
      const fresh = lastSuccess !== null
        && Date.now() - lastSuccess < HEALTHY_FRESHNESS_MS
        && wd.panicCount < PANIC_LIMIT_FOR_HEALTHY;
      // During the cold-start grace period (no rounds yet), report
      // "starting" — Docker's healthcheck `start_period` should
      // cover this; serving 503 here lets ops dashboards see the
      // distinction.
      const status = fresh
        ? "ok"
        : lastSuccess === null
          ? "starting"
          : "stalled";
      // Learning subsystem health — never fail the container on a
      // worker-thread death; the bridge surfaces `degraded:'worker_dead'`
      // and the bot keeps playing on heuristics. Killing the container
      // would tear down Chromium and the live stream.
      const learning = learningBridge?.health() ?? {
        enabled: false,
        mode: "off" as const,
      };
      res.writeHead(fresh ? 200 : 503, { "content-type": "application/json" });
      res.end(JSON.stringify({
        status,
        startedAt: state.startedAt,
        lastSuccessfulRoundAt: lastSuccess,
        panicCount: wd.panicCount,
        learning,
      }));
      return;
    }
    if (req.url === "/status") {
      const wd = watchdog.getHealth();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        startedAt: state.startedAt,
        uptimeMs: Date.now() - state.startedAt,
        lastLifecycleTick: state.lastLifecycleTick,
        watchdog: {
          lastSuccessfulRoundAt: wd.lastSuccessfulRoundAt,
          lastActivityAt: wd.lastActivityAt,
          panicCount: wd.panicCount,
          lastPanicAt: wd.lastPanicAt,
        },
        learning: learningBridge?.health() ?? null,
      }));
      return;
    }
    if (req.url === "/diag/page") {
      // Live snapshot of the broadcast page's lipsync diagnostic
      // counters (`__pgPcmStats`, `__pgVisemeStats`) plus current URL
      // and the React-state `tts.speaking` flag. Exists so ops can
      // confirm `runner.tts.audio_chunk → page.received → page.dispatched
      // → avatar.processed` without attaching a remote debugger.
      //
      // Auth-gated for parity with `/reset-learning` — same port,
      // same trust zone. The server binds to 127.0.0.1 (below) so an
      // accidental `ports:` mapping in compose can't reach this
      // endpoint, but defence-in-depth: an attacker on the docker
      // bridge network could otherwise read back `window.location.href`
      // and any unsanitised future global the page surfaces.
      // When `STREAMER_BOT_SECRET` is unset (dev / unit tests) the
      // gate degrades to "open" — same policy as the rest of the
      // streamer runtime.
      const diagSecret = process.env.STREAMER_BOT_SECRET ?? "";
      const diagPresented = (req.headers["x-streamer-bot"] as string | undefined) ?? "";
      if (diagSecret && diagPresented !== diagSecret) {
        res.writeHead(403, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "forbidden" }));
        return;
      }
      const page = getOverlayPage();
      if (!page) {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "no_page" }));
        return;
      }
      void (async () => {
        try {
          const data = await page.evaluate(() => {
            const w = window as unknown as {
              __pgPcmStats?: unknown;
              __pgVisemeStats?: unknown;
            };
            const speakingEl = document.querySelector(
              '[data-testid="broadcast-speaking-indicator"]',
            );
            const avatarEl = document.querySelector(
              '[data-testid="broadcast-avatar"]',
            );
            return {
              url: window.location.href,
              pcm: w.__pgPcmStats ?? null,
              viseme: w.__pgVisemeStats ?? null,
              avatarMounted: avatarEl !== null,
              avatarSpeaking: avatarEl?.getAttribute("data-speaking") ?? null,
              indicatorSpeaking: speakingEl?.getAttribute("data-speaking") ?? null,
            };
          });
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(data));
        } catch (err) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              error: "evaluate_failed",
              message: err instanceof Error ? err.message : String(err),
            }),
          );
        }
      })();
      return;
    }
    if (req.method === "POST" && req.url === "/reset-learning") {
      // Operator-only nuclear option — wipes the NN's in-memory state
      // and archives the latest snapshot so the bot starts learning
      // from random init on the next round. Auth is the same shared
      // secret used by the server-relay routes (X-Streamer-Bot
      // header). When the bridge is off, the request is a no-op and
      // returns 204; when it's enabled, we await the worker's
      // `reset_ack` for up to 5 s so the operator's curl returns
      // synchronously when the wipe finishes.
      const secret = process.env.STREAMER_BOT_SECRET ?? "";
      const presented = (req.headers["x-streamer-bot"] as string | undefined) ?? "";
      if (!secret || presented !== secret) {
        res.writeHead(403, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "forbidden" }));
        return;
      }
      if (!learningBridge) {
        res.writeHead(204);
        res.end();
        return;
      }
      void (async () => {
        try {
          await learningBridge.reset();
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } catch (err) {
          // Log the real error to the container log; respond with a
          // static string so an accidentally-exposed port can't leak
          // internal error details (filenames, stack fragments, etc.).
          // eslint-disable-next-line no-console
          console.warn(`[runner] reset-learning failed: ${(err as Error).message}`);
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "reset_failed" }));
        }
      })();
      return;
    }
    res.writeHead(404);
    res.end("not_found");
  });
  // Bind loopback-only. The health port is consumed by Docker's
  // healthcheck (`docker exec curl localhost:9101/healthz`) and by
  // the operator running `docker exec … curl …/diag/page`; neither
  // path needs an external interface. A loopback bind means an
  // accidental `ports: ["9101:9101"]` in a future compose edit would
  // not actually expose the endpoints to the host network — the
  // socket itself refuses non-loopback peers. Belt-and-braces with
  // the X-Streamer-Bot gate on `/diag/page` and `/reset-learning`.
  server.listen(HEALTH_PORT, "127.0.0.1", () => {
    // eslint-disable-next-line no-console
    console.log(`[runner] health server listening on :${HEALTH_PORT} (loopback)`);
  });
  return { close: () => server.close() };
}

async function main(): Promise<void> {
  const persona = loadPersonaFromEnv(process.env);
  // eslint-disable-next-line no-console
  console.log(`[runner] starting as ${persona.name} (${persona.avatar}) T=${persona.skillTemperature}`);

  const health: RunnerHealth = { startedAt: Date.now(), lastLifecycleTick: Date.now() };
  const telemetry = createTelemetry();
  telemetry.log({ evt: "runner.start", persona: persona.name, target: TARGET_URL });

  // Overlay forwarder is built below; capture a reference here via
  // `onLine` / `onPcmChunk` closures so the narrator + Piper can emit
  // subtitle, speaking-indicator, and PCM-tap events as audio flows.
  // Each closure reads `overlay` lazily — by the time a line is spoken
  // it has been assigned.
  let overlayRef: OverlayForwarder | null = null;
  // Lipsync diagnostic counters — telemetry-logged every 50 chunks so
  // ops can confirm Piper → onPcmChunk → page.evaluate is alive in
  // prod. The matching browser-side counters live on
  // `window.__pgPcmStats` / `window.__pgVisemeStats`. If `tap` rises
  // but the browser-side `received` doesn't, the page.evaluate path
  // is failing.
  const pcmDiag = {
    tap: 0,
    sent: 0,
    dispatchErrors: 0,
    droppedNoPage: 0,
    /**
     * Bumped every time the PcmBatcher fires `noteAudioBatch`. The
     * ratio `sent / batchesFlushed` should hover around `PCM_BATCH_SIZE`
     * (=5) during steady-state speech — operators verify the batching
     * policy is in effect via this counter alone, no aplay timing
     * required. Cumulative since process start.
     */
    batchesFlushed: 0,
    // Peak + mean RMS over the last 50-chunk window so ops can see
    // whether real Piper output reaches the avatar's amplitude
    // thresholds (`rmsToAperture` GAIN=9, FLOOR=0.02 → speech needs
    // RMS≥0.04 to leave the closed state). Compared against the
    // synthetic sandbox tests this surfaces voice-model gain
    // regressions immediately.
    rmsMaxWindow: 0,
    rmsSumWindow: 0,
    rmsCountWindow: 0,
  };
  function rmsOfInt16(samples: Int16Array): number {
    if (samples.length === 0) return 0;
    let sumSq = 0;
    for (let i = 0; i < samples.length; i++) sumSq += samples[i] * samples[i];
    return Math.sqrt(sumSq / samples.length) / 32768;
  }
  /**
   * Per-utterance PCM batch accumulator. The runner accumulates ~5
   * chunks (~200ms of audio at Piper's 40ms/chunk default) before
   * dispatching a single `tts.utterance.audio_batch` envelope —
   * cuts the `page.evaluate` round-trip rate from ~25/sec to ~5/sec
   * during continuous speech, materially reducing CDP pressure on
   * the headed Chromium without sacrificing perceptual lipsync
   * responsiveness (the human visual system can't see mouth changes
   * faster than ~30Hz, the page still dispatches per-chunk on
   * pcmEvents internally).
   *
   * Keyed by utterance id so chunks from the next runOnce don't
   * accidentally piggyback on a previous utterance's batch — the
   * accumulator resets per id transition.
   *
   * The FIRST batch of each utterance flushes earlier — see
   * `PCM_FIRST_BATCH_SIZE` below.
   */
  const PCM_BATCH_SIZE = 5;
  /**
   * First batch of each utterance flushes after a single chunk so the
   * page receives its first audio_batch envelope at chunk-START time
   * (anchor + 0) instead of at the size-5 boundary (anchor + 160ms).
   * Mouth animation kicks in synchronously with audio playback —
   * earlier production behaviour kept the mouth closed for the first
   * ~200-400ms of every utterance because the size-5 batcher waited
   * for chunk 5 before sending anything to the page. Steady-state
   * batches still use `PCM_BATCH_SIZE` so the per-utterance CDP
   * round-trip count grows by exactly one (the first-chunk batch).
   */
  const PCM_FIRST_BATCH_SIZE = 1;
  /**
   * Sample rate of Piper's output stream — pinned to 22050 to match
   * `aplayBin` arguments and the `noteAudioBatch` envelope. Used
   * inside the chunk-throttle calculation to convert sample-counts
   * into wall-clock target times.
   */
  const PIPER_SAMPLE_RATE = 22050;
  let utteranceController: UtteranceController | null = null;

  /**
   * Shape of the meta object narrator.dispatch attaches to engine.say
   * opts, with the runner-side `utteranceId` field that
   * `onLineProcess` mutates onto it once `controller.start` mints the
   * id. The pinning is what makes `onPcmChunk` / `onAudioEnd`
   * attribute audio to the line that was QUEUED for them rather than
   * to whatever happens to be `controller.current()` at callback time.
   */
  type PinnedLineMeta = LineMeta & { utteranceId?: string };

  /**
   * Per-utterance PCM batch accumulator. Flushes to
   * `controller.noteAudioBatch` (which emits one wire envelope per
   * batch) after every PCM_BATCH_SIZE chunks AND on audio_end (so
   * trailing < PCM_BATCH_SIZE chunks aren't lost). The batcher's
   * cross-utterance flush-on-id-change is defence in depth — under
   * serial runOnce + the audio_end flush below it should never fire.
   */
  const pcmBatcher = createPcmBatcher({
    size: PCM_BATCH_SIZE,
    firstBatchSize: PCM_FIRST_BATCH_SIZE,
    onFlush: (id, chunks) => {
      pcmDiag.batchesFlushed += 1;
      utteranceController?.noteAudioBatch(id, chunks, 22050);
    },
  });

  /**
   * Per-utterance chunk throttle (see `chunkThrottle.ts` for the full
   * rationale). Without throttling Piper's ~10x-real-time output, all
   * chunks reach the page in a 60ms burst, the mouth flickers, then
   * sits closed for the rest of audio playback. The throttle anchors
   * a wall clock at the first chunk and dispatches subsequent
   * batcher pushes at `anchor + (samplesQueuedBefore / sampleRate) *
   * 1000`, matching `aplay`'s consumption on the audio side.
   */
  const chunkThrottle = createChunkThrottle({
    sampleRate: PIPER_SAMPLE_RATE,
    dispatch: (id, payload) => {
      pcmBatcher.push(id, payload as { samples: string; ts: number });
    },
  });

  const ttsEngine = VOICE_MODEL
    ? piperEngine({
        voiceModelPath: VOICE_MODEL,
        // PCM tap: encode each chunk to base64 once and accumulate it
        // in `pcmBatchChunks`. When the batch hits `PCM_BATCH_SIZE` (or
        // when audio ends, see `onAudioEnd` below), flush via
        // `controller.noteAudioBatch` which emits ONE envelope carrying
        // all the buffered chunks. Audio playback through aplay →
        // Pulse → ffmpeg is unaffected — the tap runs in parallel.
        onPcmChunk: (samples, ts, sayOpts) => {
          pcmDiag.tap += 1;
          const ovr = overlayRef;
          if (!ovr) {
            pcmDiag.droppedNoPage += 1;
            return;
          }
          const meta = sayOpts?.meta as PinnedLineMeta | undefined;
          if (!meta?.utteranceId) return;
          const utteranceId = meta.utteranceId;
          const u8 = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
          const b64 = Buffer.from(u8).toString("base64");
          pcmDiag.sent += 1;
          // Schedule the batcher push at the chunk's real-time playback
          // boundary (chunk-START scheduling — see `chunkThrottle.ts`).
          // The optional `onFirstChunk` callback fires `audio_started`
          // at first-chunk wall time, keeping the envelope's `at`
          // timestamp aligned with REAL audio start even though the
          // first audio_batch envelope (which would otherwise fire
          // audio_started implicitly via `noteAudioBatch`) is delayed
          // by ~200ms under throttling.
          chunkThrottle.enqueue(
            utteranceId,
            samples.length,
            { samples: b64, ts },
            () => utteranceController?.noteAudioStart(utteranceId),
          );
          // Track RMS over the same 50-chunk window so the diag log
          // captures peak + mean amplitude alongside the dispatch
          // counters. `tap` / `sent` are cumulative since process
          // start; `rmsMaxWindow` / `rmsMeanWindow` reset every 50.
          const r = rmsOfInt16(samples);
          if (r > pcmDiag.rmsMaxWindow) pcmDiag.rmsMaxWindow = r;
          pcmDiag.rmsSumWindow += r;
          pcmDiag.rmsCountWindow += 1;
          if (pcmDiag.tap % 50 === 0) {
            const rmsMeanWindow = pcmDiag.rmsCountWindow > 0
              ? pcmDiag.rmsSumWindow / pcmDiag.rmsCountWindow
              : 0;
            telemetry.log({
              evt: "pcm.diag",
              tap: pcmDiag.tap,
              sent: pcmDiag.sent,
              dispatchErrors: pcmDiag.dispatchErrors,
              droppedNoPage: pcmDiag.droppedNoPage,
              rmsMaxWindow: Number(pcmDiag.rmsMaxWindow.toFixed(4)),
              rmsMeanWindow: Number(rmsMeanWindow.toFixed(4)),
            });
            pcmDiag.rmsMaxWindow = 0;
            pcmDiag.rmsSumWindow = 0;
            pcmDiag.rmsCountWindow = 0;
          }
        },
        // Fired at the top of each runOnce, BEFORE any subprocess
        // spawns. This is where we mint the utterance id and pin it
        // back into sayOpts.meta so onPcmChunk and onAudioEnd can
        // associate their events with the line that was QUEUED for
        // them — solves the attribution race where back-to-back
        // narrator.speak() calls could otherwise have the second
        // call's controller.start clobber the first's id before its
        // audio finishes.
        onLineProcess: (_line, sayOpts) => {
          const meta = sayOpts?.meta as LineMeta | undefined;
          if (!meta) return;
          const id = utteranceController?.start({
            text: meta.text,
            intent: meta.intent,
            mood: meta.mood,
            estimatedDurationMs: meta.estimatedDurationMs,
          });
          if (id && sayOpts) {
            (sayOpts.meta as PinnedLineMeta).utteranceId = id;
          }
          // Begin a fresh throttle window. Resets the sample counter
          // + activates this id; stale setTimeouts from the previous
          // utterance no-op via the throttle's active-id check.
          if (id) chunkThrottle.beginUtterance(id);
        },
        // Real audio-end signal — sourced from `aplay.exit`. Drives
        // the utterance lifecycle's audio_ended event with an
        // accurate `actualDurationMs`. The utterance ID comes from
        // sayOpts.meta — pinned by onLineProcess above — so a back-to-
        // back start that has shifted controller.current() can't make
        // us emit audio_ended for the wrong utterance.
        //
        // We FLUSH the trailing batch before noteAudioEnd so the
        // page-side reducer sees: (audio_batch with leftover chunks)
        // → (audio_ended). Without the flush, chunks accumulated since
        // the last full-batch boundary would be silently dropped.
        onAudioEnd: (sayOpts) => {
          const meta = sayOpts?.meta as PinnedLineMeta | undefined;
          if (!meta?.utteranceId) return;
          // Flush trailing chunks BEFORE audio_ended so the page sees
          // (audio_batch with leftover chunks) → (audio_ended). The
          // batcher's `flush` is a no-op on an empty accumulator.
          //
          // Throttle-timing note: with chunk-START scheduling
          // (anchor + samplesQueuedBefore / sampleRate), the LAST
          // chunk's `setTimeout` fires at anchor + (audio_duration -
          // chunk_duration). `aplay.exit` fires at anchor +
          // audio_duration after the speaker buffer has fully
          // drained — so this `onAudioEnd` runs ~40ms (one chunk
          // duration) after the last throttled push, with the
          // batcher already populated and ready to flush.
          pcmBatcher.flush();
          utteranceController?.noteAudioEnd(meta.utteranceId);
          // Drop the active id so any in-flight stale setTimeouts
          // (event-loop stall longer than 40ms) no-op rather than
          // clobbering the next utterance's batch.
          chunkThrottle.endUtterance();
        },
      })
    : nullEngine();
  // Late-bound — the narrator is built before the overlay (and thus
  // before the Thinker), but its onLine hook needs to feed the
  // Thinker's TTS-active gate so visual thoughts never overlap a
  // spoken line. Closure capture: a `let` reference filled in once
  // the Thinker is created post-overlay.
  //
  // Race-window analysis: every TTS callsite in the runner runs
  // INSIDE `driver.execute(plan)` (called from `runLifecycle` below,
  // which we don't enter until after `createThinker(overlay)` runs).
  // So onLine cannot fire before `thinkerRef` is set — the optional
  // chain is purely defensive against a future refactor that hoists
  // narrator usage above the wiring point. If you move
  // `createThinker` later, this assumption breaks silently and the
  // visual feed will stop gating against TTS.
  let thinkerRef: Thinker | null = null;
  const narrator = createNarrator(ttsEngine, {
    // PR 4 retired the legacy `tts.line` / `tts.state` / `tts.audio_chunk`
    // back-compat envelopes — page-side consumers now read the
    // currentUtterance slot reduced from `tts.utterance.*` only.
    // The hook is now load-bearing for the Thinker's TTS-active
    // gate: every queued utterance reports its estimatedDurationMs
    // so the visual thought stream can stay quiet during speech.
    onLine: (_line, _intent, durationMs) => {
      thinkerRef?.observeTtsLine(durationMs);
    },
  });
  // Build the UtteranceController. The sink forwards every envelope
  // to the overlay so the page receives `tts.utterance.start /
  // audio_started / audio_batch / audio_ended / cancelled`. Page
  // reducer in `apps/web/src/broadcast/state/overlayBus.ts` consumes
  // them and derives subtitle / speaking / mouth state from the
  // single `currentUtterance` slot.
  utteranceController = createUtteranceController({
    sink: (env) => {
      const ovr = overlayRef;
      if (!ovr) return;
      void ovr.send(env.kind, env.payload);
    },
  });

  const commandState = createInitialCommandState(persona.skillTemperature);

  const router = createCommandRouter({
    onHandlerError: (err, cmd) => {
      // eslint-disable-next-line no-console
      console.warn(`[chat] handler ${cmd.name} threw:`, err);
    },
  });
  registerChatCommands({ router, state: commandState, narrator });
  let stopAggregator: (() => void) | null = null;
  if (TWITCH_CHANNEL) {
    try {
      // Defer the tmi.js import — a deployment without the package
      // installed shouldn't fail to boot, just skip chat. tmi.js
      // ships no types so the dynamic-import shape is asserted by
      // the cast below.
      // @ts-expect-error — tmi.js has no published .d.ts; we shape the import manually.
      const tmiMod = (await import("tmi.js")) as unknown as {
        Client?: new (opts: unknown) => unknown;
        default?: { Client: new (opts: unknown) => unknown };
      };
      const TmiClient = tmiMod.Client ?? tmiMod.default?.Client;
      if (!TmiClient) throw new Error("tmi.js Client export not found");
      const tmiClientFactory = () =>
        new TmiClient({
          channels: [TWITCH_CHANNEL],
          identity: process.env.STREAMER_TWITCH_OAUTH
            ? { username: persona.name, password: process.env.STREAMER_TWITCH_OAUTH }
            : undefined,
        }) as never;
      const aggregator = createChatAggregator([
        createTwitchSource({ channel: TWITCH_CHANNEL, clientFactory: tmiClientFactory }),
      ]);
      aggregator.subscribe(chatPipelineSubscriber({ router, getOverlay: () => overlayRef }));
      aggregator.start();
      stopAggregator = () => aggregator.stop();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("[runner] chat aggregator setup failed; continuing without chat:", err);
    }
  }

  // Overlay dispatch is page-bound — page-evaluate posts the
  // envelope into the broadcast page's window. The driver's
  // onPageReady hook captures the page handle after it's created;
  // events sent before the page exists are dropped silently
  // (overlay updates are decorative, never load-bearing).
  type Page = import("playwright").Page;
  let overlayPage: Page | null = null;
  const overlay = createOverlayForwarder(async (envelope) => {
    if (!overlayPage) return;
    try {
      // Pin the postMessage target origin to TARGET_URL rather than
      // the "*" wildcard. The page is same-origin with TARGET_URL by
      // construction (the runner only ever navigates there), but
      // pinning the origin is trivial hardening against a future
      // change that introduces a cross-origin sub-context.
      await overlayPage.evaluate(
        ({ env, origin }) => {
          window.postMessage(env, origin);
        },
        { env: envelope, origin: TARGET_URL },
      );
    } catch {
      // Page may have closed mid-dispatch — overlay updates are
      // best-effort.
    }
  });
  // Bind the narrator's onLine closure now that overlay exists.
  overlayRef = overlay;

  // Thinker — visual-only inner monologue. Wired with the overlay
  // so it can emit `thought.bubble` envelopes; back-fills the
  // narrator's onLine reference so TTS lines flowing through the
  // narrator update the Thinker's TTS-active watermark.
  const thinker = createThinker(overlay);
  thinkerRef = thinker;

  // Music source — bridges mpd to the broadcast overlay's
  // MusicTicker. Skipped if mpd is unreachable (entrypoint.sh leaves
  // mpd unstarted when the music dir is empty).
  let music: MusicSource | null = null;
  try {
    // Mirror track changes to the server relay so any `?broadcast=1`
    // viewer (operator preview, co-streamer overlay) sees the same
    // "now playing" line, not just the bot's own Chromium tab. The
    // serverRelay block is no-op when STREAMER_BOT_SECRET is unset.
    const streamerBotSecret = process.env.STREAMER_BOT_SECRET ?? "";
    const serverRelay = streamerBotSecret
      ? { targetUrl: TARGET_URL, streamerBotSecret }
      : undefined;
    music = createMusicSource({
      overlay,
      commandState,
      serverRelay,
      onInfo: (msg) => telemetry.log({ evt: "music.lifecycle", msg }),
      onWarning: (msg) => telemetry.log({ evt: "music.warn", msg }),
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[runner] music source setup failed; continuing without music updates:", err);
  }

  // Match the browser viewport to the Xvfb display geometry so
  // ffmpeg's x11grab captures a perfectly-fitted frame. Defaults
  // mirror entrypoint.sh.
  const widthRaw = Number(process.env.STREAMER_WIDTH ?? "1920");
  const heightRaw = Number(process.env.STREAMER_HEIGHT ?? "1080");

  // Watchdog: monitors round throughput and kicks the driver when
  // we go > 4 minutes without progress. Five panics in an hour →
  // process.exit(70) so Docker restarts the container.
  //
  // Indirection through `driverRef` because the watchdog's onPanic
  // closure needs to outlive `driver`'s construction order — the
  // driver receives the watchdog instance during construction, so
  // the watchdog must exist first.
  const driverRef: { current: { panic(): Promise<void> } | null } = { current: null };
  const watchdog = createWatchdog({
    onPanic: async (reason) => {
      telemetry.log({ evt: "watchdog.panic", reason });
      // eslint-disable-next-line no-console
      console.warn(`[runner] watchdog firing panic — reason=${reason}`);
      await driverRef.current?.panic();
    },
    onGiveUp: (count) => {
      telemetry.log({ evt: "watchdog.give_up", panicCount: count });
      // eslint-disable-next-line no-console
      console.error(`[runner] ${count} panics in window — exiting for Docker restart`);
      process.exit(70);
    },
  });

  // Learning bridge — gated by STREAMER_LEARNING_ENABLED. When the
  // flag is false the bridge stays in `off` mode and predict/update
  // calls are no-ops; the bot operates entirely on heuristics. Boot
  // failure (e.g. SQLite open error) is non-fatal: log, drop to
  // heuristic-only operation, and surface via /healthz.
  let learningBridge: LearningBridge | null = null;
  if (LEARNING_KILL_SWITCH) {
    // eslint-disable-next-line no-console
    console.warn("[runner] LEARNING_FORCE_HEURISTIC set — skipping learning bridge boot, bot will run on heuristics only");
  } else if (LEARNING_ENABLED && LEARNING_MODE !== "off") {
    learningBridge = new LearningBridge();
    try {
      // moodInfluence is the master gate on the FiLM head + per-
      // sample arousal-gated importance. At 0 (the default) the
      // worker skips the FiLM forward and `arousalGain` collapses
      // to 1 — the prediction path is bit-identical to the pre-
      // FiLM baseline. Threaded through the persona profile so a
      // sandbox / A/B can ramp it via `STREAMER_MOOD_INFLUENCE`.
      await learningBridge.start({
        dataDir: LEARNING_DATA_DIR,
        mode: LEARNING_MODE,
        workerOptions: {
          dataDir: LEARNING_DATA_DIR,
          moodInfluence: persona.moodInfluence,
        },
      });
      // eslint-disable-next-line no-console
      console.log(`[runner] learning bridge started — mode=${LEARNING_MODE} dir=${LEARNING_DATA_DIR}`);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("[runner] learning bridge failed to start; falling back to heuristic:", err);
      learningBridge = null;
    }
  }

  const healthServer = startHealthServer(health, watchdog, learningBridge, () => overlayPage);

  // Parsed once and shared between the lifecycle picker (which gates
  // solo + host_public mode picks) and the driver (which gates
  // public_join lobby selection so the whitelist is enforced across
  // all three plan kinds).
  const rotation = parseRotation(process.env.STREAMER_ROTATION);
  const modeWhitelist = parseModeWhitelist(process.env.STREAMER_MODES);
  const modeWhitelistSet = modeWhitelist ? new Set<string>(modeWhitelist) : undefined;
  // Phase 3d.2: NPC difficulty for the auto-fill opponents in
  // quickplay_bidding plans. Defaults to "medium" inside the policy
  // when env is unset.
  const biddingBotDifficulty = parseBiddingBotDifficulty(process.env.STREAMER_BIDDING_BOT_DIFFICULTY);

  const driver = createPlaywrightDriver({
    targetUrl: TARGET_URL,
    persona,
    overlay,
    narrator,
    thinker,
    commandState,
    watchdog,
    telemetry,
    modeWhitelist: modeWhitelistSet,
    learningBridge: learningBridge ?? undefined,
    viewport: {
      width: Number.isFinite(widthRaw) ? widthRaw : 1920,
      height: Number.isFinite(heightRaw) ? heightRaw : 1080,
    },
    onPageReady: (page) => {
      overlayPage = page;
    },
  });
  driverRef.current = driver;
  watchdog.start();

  // Hydrate Pricey's mood from the server's persisted snapshot before
  // the lifecycle loop starts. Without this a container restart resets
  // the emotional arc to neutral; with it the bot resumes whatever
  // mood it had at shutdown. Best-effort — server-side issues leave
  // INITIAL_MOOD in place, same as a fresh deployment.
  await driver.hydrateMood();

  const ac = new AbortController();
  function shutdown(reason: string) {
    // eslint-disable-next-line no-console
    console.log(`[runner] shutdown requested: ${reason}`);
    ac.abort();
  }
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  // Optional rotation + mode-whitelist overrides — STREAMER_ROTATION
  // narrows which lifecycle steps run (e.g. "solo,solo" to skip MP),
  // STREAMER_MODES restricts the game-mode picker (used during
  // stabilisation when some enactors aren't yet reliable on stream).
  // Both are validated against the canonical shared lists; unknown
  // tokens are dropped with a warning so a typo can't silently widen
  // the rotation. Both are parsed earlier so the driver can also use
  // modeWhitelist to filter public_join lobby candidates.
  const policy: import("../lifecycle/policy").PolicyConfig = {};
  if (rotation) policy.rotation = rotation;
  if (modeWhitelist) policy.modeWhitelist = modeWhitelist;
  if (biddingBotDifficulty) policy.biddingBotDifficulty = biddingBotDifficulty;

  try {
    await runLifecycle(driver, ac.signal, {
      policy: Object.keys(policy).length > 0 ? policy : undefined,
      // Honour an explicit STREAMER_ROTATION by switching to the
      // legacy fixed-rotation picker. The default stateful picker
      // (probabilistic kind weights — solo:0.5, public_join:0.3,
      // host_public:0.2) silently overrides the rotation array, so
      // setting STREAMER_ROTATION=solo would still produce ~30%
      // public_join and ~20% host_public — exactly the dead-air the
      // operator is trying to avoid.
      useStatefulPicker: rotation ? false : undefined,
      onPlanComplete: (outcome) => {
        health.lastLifecycleTick = Date.now();
        telemetry.log({
          evt: "plan.end",
          kind: outcome.plan.kind,
          mode: "mode" in outcome.plan ? outcome.plan.mode : null,
          status: outcome.status,
          durationMs: outcome.durationMs,
          error: outcome.error,
        });
      },
      onPlanStart: (plan, upcoming) => {
        telemetry.log({
          evt: "plan.start",
          kind: plan.kind,
          mode: "mode" in plan ? plan.mode : null,
          upcoming: upcoming.map((p) => p.kind),
        });
      },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[runner] lifecycle crashed", err);
  } finally {
    try { stopAggregator?.(); } catch { /* noop */ }
    try { music?.stop(); } catch { /* noop */ }
    try { watchdog.stop(); } catch { /* noop */ }
    // Cancel any in-flight utterance so the page-side reducer sees a
    // clean tts.utterance.cancelled envelope on SIGTERM rather than
    // getting stuck thinking Pricey is still mid-line. The
    // controller's `cancel(id)` is a no-op when nothing is active.
    try {
      const inflight = utteranceController?.current();
      if (inflight) utteranceController?.cancel(inflight.id);
    } catch { /* noop */ }
    try { await narrator.dispose(); } catch { /* noop */ }
    try { await learningBridge?.stop(); } catch { /* noop */ }
    await driver.shutdown();
    healthServer.close();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("[runner] fatal", err);
  process.exit(1);
});
