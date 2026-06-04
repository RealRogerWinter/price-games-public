/**
 * Page → Node socket bridge. Surfaces the page's Socket.IO events to
 * the Node-side observer via two pieces:
 *
 *   1. A `Page.exposeBinding` that gives the page a callable
 *      `__pgBotForwardSocketEvent(kind, payload)`.
 *   2. An `addInitScript` that wraps `socket.io-client`'s emitted
 *      events. We patch the page's `window.io` after it's loaded so
 *      every server→client event also fires the binding.
 *
 * The bridge implements the `SocketLike` interface from the observer
 * so the existing `attachObserver()` works unchanged. `on()` /
 * `off()` register/deregister Node-side handlers; the page binding
 * fans into them.
 */

import type { SocketLike } from "../observer/observer";

type NodeHandler = (payload: unknown) => void;

export interface PageBridge extends SocketLike {
  /**
   * Called by Playwright's `exposeBinding` when the page-side script
   * forwards a server-emitted event. Public so the Driver can wire
   * Playwright's binding callback to it without circular imports.
   */
  ingest(kind: string, payload: unknown): void;
  /** True if we've registered a Node handler for `event`. */
  hasHandler(event: string): boolean;
}

/** Construct a bridge. Stateless except for the Node handler map. */
export function createPageBridge(): PageBridge {
  const handlers = new Map<string, Set<NodeHandler>>();
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
    ingest(kind, payload) {
      const set = handlers.get(kind);
      if (!set) return;
      for (const fn of [...set]) {
        try {
          fn(payload);
        } catch {
          // Observer handlers shouldn't throw, but if one does the
          // bridge mustn't break — we'd lose every subsequent event.
        }
      }
    },
    hasHandler(event) {
      return (handlers.get(event)?.size ?? 0) > 0;
    },
  };
}

/**
 * The script body to inject via `page.addInitScript`. Probes for the
 * page's socket.io-client instance and uses its documented
 * `onAny(name, ...args)` hook to forward every server→client event
 * to the Node binding.
 *
 * Socket.IO v4's `onAny` is the supported way to observe every event
 * a client receives without monkey-patching internals. We rely on
 * the price-game web app exposing the socket on `window.__pgBotSocket`
 * (a small change introduced alongside this PR; see
 * apps/web/src/api/socket.ts) — the bridge's probe falls back to
 * `window.io.socket` for older builds.
 *
 * The script is idempotent — re-attaching to a socket that's already
 * been hooked is a no-op.
 */
export const PAGE_BRIDGE_INIT_SCRIPT = `
  (function() {
    const BINDING = '__pgBotForwardSocketEvent';
    function forward(kind, payload) {
      try {
        if (typeof window[BINDING] === 'function') {
          window[BINDING](kind, payload);
        }
      } catch (e) {
        console.error('[bot-streamer] forward failed', e);
      }
    }
    function attach(socket) {
      if (!socket || socket.__pgBotPatched) return;
      if (typeof socket.onAny !== 'function') return;
      socket.__pgBotPatched = true;
      socket.onAny(function(eventName /*, ...args */) {
        forward(eventName, arguments[1]);
      });
    }
    // Solo gameplay is REST-driven, so the api client dispatches a
    // 'pg-bot-event' CustomEvent after each round-product response.
    // The bridge listens for both that event and the socket onAny
    // path, feeding both into the same Node binding.
    window.addEventListener('pg-bot-event', function(ev) {
      try {
        var detail = ev && ev.detail;
        if (detail && typeof detail.kind === 'string') {
          forward(detail.kind, detail.payload);
        }
      } catch (e) {
        console.error('[bot-streamer] window-event forward failed', e);
      }
    });
    let attempts = 0;
    const interval = setInterval(function() {
      attempts++;
      try {
        const candidate = window.__pgBotSocket || (window.io && window.io.socket);
        if (candidate) {
          attach(candidate);
          clearInterval(interval);
        }
      } catch (e) {
        console.error('[bot-streamer] bridge probe failed', e);
      }
      if (attempts > 600) clearInterval(interval); // 30s @ 50ms
    }, 50);
  })();
`;
