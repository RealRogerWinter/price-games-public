import { lazy, type ComponentType } from "react";

/**
 * Retries a dynamic import up to `retries` times with exponential backoff.
 * Exported separately so the retry logic can be unit-tested without needing
 * to render a React.lazy component.
 *
 * @param importFn - A function returning a dynamic import
 * @param retries  - Number of retry attempts (default 3)
 * @param delay    - Base delay in ms for backoff (default 1000). Set to 0 in tests.
 * @returns The resolved module
 */
export async function retryImport<T>(
  importFn: () => Promise<{ default: T }>,
  retries = 3,
  delay = 1000,
): Promise<{ default: T }> {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      return await importFn();
    } catch (err) {
      if (attempt === retries - 1) throw err;
      // Exponential backoff: 1s, 2s, 4s (skipped when delay=0)
      if (delay > 0) {
        await new Promise((r) => setTimeout(r, delay * 2 ** attempt));
      }
    }
  }
  // Unreachable — satisfies TypeScript's control flow analysis
  /* istanbul ignore next */
  return await importFn();
}

/**
 * Wraps a dynamic import with retry logic for resilience against transient
 * network failures or brief windows during deployment where a chunk is
 * temporarily unavailable.
 *
 * @param importFn - A function returning a dynamic import, e.g. `() => import('./pages/Foo')`
 * @param retries  - Number of retry attempts (default 3)
 * @returns A React.lazy component
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default function lazyWithRetry<T extends ComponentType<any>>(
  importFn: () => Promise<{ default: T }>,
  retries = 3,
) {
  return lazy(() => retryImport(importFn, retries));
}
