import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { reportImageFailure } from "../lib/imageDiagnostics";

describe("imageDiagnostics.reportImageFailure", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let gtagCalls: unknown[][];

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    gtagCalls = [];
    // Stub gtag so trackEvent forwards to our spy array.
    (globalThis as unknown as { window: Window & { gtag?: (...args: unknown[]) => void } }).window =
      globalThis as unknown as Window & { gtag?: (...args: unknown[]) => void };
    (window as unknown as { gtag?: (...args: unknown[]) => void }).gtag = (...args: unknown[]) => {
      gtagCalls.push(args);
    };
  });

  afterEach(() => {
    warnSpy.mockRestore();
    delete (window as unknown as { gtag?: (...args: unknown[]) => void }).gtag;
  });

  it("emits a console.warn with structured payload", () => {
    reportImageFailure({ productId: 42, src: "/api/image/42", phase: "error" });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [tag, payload] = warnSpy.mock.calls[0];
    expect(tag).toBe("[image-diagnostics]");
    expect(payload).toMatchObject({
      product_id: 42,
      phase: "error",
    });
    expect(payload).toHaveProperty("is_ios");
    expect(payload).toHaveProperty("visibility");
    expect(payload).toHaveProperty("src_host");
  });

  it("forwards to gtag as image_load_fail when available", () => {
    reportImageFailure({ productId: 7, src: "/api/image/7", phase: "placeholder" });
    expect(gtagCalls).toHaveLength(1);
    const [event, name, params] = gtagCalls[0] as [string, string, Record<string, unknown>];
    expect(event).toBe("event");
    expect(name).toBe("image_load_fail");
    expect(params.product_id).toBe(7);
    expect(params.phase).toBe("placeholder");
  });

  it("handles missing src gracefully", () => {
    reportImageFailure({ phase: "timeout" });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const payload = warnSpy.mock.calls[0][1] as Record<string, unknown>;
    expect(payload.product_id).toBe(0);
    expect(payload.src_host).toBe("");
  });

  it("sets src_host from the URL host when src is a full URL", () => {
    reportImageFailure({ src: "https://m.media-amazon.com/foo.jpg", phase: "error" });
    const payload = warnSpy.mock.calls[0][1] as Record<string, unknown>;
    expect(payload.src_host).toBe("m.media-amazon.com");
  });
});
