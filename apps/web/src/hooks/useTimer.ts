import { useState, useEffect, useRef, useCallback } from "react";
import { useGamePause } from "../context/GamePauseContext";

export function useTimer(durationSeconds: number, onExpire: () => void) {
  const [secondsLeft, setSecondsLeft] = useState(durationSeconds);
  const [isRunning, setIsRunning] = useState(false);
  const onExpireRef = useRef(onExpire);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const { paused } = useGamePause();

  onExpireRef.current = onExpire;

  const start = useCallback(() => {
    setSecondsLeft(durationSeconds);
    setIsRunning(true);
  }, [durationSeconds]);

  const stop = useCallback(() => {
    setIsRunning(false);
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  const reset = useCallback(() => {
    stop();
    setSecondsLeft(durationSeconds);
  }, [durationSeconds, stop]);

  // The interval is gated on BOTH the caller's intent (`isRunning`) and the
  // global pause signal. When an overlay (auth modal, etc.) sets `paused`
  // mid-round the effect tears down the interval so the timer freezes; when
  // the overlay closes the effect re-runs and the interval restarts from the
  // current `secondsLeft`. This also covers the race where a page calls
  // `start()` while a modal is already open — the interval simply doesn't
  // start until the modal closes, and `secondsLeft` stays at full duration.
  useEffect(() => {
    if (!isRunning || paused) return;

    intervalRef.current = setInterval(() => {
      setSecondsLeft((prev) => {
        if (prev <= 1) {
          setIsRunning(false);
          if (intervalRef.current) clearInterval(intervalRef.current);
          onExpireRef.current();
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [isRunning, paused]);

  return { secondsLeft, isRunning, start, stop, reset };
}
