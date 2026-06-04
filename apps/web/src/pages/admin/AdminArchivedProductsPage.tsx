import { useState, useEffect, useCallback, useRef } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import type { AdminProduct, AdminProductListParams } from "@price-game/shared";
import { getAdminProducts, getProductCategories, bulkSetProductArchived } from "../../api/adminClient";

/** Parse an integer from a URL param, returning a fallback if invalid. */
function parseIntParam(value: string | null, fallback: number): number {
  if (!value) return fallback;
  const n = parseInt(value, 10);
  return isNaN(n) ? fallback : n;
}

const VALID_SORT_BY = new Set(["id", "title", "priceCents", "category", "manufacturer", "addedAt"]);

/**
 * Admin archived products page. Shows only archived products with
 * search, filter, sort, pagination, and bulk unarchive.
 */
export default function AdminArchivedProductsPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const page = parseIntParam(searchParams.get("page"), 1);
  const pageSize = parseIntParam(searchParams.get("pageSize"), 50);
  const search = searchParams.get("search") || "";
  const category = searchParams.get("category") || "";
  const sortBy = (VALID_SORT_BY.has(searchParams.get("sortBy") || "") ? searchParams.get("sortBy") : "id") as NonNullable<AdminProductListParams["sortBy"]>;
  const sortOrder = (searchParams.get("sortOrder") === "desc" ? "desc" : "asc") as "asc" | "desc";

  const [products, setProducts] = useState<AdminProduct[]>([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(0);
  const [categories, setCategories] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [bulkUpdating, setBulkUpdating] = useState(false);

  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  function updateParams(updates: Record<string, string | number>, replace = true) {
    const next = new URLSearchParams(searchParams);
    const defaults: Record<string, string> = { page: "1", pageSize: "50", search: "", category: "", sortBy: "id", sortOrder: "asc" };
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
        isArchived: true,
      };
      if (search) params.search = search;
      if (category) params.category = category;

      const result = await getAdminProducts(params);
      setProducts(result.products);
      setTotal(result.total);
      setTotalPages(result.totalPages);
      setSelectedIds(new Set());
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load archived products");
    } finally {
      setLoading(false);
    }
  }, [page, pageSize, search, category, sortBy, sortOrder]);

  useEffect(() => {
    fetchProducts();
  }, [fetchProducts]);

  useEffect(() => {
    getProductCategories()
      .then(setCategories)
      .catch(() => {});
  }, []);

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  function debouncedSearch(value: string) {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => updateParams({ search: value, page: 1 }), 300);
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

  async function handleBulkUnarchive() {
    if (selectedIds.size === 0) return;
    try {
      setBulkUpdating(true);
      await bulkSetProductArchived([...selectedIds], false);
      await fetchProducts();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Bulk unarchive failed");
    } finally {
      setBulkUpdating(false);
    }
  }

  function formatPrice(cents: number) {
    return `$${(cents / 100).toFixed(2)}`;
  }

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

  return (
    <div className="admin-products-page" data-testid="admin-archived-products-page">
      <div className="admin-products-toolbar" data-testid="archived-toolbar">
        <button
          className="admin-btn-secondary"
          onClick={() => navigate("/admin/products")}
          data-testid="back-to-products-btn"
        >
          &larr; Back to Products
        </button>

        <input
          key={search}
          type="text"
          className="admin-search-input"
          placeholder="Search archived products..."
          defaultValue={search}
          maxLength={200}
          onChange={(e) => debouncedSearch(e.target.value)}
          data-testid="archived-search"
        />

        <select
          className="admin-filter-select"
          value={category}
          onChange={(e) => updateParams({ category: e.target.value, page: 1 })}
          data-testid="archived-category-filter"
        >
          <option value="">All Categories</option>
          {categories.map((cat) => (
            <option key={cat} value={cat}>{cat}</option>
          ))}
        </select>
      </div>

      {selectedIds.size > 0 && (
        <div className="admin-bulk-bar" data-testid="archived-bulk-bar">
          <span>{selectedIds.size} selected</span>
          <button
            className="admin-btn-primary"
            disabled={bulkUpdating}
            onClick={handleBulkUnarchive}
            data-testid="bulk-unarchive"
          >
            Unarchive
          </button>
          <button
            onClick={() => setSelectedIds(new Set())}
            data-testid="archived-bulk-clear"
          >
            Clear
          </button>
        </div>
      )}

      {error && <div className="admin-error" style={{ maxWidth: "100%", marginBottom: 16 }}>{error}</div>}

      {loading ? (
        <div className="admin-loading" style={{ minHeight: "200px" }}>
          <span className="admin-loading-spinner" />
          Loading archived products...
        </div>
      ) : (
        <>
          <div className="admin-products-count" data-testid="archived-count">
            {total.toLocaleString()} archived product{total !== 1 ? "s" : ""}
          </div>

          <div className="admin-table-wrap">
          <table className="admin-table admin-products-table admin-table-sticky-first" data-testid="archived-table">
            <thead>
              <tr>
                <th className="select-col">
                  <input
                    type="checkbox"
                    checked={products.length > 0 && selectedIds.size === products.length}
                    onChange={toggleSelectAll}
                    data-testid="archived-select-all"
                  />
                </th>
                <th className="sortable" onClick={() => handleSort("id")}>ID{sortIndicator("id")}</th>
                <th></th>
                <th className="sortable" onClick={() => handleSort("title")}>Title{sortIndicator("title")}</th>
                <th className="sortable" onClick={() => handleSort("priceCents")}>Price{sortIndicator("priceCents")}</th>
                <th className="sortable" onClick={() => handleSort("category")}>Category{sortIndicator("category")}</th>
                <th className="sortable" onClick={() => handleSort("manufacturer")}>Manufacturer{sortIndicator("manufacturer")}</th>
                <th className="sortable" onClick={() => handleSort("addedAt")}>Added{sortIndicator("addedAt")}</th>
              </tr>
            </thead>
            <tbody>
              {products.map((product) => (
                <tr
                  key={product.id}
                  className="clickable-row"
                  onClick={() => navigate(`/admin/products/${product.id}`)}
                  data-testid={`archived-row-${product.id}`}
                >
                  <td className="select-col" onClick={(e) => toggleSelect(product.id, e)}>
                    <input
                      type="checkbox"
                      checked={selectedIds.has(product.id)}
                      readOnly
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
                  <td>{product.category || "\u2014"}</td>
                  <td>{product.manufacturer || "\u2014"}</td>
                  <td>{product.addedAt ? new Date(product.addedAt).toLocaleDateString() : "\u2014"}</td>
                </tr>
              ))}
              {products.length === 0 && (
                <tr>
                  <td colSpan={8} style={{ textAlign: "center", padding: 24, color: "#666" }}>
                    No archived products
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          </div>

          {/* Pagination */}
          <div className="admin-pagination" data-testid="archived-pagination">
            <div className="admin-pagination-info">
              Showing {Math.min((page - 1) * pageSize + 1, total)}–{Math.min(page * pageSize, total)} of {total.toLocaleString()}
            </div>

            {totalPages > 1 && (
              <div className="admin-pagination-pages">
                <button
                  onClick={() => updateParams({ page: 1 }, false)}
                  disabled={page <= 1}
                  title="First page"
                >
                  &laquo;
                </button>
                <button
                  onClick={() => updateParams({ page: Math.max(1, page - 1) }, false)}
                  disabled={page <= 1}
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
                    >
                      {p}
                    </button>
                  )
                )}

                <button
                  onClick={() => updateParams({ page: Math.min(totalPages, page + 1) }, false)}
                  disabled={page >= totalPages}
                  title="Next page"
                >
                  &rsaquo;
                </button>
                <button
                  onClick={() => updateParams({ page: totalPages }, false)}
                  disabled={page >= totalPages}
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
                  onChange={(e) => updateParams({ pageSize: Number(e.target.value), page: 1 })}
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
    </div>
  );
}
