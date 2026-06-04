/**
 * Tests for the AdminProductDetailPage component.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import AdminProductDetailPage from "../pages/admin/AdminProductDetailPage";

const mockNavigate = vi.fn();

vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual("react-router-dom");
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

const mockProduct = {
  id: 42,
  title: "Test Widget",
  asin: "B0TEST",
  priceCents: 2999,
  category: "Electronics",
  manufacturer: "TestCo",
  imageUrl: "https://example.com/img.jpg",
  description: "A test product",
  isActive: true,
  lastUsedAt: null,
  scrapedAt: null,
  addedAt: "2026-01-01T00:00:00Z",
  verified: false,
};

const mockGetAdminProduct = vi.fn().mockResolvedValue(mockProduct);
const mockCreateAdminProduct = vi.fn().mockResolvedValue({ ...mockProduct, id: 100 });
const mockUpdateAdminProduct = vi.fn().mockResolvedValue({ ...mockProduct, title: "Updated" });
const mockSetAdminProductStatus = vi.fn().mockResolvedValue({ ...mockProduct, isActive: false });
const mockGetProductCategories = vi.fn().mockResolvedValue(["Electronics", "Home & Kitchen"]);

vi.mock("../api/adminClient", () => ({
  getAdminProduct: (...args: unknown[]) => mockGetAdminProduct(...args),
  createAdminProduct: (...args: unknown[]) => mockCreateAdminProduct(...args),
  updateAdminProduct: (...args: unknown[]) => mockUpdateAdminProduct(...args),
  setAdminProductStatus: (...args: unknown[]) => mockSetAdminProductStatus(...args),
  getProductCategories: (...args: unknown[]) => mockGetProductCategories(...args),
}));

function renderWithRoute(id: string) {
  return render(
    <MemoryRouter initialEntries={[`/admin/products/${id}`]}>
      <Routes>
        <Route path="/admin/products/:id" element={<AdminProductDetailPage />} />
      </Routes>
    </MemoryRouter>
  );
}

describe("AdminProductDetailPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("Edit mode", () => {
    it("loads and displays product data", async () => {
      renderWithRoute("42");
      await waitFor(() => {
        expect(screen.getByTestId("admin-product-detail")).toBeInTheDocument();
      });
      expect(screen.getByTestId("input-title")).toHaveValue("Test Widget");
      expect(screen.getByTestId("input-asin")).toHaveValue("B0TEST");
      expect(screen.getByTestId("input-price")).toHaveValue(29.99);
      expect(screen.getByTestId("input-manufacturer")).toHaveValue("TestCo");
    });

    it("shows product image", async () => {
      renderWithRoute("42");
      await waitFor(() => {
        expect(screen.getByTestId("product-image")).toBeInTheDocument();
      });
    });

    it("has a save button", async () => {
      renderWithRoute("42");
      await waitFor(() => {
        expect(screen.getByTestId("save-btn")).toBeInTheDocument();
      });
      expect(screen.getByTestId("save-btn")).toHaveTextContent("Save Changes");
    });

    it("has a back button", async () => {
      renderWithRoute("42");
      await waitFor(() => {
        expect(screen.getByTestId("back-btn")).toBeInTheDocument();
      });
      fireEvent.click(screen.getByTestId("back-btn"));
      expect(mockNavigate).toHaveBeenCalledWith(-1);
    });

    it("has a toggle active button", async () => {
      renderWithRoute("42");
      await waitFor(() => {
        expect(screen.getByTestId("toggle-active-btn")).toBeInTheDocument();
      });
      expect(screen.getByTestId("toggle-active-btn")).toHaveTextContent("Deactivate");
    });

    it("saves changes on button click", async () => {
      renderWithRoute("42");
      await waitFor(() => {
        expect(screen.getByTestId("save-btn")).toBeInTheDocument();
      });
      fireEvent.click(screen.getByTestId("save-btn"));
      await waitFor(() => {
        expect(mockUpdateAdminProduct).toHaveBeenCalled();
      });
    });

    it("shows error for invalid price", async () => {
      renderWithRoute("42");
      await waitFor(() => {
        expect(screen.getByTestId("input-price")).toBeInTheDocument();
      });
      fireEvent.change(screen.getByTestId("input-price"), { target: { value: "" } });
      fireEvent.click(screen.getByTestId("save-btn"));
      await waitFor(() => {
        expect(screen.getByTestId("detail-error")).toBeInTheDocument();
      });
    });

    it("toggles active status", async () => {
      renderWithRoute("42");
      await waitFor(() => {
        expect(screen.getByTestId("toggle-active-btn")).toBeInTheDocument();
      });
      fireEvent.click(screen.getByTestId("toggle-active-btn"));
      await waitFor(() => {
        expect(mockSetAdminProductStatus).toHaveBeenCalledWith(42, false);
      });
    });
  });

  describe("Create mode", () => {
    it("shows create form for /products/new", async () => {
      renderWithRoute("new");
      await waitFor(() => {
        expect(screen.getByTestId("admin-product-detail")).toBeInTheDocument();
      });
      expect(screen.getByTestId("save-btn")).toHaveTextContent("Create Product");
    });

    it("has empty fields in create mode", () => {
      renderWithRoute("new");
      expect(screen.getByTestId("input-title")).toHaveValue("");
    });

    it("creates product on save", async () => {
      renderWithRoute("new");
      fireEvent.change(screen.getByTestId("input-title"), { target: { value: "New Widget" } });
      fireEvent.change(screen.getByTestId("input-price"), { target: { value: "9.99" } });
      fireEvent.click(screen.getByTestId("save-btn"));
      await waitFor(() => {
        expect(mockCreateAdminProduct).toHaveBeenCalled();
      });
    });

    it("does not show toggle active button in create mode", () => {
      renderWithRoute("new");
      expect(screen.queryByTestId("toggle-active-btn")).not.toBeInTheDocument();
    });
  });
});
