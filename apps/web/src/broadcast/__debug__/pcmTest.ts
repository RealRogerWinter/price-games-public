/**
 * Lipsync diagnostic — triggers the sandbox-only TTS cycle that
 * spawns real Piper subprocesses on the server (one per Mood), runs
 * each through the production UtteranceController + PcmBatcher, and
 * fans out every envelope via Socket.IO. The relay hook
 * (`useStreamerTtsRelay`) re-issues each envelope as a postMessage
 * so the overlay reducer + Avatar viseme classifier exercise the
 * EXACT code path the production runner drives — including
 * real-time PCM batching cadence, real Piper spectral content, and
 * mood-driven prosody (lengthScale per `MOOD_REGISTRY`).
 *
 * Activated by `?broadcast=1&pcmtest=1`. Two buttons:
 *   - "Real TTS — cycle moods"   → hits POST /api/sandbox/tts/cycle-moods
 *   - "Web Speech TTS"          → browser-side speechSynthesis
 *                                  fallback (kept for environments
 *                                  without sandbox piper).
 *
 * Both buttons require a click for the AudioContext to leave its
 * autoplay-blocked state — the click satisfies the user-gesture
 * requirement for both `useStreamerTtsRelay`'s scheduler and the
 * SpeechSynthesisUtterance below.
 */

const SAMPLE_RATE = 22050;
const CHUNK_SAMPLES = 882; // 1764 bytes = 40ms at 22050 Hz.
const CHUNK_INTERVAL_MS = 40;

/** Encode an Int16Array as base64 the same way the runner does. */
function encodeBase64(samples: Int16Array): string {
  const u8 = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
  let bin = "";
  for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
  return btoa(bin);
}

/** Post one envelope through the same path the runner uses. */
function post(kind: string, payload: unknown): void {
  window.postMessage({ source: "pg-bot", kind, payload }, "*");
}

/**
 * Trigger the per-mood sandbox TTS cycle. The HTTP request returns
 * immediately ({ok: true, status: "started"}) — the actual lipsync
 * envelopes flow over Socket.IO and are bridged to the page by
 * `useStreamerTtsRelay`. Resolves once the request returns; the user
 * watches the mouth animate and hears the audio while the server
 * works through the 8 moods (~30-45s total depending on prosody).
 */
export async function runPcmTest(): Promise<void> {
  // eslint-disable-next-line no-console
  console.log(`[pcm-test] POST /api/sandbox/tts/cycle-moods`);
  try {
    const res = await fetch("/api/sandbox/tts/cycle-moods", {
      method: "POST",
      credentials: "same-origin",
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      // eslint-disable-next-line no-console
      console.warn(`[pcm-test] cycle request failed: ${res.status} ${JSON.stringify(body)}`);
      if (res.status === 429) {
        alert("A mood cycle is already running — wait for it to finish.");
      } else if (res.status === 404) {
        alert("Sandbox TTS endpoint not mounted — server must boot with SANDBOX=1.");
      } else {
        alert(`Cycle request failed: ${res.status}`);
      }
      return;
    }
    // eslint-disable-next-line no-console
    console.log(`[pcm-test] cycle started: ${JSON.stringify(body)}`);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[pcm-test] cycle request error:`, err);
    alert(`Cycle request failed: ${(err as Error).message}`);
  }
}

/**
 * Web Speech TTS variant. Uses the browser's built-in
 * `speechSynthesis` to actually speak a sample sentence aloud — used
 * as a fallback when the sandbox TTS endpoint isn't available (e.g.
 * production sandbox without piper). While the utterance plays, a
 * 25Hz timer simultaneously dispatches PCM chunks with speech-shaped
 * amplitude pulses synchronised on SpeechSynthesisUtterance
 * `boundary` events — each word boundary fires a fresh attack, so
 * the mouth aperture follows the audible speech rhythm.
 *
 * Resolves when the utterance finishes or the estimated duration
 * elapses (whichever comes first).
 */
const SPEECH_SAMPLE = "Hello stream! Welcome to Pricey's price game show. " +
  "Today we will guess prices on real products. " +
  "Let's see if you can beat the bot.";

export async function runSpeechTest(): Promise<void> {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) {
    // eslint-disable-next-line no-console
    console.log("[pcm-test] speechSynthesis unavailable; skipping speech test");
    return;
  }
  window.speechSynthesis.cancel();

  const utteranceId = `pcm-speech-${Date.now().toString(36)}`;
  let pulse = 0;
  let utteranceDone = false;
  let startEmitted = false;

  function emitStart() {
    if (startEmitted) return;
    startEmitted = true;
    post("tts.utterance.start", {
      id: utteranceId,
      text: SPEECH_SAMPLE,
      intent: "manual",
      mood: "neutral",
      estimatedDurationMs: 8000,
      at: Date.now(),
    });
    post("tts.utterance.audio_started", { id: utteranceId, at: Date.now() });
  }

  const utter = new SpeechSynthesisUtterance(SPEECH_SAMPLE);
  utter.rate = 0.95;
  utter.pitch = 1.0;
  utter.volume = 1.0;
  utter.onstart = () => emitStart();
  utter.onend = () => {
    utteranceDone = true;
  };
  utter.onerror = () => {
    utteranceDone = true;
  };
  utter.onboundary = (ev: SpeechSynthesisEvent) => {
    if (ev.name === "word") {
      pulse = 0.7 + Math.random() * 0.3;
    }
  };

  // eslint-disable-next-line no-console
  console.log(`[pcm-test] speech start: "${SPEECH_SAMPLE}"`);
  window.speechSynthesis.speak(utter);

  const startedAt = Date.now();
  const MAX_DURATION_MS = 12_000;
  let phaseSampleOffset = 0;
  while (!utteranceDone && Date.now() - startedAt < MAX_DURATION_MS) {
    if (!startEmitted) emitStart();
    const samples = buildSpeechChunk(pulse, phaseSampleOffset);
    phaseSampleOffset += CHUNK_SAMPLES;
    post("tts.utterance.audio_batch", {
      id: utteranceId,
      sampleRate: SAMPLE_RATE,
      chunks: [{ samples: encodeBase64(samples), ts: Date.now() }],
    });
    const SPEECH_BASELINE = 0.25;
    pulse = SPEECH_BASELINE + (pulse - SPEECH_BASELINE) * 0.85;
    await new Promise((r) => setTimeout(r, CHUNK_INTERVAL_MS));
  }
  post("tts.utterance.audio_ended", { id: utteranceId, at: Date.now() });
  // eslint-disable-next-line no-console
  console.log("[pcm-test] speech done");
}

/**
 * Build an Int16 chunk whose amplitude approximates `loudness` (a
 * 0..1 envelope value). Uses a 3-formant vowel waveform but scales
 * peak amplitude by `loudness`. Result fed into the Avatar's RMS
 * envelope follower produces a mouth aperture roughly equal to
 * `loudness`.
 */
function buildSpeechChunk(loudness: number, phaseSampleOffset: number): Int16Array {
  const out = new Int16Array(CHUNK_SAMPLES);
  if (loudness < 0.02) return out;
  const F = [220, 440, 660];
  const peak = 16000 * loudness;
  for (let i = 0; i < CHUNK_SAMPLES; i++) {
    const t = (phaseSampleOffset + i) / SAMPLE_RATE;
    let s = 0;
    for (const f of F) s += Math.sin(2 * Math.PI * f * t);
    s = (s / F.length) * 0.6 + (Math.random() - 0.5) * 0.2;
    out[i] = Math.round(s * peak);
  }
  return out;
}
