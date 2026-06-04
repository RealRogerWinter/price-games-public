/**
 * Tests for the io.use() handshake middleware registered by
 * setupSocketHandlers. Focuses specifically on the streamer-bot
 * detection step — the cookie-parsing path is exercised via room
 * handler integration tests.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Server, Socket } from "socket.io";
import { config } from "../config";
import { STREAMER_BOT_HEADER } from "../middleware/streamerBot";

// Stub the DB import so setupSocketHandlers' call into validateUserSession
// (which would otherwise hit the real prod DB module) is harmless when no
// cookie header is present.
vi.mock("../db", () => ({ default: null as unknown }));

const { setupSocketHandlers } = await import("./handlers");

function setSecret(value: string): void {
  (config as unknown as { streamerBotSecret: string }).streamerBotSecret = value;
}

interface CapturedMiddleware {
  fn: (socket: Socket, next: (err?: Error) => void) => void;
}

/**
 * Build a fake `io` Server that captures the first `io.use()` callback
 * passed in by setupSocketHandlers. Only the surface used by that
 * function is implemented — `use` and `on`.
 */
function captureFirstUse(): { io: Server; captured: CapturedMiddleware } {
  const captured: CapturedMiddleware = { fn: () => {} };
  let usedOnce = false;
  const io = {
    use: (fn: typeof captured.fn) => {
      if (!usedOnce) {
        captured.fn = fn;
        usedOnce = true;
      }
    },
    on: () => {},
  } as unknown as Server;
  return { io, captured };
}

function fakeSocket(headers: Record<string, string | string[] | undefined>): Socket {
  return {
    handshake: { headers },
    data: {},
  } as unknown as Socket;
}

describe("setupSocketHandlers io.use — streamer-bot stamping", () => {
  const originalSecret = config.streamerBotSecret;
  let runMiddleware: (socket: Socket) => void;

  beforeEach(() => {
    const { io, captured } = captureFirstUse();
    setupSocketHandlers(io);
    runMiddleware = (socket) => {
      const next = vi.fn();
      captured.fn(socket, next);
      expect(next).toHaveBeenCalledOnce();
    };
  });
  afterEach(() => {
    setSecret(originalSecret);
  });

  it("stamps socket.data.isStreamerBot=true when the handshake header matches the secret", () => {
    setSecret("ws-secret-1");
    const socket = fakeSocket({ [STREAMER_BOT_HEADER]: "ws-secret-1" });
    runMiddleware(socket);
    expect(socket.data.isStreamerBot).toBe(true);
  });

  it("does not stamp the flag when the header is absent", () => {
    setSecret("ws-secret-1");
    const socket = fakeSocket({});
    runMiddleware(socket);
    expect(socket.data.isStreamerBot).toBeUndefined();
  });

  it("does not stamp the flag when the header is wrong", () => {
    setSecret("ws-secret-1");
    const socket = fakeSocket({ [STREAMER_BOT_HEADER]: "guess" });
    runMiddleware(socket);
    expect(socket.data.isStreamerBot).toBeUndefined();
  });

  it("does not stamp the flag when STREAMER_BOT_SECRET is unset (dev default)", () => {
    setSecret("");
    const socket = fakeSocket({ [STREAMER_BOT_HEADER]: "anything" });
    runMiddleware(socket);
    expect(socket.data.isStreamerBot).toBeUndefined();
  });

  it("handles array-valued headers (uses first entry)", () => {
    setSecret("ws-secret-1");
    const socket = fakeSocket({ [STREAMER_BOT_HEADER]: ["ws-secret-1", "ignored"] });
    runMiddleware(socket);
    expect(socket.data.isStreamerBot).toBe(true);
  });
});
