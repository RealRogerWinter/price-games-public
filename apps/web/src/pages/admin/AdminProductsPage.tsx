import { useState, useEffect, useCallback, useRef } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import type { AdminProduct, AdminProductListParams } from "@price-game/shared";
import { getAdminProducts, getProductCategories, bulkSetProductStatus, bulkSetProductArchived } from "../../api/adminClient";
import ManufacturerModal from "./ManufacturerModal";

/** Parse an integer from a URL param, returning a fallback if invalid. */
function parseIntParam(value: string | null, fallback: number): number {
  if (!value) return fallback;
  const n = parseInt(value, 10);
  return isNaN(n) ? fallback : n;
}

const VALID_SORT_BY = new Set(["id", "title", "priceCents", "category", "manufacturer", "addedAt"]);
const VALID_ACTIVE_FILTERS = new Set(["all", "active", "inactive"]);

/**
 * Admin products list page with search, filter, sort, and pagination.
 * All filter/page state is synced to URL search params so the browser
 * back button restores the previous view.
 */
export default function AdminProductsPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  // Read state from URL params (single source of truth)
  const page = parseIntParam(searchParams.get("page"), 1);
  const pageSize = parseIntParam(searchParams.get("pageSize"), 50);
  const search = searchParams.get("search") || "";
  const category = searchParams.get("category") || "";
  const activeFilter = (VALID_ACTIVE_FILTERS.has(searchParams.get("status") || "") ? searchParams.get("status") : "all") as "all" | "active" | "inactive";
  const sortBy = (VALID_SORT_BY.has(searchParams.get("sortBy") || "") ? searchParams.get("sortBy") : "id") as NonNullable<AdminProductListParams["sortBy"]>;
  const sortOrder = (searchParams.get("sortOrder") === "desc" ? "desc" : "asc") as "asc" | "desc";

  const [products, setProducts] = useState<AdminProduct[]>([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(0);
  const [categories, setCategories] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [modalManufacturer, setModalManufacturer] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [bulkUpdating, setBulkUpdating] = useState(false);

  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  /**
   * Update URL search params, omitting keys that match their default value.
   * Uses `replace` so filter changes don't pollute history.
   */
  function updateParams(updates: Record<string, string | number>, replace = true) {
    const next = new URLSearchParams(searchParams);
    const defaults: Record<string, string> = { page: "1", pageSize: "50", search: "", category: "", status: "all", sortBy: "id", sortOrder: "asc" };
    for (const [key, value] of Object.entries(updates)) {
      const str = String(value);
      if (str === "" || str === defaults[key]) {
        next.delete(key);
      } else {
        next.set(key, str);
      }
    }
    setSearchParams(next, { replace });
  }

  const fetchProducts = useCallback(async () => {
    try {
      setError(null);
      setLoading(true);

      const params: AdminProductListParams = {
        page,
        pageSize,
        sortBy,
        sortOrder,
        isArchived: false,
      };
      if (search) params.search = search;
      if (category) params.category = category;
      if (activeFilter === "active") params.isActive = true;
      else if (activeFilter === "inactive") params.isActive = false;

      const result = await getAdminProducts(params);
      setProducts(result.products);
      setTotal(result.total);
      setTotalPages(result.totalPages);
      setSelectedIds(new Set());
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load products");
    } finally {
      setLoading(false);
    }
  }, [page, pageSize, search, category, activeFilter, sortBy, sortOrder]);

  useEffect(() => {
    fetchProducts();
  }, [fetchProducts]);

  useEffect(() => {
    getProductCategories()
      .then(setCategories)
      .catch(() => {});
  }, []);

  // Clean up debounce timer on unmount
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  function handleSearchChange(value: string) {
    updateParams({ search: value, page: 1 });
  }

  function debouncedSearch(value: string) {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => handleSearchChange(value), 300);
  }

  function handleSort(col: NonNullable<AdminProductListParams["sortBy"]>) {
    if (sortBy === col) {
      updateParams({ sortOrder: sortOrder === "asc" ? "desc" : "asc", page: 1 });
    } else {
      updateParams({ sortBy: col, sortOrder: "asc", page: 1 });
    }
  }

  function sortIndicator(col: string) {
    if (sortBy !== col) return "";
    return sortOrder === "asc" ? " ↑" : " ↓";
  }

  function handlePageSizeChange(newSize: number) {
    updateParams({ pageSize: newSize, page: 1 });
  }

  /**
   * Build an array of page numbers to display, using null for ellipsis gaps.
   * Always shows first, last, and pages around the current page.
   */
  function getPageNumbers(): (number | null)[] {
    if (totalPages <= 7) {
      return Array.from({ length: totalPages }, (_, i) => i + 1);
    }
    const pages: (number | null)[] = [1];
    const start = Math.max(2, page - 1);
    const end = Math.min(totalPages - 1, page + 1);
    if (start > 2) pages.push(null);
    for (let i = start; i <= end; i++) pages.push(i);
    if (end < totalPages - 1) pages.push(null);
    pages.push(totalPages);
    return pages;
  }

  function toggleSelectAll() {
    if (selectedIds.size === products.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(products.map((p) => p.id)));
    }
  }

  function toggleSelect(id: number, e: React.MouseEvent) {
    e.stopPropagation();
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleBulkStatus(isActive: boolean) {
    if (selectedIds.size === 0) return;
    try {
      setBulkUpdating(true);
      await bulkSetProductStatus([...selectedIds], isActive);
      await fetchProducts();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Bulk update failed");
    } finally {
      setBulkUpdating(false);
    }
  }

  async function handleBulkArchive() {
    if (selectedIds.size === 0) return;
    try {
      setBulkUpdating(true);
      await bulkSetProductArchived([...selectedIds], true);
      await fetchProducts();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Bulk archive failed");
    } finally {
      setBulkUpdating(false);
    }
  }

  function formatPrice(cents: number) {
    return `$${(cents / 100).toFixed(2)}`;
  }

  return (
    <div className="admin-products-page" data-testid="admin-products-page">
      {/* Toolbar */}
      <div className="admin-products-toolbar" data-testid="products-toolbar">
        <input
          key={search}
          type="text"
          className="admin-search-input"
          placeholder="Search title, manufacturer, ASIN..."
          defaultValue={search}
          maxLength={200}
          onChange={(e) => debouncedSearch(e.target.value)}
          data-testid="products-search"
        />

        <select
          className="admin-filter-select"
          value={category}
          onChange={(e) => updateParams({ category: e.target.value, page: 1 })}
          data-testid="products-category-filter"
        >
          <option value="">All Categories</option>
          {categories.map((cat) => (
            <option key={cat} value={cat}>{cat}</option>
          ))}
        </select>

        <div className="admin-active-toggle" data-testid="products-active-filter">
          {(["all", "active", "inactive"] as const).map((val) => (
            <button
              key={val}
              className={activeFilter === val ? "active" : ""}
              onClick={() => updateParams({ status: val, page: 1 })}
            >
              {val.charAt(0).toUpperCase() + val.slice(1)}
            </button>
          ))}
        </div>

        <select
          className="admin-filter-select"
          value={`${sortBy}-${sortOrder}`}
          onChange={(e) => {
            const [col, ord] = e.target.value.split("-") as [NonNullable<AdminProductListParams["sortBy"]>, "asc" | "desc"];
            updateParams({ sortBy: col, sortOrder: ord, page: 1 });
          }}
          data-testid="products-sort-select"
        >
          <option value="id-asc">Sort: ID (asc)</option>
          <option value="id-desc">Sort: ID (desc)</option>
          <option value="title-asc">Sort: Title (A-Z)</option>
          <option value="title-desc">Sort: Title (Z-A)</option>
          <option value="priceCents-asc">Sort: Price (low-high)</option>
          <option value="priceCents-desc">Sort: Price (high-low)</option>
          <option value="category-asc">Sort: Category (A-Z)</option>
          <option value="category-desc">Sort: Category (Z-A)</option>
          <option value="manufacturer-asc">Sort: Manufacturer (A-Z)</option>
          <option value="manufacturer-desc">Sort: Manufacturer (Z-A)</option>
          <option value="addedAt-asc">Sort: Added (oldest)</option>
          <option value="addedAt-desc">Sort: Added (newest)</option>
        </select>

        <button
          className="admin-btn-secondary"
          onClick={() => navigate("/admin/products/archived")}
          data-testid="view-archived-btn"
        >
          View Archived
        </button>
        <button
          className="admin-btn-primary"
          onClick={() => navigate("/admin/products/new")}
          data-testid="add-product-btn"
        >
          Add Product
        </button>
      </div>

      {selectedIds.size > 0 && (
        <div className="admin-bulk-bar" data-testid="bulk-action-bar">
          <span data-testid="bulk-count">{selectedIds.size} selected</span>
          <button
            className="admin-btn-primary"
            disabled={bulkUpdating}
            onClick={() => handleBulkStatus(true)}
            data-testid="bulk-activate"
          >
            Set Active
          </button>
          <button
            className="admin-btn-danger"
            disabled={bulkUpdating}
            onClick={() => handleBulkStatus(false)}
            data-testid="bulk-deactivate"
          >
            Set Inactive
          </button>
          <button
            className="admin-btn-warning"
            disabled={bulkUpdating}
            onClick={handleBulkArchive}
            data-testid="bulk-archive"
          >
            Archive
          </button>
          <button
            onClick={() => setSelectedIds(new Set())}
            data-testid="bulk-clear"
          >
            Clear
          </button>
        </div>
      )}

      {error && <div className="admin-error" style={{ maxWidth: "100%", marginBottom: 16 }}>{error}</div>}

      {loading ? (
        <div className="admin-loading" style={{ minHeight: "200px" }}>
          <span className="admin-loading-spinner" />
          Loading products...
        </div>
      ) : (
        <>
          <div className="admin-products-count" data-testid="products-count">
            {total.toLocaleString()} product{total !== 1 ? "s" : ""}
          </div>

          <div className="admin-table-wrap">
          <table className="admin-table admin-products-table admin-table-sticky-first" data-testid="products-table">
            <thead>
              <tr>
                <th className="select-col">
                  <input
                    type="checkbox"
                    checked={products.length > 0 && selectedIds.size === products.length}
                    onChange={toggleSelectAll}
                    data-testid="select-all"
                  />
                </th>
                <th className="sortable" onClick={() => handleSort("id")}>ID{sortIndicator("id")}</th>
                <th></th>
                <th className="sortable" onClick={() => handleSort("title")}>Title{sortIndicator("title")}</th>
                <th className="sortable" onClick={() => handleSort("priceCents")}>Price{sortIndicator("priceCents")}</th>
                <th className="sortable" onClick={() => handleSort("category")}>Category{sortIndicator("category")}</th>
                <th className="sortable" onClick={() => handleSort("manufacturer")}>Manufacturer{sortIndicator("manufacturer")}</th>
                <th>Status</th>
                <th className="sortable" onClick={() => handleSort("addedAt")}>Added{sortIndicator("addedAt")}</th>
              </tr>
            </thead>
            <tbody>
              {products.map((product) => (
                <tr
                  key={product.id}
                  className="clickable-row"
                  onClick={() => navigate(`/admin/products/${product.id}`)}
                  data-testid={`product-row-${product.id}`}
                >
                  <td className="select-col" onClick={(e) => toggleSelect(product.id, e)}>
                    <input
                      type="checkbox"
                      checked={selectedIds.has(product.id)}
                      readOnly
                      data-testid={`select-${product.id}`}
                    />
                  </td>
                  <td>{product.id}</td>
                  <td>
                    {product.imageUrl && (
                      <img
                        src={product.imageUrl}
                        alt=""
                        className="admin-product-thumb"
                        loading="lazy"
                      />
                    )}
                  </td>
                  <td className="product-title-cell">{product.title}</td>
                  <td>{formatPrice(product.priceCents)}</td>
                  <td>{product.category || "—"}</td>
                  <td>
                    {product.manufacturer ? (
                      <button
                        className="admin-mfg-link"
                        onClick={(e) => {
                          e.stopPropagation();
                          setModalManufacturer(product.manufacturer);
                        }}
                        data-testid={`mfg-link-${product.id}`}
                      >
                        {product.manufacturer}
                      </button>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td>
                    <span className={`status-badge ${product.isActive ? "status-active" : "status-inactive"}`}>
                      {product.isActive ? "Active" : "Inactive"}
                    </span>
                  </td>
                  <td>{product.addedAt ? new Date(product.addedAt).toLocaleDateString() : "—"}</td>
                </tr>
              ))}
              {products.length === 0 && (
                <tr>
                  <td colSpan={9} style={{ textAlign: "center", padding: 24, color: "#666" }}>
                    No products found
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          </div>

          {/* Pagination */}
          <div className="admin-pagination" data-testid="products-pagination">
            <div className="admin-pagination-info" data-testid="pagination-range">
              Showing {Math.min((page - 1) * pageSize + 1, total)}–{Math.min(page * pageSize, total)} of {total.toLocaleString()}
            </div>

            {totalPages > 1 && (
              <div className="admin-pagination-pages">
                <button
                  onClick={() => updateParams({ page: 1 }, false)}
                  disabled={page <= 1}
                  data-testid="first-page"
                  title="First page"
                >
                  &laquo;
                </button>
                <button
                  onClick={() => updateParams({ page: Math.max(1, page - 1) }, false)}
                  disabled={page <= 1}
                  data-testid="prev-page"
                  title="Previous page"
                >
                  &lsaquo;
                </button>

                {getPageNumbers().map((p, idx) =>
                  p === null ? (
                    <span key={`ellipsis-${idx}`} className="admin-pagination-ellipsis">&hellip;</span>
                  ) : (
                    <button
                      key={p}
                      className={page === p ? "active" : ""}
                      onClick={() => updateParams({ page: p }, false)}
                      data-testid={`page-btn-${p}`}
                    >
                      {p}
                    </button>
                  )
                )}

                <button
                  onClick={() => updateParams({ page: Math.min(totalPages, page + 1) }, false)}
                  disabled={page >= totalPages}
                  data-testid="next-page"
                  title="Next page"
                >
                  &rsaquo;
                </button>
                <button
                  onClick={() => updateParams({ page: totalPages }, false)}
                  disabled={page >= totalPages}
                  data-testid="last-page"
                  title="Last page"
                >
                  &raquo;
                </button>
              </div>
            )}

            <div className="admin-pagination-size">
              <label>
                Rows:
                <select
                  value={pageSize}
                  onChange={(e) => handlePageSizeChange(Number(e.target.value))}
                  data-testid="page-size-select"
                >
                  <option value={25}>25</option>
                  <option value={50}>50</option>
                  <option value={100}>100</option>
                </select>
              </label>
            </div>
          </div>
        </>
      )}

      {modalManufacturer && (
        <ManufacturerModal
          name={modalManufacturer}
          onClose={() => setModalManufacturer(null)}
        />
      )}
    </div>
  );
}
