import { describe, it, expect, vi } from "vitest";
import { chatPipelineSubscriber } from "../src/runner/chatPipeline";
import { createCommandRouter } from "../src/chat/router";
import type { OverlayForwarder } from "../src/runner/overlay";
import type { IncomingChatMessage } from "../src/chat/types";

function msg(text: string): IncomingChatMessage {
  return { id: "m1", platform: "twitch", user: "alice", text, badges: [], at: 1000 };
}

function recordingOverlay(): OverlayForwarder & { calls: Array<{ kind: string; payload?: unknown }> } {
  const calls: Array<{ kind: string; payload?: unknown }> = [];
  return {
    calls,
    async send(kind, payload) {
      calls.push({ kind, payload });
    },
  };
}

describe("chatPipelineSubscriber", () => {
  it("dispatches the message to the router AND forwards it to the overlay's chat.message", async () => {
    const router = createCommandRouter();
    const dispatchSpy = vi.spyOn(router, "dispatch");
    const overlay = recordingOverlay();
    const sub = chatPipelineSubscriber({ router, getOverlay: () => overlay });

    sub(msg("hello stream"));
    // dispatch is async via void, but sync up to the await — let microtasks settle.
    await Promise.resolve();

    expect(dispatchSpy).toHaveBeenCalledOnce();
    expect(dispatchSpy.mock.calls[0][0].text).toBe("hello stream");
    expect(overlay.calls).toEqual([{ kind: "chat.message", payload: expect.objectContaining({ text: "hello stream", user: "alice", platform: "twitch" }) }]);
  });

  it("still dispatches to the router when the overlay isn't ready yet", async () => {
    // overlayRef in main.ts is null until createOverlayForwarder is built;
    // chat that arrives in that window must still go to the command router.
    const router = createCommandRouter();
    const dispatchSpy = vi.spyOn(router, "dispatch");
    const sub = chatPipelineSubscriber({ router, getOverlay: () => null });

    sub(msg("!hint"));
    await Promise.resolve();

    expect(dispatchSpy).toHaveBeenCalledOnce();
  });

  it("re-evaluates getOverlay on every call so a late-bound overlay starts receiving messages", async () => {
    const router = createCommandRouter();
    let overlay: OverlayForwarder | null = null;
    const sub = chatPipelineSubscriber({ router, getOverlay: () => overlay });

    sub(msg("first"));
    overlay = recordingOverlay();
    sub(msg("second"));

    expect((overlay as ReturnType<typeof recordingOverlay>).calls).toHaveLength(1);
    expect((overlay as ReturnType<typeof recordingOverlay>).calls[0].payload).toMatchObject({ text: "second" });
  });

  it("logs (rather than swallows) router.dispatch rejections", async () => {
    const router = createCommandRouter();
    vi.spyOn(router, "dispatch").mockRejectedValue(new Error("router boom"));
    const overlay = recordingOverlay();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => { /* swallow during test */ });
    const sub = chatPipelineSubscriber({ router, getOverlay: () => overlay });

    sub(msg("hello"));
    // Allow the rejected promise's catch handler to flush.
    await new Promise((r) => setImmediate(r));

    expect(warn).toHaveBeenCalled();
    const firstCall = warn.mock.calls[0];
    expect(String(firstCall[0])).toContain("router.dispatch");
    // Even with router rejecting, overlay still got the message.
    expect(overlay.calls).toHaveLength(1);
    warn.mockRestore();
  });

  it("logs (rather than swallows) overlay.send rejections", async () => {
    const router = createCommandRouter();
    const overlay: OverlayForwarder = { async send() { throw new Error("overlay boom"); } };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => { /* swallow during test */ });
    const sub = chatPipelineSubscriber({ router, getOverlay: () => overlay });

    sub(msg("hi"));
    await new Promise((r) => setImmediate(r));

    expect(warn).toHaveBeenCalled();
    const firstCall = warn.mock.calls[0];
    expect(String(firstCall[0])).toContain("overlay.send");
    warn.mockRestore();
  });
});
