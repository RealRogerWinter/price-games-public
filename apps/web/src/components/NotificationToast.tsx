/**
 * In-app notification toast component.
 *
 * Listens for NOTIFICATION_RECEIVED Socket.IO events and displays a brief
 * banner at the top of the screen. Auto-dismisses after 5 seconds.
 * Provides instant in-app notification even when push permission is denied.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { useNavigate } from "react-router-dom";
import type { NotificationReceivedPayload } from "@price-game/shared";
import { SOCKET_EVENTS } from "@price-game/shared";
import { getSocket } from "../api/socket";

const TOAST_DURATION_MS = 5000;

interface ToastItem {
  id: number;
  payload: NotificationReceivedPayload;
}

let nextId = 0;

/**
 * Global notification toast manager.
 * Mount once at the app root level.
 */
export default function NotificationToast() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const navigate = useNavigate();
  const timersRef = useRef<Map<number, NodeJS.Timeout>>(new Map());

  const addToast = useCallback((payload: NotificationReceivedPayload) => {
    const id = nextId++;
    setToasts((prev) => [...prev, { id, payload }]);

    const timer = setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
      timersRef.current.delete(id);
    }, TOAST_DURATION_MS);

    timersRef.current.set(id, timer);
  }, []);

  const dismissToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
    const timer = timersRef.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timersRef.current.delete(id);
    }
  }, []);

  // Listen for socket events (active when socket is connected, e.g., multiplayer)
  useEffect(() => {
    const socket = getSocket();

    const handler = (payload: NotificationReceivedPayload) => {
      addToast(payload);
    };

    socket.on(SOCKET_EVENTS.NOTIFICATION_RECEIVED, handler);
    return () => {
      socket.off(SOCKET_EVENTS.NOTIFICATION_RECEIVED, handler);
    };
  }, [addToast]);

  // Cleanup timers on unmount
  useEffect(() => {
    return () => {
      timersRef.current.forEach((timer) => clearTimeout(timer));
    };
  }, []);

  if (toasts.length === 0) return null;

  return (
    <div className="notif-toast-container" data-testid="notif-toast-container">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className="notif-toast"
          onClick={() => {
            const url = toast.payload.url;
            if (url && url.startsWith("/") && !url.startsWith("//")) navigate(url);
            dismissToast(toast.id);
          }}
          role="alert"
          data-testid="notif-toast"
        >
          <div className="notif-toast-content">
            <strong className="notif-toast-title">{toast.payload.title}</strong>
            <span className="notif-toast-body">{toast.payload.body}</span>
          </div>
          <button
            className="notif-toast-close"
            onClick={(e) => {
              e.stopPropagation();
              dismissToast(toast.id);
            }}
            aria-label="Dismiss notification"
          >
            &times;
          </button>
        </div>
      ))}
    </div>
  );
}
