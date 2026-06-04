import { useEffect, useRef } from "react";

const BAR_COUNT = 32;
const FRAME_RATE_MS = 1000 / 30;

/**
 * Decorative audio visualizer. Renders 32 vertical bars driven by a
 * deterministic time-based wave so the broadcast doesn't look static
 * when no real audio is wired up yet.
 *
 * When a future PR exposes an AudioContext + AnalyserNode tied to the
 * music sink, this component will swap the synthetic wave for the live
 * frequency-bin reading. The drawing surface and bar count stay the same.
 *
 * The component is purely decorative (`aria-hidden`) and renders to a
 * canvas so it doesn't add layout cost during gameplay frames.
 */
export default function Visualizer() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let raf = 0;
    let last = 0;

    function draw(t: number) {
      if (t - last < FRAME_RATE_MS) {
        raf = requestAnimationFrame(draw);
        return;
      }
      last = t;
      const w = canvas!.width;
      const h = canvas!.height;
      ctx!.clearRect(0, 0, w, h);
      const barWidth = w / BAR_COUNT;
      const barGap = barWidth * 0.2;
      for (let i = 0; i < BAR_COUNT; i++) {
        // Synthetic wave: two sine components phase-shifted per bar.
        const phase = i * 0.35;
        const wave = Math.sin(t * 0.0025 + phase) * 0.5 + Math.sin(t * 0.004 + phase * 0.7) * 0.3;
        const amp = (wave + 1) / 2;
        const barHeight = Math.max(2, amp * h * 0.85);
        const y = h - barHeight;
        const hue = 200 + (i / BAR_COUNT) * 60;
        ctx!.fillStyle = `hsl(${hue}, 65%, 55%)`;
        ctx!.fillRect(i * barWidth + barGap / 2, y, barWidth - barGap, barHeight);
      }
      raf = requestAnimationFrame(draw);
    }

    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className="broadcast-visualizer"
      data-testid="broadcast-visualizer"
      width={320}
      height={80}
      aria-hidden="true"
    />
  );
}
