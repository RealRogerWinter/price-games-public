import { defineConfig } from "vitest/config";

// Per-file thresholds are meant for full-suite coverage runs. CircleCI's
// Smarter Testing analysis pass invokes vitest one test atom at a time,
// where unrelated files legitimately show 0% — set this env var there to
// suppress per-file gates without touching the global gate.
const skipPerFileThresholds = process.env.VITEST_SKIP_PER_FILE_THRESHOLDS === "1";

const perFileThresholds = skipPerFileThresholds
  ? {}
  : {
      "src/services/eventLog.ts": { lines: 90, branches: 85 },
      "src/services/analyticsHourly.ts": { lines: 90, branches: 85 },
      "src/services/analyticsV2.ts": { lines: 85, branches: 85 },
      "src/services/visitorAttribution.ts": { lines: 90, branches: 85 },
    };

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    env: {
      ADMIN_BCRYPT_ROUNDS: "4",
      USER_BCRYPT_ROUNDS: "4",
      ADMIN_2FA_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    },
    testTimeout: 15000,
    include: ["src/**/*.test.ts"],
    reporters: ["default", "junit"],
    outputFile: {
      junit: "test-results/junit.xml",
    },
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.test.ts",
        "src/test/**",
        "src/pipeline/**",
        "src/db.ts",
        "src/index.ts",
        "src/socket/**",
        "src/services/imageProxy.ts",
        "src/services/gameEngine.ts",
        "src/services/multiplayerEngine.ts",
        "src/services/universe/**",
        "src/services/ai/**",
        "src/routes/universe.ts",
      ],
      thresholds: {
        lines: 85,
        branches: 85,
        functions: 85,
        statements: 85,
        // Per-file gates for the analytics surface. The unified-analytics
        // initiative (PRs 205-214) made this the most-tested code in the
        // repo; the gates pin that bar so a future PR that drops coverage
        // on the load-bearing files fails fast in CI rather than waiting
        // for a silent regression in production. Tighter than the global
        // gate because the consequences of an analytics bug (silently
        // skewed dashboards) are higher than a typical UI regression.
        // Per-file thresholds must always be tighter than (or equal to)
        // the global gate — never looser, otherwise the per-file gate
        // is a no-op for the global metric.
        ...perFileThresholds,
      },
      reporter: ["text", "json", "html"],
    },
  },
});
