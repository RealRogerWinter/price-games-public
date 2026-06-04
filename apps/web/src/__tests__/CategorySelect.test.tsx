import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import CategorySelect from "../components/CategorySelect";
import * as api from "../api/client";
import { renderWithProviders } from "./testUtils";

vi.mock("../api/client");
const mockedApi = vi.mocked(api);

describe("CategorySelect", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    localStorage.clear();
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ rates: {} }))
    );
    mockedApi.getCategories.mockResolvedValue({
      categories: [
        { name: "Electronics", count: 50 },
        { name: "Toys & Games", count: 30 },
        { name: "Sports & Outdoors", count: 25 },
      ],
    });
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("shows loading state initially", () => {
    mockedApi.getCategories.mockReturnValue(new Promise(() => {}));
    renderWithProviders(<CategorySelect selected={[]} onChange={vi.fn()} />);
    expect(screen.getByText("Loading categories...")).toBeInTheDocument();
  });

  it("renders category chips after loading", async () => {
    renderWithProviders(<CategorySelect selected={[]} onChange={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText("Electronics")).toBeInTheDocument();
    });
    expect(screen.getByText("Toys & Games")).toBeInTheDocument();
    expect(screen.getByText("50")).toBeInTheDocument();
  });

  it("calls onChange with toggled category when chip is clicked", async () => {
    const onChange = vi.fn();
    renderWithProviders(<CategorySelect selected={[]} onChange={onChange} />);

    await waitFor(() => {
      expect(screen.getByText("Electronics")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Electronics"));
    expect(onChange).toHaveBeenCalledWith(["Electronics"]);
  });

  it("removes category when already selected chip is clicked", async () => {
    const onChange = vi.fn();
    renderWithProviders(
      <CategorySelect selected={["Electronics", "Toys & Games"]} onChange={onChange} />
    );

    await waitFor(() => {
      expect(screen.getByText("Electronics")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Electronics"));
    expect(onChange).toHaveBeenCalledWith(["Toys & Games"]);
  });

  it("Select All selects all categories", async () => {
    const onChange = vi.fn();
    renderWithProviders(<CategorySelect selected={[]} onChange={onChange} />);

    await waitFor(() => {
      expect(screen.getByText("Select All")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Select All"));
    expect(onChange).toHaveBeenCalledWith(["Electronics", "Toys & Games", "Sports & Outdoors"]);
  });

  it("shows Deselect All when all are selected", async () => {
    const onChange = vi.fn();
    renderWithProviders(
      <CategorySelect
        selected={["Electronics", "Toys & Games", "Sports & Outdoors"]}
        onChange={onChange}
      />
    );

    await waitFor(() => {
      expect(screen.getByText("Deselect All")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Deselect All"));
    expect(onChange).toHaveBeenCalledWith([]);
  });

  it("shows hint when no categories selected", async () => {
    renderWithProviders(<CategorySelect selected={[]} onChange={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText("Select at least one category to play")).toBeInTheDocument();
    });
  });

  it("does not show hint when categories are selected", async () => {
    renderWithProviders(
      <CategorySelect selected={["Electronics"]} onChange={vi.fn()} />
    );

    await waitFor(() => {
      expect(screen.getByText("Electronics")).toBeInTheDocument();
    });

    expect(screen.queryByText("Select at least one category to play")).not.toBeInTheDocument();
  });
});
