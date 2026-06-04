import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, fireEvent } from "@testing-library/react";
import CurrencySelector from "../components/CurrencySelector";
import { renderWithProviders } from "./testUtils";

describe("CurrencySelector", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    localStorage.clear();
    // Response bodies are single-use streams, so `mockResolvedValue(new Response(...))`
    // breaks once more than one hook fetches (e.g. CurrencyProvider + UserAuthProvider
    // both run on mount). Return a FRESH Response per call and only route the
    // exchange-rates URL — other fetches get a generic empty-object reply so they
    // resolve cleanly instead of pulling the mocked rates payload.
    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/api/exchange-rates")) {
        return Promise.resolve(new Response(JSON.stringify({ rates: { EUR: 0.92, GBP: 0.79 } })));
      }
      return Promise.resolve(new Response(JSON.stringify({})));
    });
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("renders a select element", () => {
    renderWithProviders(<CurrencySelector />);
    expect(screen.getByRole("combobox")).toBeInTheDocument();
  });

  it("has USD selected by default", () => {
    renderWithProviders(<CurrencySelector />);
    const select = screen.getByRole("combobox") as HTMLSelectElement;
    expect(select.value).toBe("USD");
  });

  it("shows USD option always", () => {
    renderWithProviders(<CurrencySelector />);
    expect(screen.getByText("USD ($)")).toBeInTheDocument();
  });

  it("shows additional currencies after rates load", async () => {
    renderWithProviders(<CurrencySelector />);

    // Wait for fetch effect to complete
    await screen.findByText(/EUR/);

    expect(screen.getByText(/EUR/)).toBeInTheDocument();
    expect(screen.getByText(/GBP/)).toBeInTheDocument();
  });

  it("changes currency on selection", async () => {
    renderWithProviders(<CurrencySelector />);
    await screen.findByText(/EUR/);

    const select = screen.getByRole("combobox") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "EUR" } });
    expect(select.value).toBe("EUR");
  });
});
