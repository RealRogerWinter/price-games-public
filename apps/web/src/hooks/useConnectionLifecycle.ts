import { useEffect, useRef } from "react";
import type { Socket } from "socket.io-client";
import { SOCKET_EVENTS } from "@price-game/shared";

/**
 * How long the tab may stay hidden before we proactively drop the socket.
 *
 * Bumped from 60s → 5 min after user reports of being silently dropped
 * mid-think while glancing at another app. The original 60s was tuned
 * against mobile OS freeze behaviour, but mobile browsers actually pause
 * timers in the background well before that window elapses anyway, so
 * the practical effect was just punishing power-users who tabbed away
 * briefly. Five minutes splits the difference: long enough that a quick
 * notification check doesn't cost the round, short enough that a phone
 * sitting in a pocket overnight still tears down cleanly.
 */
const HIDDEN_DISCONNECT_MS = 300_000;
/** How long we'll wait for a heartbeat ack on resume before forcing a reconnect. */
const HEARTBEAT_TIMEOUT_MS = 5_000;

interface Options {
  /** Reads the current socket lazily so we always act on the live instance. */
  getSocket: () => Socket | null;
  /** Called when we want to (re)start a connection attempt. */
  connect: () => void;
  /** Called when we want to stop the connection (e.g., long background). */
  disconnect: () => void;
  /** Optional: toggles this hook off entirely (e.g., outside a game). */
  enabled?: boolean;
  /**
   * When `false`, the visibilitychange-hidden timer never arms — even if
   * the tab is hidden on mount or transitions to hidden later. Other
   * lifecycle reactions (heartbeat on resume, online/offline, bfcache,
   * Chromium freeze/resume) still run.
   *
   * Threaded down from `MultiplayerPage` so the proactive disconnect
   * only kicks in when the user is mid-round. On lobby / results /
   * join screens, hiding the tab is an everyday user action (checking
   * a notification, looking up a price) — silently dropping the socket
   * there caused players to come back to a "Reconnecting..." overlay
   * for no reason, sometimes followed by an auto-yank back to a game
   * they'd already left. Defaults to `true` to preserve the original
   * behaviour for callers that don't need the discrimination.
   */
  shouldArmHiddenDisconnect?: boolean;
}

/**
 * Store `value` in a ref whose `.current` always mirrors the latest
 * render's value without invalidating effect dependencies. Lets the
 * listener-registration effect run exactly once per enabled/disabled
 * transition instead of on every parent re-render.
 */
function useLatestRef<T>(value: T) {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}

/**
 * Watches Page Lifecycle + network events and reacts so mobile tab
 * backgrounding, bfcache transitions, and OS-level freezes don't leave
 * the user stuck behind a dead WebSocket.
 *
 * - `visibilitychange → hidden` for 60 s: proactively disconnect.
 *   Leaving a dying socket to spin down on its own costs battery and
 *   delays reconnect. The `pagehide`/`freeze` events are not reliably
 *   fired on mobile — `visibilitychange` is the canonical signal.
 * - `visibilitychange → visible`:
 *     - disconnected socket → `connect()`;
 *     - "connected" socket → heartbeat with a short ack timeout. If
 *       the ack doesn't come back, the socket is a zombie (iOS Safari
 *       leaves `readyState === OPEN` after airplane-mode toggles;
 *       WebKit bug 247943). Force a disconnect+reconnect.
 * - `pagehide` with `event.persisted === true` (bfcache entry): close.
 *   Open WebSockets block bfcache eligibility.
 * - `pageshow` with `event.persisted === true`: reconnect.
 * - Chromium `freeze` / `resume`: treat like pagehide/pageshow.
 * - `window offline`: close the socket; `online`: reconnect.
 */
