import { useEffect, useState, useRef } from "react";

interface Particle {
  id: number;
  x: number;
  delay: number;
  duration: number;
  content: string;
  size: number;
}

function createConfetti(count: number): Particle[] {
  const emojis = ["🎉", "🥳", "✨", "💰", "🤑", "⭐", "🔥", "💵"];
  return Array.from({ length: count }, (_, i) => ({
    id: i,
    x: Math.random() * 100,
    delay: Math.random() * 0.6,
    duration: 1.5 + Math.random() * 1.5,
    content: emojis[Math.floor(Math.random() * emojis.length)],
    size: 18 + Math.random() * 16,
  }));
}

function createNegative(count: number): Particle[] {
  const emojis = ["😬", "💸", "📉", "🫠", "😅", "🙈", "❌", "👎"];
  return Array.from({ length: count }, (_, i) => ({
    id: i,
    x: Math.random() * 100,
    delay: Math.random() * 0.4,
    duration: 1.8 + Math.random() * 1.2,
    content: emojis[Math.floor(Math.random() * emojis.length)],
    size: 18 + Math.random() * 14,
  }));
}

interface ResultReactionProps {
  score: number;
  /** Threshold above which we show positive reaction. Default 400 (smooth curve shifts distribution lower). */
  goodThreshold?: number;
  /** Threshold below which we show negative reaction. Default 50. */
  badThreshold?: number;
}

export default function ResultReaction({
  score,
  goodThreshold = 400,
  badThreshold = 50,
}: ResultReactionProps) {
  const [showParticles, setShowParticles] = useState(false);
  const isGood = score >= goodThreshold;
  const isBad = score <= badThreshold;
  const isBig = score >= 850;

  const particlesRef = useRef<Particle[]>(
    isGood
      ? createConfetti(isBig ? 30 : 16)
      : isBad
      ? createNegative(12)
      : []
  );

  useEffect(() => {
    if (isGood || isBad) {
      setShowParticles(true);
      const timer = setTimeout(() => setShowParticles(false), 3000);
      return () => clearTimeout(timer);
    }
  }, [isGood, isBad]);

  if (!showParticles || particlesRef.current.length === 0) return null;

  return (
    <div className="reaction-container">
      {particlesRef.current.map((p) => (
        <div
          key={p.id}
          className={`reaction-particle ${isBad ? "reaction-negative" : ""}`}
          style={{
            left: `${p.x}%`,
            animationDelay: `${p.delay}s`,
            animationDuration: `${p.duration}s`,
            fontSize: `${p.size}px`,
          }}
        >
          {p.content}
        </div>
      ))}
    </div>
  );
}
