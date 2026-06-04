/**
 * Tests for the push-notification service worker (public/sw.js).
 *
 * The SW is plain JS that runs outside the app bundle, so we evaluate its
 * source in a sandbox with mocked `self` / `clients` globals and capture the
 * arguments passed to `showNotification`. This lets us assert the notification
 * options align with Chrome's 2026 best practices (monochrome badge, no
 * always-on hero image, quiet renotify default, Android-friendly timestamp +
 * vibrate).
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

type Handlers = {
  push?: (e: unknown) => void;
  notificationclick?: (e: unknown) => void;
  pushsubscriptionchange?: (e: unknown) => void;
};

interface SwSandbox {
  showNotification: ReturnType<typeof vi.fn>;
  handlers: Handlers;
}

function loadServiceWorker(): SwSandbox {
  const swPath = resolve(__dirname, "../../public/sw.js");
  const src = readFileSync(swPath, "utf8");
  const handlers: Handlers = {};
  const showNotification = vi.fn().mockResolvedValue(undefined);
  const self = {
    addEventListener: (name: keyof Handlers, fn: (e: unknown) => void) => {
      handlers[name] = fn;
    },
    registration: {
      showNotification,
      pushManager: { subscribe: vi.fn() },
    },
    location: { origin: "https://price.games" },
  };
  const clients = {
    matchAll: vi.fn().mockResolvedValue([]),
    openWindow: vi.fn(),
  };
  const fn = new Function("self", "clients", src);
  fn(self, clients);
  return { showNotification, handlers };
}

function pushEvent(payload: unknown): unknown {
  return {
    data: {
      json: () => payload,
      text: () => JSON.stringify(payload),
    },
    waitUntil: (_p: unknown) => undefined,
  };
}

describe("service worker — push handler", () => {
  let sw: SwSandbox;

  beforeEach(() => {
    sw = loadServiceWorker();
  });

  it("registers a push handler", () => {
    expect(sw.handlers.push).toBeTypeOf("function");
  });

  it("uses /badge-96.png as the default Android status-bar icon", () => {
    sw.handlers.push!(pushEvent({ title: "T", body: "B" }));

    expect(sw.showNotification).toHaveBeenCalledTimes(1);
    const [, options] = sw.showNotification.mock.calls[0];
    expect(options.badge).toBe("/badge-96.png");
    expect(options.icon).toBe("/logo192.png");
  });

  it("does NOT include a hero image unless the payload explicitly sets one", () => {
    sw.handlers.push!(pushEvent({ title: "T", body: "B" }));
    const [, options] = sw.showNotification.mock.calls[0];
    expect(options.image).toBeUndefined();
  });

  it("includes the hero image when the payload provides it", () => {
    sw.handlers.push!(pushEvent({ title: "T", body: "B", image: "/notif/notif-daily.png" }));
    const [, options] = sw.showNotification.mock.calls[0];
    expect(options.image).toBe("/notif/notif-daily.png");
  });

  it("defaults renotify to false — quiet replacement for same-tag pushes", () => {
    sw.handlers.push!(pushEvent({ title: "T", body: "B", tag: "daily-puzzle" }));
    const [, options] = sw.showNotification.mock.calls[0];
    expect(options.renotify).toBe(false);
  });

  it("honors explicit renotify: true when the caller opts in", () => {
    sw.handlers.push!(pushEvent({ title: "T", body: "B", tag: "streak", renotify: true }));
    const [, options] = sw.showNotification.mock.calls[0];
    expect(options.renotify).toBe(true);
  });

  it("sets a timestamp for Android notification ordering", () => {
    sw.handlers.push!(pushEvent({ title: "T", body: "B" }));
    const [, options] = sw.showNotification.mock.calls[0];
    expect(typeof options.timestamp).toBe("number");
    expect(options.timestamp).toBeGreaterThan(0);
  });

  it("applies a default vibration pattern", () => {
    sw.handlers.push!(pushEvent({ title: "T", body: "B" }));
    const [, options] = sw.showNotification.mock.calls[0];
    expect(options.vibrate).toEqual([120, 60, 120]);
  });

  it("suppresses vibration when silent: true", () => {
    sw.handlers.push!(pushEvent({ title: "T", body: "B", silent: true }));
    const [, options] = sw.showNotification.mock.calls[0];
    expect(options.silent).toBe(true);
    expect(options.vibrate).toBeUndefined();
  });

  it("passes through custom vibration patterns", () => {
    sw.handlers.push!(pushEvent({ title: "T", body: "B", vibrate: [50, 50] }));
    const [, options] = sw.showNotification.mock.calls[0];
    expect(options.vibrate).toEqual([50, 50]);
  });

  it("forwards action buttons when provided", () => {
    const actions = [{ action: "play", title: "Play" }];
    sw.handlers.push!(pushEvent({ title: "T", body: "B", actions }));
    const [, options] = sw.showNotification.mock.calls[0];
    expect(options.actions).toEqual(actions);
  });

  it("stores the click-through URL in data.url", () => {
    sw.handlers.push!(pushEvent({ title: "T", body: "B", url: "/daily" }));
    const [, options] = sw.showNotification.mock.calls[0];
    expect(options.data.url).toBe("/daily");
  });

  it("falls back to a generic title when payload JSON is malformed", () => {
    const malformed = {
      data: {
        json: () => {
          throw new Error("not json");
        },
        text: () => "plain body text",
      },
      waitUntil: () => undefined,
    };
    sw.handlers.push!(malformed);
    const [title, options] = sw.showNotification.mock.calls[0];
    expect(title).toBe("Price Games");
    expect(options.body).toBe("plain body text");
  });
});
