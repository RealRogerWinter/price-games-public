import type { SoundId } from "./types";
import { SOUND_REGISTRY } from "./sounds";

const STORAGE_KEY_VOLUME = "sound_volume";
const STORAGE_KEY_MUTED = "sound_muted";

/**
 * Singleton sound engine that manages the Web Audio API lifecycle,
 * plays procedural sound effects, and handles autoplay unlock, volume,
 * and mute state. Framework-agnostic — can be called from React hooks,
 * event handlers, or Socket.IO callbacks.
 */
class SoundEngine {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private unlocked = false;
  private muted: boolean;
  private volume: number;
  private activeSounds = new Map<SoundId, () => void>();
  private listeners = new Set<() => void>();
  private reducedMotionQuery: MediaQueryList | null = null;
  private cachedSnapshot: { volume: number; muted: boolean; unlocked: boolean };

  constructor() {
    this.volume = Math.max(0, Math.min(1, this.loadNumber(STORAGE_KEY_VOLUME, 0.8)));
    this.muted = this.loadBoolean(STORAGE_KEY_MUTED, false);
    this.cachedSnapshot = { volume: this.volume, muted: this.muted, unlocked: this.unlocked };
    if (typeof window !== "undefined" && window.matchMedia) {
      this.reducedMotionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    }
  }

  /** Unlock audio playback — must be called from a user gesture. */
  unlock(): void {
    if (this.unlocked) return;
    this.ensureContext();
    if (this.ctx && this.ctx.state === "suspended") {
      this.ctx.resume().catch(() => {});
    }
    // Play a silent buffer to fully warm iOS Safari's audio pipeline
    if (this.ctx) {
      const buf = this.ctx.createBuffer(1, 1, this.ctx.sampleRate);
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      src.connect(this.ctx.destination);
      src.start();
    }
    this.unlocked = true;
    this.notify();
  }

  /**
   * Play a sound effect by ID.
   *
   * @param id - the sound to play
   * @param options - optional per-play volume multiplier (0-1)
   */
  play(id: SoundId, options?: { volume?: number }): void {
    if (!this.shouldPlay()) return;
    this.ensureContext();
    if (!this.ctx || !this.masterGain) return;

    const def = SOUND_REGISTRY[id];
    if (!def) return;

    // For non-polyphonic sounds, stop the previous instance
    if (!def.polyphonic) {
      const existing = this.activeSounds.get(id);
      if (existing) {
        existing();
        this.activeSounds.delete(id);
      }
    }

    // Create a per-play gain node for volume adjustment (clamped to [0, 1])
    const playGain = this.ctx.createGain();
    const playVol = Math.max(0, Math.min(1, options?.volume ?? 1));
    playGain.gain.setValueAtTime(playVol, this.ctx.currentTime);
    playGain.connect(this.masterGain);

    const stopFn = def.play(this.ctx, playGain);
    if (stopFn) {
      this.activeSounds.set(id, stopFn);
    }
  }

  /** Stop a currently playing loopable sound. */
  stop(id: SoundId): void {
    const stopFn = this.activeSounds.get(id);
    if (stopFn) {
      stopFn();
      this.activeSounds.delete(id);
    }
  }

  /** Stop all currently playing sounds. */
  stopAll(): void {
    for (const stopFn of this.activeSounds.values()) {
      stopFn();
    }
    this.activeSounds.clear();
  }

  /** Set the master volume (0-1). Persisted to localStorage. */
  setVolume(v: number): void {
    this.volume = Math.max(0, Math.min(1, v));
    if (this.masterGain && this.ctx) {
      this.masterGain.gain.setValueAtTime(this.volume, this.ctx.currentTime);
    }
    this.saveValue(STORAGE_KEY_VOLUME, String(this.volume));
    this.notify();
  }

  /** Get the current master volume (0-1). */
  getVolume(): number {
    return this.volume;
  }

  /** Set the muted state. Persisted to localStorage. */
  setMuted(m: boolean): void {
    this.muted = m;
    if (this.masterGain && this.ctx) {
      this.masterGain.gain.setValueAtTime(
        m ? 0 : this.volume,
        this.ctx.currentTime
      );
    }
    this.saveValue(STORAGE_KEY_MUTED, String(m));
    this.notify();
  }

  /** Check if sound is currently muted. */
  isMuted(): boolean {
    return this.muted;
  }

  /** Check if the audio context has been unlocked by user interaction. */
  isUnlocked(): boolean {
    return this.unlocked;
  }

  /**
   * Subscribe to state changes (volume, mute, unlock).
   * Returns an unsubscribe function. Used by React's useSyncExternalStore.
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Snapshot of current state for useSyncExternalStore. Returns a cached
   * object reference that only changes when state actually changes, so
   * React's Object.is comparison works correctly.
   */
  getSnapshot(): { volume: number; muted: boolean; unlocked: boolean } {
    return this.cachedSnapshot;
  }

  // --- Private ---

  private shouldPlay(): boolean {
    if (this.muted) return false;
    if (!this.unlocked) return false;
    // Respect prefers-reduced-motion unless user explicitly unmuted
    if (this.reducedMotionQuery?.matches && !this.hasExplicitMuteSetting()) {
      return false;
    }
    return true;
  }

  private hasExplicitMuteSetting(): boolean {
    try {
      return localStorage.getItem(STORAGE_KEY_MUTED) !== null;
    } catch {
      return false;
    }
  }

  private ensureContext(): void {
    if (this.ctx) return;
    try {
      this.ctx = new AudioContext();
      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.setValueAtTime(
        this.muted ? 0 : this.volume,
        this.ctx.currentTime
      );
      this.masterGain.connect(this.ctx.destination);
    } catch {
      // Web Audio API not available
    }
  }

  private notify(): void {
    // Rebuild snapshot so useSyncExternalStore detects the change
    this.cachedSnapshot = { volume: this.volume, muted: this.muted, unlocked: this.unlocked };
    for (const listener of this.listeners) {
      listener();
    }
  }

  private loadNumber(key: string, fallback: number): number {
    try {
      const val = localStorage.getItem(key);
      if (val !== null) {
        const n = parseFloat(val);
        return isNaN(n) ? fallback : n;
      }
    } catch {
      // localStorage not available
    }
    return fallback;
  }

  private loadBoolean(key: string, fallback: boolean): boolean {
    try {
      const val = localStorage.getItem(key);
      if (val !== null) return val === "true";
    } catch {
      // localStorage not available
    }
    return fallback;
  }

  private saveValue(key: string, value: string): void {
    try {
      localStorage.setItem(key, value);
    } catch {
      // localStorage not available
    }
  }
}

/** Global singleton instance. Import this directly in hooks and callbacks. */
export const soundEngine = new SoundEngine();
