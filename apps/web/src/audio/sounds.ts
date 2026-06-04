import type { SoundId, SoundDefinition } from "./types";

/**
 * Helper: create a gain node with a short envelope to avoid clicks.
 * Ramps up over attackMs, sustains, then ramps down over releaseMs.
 */
function envelope(
  ctx: AudioContext,
  destination: AudioNode,
  volume: number,
  startTime: number,
  duration: number,
  attackMs = 5,
  releaseMs = 15
): GainNode {
  const gain = ctx.createGain();
  gain.connect(destination);
  const attack = Math.min(attackMs / 1000, duration * 0.4);
  const release = Math.min(releaseMs / 1000, duration * 0.4);
  gain.gain.setValueAtTime(0, startTime);
  gain.gain.linearRampToValueAtTime(volume, startTime + attack);
  gain.gain.setValueAtTime(volume, startTime + duration - release);
  gain.gain.linearRampToValueAtTime(0, startTime + duration);
  return gain;
}

/** Helper: play a single oscillator tone with envelope. */
function tone(
  ctx: AudioContext,
  destination: AudioNode,
  freq: number,
  type: OscillatorType,
  volume: number,
  startTime: number,
  duration: number
): OscillatorNode {
  const gain = envelope(ctx, destination, volume, startTime, duration);
  const osc = ctx.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, startTime);
  osc.connect(gain);
  osc.start(startTime);
  osc.stop(startTime + duration);
  return osc;
}

/** Helper: play a frequency-ramping tone. */
function rampTone(
  ctx: AudioContext,
  destination: AudioNode,
  freqStart: number,
  freqEnd: number,
  type: OscillatorType,
  volume: number,
  startTime: number,
  duration: number
): OscillatorNode {
  const gain = envelope(ctx, destination, volume, startTime, duration);
  const osc = ctx.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(freqStart, startTime);
  osc.frequency.linearRampToValueAtTime(freqEnd, startTime + duration);
  osc.connect(gain);
  osc.start(startTime);
  osc.stop(startTime + duration);
  return osc;
}

/** Musical note frequencies (A4 = 440Hz, equal temperament). */
const NOTE = {
  C4: 261.63,
  D4: 293.66,
  E4: 329.63,
  F4: 349.23,
  G4: 392.0,
  A4: 440.0,
  B4: 493.88,
  C5: 523.25,
  D5: 587.33,
  E5: 659.25,
  G5: 783.99,
} as const;

/**
 * Registry of all placeholder sound effects. Each entry defines how to
 * synthesize the sound using Web Audio API oscillators and gain nodes.
 * These are designed to be replaced with real audio assets later.
 */
