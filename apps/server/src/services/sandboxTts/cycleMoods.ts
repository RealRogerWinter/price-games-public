/**
 * Sandbox-only TTS lipsync diagnostic. For each of the 8 moods,
 * spawns a real Piper subprocess (via vendored `piperEngine`),
 * routes its PCM stream through the production `UtteranceController`
 * + `PcmBatcher`, and emits every resulting envelope to Socket.IO
 * clients via `STREAMER_BOT_TTS_ENVELOPE`. The page-side relay hook
 * (`useStreamerTtsRelay`) re-issues each as a `window.postMessage`
 * with the canonical `{source:'pg-bot', kind, payload}` shape so the
 * broadcast overlay's reducer + Avatar viseme classifier exercise
 * the exact code paths the production runner drives.
 *
 * The orchestrator also emits two non-TTS envelopes per mood — a
 * `mood.snapshot` and a `stats.update` — so the Avatar swaps body
 * sprites for each mood and the MoodIndicator + HUD reflect the
 * change. Mirrors the runner's `publishMood` ordering: snapshot
 * first, then stats update, then the utterance.
 *
 * Mounted only when `process.env.SANDBOX === "1"` — see route file.
 */
import type { Server } from "socket.io";
import { MOOD_LABELS, MOOD_REGISTRY, SOCKET_EVENTS, type Mood } from "@price-game/shared";
import { piperEngine } from "./piperEngine";
import { createUtteranceController } from "./utterance";
import { createPcmBatcher } from "./pcmBatcher";

/** Per-mood test sentence. Distinct lines so the user can tell moods apart. */
const MOOD_LINES: Record<Mood, string> = {
  neutral: "This is the neutral mood. Pricey is steady and even.",
  happy: "Yes! Three correct in a row. I'm having a great time today.",
  confident: "I have got this one. Just trust me on this read.",
  elated: "Wow! That was an absolutely incredible round! Amazing!",
  focused: "Okay. Let's look at this product very carefully now.",
  tilted: "Ugh, really? That is not at all what I expected to see.",
  frustrated: "Come on! How is that even the actual price of this thing?",
  despondent: "I don't even know anymore. Maybe I'm just bad at this game.",
};

/** Sample rate Piper outputs at (matches `piperEngine.ts` aplay args). */
const SAMPLE_RATE = 22050;

/**
 * Chunks per audio_batch envelope (steady state). Matches production
 * runner cadence. The FIRST batch of each utterance flushes earlier
 * — see `PCM_FIRST_BATCH_SIZE` below.
 */
const PCM_BATCH_SIZE = 5;
/**
 * First batch of each utterance flushes after a single chunk, mirroring
 * the production runner so the sandbox diagnostic exercises the same
 * lipsync timing that ships to viewers. See packages/bot-streamer/src/
 * runner/main.ts for the full rationale.
 */
const PCM_FIRST_BATCH_SIZE = 1;

/**
 * Path to a no-op aplay shim. The production streamer container
 * pipes Piper stdout into the real `aplay` for ALSA playback; the
 * sandbox container has no audio device, so we route audio bytes to
 * /dev/null. Generated at module load. The shim must accept any
 * argv (piperEngine spawns it with `-r 22050 -f S16_LE -t raw -`),
 * consume stdin to /dev/null, and exit when stdin closes — that exit
 * is the signal `piperEngine` reads as audio-end.
 */
import { writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const APLAY_SHIM_PATH = join(tmpdir(), "sandbox-aplay-shim.sh");
let aplayShimReady = false;
function ensureAplayShim(): string {
  if (aplayShimReady) return APLAY_SHIM_PATH;
  writeFileSync(APLAY_SHIM_PATH, "#!/bin/sh\nexec cat > /dev/null\n", { mode: 0o755 });
  chmodSync(APLAY_SHIM_PATH, 0o755);
  aplayShimReady = true;
  return APLAY_SHIM_PATH;
}

/**
 * Orchestrate the per-mood lipsync diagnostic. Spawns one Piper
 * subprocess per mood, sequentially, and broadcasts every envelope
 * the controller emits to all connected Socket.IO clients. Resolves
 * when all 8 utterances have finished (audio_ended emitted).
 *
 * @param io          Socket.IO server (already wired in `index.ts`).
 * @param voiceModelPath Absolute path to the Piper `.onnx` voice model.
 *                    Container default: `/opt/voices/en_US-amy-medium.onnx`.
 *                    Defaults to env `STREAMER_TTS_VOICE_MODEL`.
 * @param onLog       Optional structured logger. Receives one entry per
 *                    mood with the actualDurationMs the controller saw.
 * @returns Summary of every utterance that ran (id, mood, durationMs).
 */
export async function runCycleMoods(
  io: Server,
  opts: { voiceModelPath?: string; onLog?: (line: string) => void } = {},
): Promise<Array<{ mood: Mood; id: string; actualDurationMs: number }>> {
  const voiceModelPath = opts.voiceModelPath
    ?? process.env.STREAMER_TTS_VOICE_MODEL
    ?? "/opt/voices/en_US-amy-medium.onnx";
  const log = opts.onLog ?? (() => {});
  const aplayBin = ensureAplayShim();

  const summary: Array<{ mood: Mood; id: string; actualDurationMs: number }> = [];

  /**
   * Broadcast one canonical envelope to every connected client. The
   * payload shape mirrors the production runner's `OverlayForwarder.send`
   * output: the relay hook on the page wraps it in the
   * `{source:'pg-bot'}` postMessage envelope before the reducer sees
   * it. Errors are absorbed — overlay updates are decorative.
   */
  function emitEnvelope(kind: string, payload: unknown): void {
    try {
      io.emit(SOCKET_EVENTS.STREAMER_BOT_TTS_ENVELOPE, { kind, payload });
    } catch {
      // Never let a broadcast failure abort the test run.
    }
  }

  // The controller's sink is the same shape as production
  // (`OverlayForwarder.send`): every emission flows through emitEnvelope.
  const controller = createUtteranceController({
    sink: (env) => emitEnvelope(env.kind, env.payload),
  });

  // Batcher -> controller.noteAudioBatch — mirrors runner/main.ts wiring.
  const batcher = createPcmBatcher({
    size: PCM_BATCH_SIZE,
    firstBatchSize: PCM_FIRST_BATCH_SIZE,
    onFlush: (id, chunks) => {
      controller.noteAudioBatch(id, chunks, SAMPLE_RATE);
    },
  });

  // Real-time chunk throttle. Piper produces audio at ~10x real-time,
  // so without throttling all 600ms of chunks dispatch in 60ms — the
  // page sees the entire utterance in a burst and the mouth state
  // jumps from silence-start to silence-tail before any frame paints.
  // Production routes audio through `aplay` which naturally throttles
  // to real-time; the sandbox replaces that with a /dev/null shim
  // (no audio device), so we throttle in the chunk tap instead.
  //
  // The throttle anchors a wall-clock at the start of the active
  // utterance and dispatches each chunk at `audioStartWallMs +
  // (samplesQueuedBefore / sampleRate) * 1000` — chunk-START
  // scheduling, matching `runner/main.ts`'s production throttle so
  // both code paths converge on the same algorithm. Schedules via
  // `setTimeout`. The sandbox needs the additional
  // `inFlightDispatches` drain bookkeeping that production doesn't:
  // production's real `aplay` exits at `anchor + audio_duration`
  // (one chunk after the last setTimeout fires), so onAudioEnd
  // races it cleanly. The sandbox's /dev/null aplay shim drains
  // stdin instantly, so onAudioEnd fires BEFORE the throttled
  // chunks complete — without the `audioEndResolve` drain, the
  // controller's audio_ended would beat the last batch envelope.
  let audioStartWallMs = 0;
  let totalSamplesQueued = 0;
  let inFlightDispatches = 0;
  let audioEndResolve: (() => void) | null = null;

  function scheduleDispatch(id: string, samples: Int16Array, b64: string): void {
    const samplesAtChunkStart = totalSamplesQueued;
    totalSamplesQueued += samples.length;
    const targetWallMs = audioStartWallMs + (samplesAtChunkStart / SAMPLE_RATE) * 1000;
    const sleepMs = Math.max(0, targetWallMs - Date.now());
    inFlightDispatches += 1;
    setTimeout(() => {
      batcher.push(id, { samples: b64, ts: Date.now() });
      inFlightDispatches -= 1;
      if (inFlightDispatches === 0 && audioEndResolve) {
        const r = audioEndResolve;
        audioEndResolve = null;
        r();
      }
    }, sleepMs);
  }

  // Track the active utterance id outside the engine callbacks so
  // onPcmChunk can correlate chunks back to the utterance. This is
  // exactly the pattern used in runner/main.ts (sayOpts.meta carries
  // the id).
  let activeId: string | null = null;

  const engine = piperEngine({
    voiceModelPath,
    aplayBin,
    onLineProcess: (_line, sayOpts) => {
      const meta = sayOpts?.meta as { mood: Mood; intent: string; estimatedDurationMs: number } | undefined;
      if (!meta) return;
      const id = controller.start({
        text: _line,
        intent: meta.intent,
        mood: meta.mood,
        estimatedDurationMs: meta.estimatedDurationMs,
      });
      activeId = id;
      // Anchor the throttle clock at line-process time. Piper takes
      // ~70ms before the first PCM byte arrives (model warmup + first
      // inference); we accept that head as "audio_started lands a bit
      // late" rather than complicating the schedule. Chunks then play
      // back at real-time relative to this anchor.
      audioStartWallMs = Date.now();
      totalSamplesQueued = 0;
    },
    onPcmChunk: (samples) => {
      if (activeId === null) return;
      const u8 = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
      const b64 = Buffer.from(u8).toString("base64");
      // Real-time throttled dispatch — schedules the batcher.push at
      // wall-clock time matching the chunk's audio offset within the
      // utterance. Without this, all chunks arrive at the page in a
      // 60ms burst (sandbox aplay shim drains stdin instantly) and
      // the mouth animation is invisible to the eye. Production
      // runner has the equivalent throttle in `runner/main.ts`.
      scheduleDispatch(activeId, samples, b64);
    },
    onAudioEnd: () => {
      const id = activeId;
      if (id === null) return;
      activeId = null;
      // Wait for the throttle queue to drain BEFORE firing audio_ended,
      // so the page processes every chunk through the mouth animation
      // before the snap-closed effect runs. If the queue is already
      // empty (small utterance), we still respect the elapsed real-time
      // duration so audio_ended doesn't beat the last chunk.
      const drain = inFlightDispatches === 0
        ? Promise.resolve()
        : new Promise<void>((resolve) => { audioEndResolve = resolve; });
      void drain.then(() => {
        batcher.flush();
        controller.noteAudioEnd(id);
      });
    },
    onError: (err) => {
      log(`[sandbox-tts] piper error: ${err.message}`);
    },
  });

  for (const mood of MOOD_LABELS) {
    const line = MOOD_LINES[mood];
    const { lengthScale, noiseScale, noiseW } = MOOD_REGISTRY[mood].prosody;
    // Mirror runner's publishMood ordering: snapshot first, then stats.
    // Vibe/morale chosen to put each mood near its "characteristic"
    // axis without being authoritative — sandbox visualisation only.
    const moodAxes = MOOD_TO_AXES[mood];
    emitEnvelope("mood.snapshot", {
      mood,
      vibe: moodAxes.vibe,
      morale: moodAxes.morale,
      streak: moodAxes.streak,
      updatedAt: Date.now(),
    });
    emitEnvelope("stats.update", { mood });

    log(`[sandbox-tts] speaking mood=${mood} ls=${lengthScale} ns=${noiseScale} nw=${noiseW} text="${line}"`);
    const t0 = Date.now();
    await engine.say(line, {
      lengthScale,
      noiseScale,
      noiseW,
      meta: {
        mood,
        intent: "sandbox-mood-cycle",
        estimatedDurationMs: estimateDurationMs(line, lengthScale),
      },
    });
    // engine.say resolves at aplay.exit (instant, since shim drains
    // stdin immediately). The throttled chunk queue is still draining
    // at real-time pace — wait for it to empty before advancing to
    // the next mood, so audio_ended isn't a no-op against an
    // already-ended controller.
    while (inFlightDispatches > 0) {
      await new Promise((r) => setTimeout(r, 25));
    }
    const actualDurationMs = Date.now() - t0;
    log(`[sandbox-tts]   mood=${mood} done dur=${actualDurationMs}ms`);
    // controller.current() will be null after audio_ended fired
    summary.push({ mood, id: `done-${mood}`, actualDurationMs });
    // Brief gap between moods so the visual transition is clean.
    await new Promise((r) => setTimeout(r, 800));
  }

  await engine.dispose();
  return summary;
}

/**
 * Per-mood (vibe, morale, streak) values for the snapshot envelope.
 * Picked to land each mood in its expected region of the engine's
 * 2D space, but kept loose — sandbox UI verification, not a model
 * trace. Matches the moodEngine's natural placement: positive vibe
 * + positive morale = elated, negative vibe + negative morale =
 * despondent, etc.
 */
const MOOD_TO_AXES: Record<Mood, { vibe: number; morale: number; streak: number }> = {
  neutral: { vibe: 0, morale: 0, streak: 0 },
  happy: { vibe: 1.5, morale: 0.4, streak: 2 },
  confident: { vibe: 1.0, morale: 0.7, streak: 3 },
  elated: { vibe: 2.5, morale: 0.8, streak: 4 },
  focused: { vibe: 0.5, morale: 0.3, streak: 2 },
  tilted: { vibe: -1.5, morale: -0.2, streak: -2 },
  frustrated: { vibe: -2.0, morale: -0.4, streak: -3 },
  despondent: { vibe: -2.5, morale: -0.7, streak: -4 },
};

/** Heuristic line-duration estimate (matches narrator's `estimateSpeechDurationMs`). */
function estimateDurationMs(line: string, lengthScale: number): number {
  // ~12 chars/sec at lengthScale=1; scale linearly with prosody knob.
  const charsPerSec = 12 / lengthScale;
  return Math.max(800, Math.round((line.length / charsPerSec) * 1000));
}
