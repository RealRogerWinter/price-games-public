#!/usr/bin/env node
/**
 * Gemini image-edit helper. Sends a base image + edit prompt to
 * gemini-3-pro-image-preview's multimodal generateContent endpoint,
 * which preserves identity/composition while applying the requested
 * change. The bundled image-generation CLI is text-prompt-only —
 * this script is the supplement we use when frame-coherence
 * matters (e.g. Pricey's mouth states for lipsync).
 *
 * Usage:
 *   GEMINI_API_KEY=... node scripts/gemini-edit.mjs \
 *     --input <baseImage.png> \
 *     --prompt "edit description" \
 *     --output <out.png>
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

// The @google/genai SDK ships inside the image-generation Claude skill bundle
// rather than this repo's node_modules. Resolve it from $GENAI_MODULE, falling
// back to the skill's default install path under the user's home directory.
const genaiModule =
  process.env.GENAI_MODULE ||
  join(homedir(), ".claude/skills/image-generation/_repo/mcp-server/node_modules/@google/genai/dist/index.mjs");
const { GoogleGenAI } = await import(genaiModule);

const args = process.argv.slice(2);
function arg(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
}
const inputPath = arg("--input");
const prompt = arg("--prompt");
const outputPath = arg("--output");
const model = arg("--model") ?? "gemini-3-pro-image-preview";
if (!inputPath || !prompt || !outputPath) {
  console.error("usage: --input <path> --prompt <text> --output <path> [--model <id>]");
  process.exit(1);
}
const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error("GEMINI_API_KEY env var not set");
  process.exit(1);
}

const inputBytes = readFileSync(inputPath);
const inputB64 = inputBytes.toString("base64");
const mimeType = inputPath.endsWith(".webp")
  ? "image/webp"
  : inputPath.endsWith(".jpg") || inputPath.endsWith(".jpeg")
    ? "image/jpeg"
    : "image/png";

const ai = new GoogleGenAI({ apiKey });
console.log(`> editing ${inputPath} (${inputBytes.length}B, ${mimeType}) with model=${model}`);
const response = await ai.models.generateContent({
  model,
  contents: [
    { inlineData: { data: inputB64, mimeType } },
    { text: prompt },
  ],
  config: {
    responseModalities: ["TEXT", "IMAGE"],
  },
});

const parts = response.candidates?.[0]?.content?.parts ?? [];
for (const part of parts) {
  if ("inlineData" in part && part.inlineData?.data) {
    mkdirSync(dirname(outputPath), { recursive: true });
    const buf = Buffer.from(part.inlineData.data, "base64");
    writeFileSync(outputPath, buf);
    console.log(`> wrote ${outputPath} (${buf.length}B, mime=${part.inlineData.mimeType ?? "image/png"})`);
    process.exit(0);
  }
}
console.error("no image part in response. text:", parts.find((p) => "text" in p)?.text ?? "(none)");
process.exit(1);
