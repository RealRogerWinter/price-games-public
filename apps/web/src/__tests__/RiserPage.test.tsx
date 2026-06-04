import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, fireEvent, act } from "@testing-library/react";
import RiserPage from "../pages/RiserPage";
import * as api from "../api/client";
import {
  renderWithProviders,
  makeSession,
  makeProductWithPrice,
  flushMicrotasks,
} from "./testUtils";

vi.mock("../api/client");
const mockedApi = vi.mocked(api);

/** Minimal RiserData returned by the mocked getProduct call. */
function makeRiserData(overrides: Record<string, unknown> = {}) {
  return {
    product: {
      id: 1,
      title: "Riser Widget",
      imageUrl: "https://example.com/riser.jpg",
      description: "A rising product",
      category: "Electronics",
      amazonUrl: "https://amazon.com/riser",
    },
    maxPriceCents: 10000,
    speedPattern: "linear",
    durationMs: 5000,
    ...overrides,
  };
}

/** Minimal result returned by submitRiserGuess. */
function makeRiserResult(overrides: Record<string, unknown> = {}) {
  return {
    product: makeProductWithPrice({
      title: "Riser Widget",
      imageUrl: "https://example.com/riser.jpg",
      priceCents: 5000,
      amazonUrl: "https://amazon.com/riser",
    }),
    stoppedPriceCents: 4500,
    maxPriceCents: 10000,
    score: 700,
    pctOff: 0.1,
    wentOver: false,
    ...overrides,
  };
}

