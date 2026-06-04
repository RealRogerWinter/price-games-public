import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import GameOptionsMenu from "../components/GameOptionsMenu";
import * as api from "../api/client";
import { renderWithProviders } from "./testUtils";

vi.mock("../api/client");
const mockedApi = vi.mocked(api);

/**
 * Seeds `getCategories` with a small, stable list so tests can make
 * assertions about ordering, counts, and the Select All cardinality.
 */
function mockCategoryList() {
  mockedApi.getCategories.mockResolvedValue({
    categories: [
      { name: "Electronics", count: 50 },
      { name: "Toys & Games", count: 30 },
      { name: "Home & Kitchen", count: 18 },
    ],
  });
}

describe("GameOptionsMenu", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    localStorage.clear();
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ rates: {} }))
    );
    mockCategoryList();
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  const defaultProps = {
    selectedRounds: 5 as const,
    onSelectRounds: vi.fn(),
  };

  it("renders the Game Options toggle button", () => {
    renderWithProviders(<GameOptionsMenu {...defaultProps} />);
    expect(screen.getByText("Game Options")).toBeInTheDocument();
  });

  it("opens the dropdown when clicked", () => {
    renderWithProviders(<GameOptionsMenu {...defaultProps} />);
    fireEvent.click(screen.getByText("Game Options"));
    expect(screen.getByText("Rounds")).toBeInTheDocument();
    expect(screen.getByText("Currency")).toBeInTheDocument();
  });

  it("renders round count options (3, 5, 10)", () => {
    renderWithProviders(<GameOptionsMenu {...defaultProps} />);
    fireEvent.click(screen.getByText("Game Options"));
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getByText("5")).toBeInTheDocument();
    expect(screen.getByText("10")).toBeInTheDocument();
  });

  it("highlights the selected round count", () => {
    renderWithProviders(<GameOptionsMenu {...defaultProps} selectedRounds={5} />);
    fireEvent.click(screen.getByText("Game Options"));
    const btn5 = screen.getByText("5");
    expect(btn5.className).toContain("active");
    expect(screen.getByText("3").className).not.toContain("active");
    expect(screen.getByText("10").className).not.toContain("active");
  });

  it("calls onSelectRounds when a round option is clicked", () => {
    const onSelectRounds = vi.fn();
    renderWithProviders(
      <GameOptionsMenu {...defaultProps} onSelectRounds={onSelectRounds} />
    );
    fireEvent.click(screen.getByText("Game Options"));
    fireEvent.click(screen.getByText("10"));
    expect(onSelectRounds).toHaveBeenCalledWith(10);
  });

  describe("categories (inline v2)", () => {
    it("renders categories row when onApplyCategories is provided", () => {
      renderWithProviders(
        <GameOptionsMenu
          {...defaultProps}
          onApplyCategories={vi.fn()}
          currentCategories={["Electronics", "Toys & Games"]}
        />
      );
      fireEvent.click(screen.getByText("Game Options"));
      expect(screen.getByText("Categories")).toBeInTheDocument();
      expect(screen.getByText("2 selected")).toBeInTheDocument();
    });

    it("does not render categories row when onApplyCategories is not provided", () => {
      renderWithProviders(<GameOptionsMenu {...defaultProps} />);
      fireEvent.click(screen.getByText("Game Options"));
      expect(screen.queryByText("Categories")).not.toBeInTheDocument();
    });

    it("clicking Categories expands inline panel without closing the dropdown", async () => {
      renderWithProviders(
        <GameOptionsMenu {...defaultProps} onApplyCategories={vi.fn()} />
      );
      fireEvent.click(screen.getByText("Game Options"));
      fireEvent.click(screen.getByText("Categories"));

      // Chips from the mocked API appear (dropdown still open, main sections hidden)
      await waitFor(() => {
        expect(screen.getByText("Electronics")).toBeInTheDocument();
      });
      expect(screen.getByText("Toys & Games")).toBeInTheDocument();
      expect(screen.getByText("Home & Kitchen")).toBeInTheDocument();

      // Main sections (Rounds / Currency) are hidden behind the inline panel
      expect(screen.queryByText("Rounds")).not.toBeInTheDocument();
      expect(screen.queryByText("Currency")).not.toBeInTheDocument();
    });

    it("shows category counts inside the inline panel", async () => {
      renderWithProviders(
        <GameOptionsMenu {...defaultProps} onApplyCategories={vi.fn()} />
      );
      fireEvent.click(screen.getByText("Game Options"));
      fireEvent.click(screen.getByText("Categories"));

      await waitFor(() => {
        expect(screen.getByText("Electronics")).toBeInTheDocument();
      });
      expect(screen.getByText("50")).toBeInTheDocument();
      expect(screen.getByText("30")).toBeInTheDocument();
      expect(screen.getByText("18")).toBeInTheDocument();
    });

    it("initial draft selection defaults to currentCategories when provided", async () => {
      renderWithProviders(
        <GameOptionsMenu
          {...defaultProps}
          onApplyCategories={vi.fn()}
          currentCategories={["Electronics"]}
        />
      );
      fireEvent.click(screen.getByText("Game Options"));
      fireEvent.click(screen.getByText("Categories"));

      await waitFor(() => {
        expect(screen.getByText("Electronics")).toBeInTheDocument();
      });

      // Apply label shows 1 selected — mirrors draft count.
      expect(screen.getByRole("button", { name: /Apply/ }).textContent).toMatch(/1 category/i);
    });

    it("initial draft selection defaults to all when currentCategories is empty", async () => {
      renderWithProviders(
        <GameOptionsMenu {...defaultProps} onApplyCategories={vi.fn()} />
      );
      fireEvent.click(screen.getByText("Game Options"));
      fireEvent.click(screen.getByText("Categories"));

      await waitFor(() => {
        expect(screen.getByText("Electronics")).toBeInTheDocument();
      });
      expect(screen.getByRole("button", { name: /Apply/ }).textContent).toMatch(/3 categories/i);
    });

    it("toggling a chip updates the Apply button count", async () => {
      renderWithProviders(
        <GameOptionsMenu {...defaultProps} onApplyCategories={vi.fn()} />
      );
      fireEvent.click(screen.getByText("Game Options"));
      fireEvent.click(screen.getByText("Categories"));

      await waitFor(() => {
        expect(screen.getByText("Electronics")).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText("Electronics"));
      expect(screen.getByRole("button", { name: /Apply/ }).textContent).toMatch(/2 categories/i);
    });

    it("Select All / Deselect All toggles all chips", async () => {
      renderWithProviders(
        <GameOptionsMenu {...defaultProps} onApplyCategories={vi.fn()} />
      );
      fireEvent.click(screen.getByText("Game Options"));
      fireEvent.click(screen.getByText("Categories"));

      await waitFor(() => {
        expect(screen.getByText("Deselect All")).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText("Deselect All"));
      expect(screen.getByRole("button", { name: /Apply/ })).toBeDisabled();

      fireEvent.click(screen.getByText("Select All"));
      expect(screen.getByRole("button", { name: /Apply/ })).not.toBeDisabled();
    });

    it("Back arrow returns to the main view without calling onApplyCategories", async () => {
      const onApplyCategories = vi.fn();
      renderWithProviders(
        <GameOptionsMenu
          {...defaultProps}
          onApplyCategories={onApplyCategories}
        />
      );
      fireEvent.click(screen.getByText("Game Options"));
      fireEvent.click(screen.getByText("Categories"));

      await waitFor(() => {
        expect(screen.getByText("Electronics")).toBeInTheDocument();
      });

      fireEvent.click(screen.getByLabelText("Back to Game Options"));

      // Main view restored
      expect(screen.getByText("Rounds")).toBeInTheDocument();
      expect(onApplyCategories).not.toHaveBeenCalled();
    });

    it("Apply without requireRestartConfirm calls onApplyCategories and closes the dropdown", async () => {
      const onApplyCategories = vi.fn();
      renderWithProviders(
        <GameOptionsMenu
          {...defaultProps}
          onApplyCategories={onApplyCategories}
          currentCategories={["Electronics"]}
        />
      );
      fireEvent.click(screen.getByText("Game Options"));
      fireEvent.click(screen.getByText("Categories"));

      await waitFor(() => {
        expect(screen.getByText("Electronics")).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole("button", { name: /Apply/ }));

      expect(onApplyCategories).toHaveBeenCalledWith(["Electronics"]);
      // Dropdown should be closed
      expect(screen.queryByText("Electronics")).not.toBeInTheDocument();
    });

    it("Apply with requireRestartConfirm opens confirmation view (does not call onApplyCategories yet)", async () => {
      const onApplyCategories = vi.fn();
      renderWithProviders(
        <GameOptionsMenu
          {...defaultProps}
          onApplyCategories={onApplyCategories}
          requireRestartConfirm
        />
      );
      fireEvent.click(screen.getByText("Game Options"));
      fireEvent.click(screen.getByText("Categories"));

      await waitFor(() => {
        expect(screen.getByText("Electronics")).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole("button", { name: /Apply/ }));

      // Confirmation view now shown with the category count embedded in text
      expect(screen.getByText(/existing progress will be lost/i)).toBeInTheDocument();
      // Both the title ("Start a new game?") and the body text mention
      // the phrase, so assert at least one match.
      expect(screen.getAllByText(/start a new game/i).length).toBeGreaterThan(0);
      expect(screen.getByText(/3 categories/i)).toBeInTheDocument();

      // Not called until the user confirms
      expect(onApplyCategories).not.toHaveBeenCalled();
    });

    it("Confirm Cancel returns to the categories view with selection preserved", async () => {
      const onApplyCategories = vi.fn();
      renderWithProviders(
        <GameOptionsMenu
          {...defaultProps}
          onApplyCategories={onApplyCategories}
          requireRestartConfirm
        />
      );
      fireEvent.click(screen.getByText("Game Options"));
      fireEvent.click(screen.getByText("Categories"));

      await waitFor(() => {
        expect(screen.getByText("Electronics")).toBeInTheDocument();
      });

      // Drop "Toys & Games" from the draft selection
      fireEvent.click(screen.getByText("Toys & Games"));
      fireEvent.click(screen.getByRole("button", { name: /Apply/ }));

      // In confirm view — press Cancel
      fireEvent.click(screen.getByRole("button", { name: /Cancel/ }));

      // Back in categories view with 2 still selected
      expect(screen.getByText("Electronics")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /Apply/ }).textContent).toMatch(/2 categories/i);
      expect(onApplyCategories).not.toHaveBeenCalled();
    });

    it("Confirm Yes calls onApplyCategories with the draft selection and closes", async () => {
      const onApplyCategories = vi.fn();
      renderWithProviders(
        <GameOptionsMenu
          {...defaultProps}
          onApplyCategories={onApplyCategories}
          requireRestartConfirm
        />
      );
      fireEvent.click(screen.getByText("Game Options"));
      fireEvent.click(screen.getByText("Categories"));

      await waitFor(() => {
        expect(screen.getByText("Electronics")).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText("Home & Kitchen"));
      fireEvent.click(screen.getByRole("button", { name: /Apply/ }));
      fireEvent.click(screen.getByRole("button", { name: /Yes, Restart/i }));

      expect(onApplyCategories).toHaveBeenCalledTimes(1);
      expect(onApplyCategories).toHaveBeenCalledWith(["Electronics", "Toys & Games"]);
    });

    it("Apply button is disabled when no categories are selected", async () => {
      renderWithProviders(
        <GameOptionsMenu {...defaultProps} onApplyCategories={vi.fn()} />
      );
      fireEvent.click(screen.getByText("Game Options"));
      fireEvent.click(screen.getByText("Categories"));

      await waitFor(() => {
        expect(screen.getByText("Deselect All")).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText("Deselect All"));
      expect(screen.getByRole("button", { name: /Apply/ })).toBeDisabled();
    });

    it("shows an error message when the category fetch fails", async () => {
      mockedApi.getCategories.mockRejectedValueOnce(new Error("boom"));
      renderWithProviders(
        <GameOptionsMenu {...defaultProps} onApplyCategories={vi.fn()} />
      );
      fireEvent.click(screen.getByText("Game Options"));
      fireEvent.click(screen.getByText("Categories"));

      await waitFor(() => {
        expect(screen.getByText(/couldn.?t load categories/i)).toBeInTheDocument();
      });
      expect(screen.getByRole("button", { name: /Apply/ })).toBeDisabled();
    });

    it("drops stale categories from currentCategories that no longer exist", async () => {
      renderWithProviders(
        <GameOptionsMenu
          {...defaultProps}
          onApplyCategories={vi.fn()}
          // "Retired" isn't in the mocked server list — should be filtered out.
          currentCategories={["Electronics", "Retired"]}
        />
      );
      fireEvent.click(screen.getByText("Game Options"));
      fireEvent.click(screen.getByText("Categories"));

      await waitFor(() => {
        expect(screen.getByText("Electronics")).toBeInTheDocument();
      });

      // Only "Electronics" survives the reconciliation — 1 valid category in the draft.
      expect(screen.getByRole("button", { name: /Apply/ }).textContent).toMatch(/1 category/i);
    });
  });

  it("renders the currency selector inside the dropdown", () => {
    renderWithProviders(<GameOptionsMenu {...defaultProps} />);
    fireEvent.click(screen.getByText("Game Options"));
    expect(screen.getByRole("combobox")).toBeInTheDocument();
  });

  it("closes the dropdown on Escape key", () => {
    renderWithProviders(<GameOptionsMenu {...defaultProps} />);
    fireEvent.click(screen.getByText("Game Options"));
    expect(screen.getByText("Rounds")).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByText("Rounds")).not.toBeInTheDocument();
  });

  it("sets aria-expanded correctly", () => {
    renderWithProviders(<GameOptionsMenu {...defaultProps} />);
    const toggle = screen.getByText("Game Options");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
  });
});
