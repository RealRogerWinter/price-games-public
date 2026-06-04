/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";

// Per-file thresholds are meant for full-suite coverage runs. CircleCI's
// Smarter Testing analysis pass invokes vitest one test atom at a time,
// where unrelated files legitimately show 0% — set this env var there to
// suppress per-file gates without touching the global gate.
const skipPerFileThresholds = process.env.VITEST_SKIP_PER_FILE_THRESHOLDS === "1";

const perFileThresholds = skipPerFileThresholds
  ? {}
  : {
      "src/analytics/beacon.ts": { lines: 85, branches: 75 },
    };

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    restoreMocks: true,
    testTimeout: 15000,
    setupFiles: ["./src/setupTests.ts"],
    css: false,
    reporters: ["default", "junit"],
    outputFile: {
      junit: "test-results/junit.xml",
    },
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/main.tsx", "src/setupTests.ts", "src/**/*.test.{ts,tsx}", "src/__tests__/**"],
      thresholds: {
        // Per-file gate for the client analytics beacon. Mirrors the
        // server-side bar: an undetected drop here breaks the entire
        // ingest path even if all other coverage stays high.
        // Web global gate is 75%; this is the only per-file gate, so
        // we set it tighter than global on lines and equal on branches.
        ...perFileThresholds,
      },
    },
  },
});
