import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import ProductPickerModal from "../pages/admin/daily/ProductPickerModal";
import * as adminClient from "../api/adminClient";
import type { AdminProduct } from "@price-game/shared";

function makeProduct(id: number, overrides?: Partial<AdminProduct>): AdminProduct {
  return {
    id,
    title: `Product ${id}`,
    asin: `ASIN${id}`,
    imageUrl: `https://example.com/img${id}.jpg`,
    description: `Description for product ${id}`,
    priceCents: id * 100 + 99,
    category: "Electronics",
    isActive: true,
    isArchived: false,
    manufacturer: "TestCo",
    lastUsedAt: null,
    scrapedAt: null,
    addedAt: "2026-01-01T00:00:00Z",
    verified: true,
    ...overrides,
  };
}

beforeEach(() => {
  vi.spyOn(adminClient, "getProductCategories").mockResolvedValue([
    "Electronics", "Home & Kitchen", "Toys & Games",
  ]);
  vi.spyOn(adminClient, "getAdminProducts").mockResolvedValue({
    products: [makeProduct(1), makeProduct(2), makeProduct(3)],
    total: 3,
    page: 1,
    pageSize: 24,
    totalPages: 1,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ProductPickerModal", () => {
  it("renders nothing when closed", () => {
    const { container } = render(
      <ProductPickerModal
        isOpen={false}
        onClose={vi.fn()}
        onSelect={vi.fn()}
        excludeProductIds={[]}
      />,
    );
    expect(container.innerHTML).toBe("");
  });

  it("renders modal with search and products when open", async () => {
    render(
      <ProductPickerModal
        isOpen={true}
        onClose={vi.fn()}
        onSelect={vi.fn()}
        excludeProductIds={[]}
      />,
    );
    await waitFor(() => {
      expect(screen.getByText("Select a Product")).toBeInTheDocument();
    });
    expect(screen.getByPlaceholderText(/search/i)).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByText("Product 1")).toBeInTheDocument();
      expect(screen.getByText("Product 2")).toBeInTheDocument();
      expect(screen.getByText("Product 3")).toBeInTheDocument();
    });
  });

  it("calls onSelect when a product is clicked", async () => {
    const onSelect = vi.fn();
    render(
      <ProductPickerModal
        isOpen={true}
        onClose={vi.fn()}
        onSelect={onSelect}
        excludeProductIds={[]}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId("picker-product-1")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("picker-product-1"));
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }));
  });

  it("shows excluded products as disabled with 'In use' badge", async () => {
    render(
      <ProductPickerModal
        isOpen={true}
        onClose={vi.fn()}
        onSelect={vi.fn()}
        excludeProductIds={[2]}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId("picker-product-2")).toBeInTheDocument();
    });
    const excluded = screen.getByTestId("picker-product-2");
    expect(excluded).toBeDisabled();
    expect(screen.getByText("In use")).toBeInTheDocument();
  });

  it("calls onClose when overlay is clicked", async () => {
    const onClose = vi.fn();
    render(
      <ProductPickerModal
        isOpen={true}
        onClose={onClose}
        onSelect={vi.fn()}
        excludeProductIds={[]}
      />,
    );
    await waitFor(() => {
      expect(screen.getByText("Select a Product")).toBeInTheDocument();
    });
    // Click the overlay (the modal-overlay div)
    fireEvent.click(screen.getByText("Select a Product").closest(".modal-content")!.parentElement!);
    expect(onClose).toHaveBeenCalled();
  });

  it("fetches products with search param after typing", async () => {
    const getProducts = vi.spyOn(adminClient, "getAdminProducts");
    render(
      <ProductPickerModal
        isOpen={true}
        onClose={vi.fn()}
        onSelect={vi.fn()}
        excludeProductIds={[]}
      />,
    );

    await waitFor(() => {
      expect(screen.getByPlaceholderText(/search/i)).toBeInTheDocument();
    });

    fireEvent.change(screen.getByPlaceholderText(/search/i), { target: { value: "widget" } });

    // After the debounce fires, it should call with the search term
    await waitFor(() => {
      expect(getProducts).toHaveBeenCalledWith(
        expect.objectContaining({ search: "widget" }),
      );
    });
  });
});
