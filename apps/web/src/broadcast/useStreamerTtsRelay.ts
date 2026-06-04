/**
 * useStreamerTtsRelay — bridges the sandbox-only `streamer:tts-envelope`
 * Socket.IO event into the broadcast overlay bus AND into a local
 * AudioContext queue so the listener can hear the TTS audio.
 *
 * The sandbox TTS diagnostic (POST /api/sandbox/tts/cycle-moods)
 * spawns a real Piper subprocess on the server, feeds it through the
 * production UtteranceController + PcmBatcher, and broadcasts every
 * resulting envelope on `STREAMER_BOT_TTS_ENVELOPE`. This hook is
 * the page-side bridge: every envelope is re-issued via
 * `window.postMessage({source:'pg-bot', kind, payload}, '*')` so the
 * existing overlayBus reducer and Avatar viseme classifier see the
 * envelopes via the EXACT same path the production runner drives them.
 *
 * For `tts.utterance.audio_batch` envelopes, the hook ALSO decodes
 * each base64 chunk and schedules it onto a single AudioContext so
 * the user can hear the audio in their browser. Production routes
 * audio through `aplay` -> Pulse -> ffmpeg -> RTMP; the sandbox
 * container has no audio device, so the browser plays the same PCM
 * the lipsync sees.
 *
 * Mount from BroadcastShell. No-op when `enabled === false`.
 */

import { useEffect } from "react";
import { SOCKET_EVENTS } from "@price-game/shared";
import { connectSocket } from "../api/socket";

/** Wire shape of one envelope on the socket. */
interface TtsEnvelope {
  kind: string;
  payload: unknown;
}

function isTtsEnvelope(v: unknown): v is TtsEnvelope {
  return !!v && typeof v === "object" && typeof (v as { kind?: unknown }).kind === "string";
}

/** PCM sample rate the sandbox emits at — must match piperEngine + aplay. */
const SAMPLE_RATE = 22050;

/**
 * Decode a base64-encoded little-endian S16 chunk into a Float32 audio
 * buffer. The lipsync path uses Int16; the AudioContext API wants
 * normalised Float32 in [-1, 1].
 */
function decodeChunk(b64: string): Float32Array | null {
  try {
    const bin = atob(b64);
    const len = bin.length;
    if (len === 0 || len % 2 !== 0) return null;
    const u8 = new Uint8Array(len);
    for (let i = 0; i < len; i++) u8[i] = bin.charCodeAt(i);
    const i16 = new Int16Array(u8.buffer, u8.byteOffset, len / 2);
    const f32 = new Float32Array(i16.length);
    for (let i = 0; i < i16.length; i++) f32[i] = i16[i] / 32768;
    return f32;
  } catch {
    return null;
  }
}

/**
 * Audio scheduler — keeps a moving cursor on the AudioContext
 * timeline so successive chunks play contiguously without gaps. New
 * chunks always anchor at `Math.max(now+epsilon, cursor)` so a stall
 * in chunk arrivals doesn't cause overlap with the next chunk after
 * the stall. Cursor is reset between utterances by `resetSchedule`.
 */
interface Scheduler {
  enqueue: (samples: Float32Array) => void;
  reset: () => void;
  close: () => void;
}

function createScheduler(): Scheduler | null {
  if (typeof window === "undefined") return null;
  const Ctor: typeof AudioContext | undefined =
    window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  const ctx = new Ctor({ sampleRate: SAMPLE_RATE });
  // Resume happens on first user gesture; the on-page button click
  // satisfies that, so by the time chunks arrive the context is live.
  void ctx.resume().catch(() => {});
  let cursor = 0;
  return {
    enqueue(samples) {
      const buf = ctx.createBuffer(1, samples.length, SAMPLE_RATE);
      buf.getChannelData(0).set(samples);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);
      // 30ms anchor for the very first chunk so the start doesn't fall
      // in the past (audio API silently rounds up but loses a tiny
      // bit of head). After that, stitch contiguously.
      const startAt = cursor === 0 ? ctx.currentTime + 0.03 : Math.max(cursor, ctx.currentTime + 0.005);
      src.start(startAt);
      cursor = startAt + samples.length / SAMPLE_RATE;
    },
    reset() {
      cursor = 0;
    },
    close() {
      // Release the AudioContext so a remount (HMR, route change)
      // doesn't leak a handle. close() returns a Promise that resolves
      // when the context's resources are released; the cleanup is
      // best-effort so we swallow any rejection.
      void ctx.close().catch(() => {});
    },
  };
}

/**
 * Wire the broadcast page to the sandbox TTS relay.
 *
 * @param enabled Pass `false` to keep the hook a no-op outside
 *                broadcast mode. Cheap when enabled.
 */
export function useStreamerTtsRelay(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    if (typeof window === "undefined") return;

    const scheduler = createScheduler();
    const socket = connectSocket();

    function onEnvelope(raw: unknown): void {
      if (!isTtsEnvelope(raw)) return;
      const env = raw;

      // Audio playback: decode every chunk in audio_batch and queue.
      // Mouth animation is independent — handled by the postMessage
      // re-dispatch below (overlayBus reducer + Avatar listener).
      if (env.kind === "tts.utterance.audio_batch") {
        const p = env.payload as { chunks?: unknown } | undefined;
        if (p && Array.isArray(p.chunks)) {
          // Defence-in-depth cap: server pins each batch at
          // PCM_BATCH_SIZE = 5 chunks; cap here at 4× that as a
          // bound against a forged socket emit (or future server
          // tuning) that ships an oversized batch into the audio
          // scheduler. Mirrors the page-side
          // PCM_BATCH_MAX_CHUNKS = 50 cap in overlayBus.ts.
          const PCM_BATCH_MAX_CHUNKS = 50;
          const chunks = p.chunks.length > PCM_BATCH_MAX_CHUNKS
            ? p.chunks.slice(0, PCM_BATCH_MAX_CHUNKS)
            : p.chunks;
          for (const c of chunks) {
            if (!c || typeof c !== "object") continue;
            const samplesB64 = (c as { samples?: unknown }).samples;
            if (typeof samplesB64 !== "string") continue;
            const f32 = decodeChunk(samplesB64);
            if (f32 && scheduler) scheduler.enqueue(f32);
          }
        }
      } else if (env.kind === "tts.utterance.start") {
        // New utterance — reset the audio cursor so any previous
        // utterance's tail can't bleed into the new one's head.
        if (scheduler) scheduler.reset();
      }

      // Production-path re-dispatch: fire the canonical postMessage
      // envelope so overlayBus + Avatar process it identically to a
      // runner-injected envelope.
      window.postMessage({ source: "pg-bot", kind: env.kind, payload: env.payload }, "*");
    }

    socket.on(SOCKET_EVENTS.STREAMER_BOT_TTS_ENVELOPE, onEnvelope);
    return () => {
      socket.off(SOCKET_EVENTS.STREAMER_BOT_TTS_ENVELOPE, onEnvelope);
      // Release the AudioContext so a remount (HMR / route change)
      // doesn't accumulate handles. Best-effort — close() rejects
      // are swallowed inside scheduler.close.
      if (scheduler) scheduler.close();
    };
  }, [enabled]);
}
