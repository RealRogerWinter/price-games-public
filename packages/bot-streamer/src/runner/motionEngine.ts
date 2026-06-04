/**
 * MotionEngine — drives the cursor along a planned humanlike path
 * before each click. Wires the dead `realism/mouse.ts:planMousePath()`
 * code into the actual Playwright page via `page.mouse.move()` per
 * waypoint, with explicit sleeps between for a consistent
 * one-waypoint-per-frame cadence at the stream's 30fps output.
 *
 * Why this exists:
 *  1. **Smooth visible motion.** Playwright's bare `target.hover()`
 *     teleports the cursor; the SVG fake-cursor tracking it tweens via
 *     a 60ms CSS transition that fights Playwright's `slowMo: 80` and
 *     produces a stuttery result. With per-waypoint moves we drive
 *     the cursor frame by frame and the page-side script paints each
 *     mousemove cleanly.
 *  2. **Single source of truth.** Playwright's auto-wait + element
 *     targeting still owns the click; the engine only prepends a
 *     visible motion path. Keeps correctness intact while gaining
 *     visual control.
 *
 * Owns the current cursor position (module-scoped state) so each
 * subsequent `moveAndClick` can compute a path from the last landing
 * point. Seeded to viewport centre on first action.
 */

import type { Locator, Page } from "playwright";
import { planMousePath } from "../realism/mouse";
import { jitterClickPoint } from "../realism/mouse";

export interface MotionEngineOptions {
  /** Optional sleep injection for deterministic tests. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Initial cursor position. Defaults to viewport centre (assumes 1920×1080;
   * the engine recovers on first move when the actual viewport differs).
   */
  initialPosition?: { x: number; y: number };
  /** Inject for deterministic tests. Default Math.random. */
  rng?: () => number;
  /**
   * Per-step waypoint cadence in milliseconds. Default 33ms (1 step per
   * 30fps stream frame). Tests can override to 0 for instant moves.
   */
  stepIntervalMs?: number;
  /**
   * Optional callback fired BEFORE the cursor starts its motion path.
   * The bounding box passed in is the target's box; consumers (B3's
   * AimReticle in apps/web) render a contracting ring at that
   * location so viewers see the bot's *commit* before the click
   * arrives. The reticle is the most legible "this is what's about
   * to be clicked" cue at 30fps.
   */
  onAim?: (target: { x: number; y: number; width: number; height: number }) => void;
}

export interface MoveAndClickOptions {
  /**
   * Hover dwell after the path completes, before the click fires.
   * Default 220ms — gives the encoder time to render the cursor's
   * arrival before the click animation flashes. Tests pass 0.
   */
  hoverMs?: number;
  /**
   * Forwarded to `locator.click({ position })`. Useful for clicking
   * a specific spot on a card (e.g. the title row to avoid an inner
   * image's onClick). When unset, Playwright clicks at element centre.
   */
  position?: { x: number; y: number };
  /**
   * Force the path to include an overshoot+correction. Used by the
   * uncertainty-driven double-take in the strategy layer.
   */
  forceOvershoot?: boolean;
}

export interface MotionEngine {
  /**
   * Move the cursor to `locator`'s bounding box centre via a planned
   * humanlike path, dwell briefly, then invoke `locator.click()`. The
   * fake-cursor SVG tracks each `mouse.move` via the page-side
   * `mousemove` listener and paints the motion smoothly on stream.
   */
  moveAndClick(page: Page, locator: Locator, options?: MoveAndClickOptions): Promise<void>;
  /** Read-only view of the engine's last-known cursor position. */
  getPosition(): { x: number; y: number };
  /**
   * Manually seed the cursor position. Used by IdleChoreographer (B7)
   * when an idle hop completes and the engine needs to know where the
   * cursor ended up.
   */
  setPosition(p: { x: number; y: number }): void;
}

const DEFAULT_HOVER_MS = 220;
const DEFAULT_STEP_INTERVAL_MS = 33;
const DEFAULT_VIEWPORT_CENTRE = { x: 960, y: 540 };

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Build a MotionEngine. One instance per driver session — the cursor
 * position is module-scoped within the engine so consecutive moves
 * compute paths from the last landing point.
 */