export function useConnectionLifecycle({
  getSocket,
  connect,
  disconnect,
  enabled = true,
  shouldArmHiddenDisconnect = true,
}: Options): void {
  const hiddenTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const heartbeatTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Monotonic heartbeat id so a late ack for heartbeat N never clears
  // the timer for heartbeat N+1 — that race would mask a real zombie
  // socket on the second resume.
  const heartbeatIdRef = useRef(0);

  // Route the caller's callbacks through refs so the listener-
  // registration effect depends only on `enabled`. Without this, a
  // parent re-render that hands us new arrow functions would tear down
  // and re-register every listener on each render; if that happened
  // while the tab was hidden, the 5-min hidden-timer would be lost.
  const getSocketRef = useLatestRef(getSocket);
  const connectRef = useLatestRef(connect);
  const disconnectRef = useLatestRef(disconnect);
  // Read shouldArmHiddenDisconnect through a ref for the same reason —
  // a parent prop change must not tear down listeners. The visibility
  // handler always reads `.current`, so it sees the latest value when
  // the tab transitions to hidden.
  const shouldArmRef = useLatestRef(shouldArmHiddenDisconnect);

  useEffect(() => {
    if (!enabled) return;
    if (typeof document === "undefined") return;

    const clearHiddenTimer = () => {
      if (hiddenTimerRef.current) {
        clearTimeout(hiddenTimerRef.current);
        hiddenTimerRef.current = null;
      }
    };

    const armHiddenTimer = () => {
      clearHiddenTimer();
      // Caller opted out (e.g., user is on lobby/results/join). We
      // still want every other lifecycle reaction to run, just not the
      // proactive disconnect.
      if (!shouldArmRef.current) return;
      hiddenTimerRef.current = setTimeout(() => {
        hiddenTimerRef.current = null;
        disconnectRef.current();
      }, HIDDEN_DISCONNECT_MS);
    };

    const sendHeartbeat = () => {
      const socket = getSocketRef.current();
      if (!socket || !socket.connected) return;
      const myId = ++heartbeatIdRef.current;
      // Clear any prior timer — a new heartbeat supersedes the old one.
      if (heartbeatTimerRef.current) {
        clearTimeout(heartbeatTimerRef.current);
        heartbeatTimerRef.current = null;
      }
      // Arm the zombie-detection timer BEFORE emitting. A synchronous
      // ack (mocks in tests; happens in real code if the transport
      // happens to already hold a pending packet) would otherwise fire
      // the callback first and find no timer to cancel.
      heartbeatTimerRef.current = setTimeout(() => {
        heartbeatTimerRef.current = null;
        // Only act if we are still the latest heartbeat.
        if (myId !== heartbeatIdRef.current) return;
        const s = getSocketRef.current();
        if (s) s.disconnect();
        connectRef.current();
      }, HEARTBEAT_TIMEOUT_MS);
      socket.emit(SOCKET_EVENTS.MP_HEARTBEAT, {}, () => {
        // Ack matches our nonce → cancel the zombie check. A late ack
        // from a superseded heartbeat is a no-op.
        if (myId !== heartbeatIdRef.current) return;
        if (heartbeatTimerRef.current) {
          clearTimeout(heartbeatTimerRef.current);
          heartbeatTimerRef.current = null;
        }
      });
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        armHiddenTimer();
      } else {
        clearHiddenTimer();
        const socket = getSocketRef.current();
        if (!socket || !socket.connected) {
          connectRef.current();
        } else {
          sendHeartbeat();
        }
      }
    };

    const onPageHide = (e: PageTransitionEvent) => {
      if (e.persisted) disconnectRef.current();
    };
    const onPageShow = (e: PageTransitionEvent) => {
      if (e.persisted) connectRef.current();
    };

    const onFreeze = () => disconnectRef.current();
    const onResume = () => connectRef.current();

    const onOffline = () => disconnectRef.current();
    const onOnline = () => connectRef.current();

    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("pageshow", onPageShow);
    // `freeze`/`resume` are Chromium-only; other browsers simply never
    // fire them, which is fine.
    document.addEventListener("freeze", onFreeze as EventListener);
    document.addEventListener("resume", onResume as EventListener);
    window.addEventListener("offline", onOffline);
    window.addEventListener("online", onOnline);

    // If we mount while the tab is already hidden (e.g., bfcache
    // restore, window opened then immediately backgrounded), arm the
    // hidden-timer right away — otherwise it'd only arm on the next
    // hide transition, which may never come.
    if (document.visibilityState === "hidden") {
      armHiddenTimer();
    }

    return () => {
      clearHiddenTimer();
      if (heartbeatTimerRef.current) {
        clearTimeout(heartbeatTimerRef.current);
        heartbeatTimerRef.current = null;
      }
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("pageshow", onPageShow);
      document.removeEventListener("freeze", onFreeze as EventListener);
      document.removeEventListener("resume", onResume as EventListener);
      window.removeEventListener("offline", onOffline);
      window.removeEventListener("online", onOnline);
    };
  }, [enabled]);

  // When `shouldArmHiddenDisconnect` flips, react immediately so a
  // round ending mid-hidden-tab doesn't still drop the user 4 minutes
  // later. Flipping false → true while hidden re-arms so a freshly-
  // started round still gets its grace window.
  useEffect(() => {
    if (!enabled) return;
    if (typeof document === "undefined") return;
    if (!shouldArmHiddenDisconnect) {
      // Cancel a running timer that was armed under the previous
      // (active) state.
      if (hiddenTimerRef.current) {
        clearTimeout(hiddenTimerRef.current);
        hiddenTimerRef.current = null;
      }
      return;
    }
    // Newly active and tab is already hidden — arm the timer now;
    // otherwise we'd only arm on the next hide transition.
    if (document.visibilityState === "hidden" && !hiddenTimerRef.current) {
      hiddenTimerRef.current = setTimeout(() => {
        hiddenTimerRef.current = null;
        disconnectRef.current();
      }, HIDDEN_DISCONNECT_MS);
    }
  }, [enabled, shouldArmHiddenDisconnect]);
}
