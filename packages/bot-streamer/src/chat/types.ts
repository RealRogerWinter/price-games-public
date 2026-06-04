/**
 * Chat layer types — used by the aggregator (which receives messages
 * from Twitch / YouTube / Kick adapters), the command router (which
 * parses `!command args` and dispatches to handlers), and the runner
 * (which subscribes to dispatched commands and translates them into
 * lifecycle / TTS actions).
 */

export type ChatPlatform = "twitch" | "youtube" | "kick" | "test";

export interface IncomingChatMessage {
  /** Stable ID supplied by the source platform; used for dedupe. */
  id: string;
  platform: ChatPlatform;
  /** Username at the source. */
  user: string;
  /** Raw message text — the router parses this for `!command`. */
  text: string;
  /** Optional hex color for the user's name in chat. */
  color?: string;
  /**
   * Source-platform badges. The router uses these to gate moderator-
   * only commands (e.g. `!skill`).
   */
  badges?: ChatBadge[];
  /** ms since epoch the source assigned, or `Date.now()` if unknown. */
  at: number;
}

export type ChatBadge = "broadcaster" | "moderator" | "vip" | "subscriber" | string;

/**
 * Subscriber callback used by the aggregator to fan messages out.
 * Listeners must not throw — they run inside a tight per-message loop.
 */
export type ChatListener = (msg: IncomingChatMessage) => void;

/**
 * One-platform adapter the aggregator wraps. Real adapters live in PR 13
 * (Twitch IRC via tmi.js, YouTube live chat polling, Kick websocket).
 * Tests use the in-memory adapter from `./sources/mock`.
 */
export interface ChatSource {
  readonly platform: ChatPlatform;
  /**
   * Begin streaming messages to `listener`. The returned function
   * detaches the listener and stops the underlying connection.
   */
  start(listener: ChatListener): () => void;
}

/** Parsed command extracted from a chat message. */
export interface ParsedCommand {
  name: string;
  args: string[];
  /** The full message that produced this command, for handler context. */
  message: IncomingChatMessage;
}

/**
 * Handler invoked by the router when a registered command fires.
 * Returns void or a Promise; the router awaits it for sequencing.
 *
 * The runner provides handlers that translate commands into bot
 * actions (`!mode bidding` → queue a mode change for the next round).
 */
export type CommandHandler = (cmd: ParsedCommand) => void | Promise<void>;

/** Per-command rate-limit window. */
export interface CommandRateLimit {
  /** Cooldown applied per-user. */
  perUserSeconds: number;
  /** Cooldown applied globally across all users. */
  globalSeconds: number;
  /** Restrict to broadcaster + moderator badges. */
  modOnly?: boolean;
}

export interface CommandSpec {
  name: string;
  handler: CommandHandler;
  rateLimit?: Partial<CommandRateLimit>;
}
