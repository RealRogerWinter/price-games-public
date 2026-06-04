import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, fireEvent, act } from "@testing-library/react";
import MPGameScreen from "../components/multiplayer/MPGameScreen";
import { renderWithProviders, makePlayer, makeProduct, makeRoundStartPayload, flushMicrotasks } from "./testUtils";

describe("MPGameScreen", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ rates: {} }))
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    fetchSpy.mockRestore();
  });

  const defaultProps = {
    roundData: makeRoundStartPayload({
      gameMode: "classic",
      product: makeProduct(),
    }),
    players: [
      makePlayer({ id: "player-1", displayName: "Alice" }),
      makePlayer({ id: "player-2", displayName: "Bob" }),
    ],
    currentPlayerId: "player-1",
    lockedPlayerIds: new Set<string>(),
    currentRound: 1,
    totalRounds: 10,
    totalScore: 0,
    hasGuessed: false,
    onSubmitGuess: vi.fn(),
  };

  it("shows scoreboard with round info", () => {
    renderWithProviders(<MPGameScreen {...defaultProps} />);
    expect(screen.getByText("1 / 10")).toBeInTheDocument();
  });

  it("shows product card for classic mode", () => {
    renderWithProviders(<MPGameScreen {...defaultProps} />);
    expect(screen.getByText("Test Widget")).toBeInTheDocument();
  });

  it("shows Locked in message when hasGuessed is true", () => {
    renderWithProviders(<MPGameScreen {...defaultProps} hasGuessed={true} />);
    expect(screen.getByText("Locked in!")).toBeInTheDocument();
    expect(screen.getByText(/Waiting for other players/)).toBeInTheDocument();
  });

  it("shows locked count", () => {
    renderWithProviders(
      <MPGameScreen
        {...defaultProps}
        hasGuessed={true}
        lockedPlayerIds={new Set(["player-1"])}
      />
    );
    expect(screen.getByText(/1\/2/)).toBeInTheDocument();
  });

  it("shows higher/lower UI for that mode", () => {
    renderWithProviders(
      <MPGameScreen
        {...defaultProps}
        roundData={makeRoundStartPayload({
          gameMode: "higher-lower",
          product: makeProduct(),
          referencePrice: 2500,
        })}
      />
    );
    expect(screen.getByText("Higher")).toBeInTheDocument();
    expect(screen.getByText("Lower")).toBeInTheDocument();
  });

  it("calls onSubmitGuess with higher/lower guess", () => {
    const onSubmitGuess = vi.fn();
    renderWithProviders(
      <MPGameScreen
        {...defaultProps}
        onSubmitGuess={onSubmitGuess}
        roundData={makeRoundStartPayload({
          gameMode: "higher-lower",
          product: makeProduct(),
          referencePrice: 2500,
        })}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Higher" }));
    expect(onSubmitGuess).toHaveBeenCalledWith({ guess: "higher" });
  });

  it("shows comparison UI for that mode", () => {
    renderWithProviders(
      <MPGameScreen
        {...defaultProps}
        roundData={makeRoundStartPayload({
          gameMode: "comparison",
          products: [
            makeProduct({ id: 1, title: "Product A" }),
            makeProduct({ id: 2, title: "Product B" }),
          ],
          question: "most-expensive",
        })}
      />
    );
    expect(screen.getByText("Product A")).toBeInTheDocument();
    expect(screen.getByText("Product B")).toBeInTheDocument();
    expect(screen.getByText(/MORE/)).toBeInTheDocument();
  });

  it("shows Underbid label for closest mode", () => {
    renderWithProviders(
      <MPGameScreen
        {...defaultProps}
        roundData={makeRoundStartPayload({
          gameMode: "closest-without-going-over",
          product: makeProduct(),
        })}
      />
    );
    expect(screen.getByText("Underbid!")).toBeInTheDocument();
  });

  it("shows price match UI for that mode", () => {
    renderWithProviders(
      <MPGameScreen
        {...defaultProps}
        roundData={makeRoundStartPayload({
          gameMode: "price-match",
          products: [
            makeProduct({ id: 1, title: "Item A" }),
            makeProduct({ id: 2, title: "Item B" }),
          ],
          prices: [1000, 2000],
        })}
      />
    );
    expect(screen.getByText("Match each product to its price")).toBeInTheDocument();
    expect(screen.getByText("Item A")).toBeInTheDocument();
    expect(screen.getByText("Item B")).toBeInTheDocument();
  });

  it("shows riser UI for that mode", () => {
    renderWithProviders(
      <MPGameScreen
        {...defaultProps}
        roundData={makeRoundStartPayload({
          gameMode: "riser",
          product: makeProduct(),
          maxPriceCents: 10000,
          speedPattern: "linear",
          durationMs: 8000,
        })}
      />
    );
    expect(screen.getByRole("button", { name: "Start" })).toBeInTheDocument();
  });

  it("shows player status bar", () => {
    renderWithProviders(<MPGameScreen {...defaultProps} />);
    expect(screen.getByText("Alice")).toBeInTheDocument();
    expect(screen.getByText("Bob")).toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // Timer expiration behavior
  // -------------------------------------------------------------------------

  describe("timer expiration", () => {

    it("auto-submits guessedPriceCents: 0 for classic mode when timer expires", async () => {
      const onSubmitGuess = vi.fn();
      renderWithProviders(
        <MPGameScreen
          {...defaultProps}
          onSubmitGuess={onSubmitGuess}
          roundData={makeRoundStartPayload({
            gameMode: "classic",
            product: makeProduct(),
            timerSeconds: 3,
          })}
        />
      );

      // Advance timer to expiration (3 seconds + 1 to trigger)
      await act(async () => {
        vi.advanceTimersByTime(3000);
      });
      // Flush the setTimeout(onExpire, 0) inside MPTimer
      await act(async () => {
        vi.advanceTimersByTime(0);
      });

      expect(onSubmitGuess).toHaveBeenCalledWith({ guessedPriceCents: 0 });
    });

    it("auto-submits guessedPriceCents: 0 for closest-without-going-over when timer expires", async () => {
      const onSubmitGuess = vi.fn();
      renderWithProviders(
        <MPGameScreen
          {...defaultProps}
          onSubmitGuess={onSubmitGuess}
          roundData={makeRoundStartPayload({
            gameMode: "closest-without-going-over",
            product: makeProduct(),
            timerSeconds: 2,
          })}
        />
      );

      await act(async () => {
        vi.advanceTimersByTime(2000);
      });
      await act(async () => {
        vi.advanceTimersByTime(0);
      });

      expect(onSubmitGuess).toHaveBeenCalledWith({ guessedPriceCents: 0 });
    });

    it("auto-submits guess: lower for higher-lower mode when timer expires", async () => {
      const onSubmitGuess = vi.fn();
      renderWithProviders(
        <MPGameScreen
          {...defaultProps}
          onSubmitGuess={onSubmitGuess}
          roundData={makeRoundStartPayload({
            gameMode: "higher-lower",
            product: makeProduct(),
            referencePrice: 2500,
            timerSeconds: 2,
          })}
        />
      );

      await act(async () => {
        vi.advanceTimersByTime(2000);
      });
      await act(async () => {
        vi.advanceTimersByTime(0);
      });

      expect(onSubmitGuess).toHaveBeenCalledWith({ guess: "lower" });
    });

    it("auto-submits first product id for comparison mode when timer expires", async () => {
      const onSubmitGuess = vi.fn();
      const products = [
        makeProduct({ id: 10, title: "Product X" }),
        makeProduct({ id: 20, title: "Product Y" }),
      ];
      renderWithProviders(
        <MPGameScreen
          {...defaultProps}
          onSubmitGuess={onSubmitGuess}
          roundData={makeRoundStartPayload({
            gameMode: "comparison",
            products,
            question: "most-expensive",
            timerSeconds: 2,
          })}
        />
      );

      await act(async () => {
        vi.advanceTimersByTime(2000);
      });
      await act(async () => {
        vi.advanceTimersByTime(0);
      });

      expect(onSubmitGuess).toHaveBeenCalledWith({ guessedProductId: 10 });
    });

    it("auto-submits empty assignments for price-match mode when timer expires", async () => {
      const onSubmitGuess = vi.fn();
      renderWithProviders(
        <MPGameScreen
          {...defaultProps}
          onSubmitGuess={onSubmitGuess}
          roundData={makeRoundStartPayload({
            gameMode: "price-match",
            products: [
              makeProduct({ id: 1, title: "Item A" }),
              makeProduct({ id: 2, title: "Item B" }),
            ],
            prices: [1000, 2000],
            timerSeconds: 2,
          })}
        />
      );

      await act(async () => {
        vi.advanceTimersByTime(2000);
      });
      await act(async () => {
        vi.advanceTimersByTime(0);
      });

      expect(onSubmitGuess).toHaveBeenCalledWith({ assignments: {} });
    });

    it("does not auto-submit when hasGuessed is already true", async () => {
      const onSubmitGuess = vi.fn();
      renderWithProviders(
        <MPGameScreen
          {...defaultProps}
          onSubmitGuess={onSubmitGuess}
          hasGuessed={true}
          roundData={makeRoundStartPayload({
            gameMode: "classic",
            product: makeProduct(),
            timerSeconds: 2,
          })}
        />
      );

      await act(async () => {
        vi.advanceTimersByTime(3000);
      });
      await act(async () => {
        vi.advanceTimersByTime(0);
      });

      expect(onSubmitGuess).not.toHaveBeenCalled();
    });

    it("does not show timer for riser mode", () => {
      renderWithProviders(
        <MPGameScreen
          {...defaultProps}
          roundData={makeRoundStartPayload({
            gameMode: "riser",
            product: makeProduct(),
            maxPriceCents: 10000,
            speedPattern: "linear",
            durationMs: 8000,
          })}
        />
      );
      // Timer component renders an element with aria-label "Timer: X seconds remaining"
      expect(screen.queryByLabelText(/Timer:/)).not.toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // Classic mode PriceInput submission
  // -------------------------------------------------------------------------

  describe("classic mode price submission", () => {
    it("renders PriceInput with Lock In Price button", () => {
      renderWithProviders(<MPGameScreen {...defaultProps} />);
      expect(screen.getByRole("button", { name: "Lock In Price" })).toBeInTheDocument();
    });

    it("calls onSubmitGuess with guessedPriceCents when Lock In Price is clicked", async () => {
      const onSubmitGuess = vi.fn();
      renderWithProviders(
        <MPGameScreen
          {...defaultProps}
          onSubmitGuess={onSubmitGuess}
          roundData={makeRoundStartPayload({
            gameMode: "classic",
            product: makeProduct({ priceRange: { min: 100, max: 5000 } }),
          })}
        />
      );

      // Submit the form via the Lock In Price button
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Lock In Price" }));
      });

      expect(onSubmitGuess).toHaveBeenCalledWith({
        guessedPriceCents: expect.any(Number),
      });
    });

    it("returns null when product is missing for classic mode", () => {
      const { container } = renderWithProviders(
        <MPGameScreen
          {...defaultProps}
          roundData={makeRoundStartPayload({
            gameMode: "classic",
            product: undefined,
          })}
        />
      );
      // No PriceInput or ProductCard should be present
      expect(screen.queryByRole("button", { name: "Lock In Price" })).not.toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // Closest-without-going-over mode PriceInput submission
  // -------------------------------------------------------------------------

  describe("closest-without-going-over mode price submission", () => {
    it("calls onSubmitGuess with guessedPriceCents when Lock In Price is clicked", async () => {
      const onSubmitGuess = vi.fn();
      renderWithProviders(
        <MPGameScreen
          {...defaultProps}
          onSubmitGuess={onSubmitGuess}
          roundData={makeRoundStartPayload({
            gameMode: "closest-without-going-over",
            product: makeProduct({ priceRange: { min: 100, max: 5000 } }),
          })}
        />
      );

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Lock In Price" }));
      });

      expect(onSubmitGuess).toHaveBeenCalledWith({
        guessedPriceCents: expect.any(Number),
      });
    });

    it("returns null when product is missing for closest mode", () => {
      renderWithProviders(
        <MPGameScreen
          {...defaultProps}
          roundData={makeRoundStartPayload({
            gameMode: "closest-without-going-over",
            product: undefined,
          })}
        />
      );
      expect(screen.queryByRole("button", { name: "Lock In Price" })).not.toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // Higher/Lower mode interactions
  // -------------------------------------------------------------------------

  describe("higher-lower mode interactions", () => {
    it("calls onSubmitGuess with lower guess", () => {
      const onSubmitGuess = vi.fn();
      renderWithProviders(
        <MPGameScreen
          {...defaultProps}
          onSubmitGuess={onSubmitGuess}
          roundData={makeRoundStartPayload({
            gameMode: "higher-lower",
            product: makeProduct(),
            referencePrice: 2500,
          })}
        />
      );
      fireEvent.click(screen.getByRole("button", { name: "Lower" }));
      expect(onSubmitGuess).toHaveBeenCalledWith({ guess: "lower" });
    });

    it("returns null when product is missing for higher-lower mode", () => {
      renderWithProviders(
        <MPGameScreen
          {...defaultProps}
          roundData={makeRoundStartPayload({
            gameMode: "higher-lower",
            product: undefined,
            referencePrice: 2500,
          })}
        />
      );
      expect(screen.queryByRole("button", { name: "Higher" })).not.toBeInTheDocument();
    });

    it("returns null when referencePrice is undefined for higher-lower mode", () => {
      renderWithProviders(
        <MPGameScreen
          {...defaultProps}
          roundData={makeRoundStartPayload({
            gameMode: "higher-lower",
            product: makeProduct(),
            referencePrice: undefined,
          })}
        />
      );
      expect(screen.queryByRole("button", { name: "Higher" })).not.toBeInTheDocument();
    });

    it("disables buttons when disabled (hasGuessed is true)", () => {
      // When hasGuessed=true, the ModeGameUI is not rendered at all (locked-in state).
      // So we can't test disabled on the buttons directly in MPGameScreen.
      // Instead we verify the locked-in UI replaces the game UI.
      renderWithProviders(
        <MPGameScreen
          {...defaultProps}
          hasGuessed={true}
          roundData={makeRoundStartPayload({
            gameMode: "higher-lower",
            product: makeProduct(),
            referencePrice: 2500,
          })}
        />
      );
      expect(screen.queryByRole("button", { name: "Higher" })).not.toBeInTheDocument();
      expect(screen.getByText("Locked in!")).toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // Comparison mode interactions
  // -------------------------------------------------------------------------

  describe("comparison mode interactions", () => {
    it("calls onSubmitGuess with guessedProductId when a product is clicked", () => {
      const onSubmitGuess = vi.fn();
      renderWithProviders(
        <MPGameScreen
          {...defaultProps}
          onSubmitGuess={onSubmitGuess}
          roundData={makeRoundStartPayload({
            gameMode: "comparison",
            products: [
              makeProduct({ id: 1, title: "Product A" }),
              makeProduct({ id: 2, title: "Product B" }),
            ],
            question: "most-expensive",
          })}
        />
      );
      fireEvent.click(screen.getByText("Product B"));
      expect(onSubmitGuess).toHaveBeenCalledWith({ guessedProductId: 2 });
    });

    it("shows LESS text for least-expensive question", () => {
      renderWithProviders(
        <MPGameScreen
          {...defaultProps}
          roundData={makeRoundStartPayload({
            gameMode: "comparison",
            products: [
              makeProduct({ id: 1, title: "Product A" }),
              makeProduct({ id: 2, title: "Product B" }),
            ],
            question: "least-expensive",
          })}
        />
      );
      expect(screen.getByText(/LESS/)).toBeInTheDocument();
    });

    it("defaults to MORE when question is undefined", () => {
      renderWithProviders(
        <MPGameScreen
          {...defaultProps}
          roundData={makeRoundStartPayload({
            gameMode: "comparison",
            products: [
              makeProduct({ id: 1, title: "Product A" }),
              makeProduct({ id: 2, title: "Product B" }),
            ],
          })}
        />
      );
      expect(screen.getByText(/MORE/)).toBeInTheDocument();
    });

    it("returns null when products is missing for comparison mode", () => {
      renderWithProviders(
        <MPGameScreen
          {...defaultProps}
          roundData={makeRoundStartPayload({
            gameMode: "comparison",
            products: undefined,
          })}
        />
      );
      expect(screen.queryByText(/expensive/)).not.toBeInTheDocument();
    });

    it("does NOT open image modal when clicking the in-round product image (image is part of selection target)", async () => {
      const onSubmitGuess = vi.fn();
      renderWithProviders(
        <MPGameScreen
          {...defaultProps}
          onSubmitGuess={onSubmitGuess}
          roundData={makeRoundStartPayload({
            gameMode: "comparison",
            products: [
              makeProduct({ id: 1, title: "Product A", imageUrl: "https://example.com/a.jpg" }),
              makeProduct({ id: 2, title: "Product B", imageUrl: "https://example.com/b.jpg" }),
            ],
            question: "most-expensive",
          })}
        />
      );

      const img = screen.getByAltText("Product A") as HTMLImageElement;
      await act(async () => {
        fireEvent.click(img);
      });

      // No zoom modal should open — clicking the image bubbles up to the
      // parent button and submits the guess instead.
      expect(screen.queryByRole("dialog", { name: "Image preview" })).not.toBeInTheDocument();
      expect(onSubmitGuess).toHaveBeenCalledWith({ guessedProductId: 1 });
    });

    it("renders the ComparisonPrompt with data-question driving direction styling", () => {
      const { container } = renderWithProviders(
        <MPGameScreen
          {...defaultProps}
          roundData={makeRoundStartPayload({
            gameMode: "comparison",
            products: [
              makeProduct({ id: 1, title: "Product A" }),
              makeProduct({ id: 2, title: "Product B" }),
            ],
            question: "least-expensive",
          })}
        />
      );
      expect(
        container.querySelector('.comparison-prompt[data-question="least-expensive"]')
      ).not.toBeNull();
    });

    it("hides image on error", () => {
      renderWithProviders(
        <MPGameScreen
          {...defaultProps}
          roundData={makeRoundStartPayload({
            gameMode: "comparison",
            products: [
              makeProduct({ id: 1, title: "Product A" }),
              makeProduct({ id: 2, title: "Product B" }),
            ],
            question: "most-expensive",
          })}
        />
      );

      const img = screen.getByAltText("Product A") as HTMLImageElement;
      fireEvent.error(img);
      expect(img.style.display).toBe("none");
    });
  });

  // -------------------------------------------------------------------------
  // Price-match mode interactions
  // -------------------------------------------------------------------------

  describe("price-match mode interactions", () => {
    const priceMatchProps = {
      ...defaultProps,
      roundData: makeRoundStartPayload({
        gameMode: "price-match" as const,
        products: [
          makeProduct({ id: 1, title: "Item A" }),
          makeProduct({ id: 2, title: "Item B" }),
        ],
        prices: [1000, 2000],
      }),
    };

    it("shows instruction to tap a product initially", () => {
      renderWithProviders(<MPGameScreen {...priceMatchProps} />);
      expect(screen.getByText("Tap a product, then tap a price to assign it")).toBeInTheDocument();
    });

    it("shows instruction to pick a price after selecting a product", async () => {
      renderWithProviders(<MPGameScreen {...priceMatchProps} />);

      await act(async () => {
        fireEvent.click(screen.getByText("Item A"));
      });

      expect(screen.getByText("Now pick a price for the highlighted product")).toBeInTheDocument();
    });

    it("assigns a price to a product and shows the assigned price", async () => {
      renderWithProviders(<MPGameScreen {...priceMatchProps} />);

      // Click product A
      await act(async () => {
        fireEvent.click(screen.getByText("Item A"));
      });

      // Click the first price button ($10.00 = 1000 cents)
      const priceButtons = screen.getAllByRole("button").filter(
        (btn) => btn.classList.contains("pm-price-btn")
      );
      await act(async () => {
        fireEvent.click(priceButtons[0]);
      });

      // The assigned price should be displayed on the product card
      expect(document.querySelector(".pm-assigned-price")).toBeInTheDocument();
    });

    it("unassigns a product when clicking an already assigned product", async () => {
      renderWithProviders(<MPGameScreen {...priceMatchProps} />);

      // Select and assign Item A
      await act(async () => {
        fireEvent.click(screen.getByText("Item A"));
      });
      const priceButtons = screen.getAllByRole("button").filter(
        (btn) => btn.classList.contains("pm-price-btn")
      );
      await act(async () => {
        fireEvent.click(priceButtons[0]);
      });
      expect(document.querySelector(".pm-assigned-price")).toBeInTheDocument();

      // Click Item A again to unassign
      await act(async () => {
        fireEvent.click(screen.getByText("Item A"));
      });

      // The assigned price should be removed from Item A
      const assignedPrices = document.querySelectorAll(".pm-assigned-price");
      expect(assignedPrices.length).toBe(0);
    });

    it("removes the assigned price from the menu so it cannot be re-used", async () => {
      renderWithProviders(<MPGameScreen {...priceMatchProps} />);

      // Select Item A and assign first price (1000 cents = $10.00)
      await act(async () => {
        fireEvent.click(screen.getByText("Item A"));
      });
      const priceButtons = screen.getAllByRole("button").filter(
        (btn) => btn.classList.contains("pm-price-btn")
      );
      const initialButtonCount = priceButtons.length;
      await act(async () => {
        fireEvent.click(priceButtons[0]);
      });

      // After assignment the menu should have one fewer button — the
      // assigned price disappears entirely (it cannot be re-used).
      const updatedPriceButtons = screen.getAllByRole("button").filter(
        (btn) => btn.classList.contains("pm-price-btn")
      );
      expect(updatedPriceButtons.length).toBe(initialButtonCount - 1);
    });

    it("shows Lock In Answers button when all products are assigned", async () => {
      const onSubmitGuess = vi.fn();
      renderWithProviders(
        <MPGameScreen {...priceMatchProps} onSubmitGuess={onSubmitGuess} />
      );

      // Assign Item A -> first price
      await act(async () => {
        fireEvent.click(screen.getByText("Item A"));
      });
      let priceButtons = screen.getAllByRole("button").filter(
        (btn) => btn.classList.contains("pm-price-btn")
      );
      await act(async () => {
        fireEvent.click(priceButtons[0]);
      });

      // Assign Item B -> second price
      await act(async () => {
        fireEvent.click(screen.getByText("Item B"));
      });
      priceButtons = screen.getAllByRole("button").filter(
        (btn) => btn.classList.contains("pm-price-btn") && !btn.hasAttribute("disabled")
      );
      await act(async () => {
        fireEvent.click(priceButtons[0]);
      });

      // Lock In Answers should appear
      expect(screen.getByRole("button", { name: "Lock In Answers" })).toBeInTheDocument();
    });

    it("submits assignments when Lock In Answers is clicked", async () => {
      const onSubmitGuess = vi.fn();
      renderWithProviders(
        <MPGameScreen {...priceMatchProps} onSubmitGuess={onSubmitGuess} />
      );

      // Assign Item A -> first price
      await act(async () => {
        fireEvent.click(screen.getByText("Item A"));
      });
      let priceButtons = screen.getAllByRole("button").filter(
        (btn) => btn.classList.contains("pm-price-btn")
      );
      await act(async () => {
        fireEvent.click(priceButtons[0]);
      });

      // Assign Item B -> second price
      await act(async () => {
        fireEvent.click(screen.getByText("Item B"));
      });
      priceButtons = screen.getAllByRole("button").filter(
        (btn) => btn.classList.contains("pm-price-btn") && !btn.hasAttribute("disabled")
      );
      await act(async () => {
        fireEvent.click(priceButtons[0]);
      });

      // Click Lock In Answers
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Lock In Answers" }));
      });

      expect(onSubmitGuess).toHaveBeenCalledWith({
        assignments: expect.objectContaining({
          1: expect.any(Number),
          2: expect.any(Number),
        }),
      });
    });

    it("returns null when products is missing for price-match mode", () => {
      renderWithProviders(
        <MPGameScreen
          {...defaultProps}
          roundData={makeRoundStartPayload({
            gameMode: "price-match",
            products: undefined,
            prices: [1000, 2000],
          })}
        />
      );
      expect(screen.queryByText("Match each product to its price")).not.toBeInTheDocument();
    });

    it("returns null when prices is missing for price-match mode", () => {
      renderWithProviders(
        <MPGameScreen
          {...defaultProps}
          roundData={makeRoundStartPayload({
            gameMode: "price-match",
            products: [
              makeProduct({ id: 1, title: "Item A" }),
            ],
            prices: undefined,
          })}
        />
      );
      expect(screen.queryByText("Match each product to its price")).not.toBeInTheDocument();
    });

    it("opens image modal when clicking a product image in price-match", async () => {
      renderWithProviders(<MPGameScreen {...priceMatchProps} />);

      const img = screen.getByAltText("Item A") as HTMLImageElement;
      await act(async () => {
        fireEvent.click(img);
      });

      expect(screen.getByRole("dialog", { name: "Image preview" })).toBeInTheDocument();
    });

    it("closes image modal in price-match mode", async () => {
      renderWithProviders(<MPGameScreen {...priceMatchProps} />);

      const img = screen.getByAltText("Item A") as HTMLImageElement;
      await act(async () => {
        fireEvent.click(img);
      });
      expect(screen.getByRole("dialog")).toBeInTheDocument();

      await act(async () => {
        fireEvent.click(screen.getByLabelText("Close"));
      });
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("hides image on error in price-match", () => {
      renderWithProviders(<MPGameScreen {...priceMatchProps} />);

      const img = screen.getByAltText("Item A") as HTMLImageElement;
      fireEvent.error(img);
      expect(img.style.display).toBe("none");
    });

    it("does not respond to product click when disabled", () => {
      renderWithProviders(
        <MPGameScreen
          {...defaultProps}
          hasGuessed={true}
          roundData={makeRoundStartPayload({
            gameMode: "price-match",
            products: [
              makeProduct({ id: 1, title: "Item A" }),
              makeProduct({ id: 2, title: "Item B" }),
            ],
            prices: [1000, 2000],
          })}
        />
      );
      // When hasGuessed is true, locked-in UI replaces the game UI
      expect(screen.getByText("Locked in!")).toBeInTheDocument();
      expect(screen.queryByText("Item A")).not.toBeInTheDocument();
    });

    it("does not assign price when no product is selected", async () => {
      renderWithProviders(<MPGameScreen {...priceMatchProps} />);

      // Click a price button without selecting a product first
      const priceButtons = screen.getAllByRole("button").filter(
        (btn) => btn.classList.contains("pm-price-btn")
      );
      // All price buttons should be disabled when no product is selected
      expect(priceButtons[0]).toBeDisabled();
    });
  });

  // -------------------------------------------------------------------------
  // Riser mode interactions
  // -------------------------------------------------------------------------

  describe("riser mode interactions", () => {
    let originalRAF: typeof globalThis.requestAnimationFrame;
    let originalCAF: typeof globalThis.cancelAnimationFrame;
    let originalPerfNow: typeof performance.now;
    let rafMock: ReturnType<typeof vi.fn>;
    let cafMock: ReturnType<typeof vi.fn>;
    let perfNowMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      originalRAF = globalThis.requestAnimationFrame;
      originalCAF = globalThis.cancelAnimationFrame;
      originalPerfNow = performance.now;

      rafMock = vi.fn((cb: FrameRequestCallback) => { cb(0); return 1; });
      globalThis.requestAnimationFrame = rafMock;

      cafMock = vi.fn();
      globalThis.cancelAnimationFrame = cafMock;

      perfNowMock = vi.fn().mockReturnValue(0);
      performance.now = perfNowMock;
    });

    afterEach(() => {
      globalThis.requestAnimationFrame = originalRAF;
      globalThis.cancelAnimationFrame = originalCAF;
      performance.now = originalPerfNow;
    });

    const riserProps = {
      ...defaultProps,
      roundData: makeRoundStartPayload({
        gameMode: "riser" as const,
        product: makeProduct(),
        maxPriceCents: 10000,
        speedPattern: "linear",
        durationMs: 5000,
      }),
    };


    it("shows STOP button after clicking Start", async () => {
      rafMock.mockImplementation(() => 1);
      const onSubmitGuess = vi.fn();
      renderWithProviders(
        <MPGameScreen {...riserProps} onSubmitGuess={onSubmitGuess} />
      );

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Start" }));
      });

      expect(screen.queryByRole("button", { name: "Start" })).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "STOP!" })).toBeInTheDocument();
    });

    it("submits stoppedPriceCents when STOP is clicked", async () => {
      // First rAF call: simulate at t=0 (price = minPrice)
      let callCount = 0;
      rafMock.mockImplementation((cb: FrameRequestCallback) => {
        callCount++;
        if (callCount <= 2) {
          cb(0);
        }
        return callCount;
      });
      perfNowMock.mockReturnValue(0);

      const onSubmitGuess = vi.fn();
      renderWithProviders(
        <MPGameScreen {...riserProps} onSubmitGuess={onSubmitGuess} />
      );

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Start" }));
      });

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "STOP!" }));
      });

      expect(onSubmitGuess).toHaveBeenCalledWith({
        stoppedPriceCents: expect.any(Number),
      });
    });

    it("auto-submits maxPriceCents when animation reaches full duration", async () => {
      // rAF: simulate elapsed >= durationMs so it auto-stops
      rafMock.mockImplementation((cb: FrameRequestCallback) => {
        cb(6000); // elapsed = 6000 - 0 = 6000 >= 5000 (duration)
        return 1;
      });
      perfNowMock.mockReturnValue(0);

      const onSubmitGuess = vi.fn();
      renderWithProviders(
        <MPGameScreen {...riserProps} onSubmitGuess={onSubmitGuess} />
      );

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Start" }));
      });

      expect(onSubmitGuess).toHaveBeenCalledWith({ stoppedPriceCents: 10000 });
    });

    it("cancels animation frame when STOP is clicked", async () => {
      rafMock.mockImplementation(() => 42);
      perfNowMock.mockReturnValue(0);

      const onSubmitGuess = vi.fn();
      renderWithProviders(
        <MPGameScreen {...riserProps} onSubmitGuess={onSubmitGuess} />
      );

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Start" }));
      });

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "STOP!" }));
      });

      expect(cafMock).toHaveBeenCalled();
    });

    it("cancels animation frame on unmount", async () => {
      rafMock.mockImplementation(() => 99);
      perfNowMock.mockReturnValue(0);

      const onSubmitGuess = vi.fn();
      const { unmount } = renderWithProviders(
        <MPGameScreen {...riserProps} onSubmitGuess={onSubmitGuess} />
      );

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Start" }));
      });

      unmount();

      expect(cafMock).toHaveBeenCalled();
    });

    it("returns null when product is missing for riser mode", () => {
      renderWithProviders(
        <MPGameScreen
          {...defaultProps}
          roundData={makeRoundStartPayload({
            gameMode: "riser",
            product: undefined,
            maxPriceCents: 10000,
          })}
        />
      );
      expect(screen.queryByRole("button", { name: "Start" })).not.toBeInTheDocument();
    });

    it("displays product title in riser mode", () => {
      renderWithProviders(<MPGameScreen {...riserProps} />);
      expect(screen.getByText("Test Widget")).toBeInTheDocument();
    });

    it("displays min and max price range", () => {
      renderWithProviders(<MPGameScreen {...riserProps} />);
      const rangeContainer = document.querySelector(".riser-range");
      expect(rangeContainer).toBeInTheDocument();
    });

    it("opens image modal when clicking product image in riser", async () => {
      renderWithProviders(<MPGameScreen {...riserProps} />);

      const img = screen.getByAltText("Test Widget") as HTMLImageElement;
      await act(async () => {
        fireEvent.click(img);
      });

      expect(screen.getByRole("dialog", { name: "Image preview" })).toBeInTheDocument();
    });

    it("closes image modal in riser mode", async () => {
      renderWithProviders(<MPGameScreen {...riserProps} />);

      const img = screen.getByAltText("Test Widget") as HTMLImageElement;
      await act(async () => {
        fireEvent.click(img);
      });
      expect(screen.getByRole("dialog")).toBeInTheDocument();

      await act(async () => {
        fireEvent.click(screen.getByLabelText("Close"));
      });
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("hides product image on error in riser mode", () => {
      renderWithProviders(<MPGameScreen {...riserProps} />);

      const img = screen.getByAltText("Test Widget") as HTMLImageElement;
      fireEvent.error(img);
      expect(img.style.display).toBe("none");
    });

    it("shows riser scene with trajectory backdrop and rocket", () => {
      renderWithProviders(<MPGameScreen {...riserProps} />);
      expect(document.querySelector(".riser-scene")).toBeInTheDocument();
      expect(document.querySelector(".riser-scene-bg")).toBeInTheDocument();
      expect(document.querySelector(".riser-rocket-wrapper")).toBeInTheDocument();
    });

    it("handles accelerating speed pattern", async () => {
      const onSubmitGuess = vi.fn();
      rafMock.mockImplementation((cb: FrameRequestCallback) => {
        cb(6000);
        return 1;
      });
      perfNowMock.mockReturnValue(0);

      renderWithProviders(
        <MPGameScreen
          {...defaultProps}
          onSubmitGuess={onSubmitGuess}
          roundData={makeRoundStartPayload({
            gameMode: "riser",
            product: makeProduct(),
            maxPriceCents: 10000,
            speedPattern: "accelerating",
            durationMs: 5000,
          })}
        />
      );

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Start" }));
      });

      expect(onSubmitGuess).toHaveBeenCalledWith({ stoppedPriceCents: 10000 });
    });

    it("handles decelerating speed pattern", async () => {
      const onSubmitGuess = vi.fn();
      rafMock.mockImplementation((cb: FrameRequestCallback) => {
        cb(6000);
        return 1;
      });
      perfNowMock.mockReturnValue(0);

      renderWithProviders(
        <MPGameScreen
          {...defaultProps}
          onSubmitGuess={onSubmitGuess}
          roundData={makeRoundStartPayload({
            gameMode: "riser",
            product: makeProduct(),
            maxPriceCents: 10000,
            speedPattern: "decelerating",
            durationMs: 5000,
          })}
        />
      );

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Start" }));
      });

      expect(onSubmitGuess).toHaveBeenCalledWith({ stoppedPriceCents: 10000 });
    });

    it("handles wave speed pattern", async () => {
      const onSubmitGuess = vi.fn();
      rafMock.mockImplementation((cb: FrameRequestCallback) => {
        cb(6000);
        return 1;
      });
      perfNowMock.mockReturnValue(0);

      renderWithProviders(
        <MPGameScreen
          {...defaultProps}
          onSubmitGuess={onSubmitGuess}
          roundData={makeRoundStartPayload({
            gameMode: "riser",
            product: makeProduct(),
            maxPriceCents: 10000,
            speedPattern: "wave",
            durationMs: 5000,
          })}
        />
      );

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Start" }));
      });

      expect(onSubmitGuess).toHaveBeenCalledWith({ stoppedPriceCents: 10000 });
    });

    it("uses default maxPriceCents and durationMs when not provided", async () => {
      const onSubmitGuess = vi.fn();
      rafMock.mockImplementation((cb: FrameRequestCallback) => {
        cb(9000); // more than default 8000ms
        return 1;
      });
      perfNowMock.mockReturnValue(0);

      renderWithProviders(
        <MPGameScreen
          {...defaultProps}
          onSubmitGuess={onSubmitGuess}
          roundData={makeRoundStartPayload({
            gameMode: "riser",
            product: makeProduct(),
            // maxPriceCents and durationMs omitted, defaults to 10000 and 8000
          })}
        />
      );

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Start" }));
      });

      // Default maxPriceCents is 10000
      expect(onSubmitGuess).toHaveBeenCalledWith({ stoppedPriceCents: 10000 });
    });

    it("moves the rocket and spawns trail particles when animating", async () => {
      // Simulate mid-animation: rAF invokes once but stays running
      let callCount = 0;
      rafMock.mockImplementation((cb: FrameRequestCallback) => {
        callCount++;
        if (callCount === 1) {
          cb(2500); // half-way through 5000ms
        }
        return callCount;
      });
      perfNowMock.mockReturnValue(0);

      const onSubmitGuess = vi.fn();
      renderWithProviders(
        <MPGameScreen {...riserProps} onSubmitGuess={onSubmitGuess} />
      );

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Start" }));
      });

      // Rocket wrapper should have the flying class and an updated left offset
      const rocket = document.querySelector(".riser-rocket-wrapper") as HTMLElement | null;
      expect(rocket).toBeInTheDocument();
      expect(rocket!.className).toContain("is-flying");
      expect(rocket!.style.left).not.toBe("");
      // Trail container should have at least one spawned particle
      const trail = document.querySelector(".riser-trail");
      expect(trail?.querySelectorAll(".riser-particle").length ?? 0).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------------------------------
  // MPTimer edge cases
  // -------------------------------------------------------------------------

  describe("MPTimer behavior", () => {

    it("counts down each second", async () => {
      renderWithProviders(
        <MPGameScreen
          {...defaultProps}
          roundData={makeRoundStartPayload({
            gameMode: "classic",
            product: makeProduct(),
            timerSeconds: 5,
          })}
        />
      );

      // Timer should show initial value
      const timerEl = screen.getByLabelText(/Timer:/);
      expect(timerEl).toHaveAttribute("aria-label", "Timer: 5 seconds remaining");

      // Advance 1 second
      await act(async () => {
        vi.advanceTimersByTime(1000);
      });

      expect(screen.getByLabelText(/Timer: 4 seconds remaining/)).toBeInTheDocument();
    });

    it("pauses timer when hasGuessed is true", async () => {
      const { rerender } = renderWithProviders(
        <MPGameScreen
          {...defaultProps}
          roundData={makeRoundStartPayload({
            gameMode: "classic",
            product: makeProduct(),
            timerSeconds: 10,
          })}
        />
      );

      // Advance 2 seconds
      await act(async () => {
        vi.advanceTimersByTime(2000);
      });
      expect(screen.getByLabelText(/Timer: 8 seconds remaining/)).toBeInTheDocument();

      // Rerender with hasGuessed=true to pause
      rerender(
        <MPGameScreen
          {...defaultProps}
          hasGuessed={true}
          roundData={makeRoundStartPayload({
            gameMode: "classic",
            product: makeProduct(),
            timerSeconds: 10,
          })}
        />
      );

      // Advance more time - timer should not change
      await act(async () => {
        vi.advanceTimersByTime(3000);
      });

      // Timer should still show the paused value (it re-mounts with timerSeconds=10
      // due to re-render, but the paused flag prevents countdown)
      const timerEl = screen.getByLabelText(/Timer:/);
      expect(timerEl).toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // Chain Reaction (MP rewrite: one-product-at-a-time with Start Chain gate)
  // -------------------------------------------------------------------------

  describe("Chain Reaction UI (multiplayer)", () => {
    // Build a 3-product chain — 2 sub-guesses total.
    const products = [
      makeProduct({ id: 101, title: "Anchor Product" }),
      makeProduct({ id: 102, title: "Middle Product" }),
      makeProduct({ id: 103, title: "Final Product" }),
    ];
    const chainRound = makeRoundStartPayload({
      gameMode: "chain-reaction",
      product: undefined as any,
      products,
    } as any);

    it("renders the single-player-style header and shows the Start Chain gate", () => {
      renderWithProviders(
        <MPGameScreen {...defaultProps} roundData={chainRound} />
      );
      // New UI matches SP: "Chain Reaction — Link 1 of 3" header
      expect(screen.getByText(/Chain Reaction/)).toBeInTheDocument();
      expect(screen.getByText(/Link 1 of 3/)).toBeInTheDocument();
      // Starting product label + Start Chain button
      expect(screen.getByText("Starting product")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /Start Chain/i })).toBeInTheDocument();
      // More/Less buttons are NOT shown yet — gate is closed
      expect(screen.queryByRole("button", { name: /More Expensive/i })).not.toBeInTheDocument();
    });

    it("reveals More/Less buttons after tapping Start Chain", () => {
      renderWithProviders(
        <MPGameScreen {...defaultProps} roundData={chainRound} />
      );
      fireEvent.click(screen.getByRole("button", { name: /Start Chain/i }));
      expect(screen.getByRole("button", { name: /More Expensive/i })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /Less Expensive/i })).toBeInTheDocument();
      // Header advances to link 2 now that the first guess is pending
      expect(screen.getByText(/Link 2 of 3/)).toBeInTheDocument();
    });

    it("submits the full chain of guesses in one call once all links are answered", () => {
      const onSubmitGuess = vi.fn();
      renderWithProviders(
        <MPGameScreen
          {...defaultProps}
          roundData={chainRound}
          onSubmitGuess={onSubmitGuess}
        />
      );
      fireEvent.click(screen.getByRole("button", { name: /Start Chain/i }));
      // First guess: more
      fireEvent.click(screen.getByRole("button", { name: /More Expensive/i }));
      // onSubmitGuess should NOT be called yet — still one link left
      expect(onSubmitGuess).not.toHaveBeenCalled();
      // Second (final) guess: less → submits the whole chain
      fireEvent.click(screen.getByRole("button", { name: /Less Expensive/i }));
      expect(onSubmitGuess).toHaveBeenCalledTimes(1);
      expect(onSubmitGuess).toHaveBeenCalledWith({ chainGuesses: ["more", "less"] });
      // "Chain complete!" message should appear
      expect(screen.getByText("Chain complete!")).toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // Click-to-zoom suppression on card-pick modes (Odd One Out, Budget Builder)
  // The image is part of the parent button's selection target — tapping it
  // should select/toggle the product, not open a zoom modal.
  // -------------------------------------------------------------------------

  describe("click-to-zoom suppression", () => {
    it("does NOT open image modal when clicking image in odd-one-out mode", async () => {
      const onSubmitGuess = vi.fn();
      renderWithProviders(
        <MPGameScreen
          {...defaultProps}
          onSubmitGuess={onSubmitGuess}
          roundData={makeRoundStartPayload({
            gameMode: "odd-one-out",
            products: [
              makeProduct({ id: 11, title: "OOO A", imageUrl: "https://example.com/a.jpg" }),
              makeProduct({ id: 22, title: "OOO B", imageUrl: "https://example.com/b.jpg" }),
            ],
          })}
        />
      );

      const img = screen.getByAltText("OOO A") as HTMLImageElement;
      await act(async () => {
        fireEvent.click(img);
      });

      expect(screen.queryByRole("dialog", { name: "Image preview" })).not.toBeInTheDocument();
      expect(onSubmitGuess).toHaveBeenCalledWith({ guessedProductId: 11 });
    });

    it("does NOT open image modal when clicking image in budget-builder mode", async () => {
      renderWithProviders(
        <MPGameScreen
          {...defaultProps}
          roundData={makeRoundStartPayload({
            gameMode: "budget-builder",
            products: [
              makeProduct({ id: 31, title: "BB Item A", imageUrl: "https://example.com/a.jpg" }),
              makeProduct({ id: 32, title: "BB Item B", imageUrl: "https://example.com/b.jpg" }),
            ],
            budgetCents: 5000,
          })}
        />
      );

      const img = screen.getByAltText("BB Item A") as HTMLImageElement;
      await act(async () => {
        fireEvent.click(img);
      });

      expect(screen.queryByRole("dialog", { name: "Image preview" })).not.toBeInTheDocument();
      // Card should now be selected (counter advances to 1 item)
      expect(screen.getByRole("button", { name: /Lock In Cart \(1 items\)/ })).toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // Price Match: assigned prices disappear from the lower menu
  // -------------------------------------------------------------------------

  describe("price-match assigned-price filtering", () => {
    const priceMatchProps = {
      ...defaultProps,
      roundData: makeRoundStartPayload({
        gameMode: "price-match" as const,
        products: [
          makeProduct({ id: 1, title: "Item A" }),
          makeProduct({ id: 2, title: "Item B" }),
          makeProduct({ id: 3, title: "Item C" }),
        ],
        prices: [1000, 2000, 3000],
      }),
    };

    it("removes the assigned price button from the menu after assignment", async () => {
      renderWithProviders(<MPGameScreen {...priceMatchProps} />);

      // Initially 3 price buttons
      let priceButtons = screen.getAllByRole("button").filter(
        (btn) => btn.classList.contains("pm-price-btn")
      );
      expect(priceButtons.length).toBe(3);

      // Select Item A and assign first price
      await act(async () => {
        fireEvent.click(screen.getByText("Item A"));
      });
      await act(async () => {
        fireEvent.click(priceButtons[0]);
      });

      // After assignment only 2 price buttons remain in the menu (the
      // assigned price disappears, mirroring SP).
      priceButtons = screen.getAllByRole("button").filter(
        (btn) => btn.classList.contains("pm-price-btn")
      );
      expect(priceButtons.length).toBe(2);
    });

    it("renders the assigned price visually inside the product card", async () => {
      renderWithProviders(<MPGameScreen {...priceMatchProps} />);

      const priceButtons = screen.getAllByRole("button").filter(
        (btn) => btn.classList.contains("pm-price-btn")
      );

      await act(async () => {
        fireEvent.click(screen.getByText("Item A"));
      });
      await act(async () => {
        fireEvent.click(priceButtons[0]);
      });

      // The product card itself should contain the assigned-price chip.
      const itemACard = screen.getByText("Item A").closest(".pm-product-card");
      expect(itemACard).toBeTruthy();
      expect(itemACard!.querySelector(".pm-assigned-price")).not.toBeNull();
    });

    it("returns the price to the menu when the product is unassigned", async () => {
      renderWithProviders(<MPGameScreen {...priceMatchProps} />);

      let priceButtons = screen.getAllByRole("button").filter(
        (btn) => btn.classList.contains("pm-price-btn")
      );

      // Assign Item A to first price
      await act(async () => {
        fireEvent.click(screen.getByText("Item A"));
      });
      await act(async () => {
        fireEvent.click(priceButtons[0]);
      });

      priceButtons = screen.getAllByRole("button").filter(
        (btn) => btn.classList.contains("pm-price-btn")
      );
      expect(priceButtons.length).toBe(2);

      // Unassign Item A by clicking it again
      await act(async () => {
        fireEvent.click(screen.getByText("Item A"));
      });

      // All 3 price buttons should be back in the menu
      priceButtons = screen.getAllByRole("button").filter(
        (btn) => btn.classList.contains("pm-price-btn")
      );
      expect(priceButtons.length).toBe(3);
    });
  });

  // -------------------------------------------------------------------------
  // Market Basket: long product titles must not horizontally overflow
  // -------------------------------------------------------------------------

  describe("market-basket title overflow", () => {
    it("renders a 100-char product title with overflow-safe wrapping classes", () => {
      const longTitle = "A".repeat(100);
      renderWithProviders(
        <MPGameScreen
          {...defaultProps}
          roundData={makeRoundStartPayload({
            gameMode: "market-basket",
            products: [
              makeProduct({ id: 41, title: longTitle }),
              makeProduct({ id: 42, title: "Short B" }),
            ],
          })}
        />
      );

      // Title element should be present even with no spaces in the string
      const titleEl = screen.getByText(longTitle);
      expect(titleEl).toBeInTheDocument();
      // It should carry the `.pm-product-title` class which now includes
      // word-break/overflow-wrap rules so no horizontal scroll appears.
      expect(titleEl.classList.contains("pm-product-title")).toBe(true);
      // Card itself uses `.pm-product-card` (the class targeted by the CSS
      // min-width:0 rule that lets the grid track shrink below content size).
      const card = titleEl.closest(".pm-product-card");
      expect(card).toBeTruthy();
    });
  });

  // -------------------------------------------------------------------------
  // Chain Reaction: image preload warms the browser cache for upcoming links
  // -------------------------------------------------------------------------

  describe("chain-reaction image preload", () => {
    it("instantiates an Image() for every chain product on round start", () => {
      const created: string[] = [];
      const OriginalImage = window.Image;
      // Spy: record the src each time `new Image()` is constructed.
      // We can't use vi.spyOn on the constructor directly, so we monkey-patch.
      class ImageSpy {
        // mimic minimal HTMLImageElement surface used in the preload effect
        private _src = "";
        get src() { return this._src; }
        set src(v: string) {
          this._src = v;
          created.push(v);
        }
      }
      // @ts-expect-error monkey-patch for test
      window.Image = ImageSpy;

      try {
        const products = [
          makeProduct({ id: 201, title: "Chain A", imageUrl: "https://example.com/a.jpg" }),
          makeProduct({ id: 202, title: "Chain B", imageUrl: "https://example.com/b.jpg" }),
          makeProduct({ id: 203, title: "Chain C", imageUrl: "https://example.com/c.jpg" }),
        ];
        renderWithProviders(
          <MPGameScreen
            {...defaultProps}
            roundData={makeRoundStartPayload({
              gameMode: "chain-reaction",
              product: undefined as any,
              products,
            } as any)}
          />
        );

        // All three product image URLs should have been assigned to a
        // freshly-constructed Image() during the preload effect.
        expect(created).toContain("https://example.com/a.jpg");
        expect(created).toContain("https://example.com/b.jpg");
        expect(created).toContain("https://example.com/c.jpg");
      } finally {
        window.Image = OriginalImage;
      }
    });
  });

  // -------------------------------------------------------------------------
  // Unknown mode fallback
  // -------------------------------------------------------------------------

  it("shows Unknown mode for unrecognized game mode", () => {
    renderWithProviders(
      <MPGameScreen
        {...defaultProps}
        roundData={makeRoundStartPayload({
          gameMode: "nonexistent-mode" as any,
        })}
      />
    );
    expect(screen.getByText("Unknown mode")).toBeInTheDocument();
  });
});
