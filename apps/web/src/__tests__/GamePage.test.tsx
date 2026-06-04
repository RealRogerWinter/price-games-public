import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, fireEvent, act } from "@testing-library/react";
import GamePage from "../pages/GamePage";
import * as api from "../api/client";
import { renderWithProviders, makeSession, makeProduct, makeProductWithPrice, flushMicrotasks } from "./testUtils";

vi.mock("../api/client");
const mockedApi = vi.mocked(api);

describe("GamePage", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ rates: {} }))
    );
    mockedApi.getProduct.mockResolvedValue(makeProduct());
  });

  afterEach(() => {
    vi.useRealTimers();
    fetchSpy.mockRestore();
  });

  const defaultProps = {
    session: makeSession(),
    onRoundComplete: vi.fn(),
    onGameEnd: vi.fn(),
  };

  it("shows loading state while fetching product", () => {
    mockedApi.getProduct.mockReturnValue(new Promise(() => {}));
    renderWithProviders(<GamePage {...defaultProps} />);
    expect(screen.getByText("Loading product...")).toBeInTheDocument();
  });

  it("shows scoreboard with round info", async () => {
    renderWithProviders(<GamePage {...defaultProps} />);
    await flushMicrotasks();
    expect(screen.getByText("1 / 10")).toBeInTheDocument();
  });

  it("displays product card after loading", async () => {
    renderWithProviders(<GamePage {...defaultProps} />);
    await flushMicrotasks();
    expect(screen.getByText("Test Widget")).toBeInTheDocument();
  });

  it("shows timer hint on round 1", async () => {
    renderWithProviders(<GamePage {...defaultProps} />);
    await flushMicrotasks();
    expect(screen.getByText("Timer starts when you interact")).toBeInTheDocument();
  });

  it("shows Use Hint button", async () => {
    renderWithProviders(<GamePage {...defaultProps} />);
    await flushMicrotasks();
    expect(screen.getByRole("button", { name: "Use Hint" })).toBeInTheDocument();
  });

  it("shows hint badge after using hint", async () => {
    mockedApi.getHint.mockResolvedValue({
      hintRange: { min: 1000, max: 3000 },
    });

    renderWithProviders(<GamePage {...defaultProps} />);
    await flushMicrotasks();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Use Hint" }));
    });
    await flushMicrotasks();

    expect(screen.getByText(/Hint active/)).toBeInTheDocument();
  });

  it("hides hint button after using hint", async () => {
    mockedApi.getHint.mockResolvedValue({
      hintRange: { min: 1000, max: 3000 },
    });

    renderWithProviders(<GamePage {...defaultProps} />);
    await flushMicrotasks();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Use Hint" }));
    });
    await flushMicrotasks();

    expect(screen.queryByRole("button", { name: "Use Hint" })).not.toBeInTheDocument();
  });
});
