import { createContext, useCallback, useContext, useState, type ReactNode } from "react";

interface GamePauseContextValue {
  paused: boolean;
  /**
   * Reference-counted pause: each caller increments on mount and decrements
   * on unmount. The game stays paused until every caller has released, so
   * stacked overlays (e.g. auth modal opened while another modal was already
   * up) all participate cleanly.
   */
  pause: () => void;
  resume: () => void;
}

const GamePauseContext = createContext<GamePauseContextValue | null>(null);

const NOOP_PAUSE: GamePauseContextValue = {
  paused: false,
  pause: () => {},
  resume: () => {},
};

/**
 * Provides a global "is gameplay paused" signal that overlay UIs (auth
 * modal, future settings sheet, etc.) can flip on/off so the active round's
 * timer freezes while the player is interacting with the overlay. Without
 * this, opening the registration modal mid-round would let the timer expire
 * silently in the background and credit a $0 guess.
 */
export function GamePauseProvider({ children }: { children: ReactNode }) {
  const [pauseCount, setPauseCount] = useState(0);

  const pause = useCallback(() => setPauseCount((n) => n + 1), []);
  const resume = useCallback(() => setPauseCount((n) => Math.max(0, n - 1)), []);

  return (
    <GamePauseContext.Provider value={{ paused: pauseCount > 0, pause, resume }}>
      {children}
    </GamePauseContext.Provider>
  );
}

/**
 * Returns the current pause state and pause/resume controls. Returns a
 * harmless no-op default outside the provider so isolated tests and
 * non-game contexts don't have to mount the provider.
 */
export function useGamePause(): GamePauseContextValue {
  const ctx = useContext(GamePauseContext);
  // Return a stable singleton outside the provider so callers that subscribe
  // to `pause` / `resume` via effect deps don't re-fire on every render.
  return ctx ?? NOOP_PAUSE;
}
