import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";
import { HelmetProvider } from "react-helmet-async";
import { MemoryRouter } from "react-router-dom";

vi.mock("../components/auth/UserDropdown", () => ({
  default: () => <div data-testid="user-dropdown">UserDropdown</div>,
}));

import GameModesPage from "../pages/GameModesPage";
import { GAME_MODES } from "@price-game/shared";

afterEach(() => {
  cleanup();
});

function renderPage() {
  return render(
    <HelmetProvider>
      <MemoryRouter>
        <GameModesPage />
      </MemoryRouter>
    </HelmetProvider>,
  );
}

describe("GameModesPage", () => {
  it("renders a card for every game mode", () => {
    renderPage();
    const list = screen.getByTestId("game-modes-list");
    for (const m of GAME_MODES) {
      const anchor = list.querySelector(`#${CSS.escape(m.mode)}`);
      expect(anchor).not.toBeNull();
    }
  });

  it("links non-multiplayer modes to /play/<mode>", () => {
    renderPage();
    const classicCard = document.getElementById("classic")!;
    const playLink = classicCard.querySelector("a.game-mode-play") as HTMLAnchorElement;
    expect(playLink.getAttribute("href")).toBe("/play/classic");
  });

  it("links the multiplayer-only Bidding mode to /mp", () => {
    renderPage();
    const biddingCard = document.getElementById("bidding")!;
    const playLink = biddingCard.querySelector("a.game-mode-play") as HTMLAnchorElement;
    expect(playLink.getAttribute("href")).toBe("/mp");
  });

  it("renders an icon for every game mode card", () => {
    renderPage();
    const list = screen.getByTestId("game-modes-list");
    for (const m of GAME_MODES) {
      const card = list.querySelector(`#${CSS.escape(m.mode)}`)!;
      const icon = card.querySelector("img.game-mode-card-icon");
      expect(icon).not.toBeNull();
    }
  });

  it("renders a jump-to index with an anchor link to each mode", () => {
    renderPage();
    const index = screen.getByTestId("game-modes-index");
    for (const m of GAME_MODES) {
      const link = index.querySelector(
        `a.game-modes-index-link[href="#${CSS.escape(m.mode)}"]`,
      );
      expect(link).not.toBeNull();
    }
  });

  it("does not render the Daily-Eligible badge", () => {
    renderPage();
    expect(screen.queryByText(/Daily-Eligible/i)).toBeNull();
    expect(document.querySelector(".badge-daily")).toBeNull();
  });

  // Trademark guard: the UI must never surface the TV game show name. The
  // literal phrase below is required to assert its ABSENCE — it is not a
  // reference to the show, it is the regression check that keeps it out.
  it("does not surface the trademarked TV show name on the page", () => {
    const { container } = renderPage();
    expect(container.textContent ?? "").not.toMatch(/price\s*is\s*right/i);
  });

  it("renders the top nav (logo link to home + New Game link)", () => {
    renderPage();
    const logos = screen.getAllByAltText("price.games");
    expect(logos.length).toBeGreaterThan(0);
    expect(logos[0].closest("a")).toHaveAttribute("href", "/");
    expect(screen.getByText("New Game").closest("a")).toHaveAttribute("href", "/");
  });
});
