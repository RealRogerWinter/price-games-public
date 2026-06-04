import "@testing-library/jest-dom/vitest";
import { configure } from "@testing-library/dom";
import { vi } from "vitest";
import type React from "react";

// =============================================================================
// Sound engine mock — the SoundContext requires a SoundProvider wrapper which
// most component tests don't include. Mock the module globally so useSound()
// returns no-op functions and the SoundProvider is a transparent passthrough.
// =============================================================================

vi.mock("./audio/SoundContext", () => ({
  useSound: () => ({
    play: () => {},
    stop: () => {},
    stopAll: () => {},
    volume: 0.5,
    setVolume: () => {},
    muted: false,
    setMuted: () => {},
    unlocked: true,
  }),
  SoundProvider: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock("./audio/SoundEngine", () => ({
  soundEngine: {
    play: () => {},
    stop: () => {},
    stopAll: () => {},
    unlock: () => {},
    setVolume: () => {},
    getVolume: () => 0.5,
    setMuted: () => {},
    isMuted: () => false,
    isUnlocked: () => true,
    subscribe: () => () => {},
    getSnapshot: () => ({ volume: 0.5, muted: false, unlocked: true }),
  },
}));

// CI containers are resource-constrained; bump the default waitFor timeout
// from 1 000 ms to 10 000 ms so lazy-loaded React components have time to
// resolve during module import.
configure({ asyncUtilTimeout: 10_000 });

// =============================================================================
// jsdom polyfills for the browser APIs the Share Results feature relies on.
//
// Important: these use *plain* functions, not vi.fn(), because vitest's
// restoreMocks: true option resets every vi.fn implementation between tests,
// which would wipe out any spies installed here and leave us with undefined-
// returning stubs. Plain assignments are invisible to restoreMocks so they
// survive the whole suite.
// =============================================================================

// --- Canvas ------------------------------------------------------------------
//
// jsdom ships no canvas implementation at all: HTMLCanvasElement.prototype
// .getContext returns null and toBlob is not defined. We install a minimal
// spy context so components that use <canvas> (e.g. the share card renderer)
// can import and run in unit tests without pulling in the native `canvas`
// npm package. Tests that need to assert specific draw calls can pass a spy
// object directly to the pure draw functions in shareCanvas.ts.

const createCanvasContextSpy = () => {
  const state: Record<string, unknown> = {
    fillStyle: "",
    font: "",
    textAlign: "start",
    textBaseline: "alphabetic",
  };
  return new Proxy(state, {
    get(target, prop: string) {
      if (prop in target) return target[prop];
      // Every unknown property read (method call) returns a no-op so
      // chained accesses don't throw.
      return () => undefined;
    },
    set(target, prop: string, value: unknown) {
      target[prop] = value;
      return true;
    },
  });
};

HTMLCanvasElement.prototype.getContext = function getContext(
  this: HTMLCanvasElement,
  contextId: string
): RenderingContext | null {
  // Only satisfy 2d context requests; bitmap/webgl are out of scope.
  if (contextId === "2d") {
    return createCanvasContextSpy() as unknown as CanvasRenderingContext2D;
  }
  return null;
} as typeof HTMLCanvasElement.prototype.getContext;

HTMLCanvasElement.prototype.toBlob = function toBlob(
  this: HTMLCanvasElement,
  callback: BlobCallback,
  type?: string
) {
  callback(new Blob(["mock-png-bytes"], { type: type ?? "image/png" }));
} as typeof HTMLCanvasElement.prototype.toBlob;

// --- URL.createObjectURL / revokeObjectURL -----------------------------------
//
// Missing in jsdom but required by the share modal to render the PNG blob
// as an <img src>. Stub both with plain functions.

if (typeof URL.createObjectURL !== "function") {
  URL.createObjectURL = function createObjectURL() {
    return "blob:mock-share-card";
  } as typeof URL.createObjectURL;
}
if (typeof URL.revokeObjectURL !== "function") {
  URL.revokeObjectURL = function revokeObjectURL() {
    /* noop */
  } as typeof URL.revokeObjectURL;
}

// --- Clipboard ---------------------------------------------------------------
//
// navigator.clipboard is undefined in jsdom. Tests that need to assert
// specific clipboard behavior (clipboard.ts, ShareModal.tsx) can override
// this per-test via Object.defineProperty in beforeEach/afterEach.

if (!("clipboard" in navigator)) {
  Object.defineProperty(navigator, "clipboard", {
    value: {
      writeText: async () => undefined,
      write: async () => undefined,
    },
    writable: true,
    configurable: true,
  });
}

// ClipboardItem is required for clipboard.write() to succeed. Install a
// minimal stub class so callers can do `new ClipboardItem({...})`.
if (typeof globalThis.ClipboardItem === "undefined") {
  class MockClipboardItem {
    constructor(public readonly data: Record<string, Blob | Promise<Blob>>) {}
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).ClipboardItem = MockClipboardItem;
}
