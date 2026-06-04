import { useState, useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import type { AdminProduct, AdminProductCreateRequest, AdminProductUpdateRequest } from "@price-game/shared";
import {
  getAdminProduct,
  createAdminProduct,
  updateAdminProduct,
  setAdminProductStatus,
  getProductCategories,
} from "../../api/adminClient";

/**
 * Admin product detail/edit page. Supports both editing existing products
 * and creating new products (when ID is "new").
 */
export default function AdminProductDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const isNew = id === "new";

  const [product, setProduct] = useState<AdminProduct | null>(null);
  const [categories, setCategories] = useState<string[]>([]);
  const [loading, setLoading] = useState(!isNew);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Form state
  const [title, setTitle] = useState("");
  const [asin, setAsin] = useState("");
  const [description, setDescription] = useState("");
  const [priceStr, setPriceStr] = useState("");
  const [categoryVal, setCategoryVal] = useState("");
  const [manufacturer, setManufacturer] = useState("");
  const [imageUrl, setImageUrl] = useState("");
  const [isActive, setIsActive] = useState(true);

  useEffect(() => {
    getProductCategories().then(setCategories).catch(() => {});
  }, []);

  useEffect(() => {
    if (isNew) return;
    const productId = parseInt(id!, 10);
    if (isNaN(productId)) {
      setError("Invalid product ID");
      setLoading(false);
      return;
    }

    getAdminProduct(productId)
      .then((p) => {
        setProduct(p);
        setTitle(p.title);
        setAsin(p.asin || "");
        setDescription(p.description || "");
        setPriceStr((p.priceCents / 100).toFixed(2));
        setCategoryVal(p.category || "");
        setManufacturer(p.manufacturer || "");
        setImageUrl(p.imageUrl || "");
        setIsActive(p.isActive);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "Failed to load product");
      })
      .finally(() => setLoading(false));
  }, [id, isNew]);

  async function handleSave() {
    setError(null);
    setSuccess(null);

    const priceCents = Math.round(parseFloat(priceStr) * 100);
    if (isNaN(priceCents) || priceCents < 0) {
      setError("Please enter a valid price");
      return;
    }
    if (!title.trim()) {
      setError("Title is required");
      return;
    }

    setSaving(true);

    try {
      if (isNew) {
        const data: AdminProductCreateRequest = {
          title: title.trim(),
          priceCents,
          asin: asin || undefined,
          description: description || undefined,
          category: categoryVal || undefined,
          manufacturer: manufacturer || undefined,
          imageUrl: imageUrl || undefined,
          isActive,
        };
        const created = await createAdminProduct(data);
        setSuccess("Product created");
        navigate(`/admin/products/${created.id}`, { replace: true });
      } else {
        const data: AdminProductUpdateRequest = {
          title: title.trim(),
          priceCents,
          asin,
          description,
          category: categoryVal,
          manufacturer,
          imageUrl,
          isActive,
        };
        const updated = await updateAdminProduct(product!.id, data);
        setProduct(updated);
        setSuccess("Product saved");
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  async function handleToggleActive() {
    if (!product) return;
    try {
      const updated = await setAdminProductStatus(product.id, !product.isActive);
      setProduct(updated);
      setIsActive(updated.isActive);
      setSuccess(updated.isActive ? "Product activated" : "Product deactivated");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to update status");
    }
  }

  if (loading) {
    return (
      <div className="admin-loading" style={{ minHeight: "200px" }}>
        <span className="admin-loading-spinner" />
        Loading product...
      </div>
    );
  }

  return (
    <div className="admin-product-detail" data-testid="admin-product-detail">
      <div className="admin-detail-header">
        <button onClick={() => navigate(-1)} data-testid="back-btn">
          &larr; Back to Products
        </button>
        <h2>{isNew ? "New Product" : "Edit Product"}</h2>
      </div>

      {error && <div className="admin-error" style={{ maxWidth: "100%", marginBottom: 12 }} data-testid="detail-error">{error}</div>}
      {success && <div className="admin-success" data-testid="detail-success">{success}</div>}

      <div className="admin-detail-layout">
        {/* Image preview */}
        <div className="admin-detail-image">
          {imageUrl ? (
            <img src={imageUrl} alt={title} data-testid="product-image" />
          ) : (
            <div className="admin-detail-no-image">No image</div>
          )}
        </div>

        {/* Form */}
        <div className="admin-detail-form" data-testid="product-form">
          <label>
            Title
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              data-testid="input-title"
            />
          </label>

          <label>
            ASIN
            <input
              type="text"
              value={asin}
              onChange={(e) => setAsin(e.target.value)}
              data-testid="input-asin"
            />
          </label>

          <label>
            Price ($)
            <input
              type="number"
              step="0.01"
              min="0"
              value={priceStr}
              onChange={(e) => setPriceStr(e.target.value)}
              data-testid="input-price"
            />
          </label>

          <label>
            Category
            <select
              value={categoryVal}
              onChange={(e) => setCategoryVal(e.target.value)}
              data-testid="input-category"
            >
              <option value="">— None —</option>
              {categories.map((cat) => (
                <option key={cat} value={cat}>{cat}</option>
              ))}
            </select>
          </label>

          <label>
            Manufacturer
            <input
              type="text"
              value={manufacturer}
              onChange={(e) => setManufacturer(e.target.value)}
              data-testid="input-manufacturer"
            />
          </label>

          <label>
            Image URL
            <input
              type="text"
              value={imageUrl}
              onChange={(e) => setImageUrl(e.target.value)}
              data-testid="input-imageUrl"
            />
          </label>

          <label>
            Description
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              data-testid="input-description"
            />
          </label>

          <div className="admin-detail-toggle">
            <label>
              <input
                type="checkbox"
                checked={isActive}
                onChange={(e) => setIsActive(e.target.checked)}
                data-testid="input-isActive"
              />
              Active
            </label>
          </div>

          <div className="admin-detail-actions">
            <button
              className="admin-btn-primary"
              onClick={handleSave}
              disabled={saving}
              data-testid="save-btn"
            >
              {saving ? "Saving..." : isNew ? "Create Product" : "Save Changes"}
            </button>
            <button
              onClick={() => navigate(-1)}
              data-testid="cancel-btn"
            >
              Cancel
            </button>
            {!isNew && product && (
              <button
                className={product.isActive ? "admin-btn-danger" : "admin-btn-primary"}
                onClick={handleToggleActive}
                data-testid="toggle-active-btn"
              >
                {product.isActive ? "Deactivate" : "Activate"}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
