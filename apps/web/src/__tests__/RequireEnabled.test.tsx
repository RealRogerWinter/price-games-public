import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";
import { HelmetProvider } from "react-helmet-async";
import { MemoryRouter } from "react-router-dom";

vi.mock("../components/auth/UserDropdown", () => ({
  default: () => <div data-testid="user-dropdown">UserDropdown</div>,
}));

import RequireEnabled from "../components/RequireEnabled";
import { EnabledPagesProvider } from "../context/EnabledPagesContext";
import type { EnabledPages } from "../api/content";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** Install a mocked /api/content/pages-enabled response before rendering. */
function mockFetch(pages: EnabledPages) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ pages }),
    }),
  );
}

function renderWith(pages: EnabledPages, page: keyof EnabledPages) {
  mockFetch(pages);
  return render(
    <HelmetProvider>
      <MemoryRouter>
        <EnabledPagesProvider>
          <RequireEnabled page={page}>
            <div data-testid="real-page">Real page content</div>
          </RequireEnabled>
        </EnabledPagesProvider>
      </MemoryRouter>
    </HelmetProvider>,
  );
}

describe("RequireEnabled", () => {
  const ALL_DISABLED: EnabledPages = {
    about: false,
    faq: false,
    contact: false,
    game_modes: false,
    privacy: false,
    terms: false,
  };

  it("renders the children when the page is enabled", async () => {
    renderWith({ ...ALL_DISABLED, about: true }, "about");
    // Wait for the provider's initial fetch to settle.
    await screen.findByTestId("real-page");
    expect(screen.getByTestId("real-page")).toBeInTheDocument();
  });

  it("renders an in-app 404 shell when the page is disabled", async () => {
    renderWith(ALL_DISABLED, "about");
    await screen.findByText(/page not available/i);
    expect(screen.queryByTestId("real-page")).toBeNull();
    // Back-home link.
    const backLink = screen.getByRole("link", { name: /back to home/i });
    expect(backLink).toHaveAttribute("href", "/");
  });

  it("treats an all-disabled map the same regardless of which page is requested", async () => {
    renderWith(ALL_DISABLED, "game_modes");
    await screen.findByText(/page not available/i);
    expect(screen.queryByTestId("real-page")).toBeNull();
  });
});
