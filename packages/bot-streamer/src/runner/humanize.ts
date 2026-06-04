/**
 * Humanize helpers — make Playwright actions visible on stream.
 *
 * Two pieces are needed:
 *   1. A page-side script (`FAKE_CURSOR_INIT_SCRIPT`) that draws a
 *      DOM cursor following synthetic mouse events. Playwright sends
 *      events via CDP, which doesn't move the X11 cursor, so without
 *      a software cursor the stream never shows where the bot is
 *      looking. The injected cursor renders a small arrow at every
 *      mousemove.
 *   2. Wrappers (`humanClick`, `humanFill`) that introduce slower
 *      paths + hover delays so the eye can follow what the bot is
 *      doing.
 */

import type { Locator, Page } from "playwright";

/**
 * Init script that paints a fake mouse cursor on the page. Listens
 * for mousemove events on document and positions a fixed-position
 * div at the cursor coordinates. The cursor stays out of the way of
 * the page's own UI by using pointer-events: none.
 *
 * **No CSS `transition` on `transform`.** The MotionEngine drives
 * one `page.mouse.move()` per stream frame (~33ms cadence); a CSS
 * tween between events would re-trigger every frame and produce
 * stutter as each tween is interrupted before completing. With
 * `transition: none` the SVG snaps to each event — at 30fps that
 * reads as smooth, intentional motion.
 *
 * Click feedback is a three-layer composite:
 *  - Cursor press-down: `scale(0.85)` for 80ms then back to 1.0.
 *  - Click ripple: a sibling div animates `scale(0)→scale(2.5)` and
 *    `opacity 0.7→0` over 360ms then self-destructs.
 *  - Target outline flash: a 250ms yellow outline on the clicked
 *    element. The most legible cue at 30fps — confirms WHAT got
 *    clicked even when the cursor is small in the frame.
 */
export const FAKE_CURSOR_INIT_SCRIPT = `
  (function() {
    if (window.__pgBotCursorInjected) return;
    window.__pgBotCursorInjected = true;
    function install() {
      if (!document.body) {
        setTimeout(install, 16);
        return;
      }
      // One-time stylesheet for keyframes + class definitions. Cheaper
      // than re-setting inline styles on every event and keeps the
      // GPU compositor handling the animation.
      var style = document.createElement('style');
      style.textContent = [
        '@keyframes pgRipple { from { transform: translate(-50%,-50%) scale(0); opacity: 0.7; } ',
        '  to { transform: translate(-50%,-50%) scale(2.5); opacity: 0; } }',
        '#__pg-bot-cursor { transition: none; will-change: transform; }',
        '#__pg-bot-cursor.pressed { transform: var(--pg-cursor-pos) scale(0.85); transition: transform 80ms ease-out; }',
        '#__pg-bot-cursor.released { transform: var(--pg-cursor-pos) scale(1); transition: transform 100ms ease-out; }',
        '.__pg-ripple { position: fixed; width: 24px; height: 24px; border-radius: 50%; ',
        '  background: rgba(255,255,255,0.5); border: 2px solid white; pointer-events: none; ',
        '  z-index: 2147483646; animation: pgRipple 360ms ease-out forwards; }',
        '[data-pg-clicked] { outline: 3px solid #ffd400 !important; outline-offset: 4px !important; ',
        '  transition: outline 100ms ease-in !important; }',
      ].join('\\n');
      document.head.appendChild(style);

      var dot = document.createElement('div');
      dot.id = '__pg-bot-cursor';
      dot.style.cssText = [
        'position:fixed',
        'left:0',
        'top:0',
        'width:24px',
        'height:24px',
        'pointer-events:none',
        'z-index:2147483647',
        'transform:translate(-9999px,-9999px)',
        'background:transparent',
      ].join(';');
      dot.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">' +
        '<path d="M3 2 L3 18 L7 14 L10 21 L13 19 L10 12 L17 12 Z" ' +
        'fill="#ffffff" stroke="#000000" stroke-width="1.5" stroke-linejoin="round"/>' +
        '</svg>';
      document.body.appendChild(dot);
      function setPos(x, y) {
        dot.style.setProperty('--pg-cursor-pos', 'translate(' + x + 'px,' + y + 'px)');
        dot.style.transform = 'translate(' + x + 'px,' + y + 'px)';
      }
      document.addEventListener('mousemove', function(e) {
        setPos(e.clientX, e.clientY);
      }, true);
      document.addEventListener('mousedown', function(e) {
        setPos(e.clientX, e.clientY);
        // 1. Cursor press-down via class swap (GPU-accelerated).
        dot.classList.remove('released');
        dot.classList.add('pressed');
        // 2. Click ripple: spawn a sibling div at click coords that
        //    self-destructs after the animation.
        var ripple = document.createElement('div');
        ripple.className = '__pg-ripple';
        ripple.style.left = e.clientX + 'px';
        ripple.style.top = e.clientY + 'px';
        document.body.appendChild(ripple);
        setTimeout(function() { ripple.remove(); }, 380);
        // 3. Target outline flash — most legible click cue at 30fps.
        var target = e.target;
        if (target && target.setAttribute) {
          target.setAttribute('data-pg-clicked', '1');
          setTimeout(function() {
            try { target.removeAttribute('data-pg-clicked'); } catch (_e) { /* node may have detached */ }
          }, 250);
        }
      }, true);
      document.addEventListener('mouseup', function() {
        dot.classList.remove('pressed');
        dot.classList.add('released');
        setTimeout(function() { dot.classList.remove('released'); }, 120);
      }, true);
    }
    install();
  })();
`;

/**
 * Click `locator`, but first move the cursor through visible
 * waypoints and hover briefly so the action reads on stream. Falls
 * back to a plain click if the bounding box can't be read (e.g.
 * the element scrolled out of view).
 *
 * @param page Playwright Page (real, not the abstract PageLike).
 * @param locator Playwright Locator for the click target.
 * @param options.position Optional click position relative to the
 *                         element (passed to Playwright's click()).
 *                         Forwarded so price-match's "click below
 *                         the image" trick still works.
 */
export async function humanClick(
  page: Page,
  locator: Locator,
  options: { position?: { x: number; y: number }; hoverMs?: number } = {},
): Promise<void> {
  const hoverMs = options.hoverMs ?? 250;
  // Scroll into view first so the cursor doesn't glide off-screen.
  await locator.scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => { /* best effort */ });
  // Move slowly to the element so the fake cursor traces a visible
  // path, then hover before clicking.
  await locator.hover({ timeout: 10_000 });
  await page.waitForTimeout(hoverMs);
  await locator.click(options);
}

/**
 * Fill an input with humanlike per-keystroke delays. Wraps
 * Playwright's `pressSequentially`. Each keystroke renders on the
 * stream because the page repaints between events.
 *
 * @param locator Playwright Locator for the input.
 * @param text Value to type.
 * @param options.delayMs Per-keystroke delay; default 90ms.
 */
export async function humanFill(
  locator: Locator,
  text: string,
  options: { delayMs?: number } = {},
): Promise<void> {
  const delay = options.delayMs ?? 90;
  await locator.scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => { /* best effort */ });
  await locator.click();
  await locator.fill("");
  await locator.pressSequentially(text, { delay });
}

/**
 * Scroll the page down by a small random amount, then back up. Used
 * between rounds so the stream isn't a static frame while the bot
 * waits for the next round_start.
 */
export async function humanScrollPeek(page: Page): Promise<void> {
  const dy = 200 + Math.floor(Math.random() * 300);
  await page.mouse.wheel(0, dy);
  await page.waitForTimeout(800);
  await page.mouse.wheel(0, -dy);
}
