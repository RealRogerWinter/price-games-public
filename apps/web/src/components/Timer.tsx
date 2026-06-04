import { useEffect, useRef } from "react";
import { ROUND_TIME_SECONDS } from "@price-game/shared";
import { useSound } from "../audio/SoundContext";

interface TimerProps {
  secondsLeft: number;
  isRunning: boolean;
  paused?: boolean;
}

export default function Timer({ secondsLeft, isRunning, paused }: TimerProps) {
  const { play } = useSound();
  const total = ROUND_TIME_SECONDS;
  const fraction = secondsLeft / total;
  const radius = 40;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference * (1 - fraction);
  const isUrgent = secondsLeft <= 10 && isRunning;
  const isCritical = secondsLeft <= 5 && isRunning;

  // Track previous state to fire sounds only on transitions
  const prevUrgentRef = useRef(false);
  const prevCriticalRef = useRef(false);

  useEffect(() => {
    if (!isRunning || paused) return;

    if (isCritical && !prevCriticalRef.current) {
      play("timer_critical");
    } else if (isUrgent && !prevUrgentRef.current) {
      play("timer_urgent");
    }

    // Tick sound during urgent/critical phase
    if (isCritical) {
      play("timer_tick", { volume: 0.6 });
    } else if (isUrgent) {
      play("timer_tick", { volume: 0.3 });
    }

    prevUrgentRef.current = isUrgent;
    prevCriticalRef.current = isCritical;
  }, [secondsLeft, isRunning, paused, isUrgent, isCritical, play]);

  const timerClasses = [
    "timer",
    paused ? "timer-paused" : "",
    isCritical ? "timer-critical" : isUrgent ? "timer-urgent" : "",
  ].filter(Boolean).join(" ");

  return (
    <div
      className={timerClasses}
      role="timer"
      aria-live="off"
      aria-label={`Timer: ${secondsLeft} seconds remaining`}
    >
      <svg className="timer-svg" viewBox="0 0 100 100">
        <circle
          className="timer-bg-circle"
          cx="50"
          cy="50"
          r={radius}
          fill="none"
          strokeWidth="6"
        />
        <circle
          className="timer-progress-circle"
          cx="50"
          cy="50"
          r={radius}
          fill="none"
          strokeWidth="6"
          strokeDasharray={circumference}
          strokeDashoffset={dashOffset}
          strokeLinecap="round"
          transform="rotate(-90 50 50)"
          style={{
            stroke: paused ? "#6b6b80" : isUrgent ? "#e23e57" : "#4ecca3",
            transition: "stroke-dashoffset 1s linear, stroke 0.3s ease",
          }}
        />
        {paused ? (
          <>
            <rect x="39" y="36" width="6" height="28" rx="2" fill="#6b6b80" />
            <rect x="55" y="36" width="6" height="28" rx="2" fill="#6b6b80" />
          </>
        ) : (
          <text
            x="50"
            y="50"
            textAnchor="middle"
            dominantBaseline="central"
            className={`timer-text ${isCritical ? "timer-text-critical" : isUrgent ? "timer-text-urgent" : ""}`}
            style={{ fill: isUrgent ? "#e23e57" : "#ffffff" }}
          >
            {secondsLeft}
          </text>
        )}
      </svg>
    </div>
  );
}
