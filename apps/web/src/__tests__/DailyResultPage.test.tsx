import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import DailyResultPage from "../pages/DailyResultPage";
import { CurrencyProvider } from "../context/CurrencyContext";
import { UserAuthProvider } from "../context/UserAuthContext";
import type { GameSession, DailyCompletionPayload, DailyTodayResponse } from "@price-game/shared";

// Disable count-up animation by mocking prefers-reduced-motion.
// jsdom doesn't define matchMedia, so we assign it directly on window.
const origMatchMedia = window.matchMedia;
beforeAll(() => {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: query === "(prefers-reduced-motion: reduce)",
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
});
afterAll(() => {
  window.matchMedia = origMatchMedia;
});

function Wrapper({ children }: { children: React.ReactNode }) {
  return (
    <MemoryRouter>
      <CurrencyProvider>
        <UserAuthProvider>{children}</UserAuthProvider>
      </CurrencyProvider>
    </MemoryRouter>
  );
}

function makeSession(overrides: Partial<GameSession> = {}): GameSession {
  return {
    id: "daily-sess-1",
    currentRound: 5,
    totalRounds: 5,
    totalScore: 3500,
    completed: true,
    gameMode: "classic",
    ...overrides,
  };
}

function makeToday(): DailyTodayResponse {
  return {
    date: "2026-04-15",
    gameMode: "classic",
    modeName: "Precision",
    totalRounds: 5,
  };
}

function makePayload(overrides: Partial<DailyCompletionPayload> = {}): DailyCompletionPayload {
  return {
    streak: { current: 3, best: 5, lastDate: "2026-04-15" },
    isNewBest: false,
    isNewStreak: true,
    ...overrides,
  };
}

function makeRoundResults() {
  return [
    { score: 900, product: { title: "Widget A", imageUrl: "/a.png", priceCents: 1999 }, guessedPriceCents: 2100 },
    { score: 500, product: { title: "Widget B", imageUrl: "/b.png", priceCents: 4999 }, guessedPriceCents: 5500 },
    { score: 0, product: { title: "Widget C", imageUrl: "/c.png", priceCents: 9999 }, guessedPriceCents: 1000 },
  ];
}

