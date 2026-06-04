/**
 * Chat aggregator — fans messages from multiple ChatSource adapters
 * (one per platform) into a single subscriber bus. Each adapter runs
 * independently; the aggregator just multiplexes their outputs and
 * applies a small dedupe window so a flaky adapter that re-emits a
 * message doesn't dispatch twice.
 *
 * No I/O of its own. The Twitch / YouTube / Kick adapters that ship
 * in PR 13 implement ChatSource and pass `start(listener)` calls
 * through to their respective platform clients.
 */

import type {
  ChatListener,
  ChatSource,
  IncomingChatMessage,
} from "./types";

const DEFAULT_DEDUPE_WINDOW = 200;

interface AggregatorOptions {
  /** Inject for deterministic tests. Defaults to Date.now. */
  now?: () => number;
  /**
   * Number of recent message IDs kept for dedupe. Defaults to 200.
   * Increase if you observe a single duplicate slipping through after
   * a heavy burst.
   */
  dedupeWindow?: number;
}

export function createChatAggregator(
  sources: ChatSource[],
  opts: AggregatorOptions = {},
) {
  const now = opts.now ?? (() => Date.now());
  const dedupeWindow = Math.max(1, opts.dedupeWindow ?? DEFAULT_DEDUPE_WINDOW);
  const seenIds: string[] = [];
  const seenSet = new Set<string>();
  const listeners = new Set<ChatListener>();

  function dedupeId(msg: IncomingChatMessage): string {
    return `${msg.platform}:${msg.id}`;
  }

  function fanout(msg: IncomingChatMessage): void {
    const key = dedupeId(msg);
    if (seenSet.has(key)) return;
    seenSet.add(key);
    seenIds.push(key);
    while (seenIds.length > dedupeWindow) {
      const evicted = seenIds.shift();
      if (evicted !== undefined) seenSet.delete(evicted);
    }
    // Stamp `at` only when the source omitted it. Use Number.isFinite
    // rather than truthiness so a legitimate `at: 0` (epoch zero in
    // tests, edge in real platforms) isn't overwritten with `now()`.
    const stamped: IncomingChatMessage = Number.isFinite(msg.at) ? msg : { ...msg, at: now() };
    for (const fn of listeners) fn(stamped);
  }

  let stops: Array<() => void> = [];
  let started = false;

  return {
    /** Begin streaming from every source. Idempotent. */
    start(): void {
      if (started) return;
      started = true;
      stops = sources.map((s) => s.start(fanout));
    },
    /** Detach every source. Idempotent. */
    stop(): void {
      if (!started) return;
      for (const stop of stops) stop();
      stops = [];
      started = false;
    },
    /** Subscribe to dedup'd messages. Returns an unsubscribe fn. */
    subscribe(listener: ChatListener): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    /** Number of attached subscribers. Test affordance. */
    listenerCount(): number {
      return listeners.size;
    },
  };
}

export type ChatAggregator = ReturnType<typeof createChatAggregator>;
