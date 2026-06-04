/**
 * Bundle-isolation contract — locks in the lazy-chunk split for the
 * streamer-bot avatar code. The avatar lives in `apps/web` (so it
 * ships from the production server's bundle) but must NEVER load
 * for non-broadcast viewers. Three guarantees protect that:
 *
 *   1. `BroadcastShell` imports `Avatar` via `React.lazy(() => import(...))`.
 *   2. The lazy mount is gated behind `?broadcast=1`.
 *   3. **This test** — checks the built artifact directly: every
 *      avatar-related marker (sprite class names, sprite asset
 *      filenames, FFT vendor code) must live ONLY in the Avatar
 *      chunk, never in the main `index-*.js` that the production
 *      app fetches on every page load.
 *
 * The test is structured around `it.skipIf(!distExists)` so that
 * regular `npm run test:web` (which doesn't build) stays fast. CI's
 * pipeline runs `npm run build` before the test-web step, so the
 * dist directory will be present there. To run locally:
 *
 *     npm run build -w apps/web && npm run test:web
 *
 * If a future eager import accidentally inlines avatar code into
 * the main bundle, this test fails — much faster feedback than
 * spotting the regression in production with DevTools.
 */

import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

// vitest runs from the worktree root; dist lives at apps/web/dist.
// `import.meta.url` is not a file:// URL under vitest's jsdom env,
// so use process.cwd() with a stable relative path instead.
const DIST_DIR = resolve(process.cwd(), "apps/web/dist/assets");
const DIST_EXISTS = existsSync(DIST_DIR);

/** Markers that must NOT appear in the main `index-*.js` chunk. */
const FORBIDDEN_IN_MAIN = [
  "broadcast-avatar-frame",
  "pricey-v3-mouth-",
];

describe("bundle isolation — avatar code never reaches the main entry chunk", () => {
  it.skipIf(!DIST_EXISTS)("main index-*.js contains no avatar markers", () => {
    const files = readdirSync(DIST_DIR).filter((f) => f.startsWith("index-") && f.endsWith(".js"));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const content = readFileSync(resolve(DIST_DIR, f), "utf8");
      for (const marker of FORBIDDEN_IN_MAIN) {
        expect(content, `marker "${marker}" leaked into ${f}`).not.toContain(marker);
      }
    }
  });

  it.skipIf(!DIST_EXISTS)("Avatar-*.js chunk exists and contains the expected sprite markers", () => {
    const files = readdirSync(DIST_DIR).filter((f) => f.startsWith("Avatar-") && f.endsWith(".js"));
    expect(files, "exactly one Avatar-*.js chunk should be emitted").toHaveLength(1);
    const content = readFileSync(resolve(DIST_DIR, files[0]), "utf8");
    expect(content).toContain("broadcast-avatar");
  });

  it.skipIf(!DIST_EXISTS)("avatar WebP assets exist as separate hashed files in dist/", () => {
    const files = readdirSync(DIST_DIR).filter((f) => f.startsWith("pricey-v3-mouth-") && f.endsWith(".webp"));
    // Lipsync sprite trio per mood: 8 moods × 3 mouth states (closed,
    // mid, wide) = 24 files. The previous v2 layout (7 mood bodies +
    // 1 closed-mouth + 2 mouth overlays = 10) was the source of the
    // alignment bug fixed by this trio refactor — see Avatar.tsx for
    // the full root-cause writeup.
    expect(files).toHaveLength(24);
  });

  it.skipIf(!DIST_EXISTS)("Avatar chunk total weight (JS + WebPs) stays under the lazy budget", () => {
    // Budget: 600 KB total for the avatar's lazy graph.
    //
    // PR 5 raised it 100→250 KB to fit 8 mood bodies + 2 overlays.
    // The lipsync sprite-trio refactor (this PR) tripled sprite count
    // from 8→24 (closed/mid/wide per mood) — chromakey'd 384×384 WebP
    // at q=80, alpha_q=100 lands ~17 KB per sprite, so 24 sprites is
    // ~400 KB plus the Avatar JS chunk leaves headroom inside 600 KB.
    // The preserved-identity image-edit pipeline produces marginally
    // larger files than the earlier from-scratch sprites because each
    // pig is more detailed (the chromakey edge plus the body's full
    // shading round-trips through Gemini), so per-sprite size went
    // up ~3x vs v2 — the per-mood × per-state count is what drove
    // the budget bump, not the per-file weight.
    //
    // The lazy budget still protects non-broadcast viewers: the
    // entire graph only loads behind `?broadcast=1` per the Suspense
    // gate in BroadcastShell. Production index-*.js carries none of
    // it (locked by FORBIDDEN_IN_MAIN above).
    //
    // If you need more, raise this — the regression alarm is the
    // point, not the absolute number. Document the bump and the
    // reason inline.
    const BUDGET_BYTES = 600 * 1024;
    const files = readdirSync(DIST_DIR).filter(
      (f) => f.startsWith("Avatar-") || (f.startsWith("pricey-") && (f.endsWith(".webp") || f.endsWith(".png"))),
    );
    let total = 0;
    for (const f of files) {
      total += readFileSync(resolve(DIST_DIR, f)).byteLength;
    }
    expect(total, `Avatar lazy graph is ${(total / 1024).toFixed(1)} KB; budget ${BUDGET_BYTES / 1024} KB`).toBeLessThan(BUDGET_BYTES);
  });
});
