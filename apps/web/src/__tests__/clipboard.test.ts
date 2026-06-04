import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  canCopyText,
  canCopyImage,
  canShareNative,
  copyTextToClipboard,
  copyImageToClipboard,
  shareNative,
} from "../components/share/clipboard";

// The setupTests.ts global stubs are installed only if the property is missing.
// Per-test overrides use Object.defineProperty so we can replay the tests on
// different (mock) implementations without cross-talk.

function setNavigatorClipboard(value: unknown) {
  Object.defineProperty(navigator, "clipboard", {
    value,
    writable: true,
    configurable: true,
  });
}

function setNavigatorShare(fn: unknown) {
  Object.defineProperty(navigator, "share", {
    value: fn,
    writable: true,
    configurable: true,
  });
}

describe("feature detection", () => {
  let originalClipboard: PropertyDescriptor | undefined;
  let originalShare: PropertyDescriptor | undefined;
  let originalClipboardItem: typeof globalThis.ClipboardItem;

  beforeEach(() => {
    originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    originalShare = Object.getOwnPropertyDescriptor(navigator, "share");
    originalClipboardItem = globalThis.ClipboardItem;
  });

  afterEach(() => {
    if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard);
    if (originalShare) Object.defineProperty(navigator, "share", originalShare);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).ClipboardItem = originalClipboardItem;
  });

  describe("canCopyText", () => {
    it("returns true when navigator.clipboard.writeText is present", () => {
      setNavigatorClipboard({ writeText: vi.fn() });
      expect(canCopyText()).toBe(true);
    });

    it("returns false when navigator.clipboard is undefined", () => {
      setNavigatorClipboard(undefined);
      expect(canCopyText()).toBe(false);
    });

    it("returns false when writeText is missing", () => {
      setNavigatorClipboard({});
      expect(canCopyText()).toBe(false);
    });
  });

  describe("canCopyImage", () => {
    it("returns true when write + ClipboardItem are both present", () => {
      setNavigatorClipboard({ write: vi.fn() });
      // ClipboardItem is already stubbed globally; ensure it's defined.
      expect(typeof globalThis.ClipboardItem).not.toBe("undefined");
      expect(canCopyImage()).toBe(true);
    });

    it("returns false when clipboard.write is missing", () => {
      setNavigatorClipboard({});
      expect(canCopyImage()).toBe(false);
    });

    it("returns false when ClipboardItem is undefined (Firefox-like)", () => {
      setNavigatorClipboard({ write: vi.fn() });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).ClipboardItem = undefined;
      expect(canCopyImage()).toBe(false);
    });
  });

  describe("canShareNative", () => {
    it("returns true when navigator.share is a function", () => {
      setNavigatorShare(vi.fn());
      expect(canShareNative()).toBe(true);
    });

    it("returns false when navigator.share is undefined", () => {
      setNavigatorShare(undefined);
      expect(canShareNative()).toBe(false);
    });
  });
});

describe("copyTextToClipboard", () => {
  let originalClipboard: PropertyDescriptor | undefined;

  beforeEach(() => {
    originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  });
  afterEach(() => {
    if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard);
  });

  it("calls navigator.clipboard.writeText with the provided text", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setNavigatorClipboard({ writeText });
    await copyTextToClipboard("hello world");
    expect(writeText).toHaveBeenCalledWith("hello world");
  });

  it("rejects when the Clipboard API is unavailable", async () => {
    setNavigatorClipboard(undefined);
    await expect(copyTextToClipboard("hi")).rejects.toThrow(
      /Clipboard text API is not available/
    );
  });

  it("propagates errors from writeText", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    setNavigatorClipboard({ writeText });
    await expect(copyTextToClipboard("hi")).rejects.toThrow("denied");
  });
});

describe("copyImageToClipboard", () => {
  let originalClipboard: PropertyDescriptor | undefined;
  let originalClipboardItem: typeof globalThis.ClipboardItem;

  beforeEach(() => {
    originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    originalClipboardItem = globalThis.ClipboardItem;
  });
  afterEach(() => {
    if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).ClipboardItem = originalClipboardItem;
  });

  it("wraps the blob in a ClipboardItem and calls clipboard.write", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    setNavigatorClipboard({ write });
    const blob = new Blob(["png-bytes"], { type: "image/png" });
    await copyImageToClipboard(blob);
    expect(write).toHaveBeenCalledTimes(1);
    const arg = write.mock.calls[0][0];
    expect(Array.isArray(arg)).toBe(true);
    expect(arg[0]).toBeInstanceOf(globalThis.ClipboardItem);
  });

  it("rejects when the Clipboard image API is unavailable", async () => {
    setNavigatorClipboard({});
    const blob = new Blob(["x"], { type: "image/png" });
    await expect(copyImageToClipboard(blob)).rejects.toThrow(
      /Clipboard image API is not available/
    );
  });

  it("rejects when ClipboardItem is undefined", async () => {
    setNavigatorClipboard({ write: vi.fn() });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).ClipboardItem = undefined;
    const blob = new Blob(["x"], { type: "image/png" });
    await expect(copyImageToClipboard(blob)).rejects.toThrow(
      /Clipboard image API is not available/
    );
  });

  it("propagates errors from clipboard.write", async () => {
    const write = vi.fn().mockRejectedValue(new Error("permission denied"));
    setNavigatorClipboard({ write });
    const blob = new Blob(["x"], { type: "image/png" });
    await expect(copyImageToClipboard(blob)).rejects.toThrow("permission denied");
  });
});

describe("shareNative", () => {
  let originalShare: PropertyDescriptor | undefined;

  beforeEach(() => {
    originalShare = Object.getOwnPropertyDescriptor(navigator, "share");
  });
  afterEach(() => {
    if (originalShare) Object.defineProperty(navigator, "share", originalShare);
    else {
      // Ensure navigator.share is cleared if we set it.
      Object.defineProperty(navigator, "share", {
        value: undefined,
        writable: true,
        configurable: true,
      });
    }
  });

  it("calls navigator.share with the payload", async () => {
    const shareFn = vi.fn().mockResolvedValue(undefined);
    setNavigatorShare(shareFn);
    await shareNative({ title: "t", text: "body", url: "https://price.games" });
    expect(shareFn).toHaveBeenCalledWith({
      title: "t",
      text: "body",
      url: "https://price.games",
    });
  });

  it("rejects when navigator.share is unavailable", async () => {
    setNavigatorShare(undefined);
    await expect(shareNative({ title: "t" })).rejects.toThrow(
      /Web Share API is not available/
    );
  });

  it("silently resolves when the user cancels (DOMException AbortError)", async () => {
    const shareFn = vi.fn().mockRejectedValue(
      new DOMException("cancelled", "AbortError")
    );
    setNavigatorShare(shareFn);
    await expect(shareNative({ title: "t" })).resolves.toBeUndefined();
  });

  it("silently resolves when the user cancels (plain object with AbortError name)", async () => {
    const shareFn = vi.fn().mockRejectedValue({ name: "AbortError" });
    setNavigatorShare(shareFn);
    await expect(shareNative({ title: "t" })).resolves.toBeUndefined();
  });

  it("propagates non-abort errors", async () => {
    const shareFn = vi.fn().mockRejectedValue(new Error("boom"));
    setNavigatorShare(shareFn);
    await expect(shareNative({ title: "t" })).rejects.toThrow("boom");
  });
});
