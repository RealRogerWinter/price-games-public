import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import type { SharedGameRecord } from "@price-game/shared";
import SharePage, { SharedGameView } from "../pages/SharePage";
import * as api from "../api/client";
import { CurrencyProvider } from "../context/CurrencyContext";
import { UserAuthProvider } from "../context/UserAuthContext";

vi.mock("../api/client", () => ({
  getShare: vi.fn(),
  createShare: vi.fn(),
}));
const mockedApi = vi.mocked(api);

function makeRecord(overrides: Partial<SharedGameRecord> = {}): SharedGameRecord {
  return {
    id: "aBcD1234",
    gameMode: "classic",
    totalScore: 7500,
    perRoundMax: 1000,
    playerName: "Alice",
    createdAt: 1712700000,
    roundData: Array.from({ length: 10 }, (_, i) => ({
      roundNumber: i + 1,
      score: i < 8 ? 1000 : 0,
      products: [
        {
          title: `Product ${i + 1}`,
          imageUrl: `https://example.com/p${i + 1}.jpg`,
          priceCents: 2500 + i * 100,
        },
      ],
      guessedPriceCents: 2450,
    })),
    ...overrides,
  };
}

/** Render SharePage inside a minimal router so useParams resolves from `/s/:id`. */
function renderSharePageAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <UserAuthProvider>
        <CurrencyProvider>
          <Routes>
            <Route path="/s/:id" element={<SharePage />} />
            <Route path="/" element={<div>Home</div>} />
          </Routes>
        </CurrencyProvider>
      </UserAuthProvider>
    </MemoryRouter>
  );
}

describe("SharePage", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // CurrencyProvider fetches exchange rates on mount; stub fetch to resolve.
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ rates: {} }))
    );
    mockedApi.getShare.mockClear();
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("shows a loading state while the fetch is pending", () => {
    mockedApi.getShare.mockImplementation(() => new Promise(() => undefined));
    renderSharePageAt("/s/aBcD1234");
    expect(screen.getByText("Loading share…")).toBeInTheDocument();
  });

  it("fetches the share by id from useParams", async () => {
    mockedApi.getShare.mockResolvedValue(makeRecord());
    renderSharePageAt("/s/aBcD1234");
    await waitFor(() => {
      expect(mockedApi.getShare).toHaveBeenCalledWith("aBcD1234");
    });
  });

  it("renders the share on success with header, mode, score, and player name", async () => {
    mockedApi.getShare.mockResolvedValue(makeRecord());
    renderSharePageAt("/s/aBcD1234");
    expect(await screen.findByRole("heading", { name: "Price Games" })).toBeInTheDocument();
    expect(screen.getByText("Precision")).toBeInTheDocument();
    expect(screen.getByText("7,500")).toBeInTheDocument();
    expect(screen.getByText("/ 10,000")).toBeInTheDocument();
    expect(screen.getByText(/Alice/)).toBeInTheDocument();
  });

  it("renders the 2x5 tier grid with correct tile count", async () => {
    mockedApi.getShare.mockResolvedValue(makeRecord());
    const { container } = renderSharePageAt("/s/aBcD1234");
    await waitFor(() => {
      const tiles = container.querySelectorAll(".share-page-tile");
      expect(tiles.length).toBe(10);
    });
  });

  it("renders a round card for every round in the record", async () => {
    mockedApi.getShare.mockResolvedValue(makeRecord());
    const { container } = renderSharePageAt("/s/aBcD1234");
    await waitFor(() => {
      const cards = container.querySelectorAll(".shared-round-card");
      expect(cards.length).toBe(10);
    });
  });

  it("shows a 404 state when the API returns 404", async () => {
    mockedApi.getShare.mockRejectedValue(new Error("API error 404: Share not found"));
    renderSharePageAt("/s/missing01");
    expect(await screen.findByText("Share not found")).toBeInTheDocument();
    expect(screen.getByText("Play your own")).toBeInTheDocument();
  });

  it("navigates home when 'Play your own' is clicked on the 404 state", async () => {
    mockedApi.getShare.mockRejectedValue(new Error("API error 404: Share not found"));
    renderSharePageAt("/s/missing01");
    const btn = await screen.findByText("Play your own");
    fireEvent.click(btn);
    await waitFor(() => {
      expect(screen.getByText("Home")).toBeInTheDocument();
    });
  });

  it("shows a generic error state when the API returns a non-404 error", async () => {
    mockedApi.getShare.mockRejectedValue(new Error("API error 500: boom"));
    renderSharePageAt("/s/aBcD1234");
    expect(await screen.findByText("Couldn't load share")).toBeInTheDocument();
    expect(screen.getByText(/API error 500/)).toBeInTheDocument();
  });

  it("navigates home when 'Play your own' is clicked on the success state", async () => {
    mockedApi.getShare.mockResolvedValue(makeRecord());
    renderSharePageAt("/s/aBcD1234");
    const btn = await screen.findByRole("button", { name: "Play your own" });
    fireEvent.click(btn);
    await waitFor(() => {
      expect(screen.getByText("Home")).toBeInTheDocument();
    });
  });

  it("uses 13,130 as the total max for chain-reaction shares", async () => {
    mockedApi.getShare.mockResolvedValue(
      makeRecord({
        gameMode: "chain-reaction",
        perRoundMax: 1313,
        totalScore: 10000,
      })
    );
    renderSharePageAt("/s/aBcD1234");
    expect(await screen.findByText("Chain Reaction")).toBeInTheDocument();
    expect(screen.getByText("/ 13,130")).toBeInTheDocument();
  });

  it("omits the player name line when the record has no playerName", async () => {
    mockedApi.getShare.mockResolvedValue(makeRecord({ playerName: null }));
    renderSharePageAt("/s/aBcD1234");
    await screen.findByRole("heading", { name: "Price Games" });
    expect(screen.queryByText(/Shared by/)).not.toBeInTheDocument();
  });

  it("renders inside the standard site chrome (PageTopBar + SiteFooter)", async () => {
    mockedApi.getShare.mockResolvedValue(makeRecord());
    const { container } = renderSharePageAt("/s/aBcD1234");
    // `.app` wrapper anchors the layout; `.top-bar` comes from PageTopBar;
    // the affiliate-disclosure footer comes from SiteFooter.
    await waitFor(() => {
      expect(container.querySelector(".app")).toBeInTheDocument();
      expect(container.querySelector(".top-bar")).toBeInTheDocument();
      expect(container.querySelector(".affiliate-disclosure")).toBeInTheDocument();
    });
  });
});