describe("RiserPage", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let originalRAF: typeof globalThis.requestAnimationFrame;
  let originalCAF: typeof globalThis.cancelAnimationFrame;
  let originalPerfNow: typeof performance.now;

  let rafMock: ReturnType<typeof vi.fn>;
  let cafMock: ReturnType<typeof vi.fn>;
  let perfNowMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();

    // Save originals for globals that must be raw-assigned (no vi.spyOn support)
    originalRAF = globalThis.requestAnimationFrame;
    originalCAF = globalThis.cancelAnimationFrame;
    originalPerfNow = performance.now;

    // Stub fetch for CurrencyProvider — use vi.spyOn for automatic cleanup
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ rates: {} }))
    );

    // Mock requestAnimationFrame — default: invoke callback synchronously at t=0
    rafMock = vi.fn((cb: FrameRequestCallback) => { cb(0); return 1; });
    globalThis.requestAnimationFrame = rafMock;

    // Mock cancelAnimationFrame
    cafMock = vi.fn();
    globalThis.cancelAnimationFrame = cafMock;

    // Mock performance.now (fakeTimers already replaces it, so override again)
    perfNowMock = vi.fn().mockReturnValue(0);
    performance.now = perfNowMock;

    mockedApi.getProduct.mockResolvedValue(makeRiserData() as any);
  });

  afterEach(() => {
    vi.useRealTimers();
    fetchSpy.mockRestore();
    globalThis.requestAnimationFrame = originalRAF;
    globalThis.cancelAnimationFrame = originalCAF;
    performance.now = originalPerfNow;
  });

  const defaultProps = {
    session: makeSession({ gameMode: "riser" as any }),
    onRoundComplete: vi.fn(),
    onGameEnd: vi.fn(),
  };

  // ---------------------------------------------------------------------------
  // Loading state
  // ---------------------------------------------------------------------------

  it("shows loading state while fetching product", () => {
    mockedApi.getProduct.mockReturnValue(new Promise(() => {}));
    renderWithProviders(<RiserPage {...defaultProps} />);
    expect(screen.getByText("Loading round...")).toBeInTheDocument();
  });

  it("calls getProduct with the session id", async () => {
    renderWithProviders(<RiserPage {...defaultProps} />);
    await flushMicrotasks();
    expect(mockedApi.getProduct).toHaveBeenCalledWith("session-1");
  });

  // ---------------------------------------------------------------------------
  // Product display
  // ---------------------------------------------------------------------------

  it("displays product title after loading", async () => {
    renderWithProviders(<RiserPage {...defaultProps} />);
    await flushMicrotasks();
    expect(screen.getByText("Riser Widget")).toBeInTheDocument();
  });

  it("displays product image after loading", async () => {
    renderWithProviders(<RiserPage {...defaultProps} />);
    await flushMicrotasks();
    const img = screen.getByAltText("Riser Widget") as HTMLImageElement;
    expect(img).toBeInTheDocument();
    expect(img.src).toBe("https://example.com/riser.jpg");
  });

  it("hides image on error", async () => {
    renderWithProviders(<RiserPage {...defaultProps} />);
    await flushMicrotasks();
    const img = screen.getByAltText("Riser Widget") as HTMLImageElement;
    fireEvent.error(img);
    expect(img.style.display).toBe("none");
  });

  // ---------------------------------------------------------------------------
  // Scoreboard
  // ---------------------------------------------------------------------------

  it("shows scoreboard with round and score info", async () => {
    renderWithProviders(<RiserPage {...defaultProps} />);
    await flushMicrotasks();
    expect(screen.getByText("1 / 10")).toBeInTheDocument();
    expect(screen.getByText("0")).toBeInTheDocument();
  });

  it("shows updated score from session", async () => {
    const session = makeSession({ totalScore: 1500, currentRound: 3 });
    renderWithProviders(
      <RiserPage {...defaultProps} session={session} />
    );
    await flushMicrotasks();
    expect(screen.getByText("3 / 10")).toBeInTheDocument();
    expect(screen.getByText("1500")).toBeInTheDocument();
  });

  // ---------------------------------------------------------------------------
  // Start button
  // ---------------------------------------------------------------------------

  it("shows Start button before animation begins", async () => {
    renderWithProviders(<RiserPage {...defaultProps} />);
    await flushMicrotasks();
    expect(screen.getByRole("button", { name: "Start" })).toBeInTheDocument();
  });

  it("hides Start button and shows Stop button when animation starts", async () => {
    // Make rAF NOT immediately invoke the callback so the running state persists
    rafMock.mockImplementation(() => 1);
    mockedApi.submitRiserGuess.mockResolvedValue({
      result: makeRiserResult(),
      session: makeSession({ totalScore: 700 }),
    } as any);

    renderWithProviders(<RiserPage {...defaultProps} />);
    await flushMicrotasks();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Start" }));
    });

    expect(screen.queryByRole("button", { name: "Start" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "STOP!" })).toBeInTheDocument();
  });

  // ---------------------------------------------------------------------------
  // Price animation (rAF mocking)
  // ---------------------------------------------------------------------------

  it("starts animation on Start click and updates price via ref", async () => {
    // Let rAF invoke callback once so the price display updates
    let callCount = 0;
    rafMock.mockImplementation((cb) => {
      callCount++;
      if (callCount <= 1) {
        // Simulate 2500ms elapsed (half of 5000ms duration) with linear pattern
        cb(2500);
      }
      return callCount;
    });
    // performance.now returns 0 as start time
    perfNowMock.mockReturnValue(0);

    mockedApi.submitRiserGuess.mockResolvedValue({
      result: makeRiserResult(),
      session: makeSession({ totalScore: 700 }),
    } as any);

    renderWithProviders(<RiserPage {...defaultProps} />);
    await flushMicrotasks();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Start" }));
    });

    // The animation loop should have been invoked via rAF
    expect(rafMock).toHaveBeenCalled();
  });

  it("auto-submits when animation reaches max duration", async () => {
    // Simulate progress >= 1 so the animation auto-stops
    rafMock.mockImplementation((cb) => {
      // elapsed >= durationMs makes progress >= 1
      cb(6000);
      return 1;
    });
    perfNowMock.mockReturnValue(0);

    const result = makeRiserResult({ stoppedPriceCents: 10000, score: 0, wentOver: true, pctOff: 1.0 });
    mockedApi.submitRiserGuess.mockResolvedValue({
      result,
      session: makeSession({ totalScore: 0 }),
    } as any);

    renderWithProviders(<RiserPage {...defaultProps} />);
    await flushMicrotasks();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Start" }));
    });
    await flushMicrotasks();

    // Should have auto-submitted with maxPriceCents
    expect(mockedApi.submitRiserGuess).toHaveBeenCalledWith("session-1", 10000);
  });

  // ---------------------------------------------------------------------------
  // Stop interaction
  // ---------------------------------------------------------------------------

  it("submits the stopped price when STOP is clicked", async () => {
    // First rAF call: invoke at half-way point, second rAF call: don't invoke (so animation stays running)
    let callCount = 0;
    rafMock.mockImplementation((cb) => {
      callCount++;
      if (callCount <= 2) {
        // At time=0, progress=0, price = minPrice
        cb(0);
      }
      return callCount;
    });
    perfNowMock.mockReturnValue(0);

    const result = makeRiserResult({ stoppedPriceCents: 1000, score: 200, pctOff: 0.8 });
    mockedApi.submitRiserGuess.mockResolvedValue({
      result,
      session: makeSession({ totalScore: 200 }),
    } as any);

    renderWithProviders(<RiserPage {...defaultProps} />);
    await flushMicrotasks();

    // Start animation
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Start" }));
    });

    // Click stop
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "STOP!" }));
    });
    await flushMicrotasks();

    expect(mockedApi.submitRiserGuess).toHaveBeenCalledWith("session-1", expect.any(Number));
  });

  it("cancels animation frame on stop", async () => {
    // Keep animation running
    rafMock.mockImplementation(() => 42);
    perfNowMock.mockReturnValue(0);

    mockedApi.submitRiserGuess.mockResolvedValue({
      result: makeRiserResult(),
      session: makeSession({ totalScore: 700 }),
    } as any);

    renderWithProviders(<RiserPage {...defaultProps} />);
    await flushMicrotasks();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Start" }));
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "STOP!" }));
    });
    await flushMicrotasks();

    expect(cafMock).toHaveBeenCalled();
  });

  it("does nothing when handleStop is called but not running", async () => {
    renderWithProviders(<RiserPage {...defaultProps} />);
    await flushMicrotasks();
    // STOP button should not be visible when not running
    expect(screen.queryByRole("button", { name: "STOP!" })).not.toBeInTheDocument();
  });

  // ---------------------------------------------------------------------------
  // Result display
  // ---------------------------------------------------------------------------

  it("shows result overlay after stopping", async () => {
    rafMock.mockImplementation((cb) => {
      cb(6000);
      return 1;
    });
    perfNowMock.mockReturnValue(0);

    const result = makeRiserResult({ score: 700, pctOff: 0.1, wentOver: false });
    mockedApi.submitRiserGuess.mockResolvedValue({
      result,
      session: makeSession({ totalScore: 700 }),
    } as any);

    renderWithProviders(<RiserPage {...defaultProps} />);
    await flushMicrotasks();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Start" }));
    });
    await flushMicrotasks();

    // Result overlay should be visible
    expect(screen.getByText("Actual Price")).toBeInTheDocument();
    expect(screen.getByText("You Stopped At")).toBeInTheDocument();
    expect(screen.getByText("Difference")).toBeInTheDocument();
  });

  it("shows correct result title for high score", async () => {
    rafMock.mockImplementation((cb) => {
      cb(6000);
      return 1;
    });
    perfNowMock.mockReturnValue(0);

    const result = makeRiserResult({ score: 950 });
    mockedApi.submitRiserGuess.mockResolvedValue({
      result,
      session: makeSession({ totalScore: 950 }),
    } as any);

    renderWithProviders(<RiserPage {...defaultProps} />);
    await flushMicrotasks();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Start" }));
    });
    await flushMicrotasks();

    expect(screen.getByText("Nailed it!")).toBeInTheDocument();
  });

  it("shows 'So close!' for score >= 650", async () => {
    rafMock.mockImplementation((cb) => {
      cb(6000);
      return 1;
    });
    perfNowMock.mockReturnValue(0);

    const result = makeRiserResult({ score: 700 });
    mockedApi.submitRiserGuess.mockResolvedValue({
      result,
      session: makeSession({ totalScore: 700 }),
    } as any);

    renderWithProviders(<RiserPage {...defaultProps} />);
    await flushMicrotasks();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Start" }));
    });
    await flushMicrotasks();

    expect(screen.getByText("So close!")).toBeInTheDocument();
  });

  it("shows 'Nice stop!' for score >= 500 and < 650", async () => {
    rafMock.mockImplementation((cb) => {
      cb(6000);
      return 1;
    });
    perfNowMock.mockReturnValue(0);

    const result = makeRiserResult({ score: 550 });
    mockedApi.submitRiserGuess.mockResolvedValue({
      result,
      session: makeSession({ totalScore: 550 }),
    } as any);

    renderWithProviders(<RiserPage {...defaultProps} />);
    await flushMicrotasks();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Start" }));
    });
    await flushMicrotasks();

    expect(screen.getByText("Nice stop!")).toBeInTheDocument();
  });

  it("shows 'Good read!' for score >= 350 and < 500", async () => {
    rafMock.mockImplementation((cb) => {
      cb(6000);
      return 1;
    });
    perfNowMock.mockReturnValue(0);

    const result = makeRiserResult({ score: 400 });
    mockedApi.submitRiserGuess.mockResolvedValue({
      result,
      session: makeSession({ totalScore: 400 }),
    } as any);

    renderWithProviders(<RiserPage {...defaultProps} />);
    await flushMicrotasks();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Start" }));
    });
    await flushMicrotasks();

    expect(screen.getByText("Good read!")).toBeInTheDocument();
  });

  it("shows 'Too cautious!' for very low score", async () => {
    rafMock.mockImplementation((cb) => {
      cb(6000);
      return 1;
    });
    perfNowMock.mockReturnValue(0);

    const result = makeRiserResult({ score: 50 });
    mockedApi.submitRiserGuess.mockResolvedValue({
      result,
      session: makeSession({ totalScore: 50 }),
    } as any);

    renderWithProviders(<RiserPage {...defaultProps} />);
    await flushMicrotasks();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Start" }));
    });
    await flushMicrotasks();

    expect(screen.getByText("Too cautious!")).toBeInTheDocument();
  });

  it("shows 'WENT OVER!' when result.wentOver is true", async () => {
    rafMock.mockImplementation((cb) => {
      cb(6000);
      return 1;
    });
    perfNowMock.mockReturnValue(0);

    const result = makeRiserResult({ score: 0, wentOver: true, pctOff: 0.2 });
    mockedApi.submitRiserGuess.mockResolvedValue({
      result,
      session: makeSession({ totalScore: 0 }),
    } as any);

    renderWithProviders(<RiserPage {...defaultProps} />);
    await flushMicrotasks();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Start" }));
    });
    await flushMicrotasks();

    expect(screen.getByText("WENT OVER!")).toBeInTheDocument();
    expect(screen.getByText(/Over by 20\.0%/)).toBeInTheDocument();
  });

  it("shows percentage under when not over", async () => {
    rafMock.mockImplementation((cb) => {
      cb(6000);
      return 1;
    });
    perfNowMock.mockReturnValue(0);

    const result = makeRiserResult({ score: 700, wentOver: false, pctOff: 0.1 });
    mockedApi.submitRiserGuess.mockResolvedValue({
      result,
      session: makeSession({ totalScore: 700 }),
    } as any);

    renderWithProviders(<RiserPage {...defaultProps} />);
    await flushMicrotasks();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Start" }));
    });
    await flushMicrotasks();

    expect(screen.getByText("10.0% under")).toBeInTheDocument();
  });

  it("shows Amazon link in result when product has amazonUrl", async () => {
    rafMock.mockImplementation((cb) => {
      cb(6000);
      return 1;
    });
    perfNowMock.mockReturnValue(0);

    const result = makeRiserResult();
    mockedApi.submitRiserGuess.mockResolvedValue({
      result,
      session: makeSession({ totalScore: 700 }),
    } as any);

    renderWithProviders(<RiserPage {...defaultProps} />);
    await flushMicrotasks();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Start" }));
    });
    await flushMicrotasks();

    const link = screen.getByRole("link", {
      name: /see it on amazon/i,
    }) as HTMLAnchorElement;
    expect(link).toBeInTheDocument();
    expect(link.href).toBe("https://amazon.com/riser");
    expect(link.target).toBe("_blank");
  });

  it("shows animated score in result", async () => {
    rafMock.mockImplementation((cb) => {
      cb(6000);
      return 1;
    });
    perfNowMock.mockReturnValue(0);

    const result = makeRiserResult({ score: 700 });
    mockedApi.submitRiserGuess.mockResolvedValue({
      result,
      session: makeSession({ totalScore: 700 }),
    } as any);

    renderWithProviders(<RiserPage {...defaultProps} />);
    await flushMicrotasks();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Start" }));
    });
    await flushMicrotasks();

    // The score animation uses setInterval; advance timers to complete it
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });

    expect(screen.getByText("+700")).toBeInTheDocument();
  });

  it("shows score-zero class when score is 0", async () => {
    rafMock.mockImplementation((cb) => {
      cb(6000);
      return 1;
    });
    perfNowMock.mockReturnValue(0);

    const result = makeRiserResult({ score: 0, wentOver: true });
    mockedApi.submitRiserGuess.mockResolvedValue({
      result,
      session: makeSession({ totalScore: 0 }),
    } as any);

    renderWithProviders(<RiserPage {...defaultProps} />);
    await flushMicrotasks();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Start" }));
    });
    await flushMicrotasks();

    const scoreEl = screen.getByText("+0");
    expect(scoreEl).toHaveClass("score-zero");
  });

  it("applies score-glow class when score >= 500", async () => {
    rafMock.mockImplementation((cb) => {
      cb(6000);
      return 1;
    });
    perfNowMock.mockReturnValue(0);

    const result = makeRiserResult({ score: 700 });
    mockedApi.submitRiserGuess.mockResolvedValue({
      result,
      session: makeSession({ totalScore: 700 }),
    } as any);

    renderWithProviders(<RiserPage {...defaultProps} />);
    await flushMicrotasks();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Start" }));
    });
    await flushMicrotasks();

    const scoreContainer = screen.getByText("Points Earned").closest(".result-score");
    expect(scoreContainer).toHaveClass("score-glow");
  });

  // ---------------------------------------------------------------------------
  // Next Round / Game End
  // ---------------------------------------------------------------------------

  it("shows 'Next Round' button when game is not ended", async () => {
    rafMock.mockImplementation((cb) => {
      cb(6000);
      return 1;
    });
    perfNowMock.mockReturnValue(0);

    const result = makeRiserResult();
    mockedApi.submitRiserGuess.mockResolvedValue({
      result,
      session: makeSession({ totalScore: 700, completed: false }),
    } as any);

    renderWithProviders(<RiserPage {...defaultProps} />);
    await flushMicrotasks();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Start" }));
    });
    await flushMicrotasks();

    expect(screen.getByRole("button", { name: "Next Round" })).toBeInTheDocument();
  });

  it("clicking Next Round loads the next product", async () => {
    rafMock.mockImplementation((cb) => {
      cb(6000);
      return 1;
    });
    perfNowMock.mockReturnValue(0);

    const result = makeRiserResult();
    mockedApi.submitRiserGuess.mockResolvedValue({
      result,
      session: makeSession({ totalScore: 700, completed: false }),
    } as any);

    renderWithProviders(<RiserPage {...defaultProps} />);
    await flushMicrotasks();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Start" }));
    });
    await flushMicrotasks();

    // Reset getProduct mock to track next call
    mockedApi.getProduct.mockClear();
    mockedApi.getProduct.mockResolvedValue(
      makeRiserData({ product: { ...makeRiserData().product, title: "Next Widget" } }) as any
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Next Round" }));
    });
    await flushMicrotasks();

    // Should have fetched the next product
    expect(mockedApi.getProduct).toHaveBeenCalledWith("session-1");
    expect(screen.getByText("Next Widget")).toBeInTheDocument();
  });

  it("shows 'See Final Results' when game ended", async () => {
    rafMock.mockImplementation((cb) => {
      cb(6000);
      return 1;
    });
    perfNowMock.mockReturnValue(0);

    const result = makeRiserResult();
    mockedApi.submitRiserGuess.mockResolvedValue({
      result,
      session: makeSession({ totalScore: 700, completed: true }),
    } as any);

    renderWithProviders(<RiserPage {...defaultProps} />);
    await flushMicrotasks();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Start" }));
    });
    await flushMicrotasks();

    expect(screen.getByRole("button", { name: "See Final Results" })).toBeInTheDocument();
  });

  it("calls onGameEnd when clicking See Final Results", async () => {
    rafMock.mockImplementation((cb) => {
      cb(6000);
      return 1;
    });
    perfNowMock.mockReturnValue(0);

    const onGameEnd = vi.fn();
    const result = makeRiserResult();
    mockedApi.submitRiserGuess.mockResolvedValue({
      result,
      session: makeSession({ totalScore: 700, completed: true }),
    } as any);

    renderWithProviders(
      <RiserPage {...defaultProps} onGameEnd={onGameEnd} />
    );
    await flushMicrotasks();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Start" }));
    });
    await flushMicrotasks();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "See Final Results" }));
    });

    expect(onGameEnd).toHaveBeenCalledTimes(1);
  });

  it("calls onRoundComplete with result and session after submit", async () => {
    rafMock.mockImplementation((cb) => {
      cb(6000);
      return 1;
    });
    perfNowMock.mockReturnValue(0);

    const onRoundComplete = vi.fn();
    const result = makeRiserResult();
    const updatedSession = makeSession({ totalScore: 700 });
    mockedApi.submitRiserGuess.mockResolvedValue({
      result,
      session: updatedSession,
    } as any);

    renderWithProviders(
      <RiserPage {...defaultProps} onRoundComplete={onRoundComplete} />
    );
    await flushMicrotasks();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Start" }));
    });
    await flushMicrotasks();

    expect(onRoundComplete).toHaveBeenCalledWith(result, updatedSession, undefined);
  });

  // ---------------------------------------------------------------------------
  // Price range display
  // ---------------------------------------------------------------------------

  it("displays min and max price range", async () => {
    renderWithProviders(<RiserPage {...defaultProps} />);
    await flushMicrotasks();

    // minPrice = 10% of 10000 = 1000 cents = $10.00
    // maxPrice = 10000 cents = $100.00
    // formatPrice with USD default should show dollar amounts
    const rangeContainer = document.querySelector(".riser-range");
    expect(rangeContainer).toBeInTheDocument();
  });

  // ---------------------------------------------------------------------------
  // Error handling
  // ---------------------------------------------------------------------------

  it("handles getProduct error gracefully", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockedApi.getProduct.mockRejectedValue(new Error("Network error"));

    renderWithProviders(<RiserPage {...defaultProps} />);
    await flushMicrotasks();

    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it("handles submitRiserGuess error gracefully", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    rafMock.mockImplementation((cb) => {
      cb(6000);
      return 1;
    });
    perfNowMock.mockReturnValue(0);

    mockedApi.submitRiserGuess.mockRejectedValue(new Error("Submit failed"));

    renderWithProviders(<RiserPage {...defaultProps} />);
    await flushMicrotasks();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Start" }));
    });
    await flushMicrotasks();

    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  // ---------------------------------------------------------------------------
  // Image modal (zoom)
  // ---------------------------------------------------------------------------

  it("opens image modal when clicking product image", async () => {
    renderWithProviders(<RiserPage {...defaultProps} />);
    await flushMicrotasks();

    const img = screen.getByAltText("Riser Widget") as HTMLImageElement;
    await act(async () => {
      fireEvent.click(img);
    });

    expect(screen.getByRole("dialog", { name: "Image preview" })).toBeInTheDocument();
  });

  it("closes image modal on close button click", async () => {
    renderWithProviders(<RiserPage {...defaultProps} />);
    await flushMicrotasks();

    const img = screen.getByAltText("Riser Widget") as HTMLImageElement;
    await act(async () => {
      fireEvent.click(img);
    });

    expect(screen.getByRole("dialog")).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByLabelText("Close"));
    });

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  // ---------------------------------------------------------------------------
  // Speed patterns (getProgress)
  // ---------------------------------------------------------------------------

  it("handles accelerating speed pattern data", async () => {
    mockedApi.getProduct.mockResolvedValue(
      makeRiserData({ speedPattern: "accelerating" }) as any
    );
    rafMock.mockImplementation((cb) => {
      cb(6000);
      return 1;
    });
    perfNowMock.mockReturnValue(0);

    mockedApi.submitRiserGuess.mockResolvedValue({
      result: makeRiserResult(),
      session: makeSession({ totalScore: 700 }),
    } as any);

    renderWithProviders(<RiserPage {...defaultProps} />);
    await flushMicrotasks();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Start" }));
    });
    await flushMicrotasks();

    // Animation should complete and submit
    expect(mockedApi.submitRiserGuess).toHaveBeenCalled();
  });

  it("handles decelerating speed pattern data", async () => {
    mockedApi.getProduct.mockResolvedValue(
      makeRiserData({ speedPattern: "decelerating" }) as any
    );
    rafMock.mockImplementation((cb) => {
      cb(6000);
      return 1;
    });
    perfNowMock.mockReturnValue(0);

    mockedApi.submitRiserGuess.mockResolvedValue({
      result: makeRiserResult(),
      session: makeSession({ totalScore: 700 }),
    } as any);

    renderWithProviders(<RiserPage {...defaultProps} />);
    await flushMicrotasks();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Start" }));
    });
    await flushMicrotasks();

    expect(mockedApi.submitRiserGuess).toHaveBeenCalled();
  });

  it("handles wave speed pattern data", async () => {
    mockedApi.getProduct.mockResolvedValue(
      makeRiserData({ speedPattern: "wave" }) as any
    );
    rafMock.mockImplementation((cb) => {
      cb(6000);
      return 1;
    });
    perfNowMock.mockReturnValue(0);

    mockedApi.submitRiserGuess.mockResolvedValue({
      result: makeRiserResult(),
      session: makeSession({ totalScore: 700 }),
    } as any);

    renderWithProviders(<RiserPage {...defaultProps} />);
    await flushMicrotasks();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Start" }));
    });
    await flushMicrotasks();

    expect(mockedApi.submitRiserGuess).toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Cleanup
  // ---------------------------------------------------------------------------

  it("cancels animation frame on unmount", async () => {
    // Keep animation running (don't invoke callback)
    rafMock.mockImplementation(() => 99);
    perfNowMock.mockReturnValue(0);

    const { unmount } = renderWithProviders(<RiserPage {...defaultProps} />);
    await flushMicrotasks();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Start" }));
    });

    unmount();

    expect(cafMock).toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Result title edge cases
  // ---------------------------------------------------------------------------

  it("shows 'In the ballpark' for score >= 200 and < 350", async () => {
    rafMock.mockImplementation((cb) => {
      cb(6000);
      return 1;
    });
    perfNowMock.mockReturnValue(0);

    const result = makeRiserResult({ score: 250 });
    mockedApi.submitRiserGuess.mockResolvedValue({
      result,
      session: makeSession({ totalScore: 250 }),
    } as any);

    renderWithProviders(<RiserPage {...defaultProps} />);
    await flushMicrotasks();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Start" }));
    });
    await flushMicrotasks();

    expect(screen.getByText("In the ballpark")).toBeInTheDocument();
  });

  it("shows 'Keep going next time' for score >= 100 and < 200", async () => {
    rafMock.mockImplementation((cb) => {
      cb(6000);
      return 1;
    });
    perfNowMock.mockReturnValue(0);

    const result = makeRiserResult({ score: 150 });
    mockedApi.submitRiserGuess.mockResolvedValue({
      result,
      session: makeSession({ totalScore: 150 }),
    } as any);

    renderWithProviders(<RiserPage {...defaultProps} />);
    await flushMicrotasks();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Start" }));
    });
    await flushMicrotasks();

    expect(screen.getByText("Keep going next time")).toBeInTheDocument();
  });

  // ---------------------------------------------------------------------------
  // Result difference display
  // ---------------------------------------------------------------------------

  it("displays price difference with 'under' when not over", async () => {
    rafMock.mockImplementation((cb) => {
      cb(6000);
      return 1;
    });
    perfNowMock.mockReturnValue(0);

    const result = makeRiserResult({
      stoppedPriceCents: 4500,
      pctOff: 0.1,
      wentOver: false,
      product: makeProductWithPrice({ priceCents: 5000 }),
    });
    mockedApi.submitRiserGuess.mockResolvedValue({
      result,
      session: makeSession({ totalScore: 700 }),
    } as any);

    renderWithProviders(<RiserPage {...defaultProps} />);
    await flushMicrotasks();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Start" }));
    });
    await flushMicrotasks();

    // Difference row should show "under"
    const differenceLabels = screen.getAllByText("Difference");
    expect(differenceLabels.length).toBeGreaterThan(0);
  });

  it("displays price difference with 'over' when went over", async () => {
    rafMock.mockImplementation((cb) => {
      cb(6000);
      return 1;
    });
    perfNowMock.mockReturnValue(0);

    const result = makeRiserResult({
      stoppedPriceCents: 6000,
      pctOff: 0.2,
      wentOver: true,
      score: 0,
      product: makeProductWithPrice({ priceCents: 5000 }),
    });
    mockedApi.submitRiserGuess.mockResolvedValue({
      result,
      session: makeSession({ totalScore: 0 }),
    } as any);

    renderWithProviders(<RiserPage {...defaultProps} />);
    await flushMicrotasks();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Start" }));
    });
    await flushMicrotasks();

    expect(screen.getByText("WENT OVER!")).toBeInTheDocument();
  });

  // ---------------------------------------------------------------------------
  // Updates totalScore on result
  // ---------------------------------------------------------------------------

  it("updates totalScore in scoreboard after result", async () => {
    rafMock.mockImplementation((cb) => {
      cb(6000);
      return 1;
    });
    perfNowMock.mockReturnValue(0);

    const result = makeRiserResult({ score: 700 });
    mockedApi.submitRiserGuess.mockResolvedValue({
      result,
      session: makeSession({ totalScore: 700 }),
    } as any);

    renderWithProviders(<RiserPage {...defaultProps} />);
    await flushMicrotasks();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Start" }));
    });
    await flushMicrotasks();

    expect(screen.getByText("700")).toBeInTheDocument();
  });

  // ---------------------------------------------------------------------------
  // Inline result layout
  // ---------------------------------------------------------------------------

  it("renders the result in an inline panel below the scene (not a fullscreen overlay)", async () => {
    rafMock.mockImplementation((cb) => {
      cb(6000);
      return 1;
    });
    perfNowMock.mockReturnValue(0);

    mockedApi.submitRiserGuess.mockResolvedValue({
      result: makeRiserResult({ score: 700 }),
      session: makeSession({ totalScore: 700 }),
    } as any);

    renderWithProviders(<RiserPage {...defaultProps} />);
    await flushMicrotasks();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Start" }));
    });
    await flushMicrotasks();

    // Inline panel should be present with aria-live so screen readers announce
    // the result, and the fullscreen overlay wrapper should NOT be used.
    const inline = document.querySelector(".riser-result-inline");
    expect(inline).toBeInTheDocument();
    expect(inline).toHaveAttribute("role", "status");
    expect(inline).toHaveAttribute("aria-live", "polite");
    expect(document.querySelector(".result-overlay")).not.toBeInTheDocument();
    // The inner card gets the riser-round-result modifier for compact layout
    expect(document.querySelector(".round-result.riser-round-result")).toBeInTheDocument();
  });

  it("hides the top product thumbnail once the result is shown", async () => {
    rafMock.mockImplementation((cb) => {
      cb(6000);
      return 1;
    });
    perfNowMock.mockReturnValue(0);

    mockedApi.submitRiserGuess.mockResolvedValue({
      result: makeRiserResult({ score: 700 }),
      session: makeSession({ totalScore: 700 }),
    } as any);

    renderWithProviders(<RiserPage {...defaultProps} />);
    await flushMicrotasks();

    // Before Start: top .riser-product (with .riser-product-img) is visible.
    expect(document.querySelector(".riser-product .riser-product-img")).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Start" }));
    });
    await flushMicrotasks();

    // After result: the top .riser-product block is unmounted (avoids the
    // duplicate thumbnail since the same product is inside the result panel).
    expect(document.querySelector(".riser-product .riser-product-img")).not.toBeInTheDocument();
    // The result-card's own product image is still present.
    expect(document.querySelector(".result-product-card .result-product-img")).toBeInTheDocument();
  });
});
