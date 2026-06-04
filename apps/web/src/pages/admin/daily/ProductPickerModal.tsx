/**
 * Modal for searching and selecting a product from the product database.
 * Used when an admin wants to swap a product in a daily puzzle round.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AdminProduct } from "@price-game/shared";
import { getAdminProducts, getProductCategories } from "../../../api/adminClient";

interface ProductPickerModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSelect: (product: AdminProduct) => void;
  excludeProductIds: number[];
}

/** Format cents as $X.XX. */
function formatPrice(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/**
 * Full-screen modal with search bar, category filter, and a grid of product cards.
 * Click a product to select it and close the modal.
 */
export default function ProductPickerModal({
  isOpen,
  onClose,
  onSelect,
  excludeProductIds,
}: ProductPickerModalProps) {
  const [searchTerm, setSearchTerm] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [category, setCategory] = useState("");
  const [categories, setCategories] = useState<string[]>([]);
  const [products, setProducts] = useState<AdminProduct[]>([]);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const debounceTimer = useRef<ReturnType<typeof setTimeout>>();
  const searchInputRef = useRef<HTMLInputElement>(null);
  const excludeSet = useMemo(() => new Set(excludeProductIds), [excludeProductIds]);

  // Load categories on first open
  useEffect(() => {
    if (isOpen && categories.length === 0) {
      getProductCategories().then(setCategories).catch(() => {});
    }
  }, [isOpen, categories.length]);

  // Focus search input on open
  useEffect(() => {
    if (isOpen) {
      setTimeout(() => searchInputRef.current?.focus(), 100);
    }
  }, [isOpen]);

  // Debounce search
  useEffect(() => {
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => {
      setDebouncedSearch(searchTerm);
      setPage(1);
    }, 300);
    return () => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
    };
  }, [searchTerm]);

  // Fetch products when search/category/page changes
  const fetchProducts = useCallback(async () => {
    if (!isOpen) return;
    setLoading(true);
    try {
      const result = await getAdminProducts({
        search: debouncedSearch || undefined,
        category: category || undefined,
        isActive: true,
        isArchived: false,
        pageSize: 24,
        page,
        sortBy: "title",
        sortOrder: "asc",
      });
      setProducts(result.products);
      setTotalPages(result.totalPages);
    } catch {
      setProducts([]);
    } finally {
      setLoading(false);
    }
  }, [isOpen, debouncedSearch, category, page]);

  useEffect(() => {
    fetchProducts();
  }, [fetchProducts]);

  // Reset state when modal closes
  useEffect(() => {
    if (!isOpen) {
      setSearchTerm("");
      setDebouncedSearch("");
      setCategory("");
      setPage(1);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal-content daily-picker-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <button className="modal-close" onClick={onClose}>
          &times;
        </button>
        <h3>Select a Product</h3>

        <div className="daily-picker-search">
          <input
            ref={searchInputRef}
            type="text"
            className="admin-search-input"
            placeholder="Search by title, manufacturer, or ASIN..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
          />
          <select
            className="admin-filter-select"
            value={category}
            onChange={(e) => {
              setCategory(e.target.value);
              setPage(1);
            }}
          >
            <option value="">All Categories</option>
            {categories.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>

        {loading ? (
          <div className="admin-loading" style={{ minHeight: 200 }}>
            <span className="admin-loading-spinner" />
            Searching products...
          </div>
        ) : products.length === 0 ? (
          <div className="daily-picker-empty">
            No products found. Try adjusting your search.
          </div>
        ) : (
          <>
            <div className="daily-picker-grid">
              {products.map((product) => {
                const isExcluded = excludeSet.has(product.id);
                return (
                  <button
                    key={product.id}
                    className={`daily-picker-card ${isExcluded ? "daily-picker-card--excluded" : ""}`}
                    onClick={() => {
                      if (!isExcluded) onSelect(product);
                    }}
                    disabled={isExcluded}
                    data-testid={`picker-product-${product.id}`}
                  >
                    {product.imageUrl ? (
                      <img
                        src={product.imageUrl}
                        alt=""
                        className="daily-picker-thumb"
                        loading="lazy"
                      />
                    ) : (
                      <div className="daily-picker-thumb daily-picker-thumb--placeholder">
                        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#666" strokeWidth="1.5">
                          <rect x="3" y="3" width="18" height="18" rx="2" />
                          <path d="M3 16l5-5 3 3 4-4 6 6" />
                        </svg>
                      </div>
                    )}
                    <div className="daily-picker-card-info">
                      <span className="daily-picker-card-title">{product.title}</span>
                      <span className="daily-picker-card-price">
                        {formatPrice(product.priceCents)}
                      </span>
                      {product.category && (
                        <span className="daily-picker-card-category">{product.category}</span>
                      )}
                    </div>
                    {isExcluded && (
                      <span className="daily-picker-card-badge">In use</span>
                    )}
                  </button>
                );
              })}
            </div>

            {totalPages > 1 && (
              <div className="daily-picker-pagination">
                <button
                  className="admin-btn-secondary admin-btn-sm"
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={page <= 1}
                >
                  Prev
                </button>
                <span className="daily-picker-page-info">
                  Page {page} of {totalPages}
                </span>
                <button
                  className="admin-btn-secondary admin-btn-sm"
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  disabled={page >= totalPages}
                >
                  Next
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
