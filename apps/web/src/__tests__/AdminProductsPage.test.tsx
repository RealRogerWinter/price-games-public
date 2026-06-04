/**
 * Tests for the AdminProductsPage component.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within, act } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

const mockNavigate = vi.fn();
const mockSetSearchParams = vi.fn();

vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual("react-router-dom");
  return {
    ...actual,
    useNavigate: () => mockNavigate,
    useSearchParams: () => [new URLSearchParams(), mockSetSearchParams],
  };
});

vi.mock("../api/adminClient", () => ({
  getAdminProducts: vi.fn(),
  getProductCategories: vi.fn(),
  bulkSetProductStatus: vi.fn(),
  bulkSetProductArchived: vi.fn(),
  getManufacturerContacts: vi.fn(),
  addManufacturerContact: vi.fn(),
  updateManufacturerContact: vi.fn(),
  deleteManufacturerContact: vi.fn(),
}));

vi.mock("../pages/admin/ManufacturerModal", () => ({
  default: () => null,
}));

import * as adminClient from "../api/adminClient";
import AdminProductsPage from "../pages/admin/AdminProductsPage";

const mockGetAdminProducts = vi.mocked(adminClient.getAdminProducts);
const mockGetProductCategories = vi.mocked(adminClient.getProductCategories);
const mockBulkSetProductStatus = vi.mocked(adminClient.bulkSetProductStatus);
const mockBulkSetProductArchived = vi.mocked(adminClient.bulkSetProductArchived);

const mockProducts = {
  products: [
    {
      id: 1,
      title: "Product A",
      category: "Electronics",
      manufacturer: "Acme",
      priceCents: 2999,
      isActive: true,
      isArchived: false,
      imageUrl: "a.jpg",
      addedAt: "2026-01-01T00:00:00Z",
      asin: "B001",
      verified: false,
    },
    {
      id: 2,
      title: "Product B",
      category: "Home",
      manufacturer: "Beta",
      priceCents: 1500,
      isActive: false,
      isArchived: false,
      imageUrl: "b.jpg",
      addedAt: "2026-02-01T00:00:00Z",
      asin: "B002",
      verified: true,
    },
  ],
  total: 2,
  page: 1,
  pageSize: 50,
  totalPages: 1,
};

describe("AdminProductsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAdminProducts.mockResolvedValue(mockProducts);
    mockGetProductCategories.mockResolvedValue(["Electronics", "Home"]);
    mockBulkSetProductStatus.mockResolvedValue({ updated: 1 });
    mockBulkSetProductArchived.mockResolvedValue({ archived: 1 });
  });

  it("shows loading spinner while fetching products", () => {
    mockGetAdminProducts.mockReturnValue(new Promise(() => {}));
    render(
      <MemoryRouter>
        <AdminProductsPage />
      </MemoryRouter>
    );
    expect(screen.getByText(/loading products/i)).toBeInTheDocument();
  });

  it("renders products table after loading", async () => {
    render(
      <MemoryRouter>
        <AdminProductsPage />
      </MemoryRouter>
    );
    await waitFor(() => {
      expect(screen.getByTestId("products-table")).toBeInTheDocument();
    });
  });

  it("shows product count", async () => {
    render(
      <MemoryRouter>
        <AdminProductsPage />
      </MemoryRouter>
    );
    await waitFor(() => {
      expect(screen.getByTestId("products-count")).toHaveTextContent("2 products");
    });
  });

  it("shows singular 'product' when total is 1", async () => {
    mockGetAdminProducts.mockResolvedValueOnce({
      ...mockProducts,
      products: [mockProducts.products[0]],
      total: 1,
    });
    render(
      <MemoryRouter>
        <AdminProductsPage />
      </MemoryRouter>
    );
    await waitFor(() => {
      expect(screen.getByTestId("products-count")).toHaveTextContent("1 product");
    });
  });

  it("shows product rows", async () => {
    render(
      <MemoryRouter>
        <AdminProductsPage />
      </MemoryRouter>
    );
    await waitFor(() => {
      expect(screen.getByTestId("product-row-1")).toBeInTheDocument();
      expect(screen.getByTestId("product-row-2")).toBeInTheDocument();
    });
  });

  it("displays formatted price", async () => {
    render(
      <MemoryRouter>
        <AdminProductsPage />
      </MemoryRouter>
    );
    await waitFor(() => {
      expect(screen.getByText("$29.99")).toBeInTheDocument();
    });
    expect(screen.getByText("$15.00")).toBeInTheDocument();
  });

  it("shows 'No products found' when empty", async () => {
    mockGetAdminProducts.mockResolvedValueOnce({
      products: [],
      total: 0,
      page: 1,
      pageSize: 50,
      totalPages: 0,
    });
    render(
      <MemoryRouter>
        <AdminProductsPage />
      </MemoryRouter>
    );
    await waitFor(() => {
      expect(screen.getByText("No products found")).toBeInTheDocument();
    });
  });

  it("shows active/inactive status badges", async () => {
    render(
      <MemoryRouter>
        <AdminProductsPage />
      </MemoryRouter>
    );
    await waitFor(() => {
      expect(screen.getByTestId("products-table")).toBeInTheDocument();
    });
    const table = screen.getByTestId("products-table");
    expect(within(table).getByText("Active")).toBeInTheDocument();
    expect(within(table).getByText("Inactive")).toBeInTheDocument();
  });

  it("renders search input", async () => {
    render(
      <MemoryRouter>
        <AdminProductsPage />
      </MemoryRouter>
    );
    await waitFor(() => {
      expect(screen.getByTestId("products-search")).toBeInTheDocument();
    });
  });

  it("renders category filter dropdown", async () => {
    render(
      <MemoryRouter>
        <AdminProductsPage />
      </MemoryRouter>
    );
    await waitFor(() => {
      expect(screen.getByTestId("products-category-filter")).toBeInTheDocument();
    });
    const select = screen.getByTestId("products-category-filter") as HTMLSelectElement;
    const options = Array.from(select.options).map((o) => o.text);
    expect(options).toContain("All Categories");
  });

  it("populates category dropdown with loaded categories", async () => {
    render(
      <MemoryRouter>
        <AdminProductsPage />
      </MemoryRouter>
    );
    await waitFor(() => {
      const select = screen.getByTestId("products-category-filter") as HTMLSelectElement;
      const options = Array.from(select.options).map((o) => o.text);
      expect(options).toContain("Electronics");
      expect(options).toContain("Home");
    });
  });

  it("renders active filter toggle buttons", async () => {
    render(
      <MemoryRouter>
        <AdminProductsPage />
      </MemoryRouter>
    );
    await waitFor(() => {
      expect(screen.getByTestId("products-active-filter")).toBeInTheDocument();
    });
    const filter = screen.getByTestId("products-active-filter");
    expect(within(filter).getByText("All")).toBeInTheDocument();
    expect(within(filter).getByText("Active")).toBeInTheDocument();
    expect(within(filter).getByText("Inactive")).toBeInTheDocument();
  });

  it("navigates to product detail on row click", async () => {
    render(
      <MemoryRouter>
        <AdminProductsPage />
      </MemoryRouter>
    );
    await waitFor(() => {
      expect(screen.getByTestId("product-row-1")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("product-row-1"));
    expect(mockNavigate).toHaveBeenCalledWith("/admin/products/1");
  });

  it("navigates to new product page on Add Product button click", async () => {
    render(
      <MemoryRouter>
        <AdminProductsPage />
      </MemoryRouter>
    );
    await waitFor(() => {
      expect(screen.getByTestId("add-product-btn")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("add-product-btn"));
    expect(mockNavigate).toHaveBeenCalledWith("/admin/products/new");
  });

  it("navigates to archived products on View Archived click", async () => {
    render(
      <MemoryRouter>
        <AdminProductsPage />
      </MemoryRouter>
    );
    await waitFor(() => {
      expect(screen.getByTestId("view-archived-btn")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("view-archived-btn"));
    expect(mockNavigate).toHaveBeenCalledWith("/admin/products/archived");
  });

  it("renders sort dropdown", async () => {
    render(
      <MemoryRouter>
        <AdminProductsPage />
      </MemoryRouter>
    );
    await waitFor(() => {
      expect(screen.getByTestId("products-sort-select")).toBeInTheDocument();
    });
    const select = screen.getByTestId("products-sort-select") as HTMLSelectElement;
    const options = Array.from(select.options).map((o) => o.text);
    expect(options).toContain("Sort: Title (A-Z)");
    expect(options).toContain("Sort: Price (low-high)");
    expect(options).toContain("Sort: Manufacturer (A-Z)");
    expect(options).toContain("Sort: Added (newest)");
  });

  it("changes sort via dropdown triggers new fetch", async () => {
    render(
      <MemoryRouter>
        <AdminProductsPage />
      </MemoryRouter>
    );
    await waitFor(() => {
      expect(screen.getByTestId("products-sort-select")).toBeInTheDocument();
    });
    fireEvent.change(screen.getByTestId("products-sort-select"), {
      target: { value: "title-asc" },
    });
    expect(mockSetSearchParams).toHaveBeenCalled();
  });

  it("shows pagination range info", async () => {
    render(
      <MemoryRouter>
        <AdminProductsPage />
      </MemoryRouter>
    );
    await waitFor(() => {
      expect(screen.getByTestId("pagination-range")).toBeInTheDocument();
    });
    expect(screen.getByTestId("pagination-range")).toHaveTextContent("Showing 1–2 of 2");
  });

  it("shows page size selector with options", async () => {
    render(
      <MemoryRouter>
        <AdminProductsPage />
      </MemoryRouter>
    );
    await waitFor(() => {
      expect(screen.getByTestId("page-size-select")).toBeInTheDocument();
    });
    const select = screen.getByTestId("page-size-select") as HTMLSelectElement;
    const options = Array.from(select.options).map((o) => o.value);
    expect(options).toEqual(["25", "50", "100"]);
  });

  it("shows page buttons when multiple pages", async () => {
    mockGetAdminProducts.mockResolvedValueOnce({
      products: mockProducts.products,
      total: 200,
      page: 1,
      pageSize: 50,
      totalPages: 4,
    });
    render(
      <MemoryRouter>
        <AdminProductsPage />
      </MemoryRouter>
    );
    await waitFor(() => {
      expect(screen.getByTestId("page-btn-1")).toBeInTheDocument();
    });
    expect(screen.getByTestId("page-btn-2")).toBeInTheDocument();
    expect(screen.getByTestId("first-page")).toBeInTheDocument();
    expect(screen.getByTestId("last-page")).toBeInTheDocument();
  });

  it("renders select-all checkbox", async () => {
    render(
      <MemoryRouter>
        <AdminProductsPage />
      </MemoryRouter>
    );
    await waitFor(() => {
      expect(screen.getByTestId("select-all")).toBeInTheDocument();
    });
    expect(screen.getByTestId("select-1")).toBeInTheDocument();
    expect(screen.getByTestId("select-2")).toBeInTheDocument();
  });

  it("clicking select-all shows bulk action bar", async () => {
    render(
      <MemoryRouter>
        <AdminProductsPage />
      </MemoryRouter>
    );
    await waitFor(() => {
      expect(screen.getByTestId("select-all")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("select-all"));
    await waitFor(() => {
      expect(screen.getByTestId("bulk-action-bar")).toBeInTheDocument();
    });
    expect(screen.getByTestId("bulk-count")).toHaveTextContent("2 selected");
  });

  it("selecting individual product shows bulk action bar", async () => {
    render(
      <MemoryRouter>
        <AdminProductsPage />
      </MemoryRouter>
    );
    await waitFor(() => {
      expect(screen.getByTestId("select-1")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("select-1"));
    await waitFor(() => {
      expect(screen.getByTestId("bulk-action-bar")).toBeInTheDocument();
    });
    expect(screen.getByTestId("bulk-count")).toHaveTextContent("1 selected");
  });

  it("bulk activate calls bulkSetProductStatus with true", async () => {
    render(
      <MemoryRouter>
        <AdminProductsPage />
      </MemoryRouter>
    );
    await waitFor(() => {
      expect(screen.getByTestId("select-all")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("select-all"));
    await waitFor(() => {
      expect(screen.getByTestId("bulk-activate")).toBeInTheDocument();
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("bulk-activate"));
    });
    await waitFor(() => {
      expect(mockBulkSetProductStatus).toHaveBeenCalledWith([1, 2], true);
    });
  });

  it("bulk deactivate calls bulkSetProductStatus with false", async () => {
    render(
      <MemoryRouter>
        <AdminProductsPage />
      </MemoryRouter>
    );
    await waitFor(() => {
      expect(screen.getByTestId("select-1")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("select-1"));
    await waitFor(() => {
      expect(screen.getByTestId("bulk-deactivate")).toBeInTheDocument();
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("bulk-deactivate"));
    });
    await waitFor(() => {
      expect(mockBulkSetProductStatus).toHaveBeenCalledWith([1], false);
    });
  });

  it("bulk archive calls bulkSetProductArchived", async () => {
    render(
      <MemoryRouter>
        <AdminProductsPage />
      </MemoryRouter>
    );
    await waitFor(() => {
      expect(screen.getByTestId("select-1")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("select-1"));
    await waitFor(() => {
      expect(screen.getByTestId("bulk-archive")).toBeInTheDocument();
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("bulk-archive"));
    });
    await waitFor(() => {
      expect(mockBulkSetProductArchived).toHaveBeenCalledWith([1], true);
    });
  });

  it("clear button clears selection", async () => {
    render(
      <MemoryRouter>
        <AdminProductsPage />
      </MemoryRouter>
    );
    await waitFor(() => {
      expect(screen.getByTestId("select-all")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("select-all"));
    await waitFor(() => {
      expect(screen.getByTestId("bulk-clear")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("bulk-clear"));
    expect(screen.queryByTestId("bulk-action-bar")).not.toBeInTheDocument();
  });

  it("select-all toggles off when all are selected", async () => {
    render(
      <MemoryRouter>
        <AdminProductsPage />
      </MemoryRouter>
    );
    await waitFor(() => {
      expect(screen.getByTestId("select-all")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("select-all"));
    await waitFor(() => {
      expect(screen.getByTestId("bulk-count")).toHaveTextContent("2 selected");
    });
    fireEvent.click(screen.getByTestId("select-all"));
    expect(screen.queryByTestId("bulk-action-bar")).not.toBeInTheDocument();
  });

  it("checkbox click does not navigate to product detail", async () => {
    render(
      <MemoryRouter>
        <AdminProductsPage />
      </MemoryRouter>
    );
    await waitFor(() => {
      expect(screen.getByTestId("select-1")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("select-1"));
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it("shows error state when getAdminProducts fails", async () => {
    mockGetAdminProducts.mockRejectedValueOnce(new Error("Failed to load products"));
    render(
      <MemoryRouter>
        <AdminProductsPage />
      </MemoryRouter>
    );
    await waitFor(() => {
      expect(screen.getByText("Failed to load products")).toBeInTheDocument();
    });
  });

  it("shows error state when bulkSetProductStatus fails", async () => {
    mockBulkSetProductStatus.mockRejectedValueOnce(new Error("Bulk update failed"));
    render(
      <MemoryRouter>
        <AdminProductsPage />
      </MemoryRouter>
    );
    await waitFor(() => {
      expect(screen.getByTestId("select-all")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("select-all"));
    await waitFor(() => {
      expect(screen.getByTestId("bulk-activate")).toBeInTheDocument();
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("bulk-activate"));
    });
    await waitFor(() => {
      expect(screen.getByText("Bulk update failed")).toBeInTheDocument();
    });
  });

  it("changes page size via dropdown", async () => {
    render(
      <MemoryRouter>
        <AdminProductsPage />
      </MemoryRouter>
    );
    await waitFor(() => {
      expect(screen.getByTestId("page-size-select")).toBeInTheDocument();
    });
    fireEvent.change(screen.getByTestId("page-size-select"), {
      target: { value: "25" },
    });
    expect(mockSetSearchParams).toHaveBeenCalled();
  });

  it("renders column sort headers", async () => {
    render(
      <MemoryRouter>
        <AdminProductsPage />
      </MemoryRouter>
    );
    await waitFor(() => {
      expect(screen.getByTestId("products-table")).toBeInTheDocument();
    });
    const table = screen.getByTestId("products-table");
    expect(within(table).getByText(/^ID/)).toBeInTheDocument();
    expect(within(table).getByText(/^Title/)).toBeInTheDocument();
    expect(within(table).getByText(/^Price/)).toBeInTheDocument();
    expect(within(table).getByText(/^Category/)).toBeInTheDocument();
    expect(within(table).getByText(/^Manufacturer/)).toBeInTheDocument();
  });

  it("renders pagination section", async () => {
    render(
      <MemoryRouter>
        <AdminProductsPage />
      </MemoryRouter>
    );
    await waitFor(() => {
      expect(screen.getByTestId("products-pagination")).toBeInTheDocument();
    });
  });

  it("product row shows product title", async () => {
    render(
      <MemoryRouter>
        <AdminProductsPage />
      </MemoryRouter>
    );
    await waitFor(() => {
      expect(screen.getByText("Product A")).toBeInTheDocument();
    });
    expect(screen.getByText("Product B")).toBeInTheDocument();
  });
});