export function createMotionEngine(opts: MotionEngineOptions = {}): MotionEngine {
  const sleep = opts.sleep ?? defaultSleep;
  const rng = opts.rng ?? Math.random;
  const stepIntervalMs = opts.stepIntervalMs ?? DEFAULT_STEP_INTERVAL_MS;
  let position = { ...(opts.initialPosition ?? DEFAULT_VIEWPORT_CENTRE) };

  return {
    async moveAndClick(page: Page, locator: Locator, options: MoveAndClickOptions = {}): Promise<void> {
      const hoverMs = options.hoverMs ?? DEFAULT_HOVER_MS;
      // Scroll into view first so the path doesn't glide off-screen.
      // try/catch instead of `.catch()` so the call to a missing method
      // (e.g. on a fake-page in unit tests) is also tolerated.
      try { await locator.scrollIntoViewIfNeeded({ timeout: 5_000 }); } catch { /* best-effort */ }

      let box: { x: number; y: number; width: number; height: number } | null = null;
      try { box = await locator.boundingBox(); } catch { box = null; }
      // Fallback path: no bounding box (element scrolled out, hidden,
      // or the test fake doesn't implement boundingBox). Just hover +
      // click — Playwright's auto-wait handles visibility.
      if (!box || !page.mouse) {
        try { await locator.hover({ timeout: 10_000 }); } catch { /* best effort */ }
        await locator.click(options.position ? { position: options.position } : undefined);
        return;
      }

      // Aim event: surface the target bbox to the broadcast overlay
      // so the AimReticle component can telegraph the click before
      // the cursor arrives. Fired BEFORE the path so the reticle
      // contracts toward the cursor's eventual landing point.
      if (opts.onAim) {
        try { opts.onAim(box); } catch { /* best-effort, never block motion */ }
      }

      // Click target inside the bounding box. Either the caller-supplied
      // position (e.g. price-match's `.pm-product-title` already routes
      // through this — falls back to centre+jitter) or jittered centre.
      const targetX = options.position
        ? box.x + options.position.x
        : box.x + box.width / 2;
      const targetY = options.position
        ? box.y + options.position.y
        : box.y + box.height / 2;
      const jittered = options.position
        ? { x: targetX, y: targetY }
        : jitterClickPoint({ x: targetX, y: targetY }, { rng });

      const targetWidth = Math.max(1, Math.min(box.width, box.height));
      const waypoints = planMousePath(
        position,
        jittered,
        {
          rng,
          targetWidth,
          forceOvershoot: options.forceOvershoot,
        },
      );

      // Walk the path one waypoint per frame. `page.mouse.move(x, y)`
      // dispatches a CDP mousemove which the fake-cursor's
      // `addEventListener('mousemove')` listener intercepts and
      // repositions the SVG. At 33ms per step the encoder sees a
      // unique cursor frame for every emitted waypoint.
      for (const wp of waypoints) {
        await page.mouse.move(wp.x, wp.y);
        if (stepIntervalMs > 0) await sleep(stepIntervalMs);
      }

      // Update the engine's position to the final waypoint so the next
      // call computes its path from here.
      const last = waypoints[waypoints.length - 1] ?? jittered;
      position = { x: last.x, y: last.y };

      // Hover dwell — gives the encoder a beat to render the cursor's
      // arrival before the click animation fires.
      if (hoverMs > 0) await sleep(hoverMs);

      // Click. If the planner overshot the bounding box (rare but
      // possible on very small targets) or the layout shifted during
      // the path, Playwright's click() does its own re-scroll + retry
      // via auto-wait, so a final correction is implicit.
      await locator.click(options.position ? { position: options.position } : undefined);
    },
    getPosition(): { x: number; y: number } {
      return { ...position };
    },
    setPosition(p: { x: number; y: number }): void {
      position = { ...p };
    },
  };
}