export const SOUND_REGISTRY: Record<SoundId, SoundDefinition> = {
  // --- Core Gameplay ---

  timer_tick: {
    polyphonic: true,
    play(ctx, dest) {
      const t = ctx.currentTime;
      tone(ctx, dest, 800, "sine", 0.08, t, 0.03);
    },
  },

  timer_urgent: {
    play(ctx, dest) {
      const t = ctx.currentTime;
      rampTone(ctx, dest, 600, 400, "sine", 0.15, t, 0.15);
    },
  },

  timer_critical: {
    play(ctx, dest) {
      const t = ctx.currentTime;
      rampTone(ctx, dest, 800, 600, "square", 0.12, t, 0.1);
    },
  },

  timer_expire: {
    play(ctx, dest) {
      const t = ctx.currentTime;
      rampTone(ctx, dest, 250, 150, "square", 0.2, t, 0.5);
    },
  },

  guess_submit: {
    play(ctx, dest) {
      const t = ctx.currentTime;
      tone(ctx, dest, 1200, "sine", 0.15, t, 0.05);
      tone(ctx, dest, 1600, "sine", 0.1, t + 0.03, 0.04);
    },
  },

  round_start: {
    play(ctx, dest) {
      const t = ctx.currentTime;
      const notes = [NOTE.C4, NOTE.E4, NOTE.G4];
      notes.forEach((freq, i) => {
        tone(ctx, dest, freq, "sine", 0.12, t + i * 0.1, 0.15);
      });
    },
  },

  result_exact: {
    play(ctx, dest) {
      const t = ctx.currentTime;
      const notes = [NOTE.C4, NOTE.E4, NOTE.G4, NOTE.C5];
      notes.forEach((freq, i) => {
        tone(ctx, dest, freq, "sine", 0.15, t + i * 0.1, 0.2);
      });
      // Bonus shimmer
      tone(ctx, dest, NOTE.E5, "sine", 0.08, t + 0.4, 0.3);
    },
  },

  result_great: {
    play(ctx, dest) {
      const t = ctx.currentTime;
      tone(ctx, dest, NOTE.C4, "sine", 0.13, t, 0.3);
      tone(ctx, dest, NOTE.E4, "sine", 0.13, t, 0.3);
      tone(ctx, dest, NOTE.G4, "sine", 0.13, t, 0.3);
    },
  },

  result_good: {
    play(ctx, dest) {
      const t = ctx.currentTime;
      tone(ctx, dest, NOTE.C4, "triangle", 0.12, t, 0.2);
      tone(ctx, dest, NOTE.E4, "triangle", 0.12, t, 0.2);
    },
  },

  result_poor: {
    play(ctx, dest) {
      const t = ctx.currentTime;
      rampTone(ctx, dest, NOTE.D4, NOTE.F4 * 0.8, "sawtooth", 0.1, t, 0.3);
    },
  },

  result_miss: {
    play(ctx, dest) {
      const t = ctx.currentTime;
      rampTone(ctx, dest, 180, 120, "square", 0.15, t, 0.4);
    },
  },

  confetti: {
    play(ctx, dest) {
      const t = ctx.currentTime;
      for (let i = 0; i < 10; i++) {
        const freq = 1200 + Math.random() * 800;
        tone(ctx, dest, freq, "sine", 0.06, t + i * 0.06, 0.05);
      }
    },
  },

  score_counting: {
    polyphonic: true,
    play(ctx, dest) {
      const t = ctx.currentTime;
      tone(ctx, dest, 1000, "sine", 0.05, t, 0.02);
    },
  },

  next_round: {
    play(ctx, dest) {
      const t = ctx.currentTime;
      tone(ctx, dest, NOTE.G4, "sine", 0.12, t, 0.12);
      tone(ctx, dest, NOTE.C5, "sine", 0.12, t + 0.1, 0.15);
    },
  },

  game_over: {
    play(ctx, dest) {
      const t = ctx.currentTime;
      const notes = [NOTE.C4, NOTE.E4, NOTE.G4, NOTE.C5];
      notes.forEach((freq, i) => {
        tone(ctx, dest, freq, "sine", 0.14, t + i * 0.15, 0.25);
        tone(ctx, dest, freq * 2, "sine", 0.06, t + i * 0.15, 0.25);
      });
    },
  },

  // --- Multiplayer ---

  player_join: {
    play(ctx, dest) {
      const t = ctx.currentTime;
      tone(ctx, dest, NOTE.C5, "sine", 0.1, t, 0.1);
      tone(ctx, dest, NOTE.G5, "sine", 0.1, t + 0.08, 0.12);
    },
  },

  player_leave: {
    play(ctx, dest) {
      const t = ctx.currentTime;
      rampTone(ctx, dest, NOTE.G4, NOTE.C4, "sine", 0.08, t, 0.2);
    },
  },

  player_locked: {
    polyphonic: true,
    play(ctx, dest) {
      const t = ctx.currentTime;
      tone(ctx, dest, 1000, "sine", 0.08, t, 0.06);
    },
  },

  all_locked: {
    play(ctx, dest) {
      const t = ctx.currentTime;
      tone(ctx, dest, NOTE.C4, "sine", 0.1, t, 0.25);
      tone(ctx, dest, NOTE.E4, "sine", 0.1, t, 0.25);
      tone(ctx, dest, NOTE.G4, "sine", 0.1, t, 0.25);
      tone(ctx, dest, NOTE.C5, "sine", 0.08, t + 0.15, 0.15);
    },
  },

  round_end_mp: {
    play(ctx, dest) {
      const t = ctx.currentTime;
      tone(ctx, dest, NOTE.G4, "sine", 0.1, t, 0.15);
      tone(ctx, dest, NOTE.E4, "sine", 0.1, t + 0.1, 0.15);
      tone(ctx, dest, NOTE.C4, "sine", 0.12, t + 0.2, 0.2);
    },
  },

  // --- Bidding ---

  bidding_shuffle: {
    play(ctx, dest) {
      const t = ctx.currentTime;
      for (let i = 0; i < 6; i++) {
        const freq = i % 2 === 0 ? NOTE.E4 : NOTE.G4;
        tone(ctx, dest, freq, "sine", 0.08, t + i * 0.08, 0.06);
      }
    },
  },

  spotlight_activate: {
    play(ctx, dest) {
      const t = ctx.currentTime;
      rampTone(ctx, dest, NOTE.C4, NOTE.G4, "sine", 0.12, t, 0.2);
      rampTone(ctx, dest, NOTE.E4, NOTE.C5, "sine", 0.1, t + 0.1, 0.2);
    },
  },

  bid_reveal: {
    play(ctx, dest) {
      const t = ctx.currentTime;
      // Short noise burst via oscillator detuning
      tone(ctx, dest, NOTE.A4, "sine", 0.12, t, 0.08);
      tone(ctx, dest, NOTE.A4 * 1.5, "sine", 0.08, t + 0.02, 0.06);
      tone(ctx, dest, NOTE.E5, "sine", 0.1, t + 0.05, 0.1);
    },
  },

  bid_dock: {
    play(ctx, dest) {
      const t = ctx.currentTime;
      rampTone(ctx, dest, NOTE.G4, NOTE.C4, "triangle", 0.08, t, 0.15);
    },
  },

  // --- Mode-Specific ---

  riser_launch: {
    play(ctx, dest) {
      const t = ctx.currentTime;

      // Soft static crackle — lowpass-filtered noise fading in like a
      // TV tuning into the launch. Gentle, not harsh.
      const bufSize = ctx.sampleRate * 0.7;
      const buf = ctx.createBuffer(1, bufSize, ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < bufSize; i++) data[i] = Math.random() * 2 - 1;
      const noise = ctx.createBufferSource();
      noise.buffer = buf;
      const lp = ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.setValueAtTime(400, t);
      lp.frequency.linearRampToValueAtTime(1200, t + 0.6);
      const noiseGain = ctx.createGain();
      noiseGain.gain.setValueAtTime(0, t);
      noiseGain.gain.linearRampToValueAtTime(0.06, t + 0.15);
      noiseGain.gain.linearRampToValueAtTime(0.04, t + 0.7);
      noiseGain.connect(dest);
      noise.connect(lp);
      lp.connect(noiseGain);
      noise.start(t);
      noise.stop(t + 0.7);

      // Playful rising chime — game-show "here we go!" feel
      tone(ctx, dest, NOTE.C4, "sine", 0.07, t + 0.05, 0.12);
      tone(ctx, dest, NOTE.E4, "sine", 0.07, t + 0.15, 0.12);
      tone(ctx, dest, NOTE.G4, "sine", 0.08, t + 0.25, 0.15);
    },
  },

  riser_flying: {
    play(ctx, dest) {
      const t = ctx.currentTime;
      // Cozy rocket hum: soft filtered noise (like gentle static/wind)
      // layered with a warm sine drone. Sounds like a friendly spaceship
      // cruising — not aggressive, pleasant to listen to on loop.
      const masterGain = ctx.createGain();
      masterGain.gain.setValueAtTime(0, t);
      masterGain.gain.linearRampToValueAtTime(0.14, t + 0.3);
      masterGain.connect(dest);

      // Filtered white noise — the "static" rocket rumble
      const noiseLen = ctx.sampleRate * 2;
      const noiseBuf = ctx.createBuffer(1, noiseLen, ctx.sampleRate);
      const noiseData = noiseBuf.getChannelData(0);
      for (let i = 0; i < noiseLen; i++) noiseData[i] = Math.random() * 2 - 1;
      const noise = ctx.createBufferSource();
      noise.buffer = noiseBuf;
      noise.loop = true;
      const noiseLp = ctx.createBiquadFilter();
      noiseLp.type = "lowpass";
      noiseLp.frequency.setValueAtTime(500, t);
      // Slow filter sweep upward for building intensity
      noiseLp.frequency.linearRampToValueAtTime(900, t + 20);
      const noiseGain = ctx.createGain();
      noiseGain.gain.setValueAtTime(0.7, t);
      noise.connect(noiseLp);
      noiseLp.connect(noiseGain);
      noiseGain.connect(masterGain);

      // Warm sine hum — the tonal "engine" underneath
      const hum = ctx.createOscillator();
      hum.type = "sine";
      hum.frequency.setValueAtTime(90, t);
      hum.frequency.linearRampToValueAtTime(130, t + 20);
      const humGain = ctx.createGain();
      humGain.gain.setValueAtTime(0.6, t);
      hum.connect(humGain);
      humGain.connect(masterGain);

      // Gentle tremolo — very subtle pulsing, like a heartbeat
      const lfo = ctx.createOscillator();
      lfo.frequency.setValueAtTime(3, t);
      const lfoGain = ctx.createGain();
      lfoGain.gain.setValueAtTime(0.008, t);
      lfo.connect(lfoGain);
      lfoGain.connect(masterGain.gain);

      noise.start(t);
      hum.start(t);
      lfo.start(t);

      return () => {
        const now = ctx.currentTime;
        masterGain.gain.linearRampToValueAtTime(0, now + 0.12);
        setTimeout(() => {
          try { noise.stop(); } catch {}
          try { hum.stop(); } catch {}
          try { lfo.stop(); } catch {}
        }, 200);
      };
    },
  },

  riser_stop: {
    play(ctx, dest) {
      const t = ctx.currentTime;

      // Quick static burst that fades — like the signal cutting out
      const bufSize = ctx.sampleRate * 0.35;
      const buf = ctx.createBuffer(1, bufSize, ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < bufSize; i++) data[i] = Math.random() * 2 - 1;
      const noise = ctx.createBufferSource();
      noise.buffer = buf;
      const lp = ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.setValueAtTime(1000, t);
      lp.frequency.exponentialRampToValueAtTime(150, t + 0.3);
      const noiseGain = ctx.createGain();
      noiseGain.gain.setValueAtTime(0.06, t);
      noiseGain.gain.linearRampToValueAtTime(0, t + 0.35);
      noiseGain.connect(dest);
      noise.connect(lp);
      lp.connect(noiseGain);
      noise.start(t);
      noise.stop(t + 0.35);

      // Descending "powering down" tone — soft and round
      rampTone(ctx, dest, 250, 80, "sine", 0.07, t, 0.3);
    },
  },

  button_click: {
    polyphonic: true,
    play(ctx, dest) {
      const t = ctx.currentTime;
      tone(ctx, dest, 800, "sine", 0.08, t, 0.04);
    },
  },

  slider_tick: {
    polyphonic: true,
    play(ctx, dest) {
      const t = ctx.currentTime;
      tone(ctx, dest, 600, "sine", 0.04, t, 0.015);
    },
  },

  item_select: {
    polyphonic: true,
    play(ctx, dest) {
      const t = ctx.currentTime;
      tone(ctx, dest, NOTE.E4, "sine", 0.1, t, 0.06);
      tone(ctx, dest, NOTE.G4, "sine", 0.08, t + 0.04, 0.06);
    },
  },

  item_deselect: {
    polyphonic: true,
    play(ctx, dest) {
      const t = ctx.currentTime;
      tone(ctx, dest, NOTE.G4, "sine", 0.08, t, 0.05);
      tone(ctx, dest, NOTE.E4, "sine", 0.06, t + 0.03, 0.05);
    },
  },

  swap: {
    play(ctx, dest) {
      const t = ctx.currentTime;
      rampTone(ctx, dest, NOTE.C4, NOTE.G4, "triangle", 0.08, t, 0.1);
      rampTone(ctx, dest, NOTE.G4, NOTE.C4, "triangle", 0.08, t + 0.05, 0.1);
    },
  },

  chain_link: {
    polyphonic: true,
    play(ctx, dest) {
      const t = ctx.currentTime;
      tone(ctx, dest, NOTE.C5, "sine", 0.1, t, 0.08);
    },
  },

  correct: {
    play(ctx, dest) {
      const t = ctx.currentTime;
      tone(ctx, dest, NOTE.C4, "sine", 0.12, t, 0.15);
      tone(ctx, dest, NOTE.E4, "sine", 0.12, t + 0.08, 0.15);
      tone(ctx, dest, NOTE.G4, "sine", 0.12, t + 0.16, 0.15);
    },
  },

  incorrect: {
    play(ctx, dest) {
      const t = ctx.currentTime;
      rampTone(ctx, dest, 300, 200, "square", 0.1, t, 0.25);
    },
  },
};
