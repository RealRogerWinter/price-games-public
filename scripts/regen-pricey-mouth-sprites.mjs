#!/usr/bin/env node
/**
 * Regenerate Pricey's per-(mood, mouth-state) lipsync sprite trio.
 *
 * For each of the 8 moods, generates three full-body 384×384 WebPs
 * (closed, mid, wide) where body identity is preserved across the
 * three but the mouth shape differs. Drives the mouth animation in
 * the broadcast Avatar via opacity-only sprite swap.
 *
 * Pipeline (per output sprite):
 *   1. Send the per-mood v2 closed-mouth source to Gemini's image
 *      edit endpoint with a per-state prompt + a "render on flat
 *      green #00FF00 background" instruction.
 *   2. Run the resulting RGB raster through ffmpeg `colorkey` to
 *      drop the green to alpha=0.
 *   3. Scale to 384×384 with lanczos so all 24 sprites share canvas
 *      coordinates and the painted Pricey lands at the same x/y
 *      across the trio for every mood (zero-jump alignment).
 *   4. Encode to WebP q=80, alpha_q=100 via cwebp — keeps the lazy
 *      bundle's avatar graph under the 600 KB budget enforced by
 *      `apps/web/src/broadcast/bundleIsolation.test.ts`.
 *   5. Write a sidecar JSON to the image archive (per CLAUDE.md
 *      §"Image Assets") so future regenerations are reproducible.
 *
 * Usage:
 *   GEMINI_API_KEY=... node scripts/regen-pricey-mouth-sprites.mjs [--moods=happy,...] [--states=closed,mid,wide]
 *
 * Defaults: all 8 moods × all 3 states = 24 sprites. The skip-if-
 * exists guard lets you re-run after a partial failure without
 * re-billing successful generations.
 *
 * Prereqs:
 *   - npm install @google/genai (or set GENAI_PATH to an existing copy)
 *   - cwebp on $PATH (apt-get install webp)
 *   - ffmpeg on $PATH
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC_DIR = resolve(REPO_ROOT, "apps/web/src/assets/avatar");
const ARCHIVE_DIR = resolve(
  process.env.IMAGE_ARCHIVE_ROOT ?? join(homedir(), "image-archive"),
  "images/avatars-pricey-mouth-states",
);
const ASSET_DIR = SRC_DIR;
const MODEL = "gemini-3.1-flash-image-preview";
const ALL_MOODS = ["neutral", "happy", "confident", "elated", "focused", "tilted", "frustrated", "despondent"];
const ALL_STATES = ["closed", "mid", "wide"];

const PROMPTS = {
  closed: "Same pig piggy bank illustration, mouth closed in a small smile (keep the mouth EXACTLY as it is in the input image — closed). Critical: the BODY, EYES, COIN, COLORS, OUTLINE, POSE, MOOD EXPRESSION must be EXACTLY identical to the input image. This is essentially a re-rendering of the same image. Render on a pure flat green background (#00FF00) so we can chroma-key it out. Square 1:1 aspect ratio.",
  mid: "Identical pig piggy bank illustration, but the mouth is now open in a small surprised oval shape (small 'oh'). Critical: the BODY, EYES, COIN, COLORS, OUTLINE, POSE, MOOD EXPRESSION must be EXACTLY identical to the input image — only the mouth shape changes from closed to a small open 'oh'. Render on a pure flat green background (#00FF00) so we can chroma-key it out. Square 1:1 aspect ratio.",
  wide: "Identical pig piggy bank illustration, but the mouth is now WIDE OPEN in a big oval shape (large 'Aaaa' yelling shape) with the dark mouth interior and a tongue visible. Critical: the BODY, EYES, COIN, COLORS, OUTLINE, POSE, MOOD EXPRESSION must be EXACTLY identical to the input image — only the mouth shape changes from closed to wide open. Render on a pure flat green background (#00FF00). Square 1:1 aspect ratio.",
};

function arg(name, fallback) {
  // Accept both `--name value` and `--name=value` forms.
  const eq = process.argv.find((a) => a.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const i = process.argv.indexOf(name);
  if (i < 0) return fallback;
  return process.argv[i + 1];
}
function csvArg(name, fallback) {
  const v = arg(name);
  return v ? v.split(",") : fallback;
}

const moods = csvArg("--moods", ALL_MOODS);
const states = csvArg("--states", ALL_STATES);

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error("error: GEMINI_API_KEY env var is required");
  process.exit(1);
}

// Lazy-import @google/genai so missing-dep errors are clear. Allow override
// of the package path via env for environments where it's installed
// elsewhere (e.g. the host-level claude skill cache).
const genaiPath = process.env.GENAI_PATH ?? "@google/genai";
let GoogleGenAI;
try {
  ({ GoogleGenAI } = await import(genaiPath));
} catch (err) {
  console.error(`error: failed to import @google/genai from "${genaiPath}".`);
  console.error("  install it via:  npm install @google/genai");
  console.error("  or set GENAI_PATH to a path containing the package.");
  console.error(`  underlying error: ${err.message}`);
  process.exit(1);
}

mkdirSync(ARCHIVE_DIR, { recursive: true });
mkdirSync(ASSET_DIR, { recursive: true });

const ai = new GoogleGenAI({ apiKey });

function sourceFor(mood) {
  // Neutral mood originally lived in `pricey-v2-mouth-closed.webp`
  // (the unsuffixed canonical sprite); the other 7 moods are
  // `pricey-v2-mood-{label}.webp`. The v3 trio is regenerated FROM
  // these v2 sources so the per-mood expression, eye state, and pose
  // continue to be ground-truthed against an artist-drawn original.
  return mood === "neutral"
    ? resolve(SRC_DIR, "pricey-v2-mouth-closed.webp")
    : resolve(SRC_DIR, `pricey-v2-mood-${mood}.webp`);
}

async function generate(mood, state) {
  const src = sourceFor(mood);
  const rawPath = resolve(ARCHIVE_DIR, `${mood}-${state}-raw.png`);
  const archivePath = resolve(ARCHIVE_DIR, `${mood}-${state}.png`);
  const sidecarPath = resolve(ARCHIVE_DIR, `${mood}-${state}.json`);
  const assetPath = resolve(ASSET_DIR, `pricey-v3-mouth-${mood}-${state}.webp`);

  if (!existsSync(src)) {
    console.warn(`  [skip] missing source for ${mood}: ${src}`);
    return;
  }
  if (existsSync(assetPath)) {
    console.log(`  [skip] already exists: ${assetPath}`);
    return;
  }

  const prompt = PROMPTS[state];
  if (!prompt) throw new Error(`unknown state: ${state}`);

  console.log(`==> ${mood}/${state}`);
  const inputBytes = readFileSync(src);
  const response = await ai.models.generateContent({
    model: MODEL,
    contents: [
      { inlineData: { data: inputBytes.toString("base64"), mimeType: "image/webp" } },
      { text: prompt },
    ],
    config: { responseModalities: ["TEXT", "IMAGE"] },
  });
  const parts = response.candidates?.[0]?.content?.parts ?? [];
  const imagePart = parts.find((p) => "inlineData" in p && p.inlineData?.data);
  if (!imagePart) {
    const text = parts.find((p) => "text" in p)?.text ?? "(no text)";
    throw new Error(`no image part in response: ${text}`);
  }
  writeFileSync(rawPath, Buffer.from(imagePart.inlineData.data, "base64"));

  // Chromakey the green background → alpha, scale to 384×384.
  execFileSync(
    "ffmpeg",
    [
      "-y", "-i", rawPath,
      "-vf", "colorkey=0x00FF00:0.30:0.10,scale=384:384:flags=lanczos",
      "-c:v", "png", "-pix_fmt", "rgba",
      archivePath,
    ],
    { stdio: "ignore" },
  );

  // Encode to WebP for the bundle.
  execFileSync(
    "cwebp",
    ["-quiet", "-q", "80", "-alpha_q", "100", archivePath, "-o", assetPath],
    { stdio: "inherit" },
  );

  // Sidecar JSON per CLAUDE.md §"Image Assets".
  const sidecar = {
    title: `Pricey ${mood} – ${state} mouth`,
    category: "avatars",
    tags: ["avatar", "pricey", "piggy-bank", mood, `mouth-${state}`, "lipsync"],
    description: `Streamer-bot mascot. ${mood} mood with mouth in ${state}-open state. Generated as part of the lipsync sprite trio (closed/mid/wide) so swapping among them animates the mouth without the body morphing.`,
    prompt,
    model: MODEL,
    aspectRatio: "1:1",
    createdAt: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
    source: "generated",
  };
  writeFileSync(sidecarPath, JSON.stringify(sidecar, null, 2) + "\n");

  const sz = statSync(assetPath).size;
  console.log(`  -> wrote ${assetPath} (${(sz / 1024).toFixed(1)} KB)`);
}

let failures = 0;
for (const mood of moods) {
  for (const state of states) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await generate(mood, state);
        break;
      } catch (err) {
        console.warn(`  attempt ${attempt} failed: ${err.message}`);
        if (attempt === 3) {
          console.error(`  [GAVE UP] ${mood}/${state}`);
          failures += 1;
          break;
        }
        // Gemini 3 image preview is rate-limited; wait between retries.
        await new Promise((r) => setTimeout(r, 15_000));
      }
    }
  }
}

console.log(`\nDone. ${failures > 0 ? `${failures} failures` : "all sprites generated"}.`);
process.exit(failures > 0 ? 1 : 0);
