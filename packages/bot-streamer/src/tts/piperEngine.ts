/**
 * Piper subprocess TTS engine — pipes a line of text into the Piper
 * CLI binary, which synthesises WAV audio and pipes it into a
 * Pulse/ALSA sink via `aplay`. The streamer container's entrypoint
 * pre-configures Piper + the audio chain; this engine just shell-
 * escapes the line and waits for the subprocess to exit.
 *
 * Implementation notes:
 *   - Each `say()` queues behind the previous one so audio doesn't
 *     overlap.
 *   - Failures are logged via `onError` and dropped — the lifecycle
 *     loop must never block on TTS.
 *   - The voice slug is constrained to `[A-Za-z0-9_-]+` upstream by
 *     the persona env loader (PR 11), so it's safe to interpolate
 *     into the argv array.
 *   - The line text is passed via STDIN (not argv) so quoting /
 *     metacharacters in the line itself never need escaping.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { SayOptions, TtsEngine } from "./engine";

/**
 * Default PCM chunk size in bytes. 1764 bytes = 882 16-bit samples =
 * 40ms at Piper's 22.05 kHz output. Halves the postMessage rate vs.
 * 20ms (~25 dispatches/sec instead of ~50) without sacrificing
 * perceptual lipsync responsiveness — the human visual system can't
 * see mouth changes faster than ~30Hz anyway.
 */
const DEFAULT_PCM_CHUNK_BYTES = 1764;

export interface PiperEngineOptions {
  /** Path to the piper binary; defaults to `piper` on PATH. */
  piperBin?: string;
  /** Path to the audio player binary; defaults to `aplay`. */
  aplayBin?: string;
  /** Path to the voice .onnx model. */
  voiceModelPath: string;
  /** Optional callback for subprocess failures. */
  onError?: (err: Error, line: string) => void;
  /**
   * Override the spawn function for tests. Defaults to node's
   * `child_process.spawn`. The fake doesn't have to start a real
   * process — just produce ChildProcessWithoutNullStreams shape.
   */
  spawnFn?: typeof spawn;
  /**
   * Optional sidechannel: receive Piper's raw PCM as fixed-size
   * Int16Array chunks while audio simultaneously plays through aplay.
   * The broadcast overlay's lipsync layer consumes this to drive the
   * avatar mouth; the audio path is unchanged either way.
   *
   * Bytes are forwarded to aplay as they arrive (no playback latency
   * cost). Chunks are aggregated to `pcmChunkBytes` boundaries before
   * the callback fires; sub-chunk remainders flush at end-of-stream.
   */
  onPcmChunk?: (samples: Int16Array, ts: number, sayOpts?: SayOptions) => void;
  /**
   * Chunk size in bytes for `onPcmChunk`. Must be even (16-bit aligned).
   * Defaults to {@link DEFAULT_PCM_CHUNK_BYTES} (~40ms at 22.05 kHz).
   */
  pcmChunkBytes?: number;
  /**
   * Optional callback fired the moment `runOnce` begins processing a
   * line — BEFORE Piper / aplay are spawned, BEFORE any PCM bytes flow.
   * Receives the line text + `sayOpts` (whose `meta` field carries
   * caller-defined metadata pinned at queue time). Used by the runner
   * to invoke `UtteranceController.start` SYNCHRONOUSLY with the
   * engine's serial chain — solves the attribution race where reading
   * `controller.current()` from within `onPcmChunk` could otherwise
   * return the wrong utterance under back-to-back `narrator.speak()`
   * calls. Errors are swallowed.
   */
  onLineProcess?: (line: string, sayOpts?: SayOptions) => void;
  /**
   * Optional callback fired the moment `aplay` exits — i.e. when the
   * speaker buffer has actually drained and audio playback has stopped.
   * This is the REAL audio-end signal that drives PR 2's
   * `UtteranceController.noteAudioEnd`, replacing the speakingClock
   * quiescence heuristic with an event sourced from the actual audio
   * subsystem. Receives the same `sayOpts` passed to `engine.say` so
   * the runner can correlate the end with the line-start meta. Fires
   * once per `say()` call regardless of whether `onPcmChunk` was wired.
   * Errors are swallowed.
   */
  onAudioEnd?: (sayOpts?: SayOptions) => void;
}

