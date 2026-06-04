import { describe, it, expect, vi } from "vitest";
import { retryImport } from "../utils/lazyWithRetry";

describe("retryImport", () => {
  it("returns the module on first success", async () => {
    const mod = { default: () => null };
    const importFn = vi.fn().mockResolvedValue(mod);

    const result = await retryImport(importFn, 3, 0);
    expect(result).toBe(mod);
    expect(importFn).toHaveBeenCalledOnce();
  });

  it("retries on transient failure and succeeds", async () => {
    const mod = { default: () => null };
    const importFn = vi
      .fn()
      .mockRejectedValueOnce(new Error("network error"))
      .mockRejectedValueOnce(new Error("network error"))
      .mockResolvedValue(mod);

    const result = await retryImport(importFn, 3, 0);
    expect(result).toBe(mod);
    expect(importFn).toHaveBeenCalledTimes(3);
  });

  it("throws after exhausting all retries", async () => {
    const importFn = vi.fn().mockRejectedValue(new Error("chunk gone"));

    await expect(retryImport(importFn, 3, 0)).rejects.toThrow("chunk gone");
    expect(importFn).toHaveBeenCalledTimes(3);
  });
});
