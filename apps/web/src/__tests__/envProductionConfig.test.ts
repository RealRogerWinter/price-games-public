/**
 * Build-time regression test: verifies that apps/web/.env.production contains
 * every VITE_* env var required for production builds.
 *
 * WHY: Vite statically replaces `import.meta.env.VITE_*` at build time using
 * values from `.env.production`. If a key is missing from that file but present
 * in the local `.env` (which is gitignored), the local dev build works fine but
 * the Docker/CI production build silently bakes in an empty string. This caused
 * a critical signup bug: the Turnstile widget never rendered in production
 * because VITE_TURNSTILE_SITE_KEY was only in the gitignored `.env`, not in
 * `.env.production`.
 *
 * This test reads the actual `.env.production` file from disk and asserts that
 * every required key is present and non-empty. Adding a new public env var to
 * the frontend requires adding it here too — which is the point.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";

/** Parse a .env file into a key→value map, ignoring comments and blank lines. */
function parseDotEnv(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    result[key] = value;
  }
  return result;
}

/**
 * Locate apps/web/.env.production regardless of where vitest runs from.
 * CI runs from apps/web/ (cwd), local runs may be from the repo root.
 */
function findEnvProduction(): string {
  // Try cwd first (CI: cwd is apps/web/)
  const fromCwd = resolve(process.cwd(), ".env.production");
  if (existsSync(fromCwd)) return fromCwd;
  // Fallback: repo root (local: cwd is repo root)
  const fromRoot = resolve(process.cwd(), "apps/web/.env.production");
  if (existsSync(fromRoot)) return fromRoot;
  // Last resort: relative to this source file
  const fromFile = resolve(__dirname, "../../.env.production");
  return fromFile;
}

describe(".env.production required VITE_* keys", () => {
  const envPath = findEnvProduction();
  let envVars: Record<string, string>;

  try {
    const content = readFileSync(envPath, "utf-8");
    envVars = parseDotEnv(content);
  } catch {
    envVars = {};
  }

  // ── Add new required public env vars here ────────────────────────────
  const REQUIRED_KEYS = [
    "VITE_TURNSTILE_SITE_KEY",
    "VITE_GA_MEASUREMENT_ID",
  ];

  for (const key of REQUIRED_KEYS) {
    it(`${key} is present and non-empty in .env.production`, () => {
      expect(envVars[key], `${key} is missing or empty in ${envPath}`).toBeTruthy();
    });
  }

  it(".env.production file exists and is readable", () => {
    const content = readFileSync(envPath, "utf-8");
    expect(content.length).toBeGreaterThan(0);
  });
});
