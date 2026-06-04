import { useEffect, useRef, useState } from "react";
import { useSound } from "../../audio/SoundContext";

interface AutoLobbyCountdownProps {
  /** ISO timestamp when the round will start. The component is silent when this is missing. */
  targetAt?: string;
  /** How many real humans are seated; affects the headline copy. */
  humanCount: number;
  /** Test override — defaults to Date.now(). */
  nowProvider?: () => number;
}

function formatMMSS(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, "0")}`;
}

/**
 * Pre-game countdown banner shown in the lobby waiting room when the room
 * is an auto-lobby and the first real human has joined.
 *
 * Renders nothing when `targetAt` is absent (real lobbies / auto-lobbies
 * before the first human walks in). Updates four times per second so the
 * MM:SS display flips cleanly on the second boundary. Honors
 * `prefers-reduced-motion` via the CSS class. Announces via role=status.
 *
 * Visual styling lives in `.auto-lobby-countdown` in `index.css` so the
 * banner picks up the dark-navy lobby palette instead of a generic white
 * card.
 */
export default function AutoLobbyCountdown({
  targetAt,
  humanCount,
  nowProvider,
}: AutoLobbyCountdownProps): JSX.Element | null {
  const now = nowProvider ?? (() => Date.now());
  const { play } = useSound();
  const [secondsLeft, setSecondsLeft] = useState<number>(() =>
    targetAt ? Math.max(0, (new Date(targetAt).getTime() - now()) / 1000) : 0,
  );
  // Capture the original total when targetAt is first observed (or changes)
  // so the progress bar uses a stable denominator.
  const [totalSeconds, setTotalSeconds] = useState<number>(() =>
    targetAt ? Math.max(1, (new Date(targetAt).getTime() - now()) / 1000) : 1,
  );
  // Sound state — track the last whole-second tick we emitted, whether
  // we've fired the one-shot start cue, and whether the urgency cue
  // (`timer_critical`) has fired. Refs (not state) so they don't
  // trigger re-renders, and so the 4-Hz polling interval can read+write
  // them without races.
  const lastTickSecondRef = useRef<number | null>(null);
  const startFiredRef = useRef(false);
  const criticalFiredRef = useRef(false);

  useEffect(() => {
    if (!targetAt) return;
    const target = new Date(targetAt).getTime();
    const initialRemaining = Math.max(0, (target - now()) / 1000);
    setSecondsLeft(initialRemaining);
    setTotalSeconds(Math.max(1, initialRemaining));
    // Reset sound dedup refs whenever the target shifts (new countdown).
    lastTickSecondRef.current = null;
    startFiredRef.current = false;
    criticalFiredRef.current = false;
    const id = setInterval(() => {
      const remaining = Math.max(0, (target - now()) / 1000);
      setSecondsLeft(remaining);
      if (remaining <= 0) clearInterval(id);
    }, 250);
    return () => clearInterval(id);
  }, [targetAt, now]);

  // Audio cues: tick on each integer-second crossing in the last 5s,
  // then a one-shot launch cue at 0. Guarded so the 250ms poll fires
  // each cue at most once per second.
  useEffect(() => {
    if (!targetAt) return;
    if (secondsLeft <= 0) {
      if (!startFiredRef.current) {
        startFiredRef.current = true;
        play("round_start");
      }
      return;
    }
    if (secondsLeft <= 5) {
      const wholeSecond = Math.ceil(secondsLeft);
      if (lastTickSecondRef.current !== wholeSecond) {
        lastTickSecondRef.current = wholeSecond;
        // Slightly louder ticks at <=3s. Fire the attention-grabbing
        // `timer_critical` cue on the first whole-second that lands in
        // the urgent window — usually 5, but on a late mount (page
        // wake, late join, route change) the component might first see
        // secondsLeft already at 4 or 3, so guard on the cumulative
        // ref instead of `=== 5`.
        const isCritical = secondsLeft <= 3;
        play("timer_tick", { volume: isCritical ? 0.7 : 0.5 });
        if (!criticalFiredRef.current) {
          criticalFiredRef.current = true;
          play("timer_critical");
        }
      }
    }
  }, [secondsLeft, targetAt, play]);

  if (!targetAt) return null;

  const display = formatMMSS(secondsLeft);
  const isUrgent = secondsLeft <= 5 && secondsLeft > 0;

  let copy: string;
  if (secondsLeft <= 0) {
    copy = "Starting now…";
  } else if (isUrgent) {
    copy = "Get ready!";
  } else if (humanCount <= 1) {
    copy = "Waiting for more players…";
  } else {
    copy = "Starting in";
  }

  const fraction = Math.max(0, Math.min(1, secondsLeft / totalSeconds));

  return (
    <div
      className={`auto-lobby-countdown${isUrgent ? " auto-lobby-countdown--urgent" : ""}`}
      role="status"
    >
      <div className="auto-lobby-countdown__row">
        <span className="auto-lobby-countdown__copy">{copy}</span>
        <span className="auto-lobby-countdown__time">{display}</span>
      </div>
      <div
        className="auto-lobby-countdown__bar"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={Math.ceil(totalSeconds)}
        aria-valuenow={Math.ceil(secondsLeft)}
        aria-label="Pre-game countdown"
      >
        <div
          className="auto-lobby-countdown__fill"
          style={{ width: `${fraction * 100}%` }}
        />
      </div>
    </div>
  );
}
