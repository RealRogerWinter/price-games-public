import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, fireEvent } from "@testing-library/react";
import RoundResult from "../components/RoundResult";
import type { RoundResult as RoundResultType } from "@price-game/shared";
import { renderWithProviders } from "./testUtils";

function makeResult(overrides: Partial<RoundResultType> = {}): RoundResultType {
  return {
    product: {
      id: 1,
      title: "Widget",
      imageUrl: "https://example.com/widget.jpg",
      description: "A widget",
      category: "Electronics",
      priceCents: 2000,
    },
    guessedPriceCents: 2200,
    score: 500,
    pctOff: 0.10,
    ...overrides,
  };
}

describe("RoundResult", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ rates: {} }))
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    fetchSpy.mockRestore();
  });

  it("displays 'In the Ballpark' label for 10% off", () => {
    renderWithProviders(
      <RoundResult result={makeResult({ pctOff: 0.10 })} isLastRound={false} onNextRound={vi.fn()} />
    );
    expect(screen.getByText("In the Ballpark")).toBeInTheDocument();
  });

  it("displays PIXEL PERFECT for 0% off", () => {
    renderWithProviders(
      <RoundResult
        result={makeResult({ pctOff: 0, guessedPriceCents: 2000, score: 1000 })}
        isLastRound={false}
        onNextRound={vi.fn()}
      />
    );
    expect(screen.getByText("PIXEL PERFECT!")).toBeInTheDocument();
    expect(screen.getByText("Spot on!")).toBeInTheDocument();
  });

  it("displays Laser-Guided for <= 1% off", () => {
    renderWithProviders(
      <RoundResult result={makeResult({ pctOff: 0.01 })} isLastRound={false} onNextRound={vi.fn()} />
    );
    expect(screen.getByText("Laser-Guided")).toBeInTheDocument();
  });

  it("displays snarky 'Are You Bidding in Yen?' for 75% off", () => {
    renderWithProviders(
      <RoundResult result={makeResult({ pctOff: 0.75, score: 0 })} isLastRound={false} onNextRound={vi.fn()} />
    );
    expect(screen.getByText("Are You Bidding in Yen?")).toBeInTheDocument();
  });

  it("displays deadpan 'Technically a Number' for wildly-off bids", () => {
    renderWithProviders(
      <RoundResult result={makeResult({ pctOff: 1.5, score: 0 })} isLastRound={false} onNextRound={vi.fn()} />
    );
    expect(screen.getByText("Technically a Number")).toBeInTheDocument();
  });

  it("displays 'Sharpshooter' at ~3% off (new intermediate tier)", () => {
    renderWithProviders(
      <RoundResult result={makeResult({ pctOff: 0.025 })} isLastRound={false} onNextRound={vi.fn()} />
    );
    expect(screen.getByText("Sharpshooter")).toBeInTheDocument();
  });

  it("displays actual price", () => {
    renderWithProviders(
      <RoundResult result={makeResult()} isLastRound={false} onNextRound={vi.fn()} />
    );
    expect(screen.getByText("$20.00")).toBeInTheDocument();
  });

  it("displays your guess", () => {
    renderWithProviders(
      <RoundResult result={makeResult()} isLastRound={false} onNextRound={vi.fn()} />
    );
    expect(screen.getByText("$22.00")).toBeInTheDocument();
  });

  it('shows "Next Round" button when not last round', () => {
    renderWithProviders(
      <RoundResult result={makeResult()} isLastRound={false} onNextRound={vi.fn()} />
    );
    expect(screen.getByRole("button", { name: "Next Round" })).toBeInTheDocument();
  });

  it('shows "See Final Results" button on last round', () => {
    renderWithProviders(
      <RoundResult result={makeResult()} isLastRound={true} onNextRound={vi.fn()} />
    );
    expect(screen.getByRole("button", { name: "See Final Results" })).toBeInTheDocument();
  });

  it("calls onNextRound when button is clicked", () => {
    const onNextRound = vi.fn();
    renderWithProviders(
      <RoundResult result={makeResult()} isLastRound={false} onNextRound={onNextRound} />
    );
    fireEvent.click(screen.getByRole("button", { name: "Next Round" }));
    expect(onNextRound).toHaveBeenCalledOnce();
  });

  it("shows hint badge when usedHint is true", () => {
    renderWithProviders(
      <RoundResult result={makeResult()} isLastRound={false} onNextRound={vi.fn()} usedHint />
    );
    expect(screen.getByText("Hint was used this round")).toBeInTheDocument();
  });

  it("does not show hint badge when usedHint is false", () => {
    renderWithProviders(
      <RoundResult result={makeResult()} isLastRound={false} onNextRound={vi.fn()} />
    );
    expect(screen.queryByText("Hint was used this round")).not.toBeInTheDocument();
  });

  it("shows product title", () => {
    renderWithProviders(
      <RoundResult result={makeResult()} isLastRound={false} onNextRound={vi.fn()} />
    );
    expect(screen.getByText("Widget")).toBeInTheDocument();
  });

  it('shows "over" for guess above actual price', () => {
    renderWithProviders(
      <RoundResult
        result={makeResult({ guessedPriceCents: 2500, pctOff: 0.25 })}
        isLastRound={false}
        onNextRound={vi.fn()}
      />
    );
    expect(screen.getByText(/over/)).toBeInTheDocument();
  });

  it('shows "under" for guess below actual price', () => {
    renderWithProviders(
      <RoundResult
        result={makeResult({ guessedPriceCents: 1500, pctOff: 0.25 })}
        isLastRound={false}
        onNextRound={vi.fn()}
      />
    );
    expect(screen.getByText(/under/)).toBeInTheDocument();
  });
});
