/**
 * VENDORED FROM `packages/bot-streamer/src/tts/engine.ts` —
 * byte-equivalent. Sync if upstream changes. See sibling
 * piperEngine.ts header for why we vendor instead of import.
 *
 * TTS engine abstraction. The runner calls `say(line)` whenever it
 * wants the bot to narrate something on stream. Implementations:
 *
 *   - `nullEngine`     — drops every line (default for unit tests and
 *                        local dev where the streamer container isn't
 *                        running).
 *   - `loggingEngine`  — writes lines to a sink for tests / debugging.
 *   - `piperEngine`    — spawns the Piper CLI binary and pipes audio
 *                        into a Pulse sink. Lives in PR 13 alongside
 *                        the streamer container; this PR ships the
 *                        interface and the two test-friendly engines
 *                        only.
 *
 * Calls are queued so a fast burst of events doesn't overlap audio.
 */

export interface SayOptions {
  /**
   * Optional priority. The default queue is FIFO; high-priority lines
   * (e.g. viewer command acks) jump to the head of the queue but
   * don't interrupt audio that's already speaking.
   */
  priority?: "normal" | "high";
  /**
   * Piper `--length_scale` value for this utterance. Drives mood-
   * dependent pacing (faster when elated, slower when despondent).
   * The narrator passes this through from the active mood's
   * `MoodProsody.lengthScale`. Engines that don't support pacing
   * (logging, null) ignore it.
   *
   * Range guard: clamped to [0.5, 2.0] inside `piperEngine` before
   * shelling out, so a malformed descriptor can't ask Piper for an
   * unintelligible utterance.
   */
  lengthScale?: number;
  /**
   * Piper `--noise_scale` value (acoustic / expressive variability).
   * Sourced from the active mood's `MoodProsody.noiseScale`. Higher =
   * more expressive timbral variation. Ignored by non-Piper engines.
   * Clamped to [0.0, 1.5] inside `piperEngine`.
   */
  noiseScale?: number;
  /**
   * Piper `--noise_w` value (phoneme-duration jitter — rhythmic
   * variability). Sourced from the active mood's `MoodProsody.noiseW`.
   * Higher = more uneven cadence. Ignored by non-Piper engines.
   * Clamped to [0.0, 1.5] inside `piperEngine`.
   */
  noiseW?: number;
  /**
   * Opaque metadata threaded through the engine's `onLineProcess` /
   * `onPcmChunk` / `onAudioEnd` callbacks. Engines do not interpret
   * the value; they just pass it back. Used by the runner to
   * associate every PCM chunk and audio-end event with the utterance
   * that was QUEUED for them — read once at queue time and pinned for
   * the lifetime of `runOnce`. Solves the attribution race where
   * reading `controller.current()` from inside callbacks could return
   * the WRONG utterance when two `narrator.speak()` calls overlap
   * (the second call's synchronous `controller.start` clobbers the
   * first's id before the first's audio has finished playing).
   */
  meta?: unknown;
}

export interface TtsEngine {
  /**
   * Enqueue `line` for narration. Resolves when the line has been
   * spoken (or queued if a previous line is still playing).
   *
   * Implementations must never throw — TTS failures should be logged
   * and dropped rather than crashing the lifecycle loop.
   */
  say(line: string, opts?: SayOptions): Promise<void>;
  /** Drain the queue and shut down. */
  dispose(): Promise<void>;
}

/** Drops every line. Safe default for environments without TTS. */
export function nullEngine(): TtsEngine {
  return {
    async say() {},
    async dispose() {},
  };
}

/**
 * Engine that records lines into a caller-provided sink. Used by tests
 * and by the operator preview UI to capture the bot's narration log.
 *
 * The sink shape captures the full set of side-channel SayOptions
 * (priority, lengthScale, noiseScale, noiseW) so tests can assert the
 * narrator threads mood-derived prosody through to the engine without
 * standing up the Piper subprocess.
 */
export interface LoggingEngineEntry {
  line: string;
  priority: SayOptions["priority"];
  lengthScale: SayOptions["lengthScale"];
  noiseScale: SayOptions["noiseScale"];
  noiseW: SayOptions["noiseW"];
}

export function loggingEngine(sink: LoggingEngineEntry[] = []): TtsEngine & {
  log: LoggingEngineEntry[];
} {
  return {
    log: sink,
    async say(line, opts) {
      sink.push({
        line,
        priority: opts?.priority ?? "normal",
        lengthScale: opts?.lengthScale,
        noiseScale: opts?.noiseScale,
        noiseW: opts?.noiseW,
      });
    },
    async dispose() {},
  };
}
