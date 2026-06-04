import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import SiteFooter from "../components/SiteFooter";
import { EnabledPagesProvider } from "../context/EnabledPagesContext";
import type { EnabledPages } from "../api/content";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function mockFetch(pages: EnabledPages) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ pages }),
    }),
  );
}

function renderFooter(pages: EnabledPages) {
  mockFetch(pages);
  return render(
    <MemoryRouter>
      <EnabledPagesProvider>
        <SiteFooter />
      </EnabledPagesProvider>
    </MemoryRouter>,
  );
}

describe("SiteFooter", () => {
  it("renders the affiliate notice regardless of visibility", async () => {
    renderFooter({
      about: false,
      faq: false,
      contact: false,
      game_modes: false,
      privacy: false,
      terms: false,
    });
    expect(
      await screen.findByText(/as an amazon associate/i),
    ).toBeInTheDocument();
  });

  it("hides all footer links when every page is disabled", async () => {
    renderFooter({
      about: false,
      faq: false,
      contact: false,
      game_modes: false,
      privacy: false,
      terms: false,
    });
    // Wait for the initial fetch to settle (defaults to all-disabled
    // before the fetch resolves, so the assertion below already holds
    // pre-fetch — still `await` so the provider state is stable).
    await screen.findByText(/as an amazon associate/i);
    expect(screen.queryByRole("link", { name: "About" })).toBeNull();
    expect(screen.queryByRole("link", { name: "FAQ" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Contact" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Game Modes" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Privacy Policy" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Terms of Service" })).toBeNull();
  });

  it("renders only the enabled links", async () => {
    renderFooter({
      about: true,
      faq: false,
      contact: true,
      game_modes: false,
      privacy: true,
      terms: false,
    });
    // Wait for the provider's state to pick up the enabled map.
    await screen.findByRole("link", { name: "About" });
    expect(screen.getByRole("link", { name: "About" })).toHaveAttribute("href", "/about");
    expect(screen.getByRole("link", { name: "Contact" })).toHaveAttribute("href", "/contact");
    expect(screen.getByRole("link", { name: "Privacy Policy" })).toHaveAttribute("href", "/privacy");
    expect(screen.queryByRole("link", { name: "FAQ" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Game Modes" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Terms of Service" })).toBeNull();
  });
});
