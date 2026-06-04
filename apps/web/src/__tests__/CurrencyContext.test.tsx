import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { CurrencyProvider, useCurrency } from "../context/CurrencyContext";

function wrapper({ children }: { children: React.ReactNode }) {
  return <CurrencyProvider>{children}</CurrencyProvider>;
}

describe("CurrencyContext", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    localStorage.clear();
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ rates: { EUR: 0.92, GBP: 0.79, JPY: 150 } }))
    );
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("defaults to USD currency", () => {
    const { result } = renderHook(() => useCurrency(), { wrapper });
    expect(result.current.currency).toBe("USD");
  });

  it("formats price in USD", () => {
    const { result } = renderHook(() => useCurrency(), { wrapper });
    expect(result.current.formatPrice(1999)).toBe("$19.99");
    expect(result.current.formatPrice(100)).toBe("$1.00");
    expect(result.current.formatPrice(50)).toBe("$0.50");
  });

  it("parses USD input to cents", () => {
    const { result } = renderHook(() => useCurrency(), { wrapper });
    expect(result.current.parseInput("19.99")).toBe(1999);
    expect(result.current.parseInput("$19.99")).toBe(1999);
    expect(result.current.parseInput("100")).toBe(10000);
  });

  it("parses invalid input as 0", () => {
    const { result } = renderHook(() => useCurrency(), { wrapper });
    expect(result.current.parseInput("abc")).toBe(0);
    expect(result.current.parseInput("")).toBe(0);
  });

  it("changes currency and saves to localStorage", () => {
    const { result } = renderHook(() => useCurrency(), { wrapper });
    act(() => result.current.setCurrency("EUR"));
    expect(result.current.currency).toBe("EUR");
    expect(localStorage.getItem("selected_currency")).toBe("EUR");
  });

  it("restores saved currency from localStorage", () => {
    localStorage.setItem("selected_currency", "GBP");
    const { result } = renderHook(() => useCurrency(), { wrapper });
    expect(result.current.currency).toBe("GBP");
  });

  it("throws when useCurrency is used outside provider", () => {
    expect(() => {
      renderHook(() => useCurrency());
    }).toThrow("useCurrency must be used within a CurrencyProvider");
  });

  it("fetches exchange rates on mount", async () => {
    renderHook(() => useCurrency(), { wrapper });
    expect(fetchSpy).toHaveBeenCalledWith("/api/exchange-rates");
  });

  it("formats prices in foreign currencies after rates load", async () => {
    const { result } = renderHook(() => useCurrency(), { wrapper });

    // Wait for fetch to resolve
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    act(() => result.current.setCurrency("EUR"));
    // 1000 cents = $10.00 * 0.92 = €9.20
    expect(result.current.formatPrice(1000)).toBe("\u20ac9.20");
  });

  it("formats JPY without decimals", async () => {
    const { result } = renderHook(() => useCurrency(), { wrapper });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    act(() => result.current.setCurrency("JPY"));
    // 1000 cents = $10.00 * 150 = ¥1500
    expect(result.current.formatPrice(1000)).toBe("\u00a51500");
  });

  it("falls back to USD formatting when rate unavailable", async () => {
    const { result } = renderHook(() => useCurrency(), { wrapper });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    act(() => result.current.setCurrency("ZZZ"));
    expect(result.current.formatPrice(1999)).toBe("$19.99");
  });

  it("converts foreign input back to USD cents", async () => {
    const { result } = renderHook(() => useCurrency(), { wrapper });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    act(() => result.current.setCurrency("EUR"));
    // Input "9.20" EUR → 9.20 / 0.92 * 100 = 1000 cents
    expect(result.current.parseInput("9.20")).toBe(1000);
  });
});
