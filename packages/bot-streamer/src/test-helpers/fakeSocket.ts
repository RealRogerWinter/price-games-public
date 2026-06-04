/**
 * In-memory Socket.IO doppelganger for unit tests.
 *
 * Implements the {@link SocketLike} contract from the observer plus a
 * test-side `emit(event, payload)` to inject events. Synchronous: when
 * `emit` is called, every registered handler runs immediately. That's
 * what we want for assertions about state changes; production code uses
 * a real socket whose `on` handlers fire asynchronously, but the bot's
 * observer reduces them in the same shape either way.
 */

import type { SocketLike } from "../observer/observer";

type Handler = (payload: unknown) => void;

export interface FakeSocket extends SocketLike {
  /** Inject a server→client event. Every handler for `event` fires synchronously. */
  emit(event: string, payload?: unknown): void;
  /** Number of handlers currently registered for `event`. Test affordance. */
  handlerCount(event: string): number;
  /** Clear every handler. Test affordance. */
  clear(): void;
}

/**
 * Construct a fresh fake socket. Each test should create its own — the
 * map is mutable and not safe to share.
 */
export function createFakeSocket(): FakeSocket {
  const handlers = new Map<string, Set<Handler>>();

  return {
    on(event, handler) {
      let set = handlers.get(event);
      if (!set) {
        set = new Set();
        handlers.set(event, set);
      }
      set.add(handler);
    },
    off(event, handler) {
      handlers.get(event)?.delete(handler);
    },
    emit(event, payload) {
      const set = handlers.get(event);
      if (!set) return;
      // Snapshot listeners before invoking so a handler that removes
      // itself mid-dispatch doesn't skip a sibling.
      for (const fn of [...set]) fn(payload);
    },
    handlerCount(event) {
      return handlers.get(event)?.size ?? 0;
    },
    clear() {
      handlers.clear();
    },
  };
}
