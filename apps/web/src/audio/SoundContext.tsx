import React, { createContext, useContext, useEffect, useSyncExternalStore, useCallback } from "react";
import type { SoundId } from "./types";
import { soundEngine } from "./SoundEngine";

interface SoundContextType {
  /** Play a sound effect by ID. */
  play: (id: SoundId, options?: { volume?: number }) => void;
  /** Stop a loopable sound by ID. */
  stop: (id: SoundId) => void;
  /** Stop all currently playing sounds. */
  stopAll: () => void;
  /** Master volume (0-1). */
  volume: number;
  /** Set master volume (0-1). */
  setVolume: (v: number) => void;
  /** Whether sound is muted. */
  muted: boolean;
  /** Toggle mute state. */
  setMuted: (m: boolean) => void;
  /** Whether audio has been unlocked by user interaction. */
  unlocked: boolean;
}

const SoundContext = createContext<SoundContextType | undefined>(undefined);

/**
 * Provider that wraps the app to enable sound effects. Handles
 * autoplay unlock on first user interaction and provides reactive
 * state for settings UI via useSyncExternalStore.
 */
export function SoundProvider({ children }: { children: React.ReactNode }) {
  // Sync React state with the singleton engine
  const snapshot = useSyncExternalStore(
    (cb) => soundEngine.subscribe(cb),
    () => soundEngine.getSnapshot()
  );

  // Autoplay unlock on first user gesture
  useEffect(() => {
    const unlock = () => {
      soundEngine.unlock();
      document.removeEventListener("click", unlock);
      document.removeEventListener("touchstart", unlock);
      document.removeEventListener("keydown", unlock);
    };
    document.addEventListener("click", unlock, { once: false });
    document.addEventListener("touchstart", unlock, { once: false });
    document.addEventListener("keydown", unlock, { once: false });
    return () => {
      document.removeEventListener("click", unlock);
      document.removeEventListener("touchstart", unlock);
      document.removeEventListener("keydown", unlock);
    };
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => soundEngine.stopAll();
  }, []);

  const play = useCallback(
    (id: SoundId, options?: { volume?: number }) => soundEngine.play(id, options),
    []
  );
  const stop = useCallback((id: SoundId) => soundEngine.stop(id), []);
  const stopAll = useCallback(() => soundEngine.stopAll(), []);
  const setVolume = useCallback((v: number) => soundEngine.setVolume(v), []);
  const setMuted = useCallback((m: boolean) => soundEngine.setMuted(m), []);

  const value: SoundContextType = {
    play,
    stop,
    stopAll,
    volume: snapshot.volume,
    setVolume,
    muted: snapshot.muted,
    setMuted,
    unlocked: snapshot.unlocked,
  };

  return (
    <SoundContext.Provider value={value}>
      {children}
    </SoundContext.Provider>
  );
}

/**
 * Hook to access the sound engine from any component.
 * Must be used within a SoundProvider.
 */
export function useSound(): SoundContextType {
  const context = useContext(SoundContext);
  if (context === undefined) {
    throw new Error("useSound must be used within a SoundProvider");
  }
  return context;
}
