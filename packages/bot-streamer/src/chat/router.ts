/**
 * Command router — parses `!name args...` from incoming chat messages,
 * dispatches to the registered handler, and enforces rate limits +
 * mod-only gates.
 *
 * Stateful (cooldown timestamps live in-memory) but the state is
 * scoped to a single router instance, so tests get a clean slate per
 * `createCommandRouter()`.
 */

import type {
  ChatBadge,
  CommandHandler,
  CommandRateLimit,
  CommandSpec,
  IncomingChatMessage,
  ParsedCommand,
} from "./types";

const DEFAULT_LIMIT: CommandRateLimit = {
  perUserSeconds: 30,
  globalSeconds: 5,
  modOnly: false,
};

const MOD_BADGES: ReadonlySet<ChatBadge> = new Set(["broadcaster", "moderator"]);

interface RouterOptions {
  /** Inject for deterministic tests. Defaults to Date.now(). */
  now?: () => number;
  /**
   * Optional listener for commands that were rejected by rate-limit /
   * mod-gate. Useful for telemetry; never required.
   */
  onRejected?: (reason: "cooldown_user" | "cooldown_global" | "mod_only" | "unknown_command", cmd: ParsedCommand) => void;
  /**
   * Optional listener for handler errors. The router still swallows
   * the throw so the dispatch loop continues, but a runner that wants
   * to log errors or surface them to the operator can attach here.
   */
  onHandlerError?: (err: unknown, cmd: ParsedCommand) => void;
}

/**
 * Parse a single chat message into a command, if it is one.
 * Returns null when the message doesn't start with `!` or has no name.
 */
export function parseCommand(message: IncomingChatMessage): ParsedCommand | null {
  const trimmed = message.text.trimStart();
  if (!trimmed.startsWith("!")) return null;
  // Strip leading `!`, split on whitespace. The first token is the
  // command name (lowercased); everything else is args (preserving
  // their original case).
  const [head, ...rest] = trimmed.slice(1).split(/\s+/).filter((p) => p.length > 0);
  if (!head) return null;
  return {
    name: head.toLowerCase(),
    args: rest,
    message,
  };
}

function isModerator(badges?: ChatBadge[]): boolean {
  if (!badges) return false;
  return badges.some((b) => MOD_BADGES.has(b));
}

/**
 * Build a router with no commands registered. Add commands via
 * `register()`, dispatch incoming chat via `dispatch()`.
 */
export function createCommandRouter(opts: RouterOptions = {}) {
  const now = opts.now ?? (() => Date.now());
  const handlers = new Map<string, { handler: CommandHandler; limit: CommandRateLimit }>();
  /** name -> last fire timestamp (ms). */
  const lastGlobal = new Map<string, number>();
  /** `${name}:${user}@${platform}` -> last fire timestamp (ms). */
  const lastUser = new Map<string, number>();

  function userKey(name: string, msg: IncomingChatMessage): string {
    return `${name}:${msg.user}@${msg.platform}`;
  }

  return {
    /**
     * Register or replace a command. Last registration wins so a
     * runner can swap handlers across reconfiguration without
     * re-creating the router.
     */
    register(spec: CommandSpec): void {
      handlers.set(spec.name.toLowerCase(), {
        handler: spec.handler,
        limit: { ...DEFAULT_LIMIT, ...spec.rateLimit },
      });
    },
    /** Remove a command. Idempotent — no-op if the name isn't registered. */
    unregister(name: string): void {
      handlers.delete(name.toLowerCase());
    },
    /** True if a command is currently registered under `name`. */
    has(name: string): boolean {
      return handlers.has(name.toLowerCase());
    },
    /**
     * Dispatch an incoming chat message. Parses it for a command,
     * checks rate limits / mod gate, and invokes the handler.
     *
     * Returns the dispatch outcome so the runner can update the
     * overlay (e.g. surface "command on cooldown" in the operator UI).
     */
    async dispatch(message: IncomingChatMessage): Promise<
      | { kind: "dispatched"; command: ParsedCommand }
      | { kind: "not_a_command" }
      | { kind: "rejected"; reason: "cooldown_user" | "cooldown_global" | "mod_only" | "unknown_command"; command: ParsedCommand }
    > {
      const parsed = parseCommand(message);
      if (!parsed) return { kind: "not_a_command" };
      const entry = handlers.get(parsed.name);
      if (!entry) {
        opts.onRejected?.("unknown_command", parsed);
        return { kind: "rejected", reason: "unknown_command", command: parsed };
      }
      const t = now();
      if (entry.limit.modOnly && !isModerator(message.badges)) {
        opts.onRejected?.("mod_only", parsed);
        return { kind: "rejected", reason: "mod_only", command: parsed };
      }
      const lastG = lastGlobal.get(parsed.name) ?? -Infinity;
      if (t - lastG < entry.limit.globalSeconds * 1000) {
        opts.onRejected?.("cooldown_global", parsed);
        return { kind: "rejected", reason: "cooldown_global", command: parsed };
      }
      const uKey = userKey(parsed.name, message);
      const lastU = lastUser.get(uKey) ?? -Infinity;
      if (t - lastU < entry.limit.perUserSeconds * 1000) {
        opts.onRejected?.("cooldown_user", parsed);
        return { kind: "rejected", reason: "cooldown_user", command: parsed };
      }
      // Cooldown stamp lands BEFORE the handler runs so a thrown
      // handler still consumes the window — that prevents a buggy
      // command from being spammed if the failure is intermittent.
      // Document this contract so a future reader doesn't assume the
      // cooldown is "successful invocations only".
      lastGlobal.set(parsed.name, t);
      lastUser.set(uKey, t);
      try {
        await entry.handler(parsed);
      } catch (err) {
        // Handler errors must not propagate — they'd stall the chat
        // dispatch loop. Surface via onHandlerError for runner-level
        // logging instead.
        opts.onHandlerError?.(err, parsed);
      }
      return { kind: "dispatched", command: parsed };
    },
  };
}

export type CommandRouter = ReturnType<typeof createCommandRouter>;