describe("SharedGameView (presentational)", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ rates: {} }))
    );
  });

  it("renders a round card with a guessed-price detail for classic mode", () => {
    const record = makeRecord();
    render(
      <MemoryRouter>
        <CurrencyProvider>
          <SharedGameView record={record} onPlay={vi.fn()} />
        </CurrencyProvider>
      </MemoryRouter>
    );
    // First round has guessedPriceCents=2450.
    expect(screen.getAllByText(/Guess:/).length).toBeGreaterThan(0);
  });

  it("renders an empty-products message when a round has no products", () => {
    const record = makeRecord({
      roundData: [
        { roundNumber: 1, score: 0, products: [] },
      ],
    });
    render(
      <MemoryRouter>
        <CurrencyProvider>
          <SharedGameView record={record} onPlay={vi.fn()} />
        </CurrencyProvider>
      </MemoryRouter>
    );
    expect(screen.getByText("No product data")).toBeInTheDocument();
  });

  it("renders the higher/lower guess detail when present", () => {
    const record = makeRecord({
      roundData: [
        {
          roundNumber: 1,
          score: 1000,
          products: [
            { title: "A", imageUrl: "https://e.co/a.jpg", priceCents: 100 },
          ],
          guess: "higher",
          correct: true,
        },
      ],
    });
    render(
      <MemoryRouter>
        <CurrencyProvider>
          <SharedGameView record={record} onPlay={vi.fn()} />
        </CurrencyProvider>
      </MemoryRouter>
    );
    expect(screen.getByText(/Picked: Higher/)).toBeInTheDocument();
  });

  it("renders the budget-builder cart/budget detail when present", () => {
    const record = makeRecord({
      gameMode: "budget-builder",
      roundData: [
        {
          roundNumber: 1,
          score: 1000,
          products: [
            { title: "Bundle", imageUrl: "https://e.co/b.jpg", priceCents: 9000 },
          ],
          cartTotalCents: 9500,
          budgetCents: 10000,
        },
      ],
    });
    render(
      <MemoryRouter>
        <CurrencyProvider>
          <SharedGameView record={record} onPlay={vi.fn()} />
        </CurrencyProvider>
      </MemoryRouter>
    );
    expect(screen.getByText(/Cart/)).toBeInTheDocument();
  });

  it("renders the accessible text description for screen readers", () => {
    const record = makeRecord();
    render(
      <MemoryRouter>
        <CurrencyProvider>
          <SharedGameView record={record} onPlay={vi.fn()} />
        </CurrencyProvider>
      </MemoryRouter>
    );
    expect(screen.getByText(/Score 7,500 of 10,000/)).toBeInTheDocument();
  });
});
