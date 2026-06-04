import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, screen, waitFor } from "@testing-library/react";
import { HelmetProvider } from "react-helmet-async";
import { MemoryRouter } from "react-router-dom";

vi.mock("../components/auth/UserDropdown", () => ({
  default: () => <div data-testid="user-dropdown">UserDropdown</div>,
}));

import FAQPage from "../pages/FAQPage";

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("FAQPage", () => {
  it("renders each FAQ item from the content API response", async () => {
    const items = [
      { question: "Is it free?", answer: "Yes." },
      { question: "Do I need an account?", answer: "No." },
    ];
    (global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ key: "faq", title: "FAQs", items }),
    });

    render(
      <HelmetProvider>
        <MemoryRouter>
          <FAQPage />
        </MemoryRouter>
      </HelmetProvider>,
    );

    await waitFor(() => expect(screen.getByTestId("faq-list")).toBeDefined());
    expect(screen.getByText("Is it free?")).toBeDefined();
    expect(screen.getByText("Do I need an account?")).toBeDefined();
  });

  it("shows an empty-state message when no items are configured", async () => {
    (global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ key: "faq", title: "FAQs", items: [] }),
    });

    render(
      <HelmetProvider>
        <MemoryRouter>
          <FAQPage />
        </MemoryRouter>
      </HelmetProvider>,
    );

    await waitFor(() => {
      expect(screen.getByText(/no faq entries/i)).toBeDefined();
    });
  });
});
