// This file is loaded by apps/web/vite.config.ts's vitest test config — a
// legacy path kept for compatibility with CLAUDE.md's single-file run
// instructions (`npx vitest run path/to/file.test.tsx --config apps/web/vite.config.ts`).
//
// The canonical setup file is ../setupTests.ts, used by the workspace
// vitest.config.ts that `npm run test:web` picks up. Re-import it here so
// both paths install identical stubs and cleanups.

import "../setupTests";

import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

// The workspace vitest.config.ts has `globals: true`, which gives
// @testing-library/react automatic afterEach cleanup. vite.config.ts does
// not, so we register it manually here.
afterEach(() => {
  cleanup();
});
