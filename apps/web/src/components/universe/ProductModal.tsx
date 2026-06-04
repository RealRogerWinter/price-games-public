/**
 * Product quick-view modal for the galaxy view.
 *
 * Shows product details (image, title, price, tags, summary cards, materials)
 * in an overlay without navigating away from the galaxy.
 *
 * @param productId - The product to display
 * @param onClose - Called when the modal should close
 */

import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { puGetProduct, puGetCards, puGetMaterials } from "../../api/universeClient";
import type { PUProductDetail, PUSummaryCard } from "@price-game/shared";
import LoadingSpinner from "./LoadingSpinner";
import ErrorDisplay from "./ErrorDisplay";

interface ProductModalProps {
  productId: number;
  onClose: () => void;
}

export default function ProductModal({ productId, onClose }: ProductModalProps) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const [product, setProduct] = useState<PUProductDetail | null>(null);
  const [cards, setCards] = useState<PUSummaryCard[]>([]);
  const [materials, setMaterials] = useState<{ name: string; percentage: number | null }[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  useEffect(() => {
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = "";
    };
  }, []);

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;

    puGetProduct(productId)
      .then((prod) => {
        if (cancelled) return;
        setProduct(prod);
        return Promise.all([puGetCards(productId), puGetMaterials(productId)]);
      })
      .then((results) => {
        if (cancelled || !results) return;
        const [cardsRes, matsRes] = results;
        setCards(cardsRes.cards);
        setMaterials(matsRes.materials);
      })
      .catch((err) => {
        if (!cancelled) setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [productId]);

  return (
    <div
      className="pu-modal-overlay"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Product details"
    >
      <div className="pu-modal" onClick={(e) => e.stopPropagation()}>
        <div className="pu-modal-header">
          <span />
          <button
            ref={closeRef}
            className="pu-modal-close"
            onClick={onClose}
            aria-label="Close"
          >
            &times;
          </button>
        </div>

        <div className="pu-modal-body">
          {loading && <LoadingSpinner message="Loading product..." />}
          {error && <ErrorDisplay message={error} />}
          {!loading && !error && product && (
            <>
              {product.imageUrl && (
                <img
                  className="pu-modal-img"
                  src={product.imageUrl}
                  alt={product.title}
                />
              )}
              <div className="pu-modal-info">
                <h2>{product.title}</h2>
                <div className="pu-modal-price">
                  ${(product.priceCents / 100).toFixed(2)}
                </div>
                <div className="pu-modal-tags">
                  {product.category && (
                    <span className="pu-tag">{product.category}</span>
                  )}
                  {product.manufacturer && (
                    <span className="pu-tag">{product.manufacturer}</span>
                  )}
                </div>
              </div>

              {cards.length > 0 && (
                <div className="pu-modal-section">
                  <h3>Summary</h3>
                  <div className="pu-summary-cards">
                    {cards.map((card, i) => (
                      <div
                        key={i}
                        className="pu-summary-card"
                        data-category={card.category}
                      >
                        <div className="pu-summary-card-header">
                          <span className="pu-summary-card-icon">{card.icon}</span>
                          <span className="pu-summary-card-title">{card.title}</span>
                        </div>
                        <div className="pu-summary-card-content">{card.content}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {materials.length > 0 && (
                <div className="pu-modal-section">
                  <h3>Materials</h3>
                  <div className="pu-materials">
                    {materials.map((mat, i) => (
                      <div key={i} className="pu-material-item">
                        <span>{mat.name}</span>
                        <div className="pu-material-bar">
                          <div
                            className="pu-material-bar-fill"
                            style={{ width: `${mat.percentage}%` }}
                          />
                        </div>
                        <span className="pu-material-pct">{mat.percentage}%</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {!loading && !error && product && (
          <div className="pu-modal-footer">
            <Link to={`/universe/product/${productId}`} onClick={onClose}>
              View full details
            </Link>
            <Link to={`/universe/product/${productId}/supply-chain`} onClick={onClose}>
              Supply chain map
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}
