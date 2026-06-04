import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import type { SharedGameRecord } from "@price-game/shared";
import RecapPage from "../pages/RecapPage";
import * as userClient from "../api/userClient";
import { CurrencyProvider } from "../context/CurrencyContext";
import { UserAuthProvider } from "../context/UserAuthContext";

vi.mock("../api/userClient", async () => {
  const actual = await vi.importActual<typeof import("../api/userClient")>("../api/userClient");
  return { ...actual, userGetHistoryRecap: vi.fn() };
});
const mockedClient = vi.mocked(userClient);

function makeRecord(overrides: Partial<SharedGameRecord> = {}): SharedGameRecord {
  return {
    id: "aBcD1234",
    gameMode: "classic",
    totalScore: 4200,
    perRoundMax: 1000,
    playerName: "Bob",
    createdAt: 1712700000,
    roundData: Array.from({ length: 5 }, (_, i) => ({
      roundNumber: i + 1,
      score: 800 + i * 50,
      products: [
        {
          title: `Item ${i + 1}`,
          imageUrl: `/api/image/${i + 1}`,
          priceCents: 1500 + i * 100,
        },
      ],
      guessedPriceCents: 1450 + i * 100,
    })),
    ...overrides,
  };
}

/** Render RecapPage inside a minimal router so useParams resolves from `/recap/:historyId`. */
function renderRecapAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <UserAuthProvider>
        <CurrencyProvider>
          <Routes>
            <Route path="/recap/:historyId" element={<RecapPage />} />
            <Route path="/" element={<div>Home</div>} />
          </Routes>
        </CurrencyProvider>
      </UserAuthProvider>
    </MemoryRouter>,
  );
}

describe("RecapPage", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ rates: {} })),
    );
    mockedClient.userGetHistoryRecap.mockClear();
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("shows a loading state while the fetch is pending", () => {
    mockedClient.userGetHistoryRecap.mockImplementation(() => new Promise(() => undefined));
    renderRecapAt("/recap/42");
    expect(screen.getByText("Loading recap…")).toBeInTheDocument();
  });

  it("fetches the recap by numeric history id from useParams", async () => {
    mockedClient.userGetHistoryRecap.mockResolvedValue(makeRecord());
    renderRecapAt("/recap/42");
    await waitFor(() => {
      expect(mockedClient.userGetHistoryRecap).toHaveBeenCalledWith(42);
    });
  });

  it("renders a full recap on success via SharedGameView", async () => {
    mockedClient.userGetHistoryRecap.mockResolvedValue(makeRecord());
    const { container } = renderRecapAt("/recap/42");
    expect(await screen.findByRole("heading", { name: "Price Games" })).toBeInTheDocument();
    expect(screen.getByText("Precision")).toBeInTheDocument();
    expect(screen.getByText(/Bob/)).toBeInTheDocument();
    await waitFor(() => {
      const cards = container.querySelectorAll(".shared-round-card");
      expect(cards.length).toBe(5);
    });
  });

  it("shows the empty-breakdown state when roundData is empty", async () => {
    mockedClient.userGetHistoryRecap.mockResolvedValue(
      makeRecord({ roundData: [], totalScore: 2500 }),
    );
    renderRecapAt("/recap/99");
    expect(await screen.findByText("No breakdown available")).toBeInTheDocument();
    // Total score is still surfaced so users don't think the score is lost.
    expect(screen.getByText("2,500")).toBeInTheDocument();
  });

  it("renders a 404 state when the API returns 404", async () => {
    mockedClient.userGetHistoryRecap.mockRejectedValue(
      new Error("API error 404: History entry not found"),
    );
    renderRecapAt("/recap/12345");
    expect(await screen.findByText("Recap not found")).toBeInTheDocument();
  });

  it("renders a generic error state on non-404 errors", async () => {
    mockedClient.userGetHistoryRecap.mockRejectedValue(new Error("Boom"));
    renderRecapAt("/recap/42");
    expect(await screen.findByText("Couldn't load recap")).toBeInTheDocument();
    expect(screen.getByText("Boom")).toBeInTheDocument();
  });

  it("shows the 'Recap not found' state when historyId isn't a positive integer", async () => {
    renderRecapAt("/recap/abc");
    expect(await screen.findByText("Recap not found")).toBeInTheDocument();
    expect(mockedClient.userGetHistoryRecap).not.toHaveBeenCalled();
  });

  it("navigates home when 'Play your own' is clicked on the success state", async () => {
    mockedClient.userGetHistoryRecap.mockResolvedValue(makeRecord());
    renderRecapAt("/recap/42");
    const btn = await screen.findByText("Play your own");
    fireEvent.click(btn);
    await waitFor(() => {
      expect(screen.getByText("Home")).toBeInTheDocument();
    });
  });

  it("renders inside the standard site chrome (PageTopBar + SiteFooter)", async () => {
    mockedClient.userGetHistoryRecap.mockResolvedValue(makeRecord());
    const { container } = renderRecapAt("/recap/42");
    // `.app` wrapper anchors the layout; `.top-bar` comes from PageTopBar;
    // the affiliate-disclosure footer comes from SiteFooter.
    await waitFor(() => {
      expect(container.querySelector(".app")).toBeInTheDocument();
      expect(container.querySelector(".top-bar")).toBeInTheDocument();
      expect(container.querySelector(".affiliate-disclosure")).toBeInTheDocument();
    });
  });
});