describe("DailyResultPage", () => {
  it("renders the total score", () => {
    render(
      <DailyResultPage
        session={makeSession()}
        roundResults={[]}
        today={makeToday()}
        dailyPayload={makePayload()}
        onBackToModes={vi.fn()}
      />,
      { wrapper: Wrapper },
    );
    expect(screen.getByText(/3,500|3500/)).toBeInTheDocument();
  });

  it("shows the current streak when dailyPayload is provided", () => {
    render(
      <DailyResultPage
        session={makeSession()}
        roundResults={[]}
        today={makeToday()}
        dailyPayload={makePayload({ streak: { current: 7, best: 10, lastDate: "2026-04-15" } })}
        onBackToModes={vi.fn()}
      />,
      { wrapper: Wrapper },
    );
    // "7 days" — match the full streak readout
    expect(screen.getByText(/7 days/)).toBeInTheDocument();
  });

  it("shows 'Streak started!' for isNewStreak + isNewBest + current=1", () => {
    render(
      <DailyResultPage
        session={makeSession()}
        roundResults={[]}
        today={makeToday()}
        dailyPayload={makePayload({
          streak: { current: 1, best: 1, lastDate: "2026-04-15" },
          isNewStreak: true,
          isNewBest: true,
        })}
        onBackToModes={vi.fn()}
      />,
      { wrapper: Wrapper },
    );
    expect(screen.getByText(/Streak started/i)).toBeInTheDocument();
  });

  it("shows 'Streak maintained' when score is 0 (tough day) but streak survives", () => {
    render(
      <DailyResultPage
        session={makeSession({ totalScore: 0 })}
        roundResults={[]}
        today={makeToday()}
        dailyPayload={makePayload({
          streak: { current: 5, best: 5, lastDate: "2026-04-15" },
          isNewStreak: true,
        })}
        onBackToModes={vi.fn()}
      />,
      { wrapper: Wrapper },
    );
    expect(screen.getByText(/Streak maintained/i)).toBeInTheDocument();
  });

  it("renders a countdown to next UTC midnight", () => {
    render(
      <DailyResultPage
        session={makeSession()}
        roundResults={[]}
        today={makeToday()}
        dailyPayload={makePayload()}
        onBackToModes={vi.fn()}
      />,
      { wrapper: Wrapper },
    );
    expect(screen.getByText(/Next/i)).toBeInTheDocument();
  });

  it("renders a 'Try another mode' link that calls onBackToModes", () => {
    const onBack = vi.fn();
    render(
      <DailyResultPage
        session={makeSession()}
        roundResults={[]}
        today={makeToday()}
        dailyPayload={makePayload()}
        onBackToModes={onBack}
      />,
      { wrapper: Wrapper },
    );
    const link = screen.getByText(/another mode/i);
    fireEvent.click(link);
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("renders without dailyPayload (anonymous user flow)", () => {
    render(
      <DailyResultPage
        session={makeSession()}
        roundResults={[]}
        today={makeToday()}
        dailyPayload={null}
        onBackToModes={vi.fn()}
      />,
      { wrapper: Wrapper },
    );
    expect(screen.getByText(/3,500|3500/)).toBeInTheDocument();
  });

  it("renders the SignupCtaCard for anon users when onOpenRegister is provided", () => {
    const onOpen = vi.fn();
    render(
      <DailyResultPage
        session={makeSession()}
        roundResults={[]}
        today={makeToday()}
        dailyPayload={null}
        onBackToModes={vi.fn()}
        onOpenRegister={onOpen}
      />,
      { wrapper: Wrapper },
    );
    expect(screen.getByText(/Save your daily streak/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Create free account/i }));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("daily Bidding War final screen shows daily-specific UI (parity regression)", () => {
    render(
      <DailyResultPage
        session={makeSession({ gameMode: "bidding", totalScore: 4200 })}
        roundResults={[
          { score: 1000, product: { title: "Bidding item A", imageUrl: "/a.png", priceCents: 2999 }, guessedPriceCents: 2500 },
        ]}
        today={{ ...makeToday(), gameMode: "bidding", modeName: "Bidding War" }}
        dailyPayload={makePayload({ streak: { current: 4, best: 6, lastDate: "2026-04-15" }, isNewStreak: true })}
        onBackToModes={vi.fn()}
      />,
      { wrapper: Wrapper },
    );
    // Daily headline + streak flame + countdown must all render — if the
    // ClosestPage 2-arg regression ever returns, this case breaks first.
    expect(screen.getByText(/DAILY CHALLENGE/i)).toBeInTheDocument();
    expect(screen.getByText(/4 days/)).toBeInTheDocument();
    expect(screen.getByText(/Next/i)).toBeInTheDocument();
  });

  it("shows round-by-round item recap when roundResults have products", () => {
    render(
      <DailyResultPage
        session={makeSession()}
        roundResults={makeRoundResults()}
        today={makeToday()}
        dailyPayload={makePayload()}
        onBackToModes={vi.fn()}
      />,
      { wrapper: Wrapper },
    );
    expect(screen.getByText("Round-by-Round")).toBeInTheDocument();
    expect(screen.getByText("Widget A")).toBeInTheDocument();
    expect(screen.getByText("Widget B")).toBeInTheDocument();
    expect(screen.getByText("Widget C")).toBeInTheDocument();
  });

  it("shows Share Results button", () => {
    render(
      <DailyResultPage
        session={makeSession()}
        roundResults={makeRoundResults()}
        today={makeToday()}
        dailyPayload={makePayload()}
        onBackToModes={vi.fn()}
      />,
      { wrapper: Wrapper },
    );
    expect(screen.getByText("Share Results")).toBeInTheDocument();
  });
});
