/**
 * In-memory ChatSource for unit tests. The aggregator + router can
 * be exercised end-to-end without spinning up any external chat
 * connection — just call `mock.send(msg)` to inject events.
 */

import type {
  ChatBadge,
  ChatListener,
  ChatPlatform,
  ChatSource,
  IncomingChatMessage,
} from "../types";

export interface MockChatSource extends ChatSource {
  /** Inject a message at any time after `start()` has been called. */
  send(partial: PartialMessage): void;
}

interface PartialMessage {
  user: string;
  text: string;
  id?: string;
  platform?: ChatPlatform;
  badges?: ChatBadge[];
  color?: string;
  at?: number;
}

/**
 * Construct a mock source. Defaults to `platform: "test"` so tests
 * don't accidentally collide with the dedupe key for a real platform.
 *
 * The auto-id counter is per-instance so two sources created in the
 * same test process can't accidentally share IDs (which would let the
 * aggregator's dedupe drop messages across unrelated tests).
 */
export function createMockChatSource(platform: ChatPlatform = "test"): MockChatSource {
  let listener: ChatListener | null = null;
  let nextId = 1;
  return {
    platform,
    start(l) {
      listener = l;
      return () => {
        listener = null;
      };
    },
    send(partial) {
      if (!listener) return;
      const msg: IncomingChatMessage = {
        id: partial.id ?? `mock-${nextId++}`,
        platform: partial.platform ?? platform,
        user: partial.user,
        text: partial.text,
        badges: partial.badges,
        color: partial.color,
        at: partial.at ?? Date.now(),
      };
      listener(msg);
    },
  };
}