/** Construct a Piper-backed TTS engine. */
export function piperEngine(opts: PiperEngineOptions): TtsEngine {
  const piperBin = opts.piperBin ?? "piper";
  const aplayBin = opts.aplayBin ?? "aplay";
  const spawnFn = opts.spawnFn ?? spawn;
  const voiceModelPath = opts.voiceModelPath;
  const onError = opts.onError ?? (() => {});
  const onPcmChunk = opts.onPcmChunk;
  const onLineProcess = opts.onLineProcess;
  const onAudioEnd = opts.onAudioEnd;
  const pcmChunkBytes = opts.pcmChunkBytes ?? DEFAULT_PCM_CHUNK_BYTES;
  // Even-byte alignment is a hard requirement: emitting an odd-sized
  // buffer would split a 16-bit sample across two chunks.
  if (pcmChunkBytes % 2 !== 0) {
    throw new Error(`pcmChunkBytes must be even (got ${pcmChunkBytes})`);
  }

  // Serial queue: only one say() runs at a time.
  let chain: Promise<void> = Promise.resolve();
  let disposed = false;

  function runOnce(line: string, sayOpts?: SayOptions): Promise<void> {
    return new Promise<void>((resolve) => {
      // Fire onLineProcess BEFORE spawning the subprocesses so the
      // runner can mint its utterance id (and any other per-line state)
      // synchronously with the engine's serial chain. By the time PCM
      // chunks start flowing, the runner already knows which utterance
      // this runOnce belongs to. Errors swallowed for parity with the
      // other tap callbacks.
      if (onLineProcess) {
        try { onLineProcess(line, sayOpts); } catch { /* never break audio */ }
      }
      let piper: ChildProcessWithoutNullStreams;
      let aplay: ChildProcessWithoutNullStreams;
      try {
        const args = buildPiperArgs(voiceModelPath, {
          lengthScale: sayOpts?.lengthScale,
          noiseScale: sayOpts?.noiseScale,
          noiseW: sayOpts?.noiseW,
        });
        piper = spawnFn(piperBin, args, {
          stdio: ["pipe", "pipe", "pipe"],
        }) as ChildProcessWithoutNullStreams;
        aplay = spawnFn(aplayBin, ["-r", "22050", "-f", "S16_LE", "-t", "raw", "-"], {
          stdio: ["pipe", "pipe", "pipe"],
        }) as ChildProcessWithoutNullStreams;
      } catch (err) {
        onError(err instanceof Error ? err : new Error(String(err)), line);
        resolve();
        return;
      }

      // Forward Piper's raw audio to aplay. When a PCM tap is wired we
      // can't use `.pipe()` because we need to also accumulate bytes
      // into chunked Int16Array deliveries; instead we manually copy
      // each `data` chunk into aplay AND into the chunk buffer.
      // Without a tap we still use manual forwarding (one code path)
      // — the behavioural overhead is negligible vs. .pipe().
      let pcmBuffer: Buffer = Buffer.alloc(0);
      // Hard cap on the rolling buffer. Piper exits per utterance and
      // chunks flush every `pcmChunkBytes`, so in normal operation the
      // buffer never exceeds one chunk worth. The cap exists purely as
      // a defensive bound against a pathological consumer (slow / blocking
      // onPcmChunk) silently growing memory.
      const PCM_BUFFER_MAX_BYTES = pcmChunkBytes * 32;
      function flushChunks(): void {
        if (!onPcmChunk) return;
        while (pcmBuffer.length >= pcmChunkBytes) {
          const slice = pcmBuffer.subarray(0, pcmChunkBytes);
          // Copy into a fresh ArrayBuffer so the Int16Array is
          // independent of the rolling buffer (otherwise consumers
          // that retain the array would see it overwritten).
          const ab = new ArrayBuffer(slice.length);
          new Uint8Array(ab).set(slice);
          const samples = new Int16Array(ab);
          try {
            onPcmChunk(samples, Date.now(), sayOpts);
          } catch {
            // Tap is decorative; never let it kill the audio path.
          }
          pcmBuffer = pcmBuffer.subarray(pcmChunkBytes);
        }
      }
      piper.stdout.on("data", (chunk: Buffer) => {
        try {
          aplay.stdin.write(chunk);
        } catch {
          // aplay may have closed (process exit race); audio path is
          // best-effort once the subprocess is dying.
        }
        if (onPcmChunk) {
          pcmBuffer = pcmBuffer.length === 0 ? chunk : Buffer.concat([pcmBuffer, chunk]);
          // Cap the rolling buffer — drop the oldest aligned chunks
          // rather than letting it grow without bound. The drop is
          // perceptually invisible at this length and keeps RSS sane
          // if a downstream stall ever stops draining.
          if (pcmBuffer.length > PCM_BUFFER_MAX_BYTES) {
            const overflow = pcmBuffer.length - PCM_BUFFER_MAX_BYTES;
            // Snap the cut to a chunk boundary so we never split a
            // 16-bit sample.
            const aligned = overflow + ((pcmChunkBytes - (overflow % pcmChunkBytes)) % pcmChunkBytes);
            pcmBuffer = pcmBuffer.subarray(Math.min(aligned, pcmBuffer.length));
          }
          flushChunks();
        }
      });
      piper.stdout.on("end", () => {
        try { aplay.stdin.end(); } catch { /* race with aplay exit */ }
        // The trailing sub-chunk remainder (< pcmChunkBytes) is
        // intentionally dropped — at <40ms it contributes nothing
        // perceptible to the lipsync envelope. Calling flushChunks()
        // here would only matter if a buffer-cap drop above had left
        // a complete chunk un-emitted, which is the safety case it's
        // here for.
        flushChunks();
      });

      let settled = false;
      function done() {
        if (settled) return;
        settled = true;
        // Make sure we don't leak handles when one side errors.
        try { piper.kill(); } catch { /* ignore */ }
        try { aplay.kill(); } catch { /* ignore */ }
        resolve();
      }

      piper.on("error", (err) => {
        onError(err, line);
        done();
      });
      aplay.on("error", (err) => {
        onError(err, line);
        done();
      });
      aplay.on("exit", () => {
        // Real audio-end signal — speaker buffer has actually drained.
        // Fire onAudioEnd BEFORE done() so any synchronous follow-up
        // (e.g. UtteranceController.noteAudioEnd → overlay envelope
        // dispatch) lands before the next runOnce can take over the
        // chain. Pass sayOpts so the runner can correlate this end
        // with the line-start meta. Errors swallowed for parity with
        // onPcmChunk.
        if (onAudioEnd) {
          try { onAudioEnd(sayOpts); } catch { /* never break the audio chain */ }
        }
        done();
      });

      // Feed the line via stdin so quoting in the text can't escape
      // into the argv. Trailing newline so Piper flushes its buffer.
      try {
        piper.stdin.write(line + "\n");
        piper.stdin.end();
      } catch (err) {
        onError(err instanceof Error ? err : new Error(String(err)), line);
        done();
      }
    });
  }

  return {
    async say(line: string, sayOpts?: SayOptions): Promise<void> {
      if (disposed || !line) return;
      // Chain so calls run in arrival order. Errors are absorbed by
      // runOnce so the chain never rejects.
      const next = chain.then(() => runOnce(line, sayOpts));
      chain = next;
      await next;
    },
    async dispose(): Promise<void> {
      disposed = true;
      // Drain the in-flight queue before returning so the caller can
      // be sure no audio is still about to play.
      await chain.catch(() => {});
    },
  };
}

