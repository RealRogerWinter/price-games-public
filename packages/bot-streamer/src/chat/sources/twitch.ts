/**
 * Twitch ChatSource — wraps a tmi.js client and forwards every chat
 * message into the aggregator. The streamer container has tmi.js as
 * a dependency; this module is decoupled from it via a `clientFactory`
 * injection so unit tests don't need the real package.
 *
 * Authentication: anonymous read works for any public channel
 * ("justinfan12345" tmi.js convention). Setting STREAMER_TWITCH_OAUTH
 * unlocks chat-back from the bot's own account if we ever want it.
 */

import type {
  ChatBadge,
  ChatListener,
  ChatSource,
  IncomingChatMessage,
} from "../types";

/**
 * Subset of tmi.js Client we depend on. The real client has many more
 * methods; only what's exercised here is in the contract.
 */
export interface TmiClientLike {
  on(event: "message", handler: TmiMessageHandler): void;
  connect(): Promise<unknown>;
  disconnect(): Promise<unknown>;
}

export interface TmiUserstate {
  username?: string;
  "display-name"?: string;
  id?: string;
  color?: string;
  badges?: Record<string, string | undefined>;
  mod?: boolean;
  "tmi-sent-ts"?: string;
}

export type TmiMessageHandler = (
  channel: string,
  userstate: TmiUserstate,
  text: string,
  self: boolean,
) => void;

export interface TwitchSourceOptions {
  /** Channel name without the leading `#`. */
  channel: string;
  /**
   * Build the tmi.js client. Tests pass a fake; the streamer container
   * passes a closure that calls `new tmi.Client(...)`. Decoupling
   * means this module doesn't take tmi.js as a direct dep.
   */
  clientFactory: () => TmiClientLike;
  /** Optional callback for connection / dispatch errors. */
  onError?: (err: Error) => void;
}

function badgesFromUserstate(userstate: TmiUserstate): ChatBadge[] {
  // Use a Set because tmi.js exposes "is moderator" both via the
  // top-level `mod` boolean and the `badges.moderator` map entry —
  // both are typically set for an actual moderator, and a duplicate
  // "moderator" badge in the array would surprise downstream consumers
  // (e.g. analytics that count badges).
  const out = new Set<ChatBadge>();
  if (userstate.mod) out.add("moderator");
  if (userstate.badges) {
    if (userstate.badges.broadcaster) out.add("broadcaster");
    if (userstate.badges.moderator) out.add("moderator");
    if (userstate.badges.vip) out.add("vip");
    if (userstate.badges.subscriber) out.add("subscriber");
  }
  return Array.from(out);
}

/**
 * Construct a Twitch ChatSource. The aggregator calls `start()` once;
 * the returned function tears down the connection.
 */
export function createTwitchSource(opts: TwitchSourceOptions): ChatSource {
  const onError = opts.onError ?? (() => {});

  return {
    platform: "twitch",
    start(listener: ChatListener) {
      let client: TmiClientLike | null = null;
      try {
        client = opts.clientFactory();
      } catch (err) {
        onError(err instanceof Error ? err : new Error(String(err)));
        return () => {};
      }

      const localClient = client;

      const handler: TmiMessageHandler = (_channel, userstate, text, self) => {
        if (self) return;
        try {
          const username = userstate["display-name"] ?? userstate.username ?? "anon";
          const id = userstate.id ?? `tw-${userstate["tmi-sent-ts"] ?? Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
          const sentTsRaw = userstate["tmi-sent-ts"];
          const at = sentTsRaw ? Number(sentTsRaw) : Date.now();
          const msg: IncomingChatMessage = {
            id,
            platform: "twitch",
            user: username,
            text,
            color: userstate.color,
            badges: badgesFromUserstate(userstate),
            at: Number.isFinite(at) ? at : Date.now(),
          };
          listener(msg);
        } catch (err) {
          onError(err instanceof Error ? err : new Error(String(err)));
        }
      };

      localClient.on("message", handler);
      localClient.connect().catch((err) => onError(err instanceof Error ? err : new Error(String(err))));

      return () => {
        localClient.disconnect().catch(() => { /* best effort */ });
      };
    },
  };
}

// Re-export for tests.
export const __twitchInternals = { badgesFromUserstate };
