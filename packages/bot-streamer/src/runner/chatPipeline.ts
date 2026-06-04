/**
 * Chat-pipeline subscriber: bridges the chat aggregator to BOTH the
 * command router (so `!commands` fire) AND the broadcast overlay's
 * `chat.message` panel (so viewers see what was said on stream).
 *
 * Extracted from main.ts so the wiring is unit-testable without booting
 * Playwright + Pulse + Xvfb.
 */
import type { IncomingChatMessage } from "../chat/types";
import type { CommandRouter } from "../chat/router";
import type { OverlayForwarder } from "./overlay";

export interface ChatPipelineDeps {
  router: CommandRouter;
  /**
   * Lazy getter so the subscriber can be wired before the overlay
   * forwarder exists. main.ts builds the overlay after the aggregator
   * setup; messages only arrive once both are wired, so the indirection
   * is invisible at runtime.
   */
  getOverlay: () => OverlayForwarder | null;
}

export function chatPipelineSubscriber(deps: ChatPipelineDeps): (msg: IncomingChatMessage) => void {
  return (msg) => {
    // Surface async rejections via console.warn instead of swallowing
    // them silently. router.dispatch is fire-and-forget by design
    // (the subscriber callback is sync), but a router handler bug
    // shouldn't go invisible.
    deps.router.dispatch(msg).catch((err: unknown) => {
      console.warn("[chat-pipeline] router.dispatch rejected:", err);
    });
    const ovr = deps.getOverlay();
    if (ovr) {
      ovr.send("chat.message", msg).catch((err: unknown) => {
        console.warn("[chat-pipeline] overlay.send rejected:", err);
      });
    }
  };
}