/**
 * Per-utterance prosody knobs forwarded to Piper. All fields optional
 * so callers can pass partial overrides (e.g. only `lengthScale`).
 * Each knob is clamped to a practical range inside `buildPiperArgs`
 * before reaching the subprocess so a malformed descriptor can't ask
 * Piper for an unintelligible / artefacted utterance.
 */
export interface PiperProsodyArgs {
  /** `--length_scale` — pacing. Clamped to [0.5, 2.0]. */
  lengthScale?: number;
  /** `--noise_scale` — expressive / acoustic variability. Clamped to [0.0, 1.5]. */
  noiseScale?: number;
  /** `--noise_w` — phoneme-duration jitter / cadence variability. Clamped to [0.0, 1.5]. */
  noiseW?: number;
}

/**
 * Build the Piper argv for one utterance. Centralised + exported so
 * the argv shape is unit-testable without spinning up real
 * subprocesses.
 *
 * Each knob is clamped to a practical range:
 *   - `lengthScale` ∈ [0.5, 2.0] — outside this Piper clips syllables
 *     (too fast) or stretches past intelligibility (too slow).
 *   - `noiseScale`  ∈ [0.0, 1.5] — past ~1.0 the vocoder buzzes /
 *     artefacts; the upper bound is a defensive ceiling.
 *   - `noiseW`      ∈ [0.0, 1.5] — same clamp shape as noiseScale.
 *
 * All `MoodProsody` registry values live well inside these ranges;
 * the clamps protect against a malformed descriptor or a bug in a
 * future caller from asking Piper for nonsense.
 *
 * @param voiceModelPath Absolute path to the Piper `.onnx` voice model.
 * @param prosody        Optional per-utterance prosody overrides.
 *                       Omitted fields fall back to Piper's built-in
 *                       model defaults (lengthScale=1.0, noiseScale=
 *                       0.667, noiseW=0.8).
 * @returns argv array safe to pass to `spawn(piperBin, …)`.
 */
export function buildPiperArgs(
  voiceModelPath: string,
  prosody: PiperProsodyArgs = {},
): string[] {
  const args = ["--model", voiceModelPath, "--output_raw"];
  if (typeof prosody.lengthScale === "number" && Number.isFinite(prosody.lengthScale)) {
    args.push("--length_scale", String(Math.max(0.5, Math.min(2.0, prosody.lengthScale))));
  }
  if (typeof prosody.noiseScale === "number" && Number.isFinite(prosody.noiseScale)) {
    args.push("--noise_scale", String(Math.max(0.0, Math.min(1.5, prosody.noiseScale))));
  }
  if (typeof prosody.noiseW === "number" && Number.isFinite(prosody.noiseW)) {
    args.push("--noise_w", String(Math.max(0.0, Math.min(1.5, prosody.noiseW))));
  }
  return args;
}
