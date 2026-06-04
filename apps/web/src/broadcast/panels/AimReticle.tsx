import { useEffect, useState } from "react";
import type { CursorAim } from "../state/overlayBus";

interface AimReticleProps {
  /** Latest aim envelope from the motion engine, or null. */
  aim: CursorAim | null;
}

/**
 * How long after `aim.at` the reticle stays visible. The aim event
 * is fired right before the cursor begins its motion path; the
 * reticle should outlive the path (typically 480ms) so viewers see
 * the click commit. 800ms covers the path + dwell + click.
 */
const RETICLE_LIFETIME_MS = 800;

/**
 * Telegraphs the bot's about-to-click target with a contracting
 * outline ring. Fired by `cursor.aim` from the motion engine, BEFORE
 * the cursor begins its path — so viewers see the bot's commit
 * before the click arrives. Helps comprehension on dense modes
 * (sort-it-out, comparison) where 4+ candidates are visible and
 * the cursor's destination would otherwise be ambiguous.
 *
 * Visual: a teal ring sized 1.4× the target's largest dimension,
 * contracting to 1.05× over 600ms (CSS transition). Stroke 3px,
 * opacity 0.85→0.45. Disposes after 800ms total.
 *
 * @param props.aim Latest aim envelope (null when no aim is active).
 */
export default function AimReticle({ aim }: AimReticleProps) {
  // Internal "expired" gate so the reticle doesn't linger after its
  // lifetime even if no new aim arrives. Driven by setTimeout so we
  // don't need to poll.
  const [expired, setExpired] = useState(true);

  useEffect(() => {
    if (!aim) {
      setExpired(true);
      return;
    }
    setExpired(false);
    const id = setTimeout(() => setExpired(true), RETICLE_LIFETIME_MS);
    return () => clearTimeout(id);
  }, [aim]);

  if (!aim || expired) return null;

  // Place the SVG so its viewport encompasses the 1.4× starting size
  // (so the contraction stays inside). Centre on the target's centre.
  const cx = aim.x + aim.width / 2;
  const cy = aim.y + aim.height / 2;
  const baseR = Math.max(aim.width, aim.height) / 2;
  const startR = baseR * 1.4;

  return (
    <svg
      className="broadcast-aim-reticle"
      data-testid="broadcast-aim-reticle"
      style={{
        position: "fixed",
        left: cx - startR - 8,
        top: cy - startR - 8,
        width: (startR + 8) * 2,
        height: (startR + 8) * 2,
        pointerEvents: "none",
        zIndex: 9050,
      }}
      viewBox={`-${startR + 8} -${startR + 8} ${(startR + 8) * 2} ${(startR + 8) * 2}`}
    >
      <circle
        cx={0}
        cy={0}
        r={startR}
        className="broadcast-aim-reticle-ring"
      />
    </svg>
  );
}
