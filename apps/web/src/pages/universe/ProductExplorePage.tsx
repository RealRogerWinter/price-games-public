/**
 * Product explore page for Product Universe.
 *
 * Shows full product detail with summary cards, materials, supply chain
 * link, related products, and enrichment status.
 */

import { useState, useEffect } from "react";
import { useParams, Link } from "react-router-dom";
import SummaryCards from "../../components/universe/SummaryCards";
import EnrichmentStatus from "../../components/universe/EnrichmentStatus";
import MaterialBreakdown from "../../components/universe/MaterialBreakdown";
import RelatedProducts from "../../components/universe/RelatedProducts";
import LoadingSpinner from "../../components/universe/LoadingSpinner";
import ErrorDisplay from "../../components/universe/ErrorDisplay";
import { puGetProduct, puGetCards, puGetMaterials, puGetRelated } from "../../api/universeClient";
import type { PUSummaryCard } from "@price-game/shared";

export default function ProductExplorePage() {
  const { id } = useParams<{ id: string }>();
  const productId = parseInt(id || "0", 10);

  const [product, setProduct] = useState<any>(null);
  const [cards, setCards] = useState<PUSummaryCard[]>([]);
  const [materials, setMaterials] = useState<any[]>([]);
  const [related, setRelated] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [cardsLoading, setCardsLoading] = useState(false);

  useEffect(() => {
    if (!productId) return;
    setLoading(true);
    setError(null);

    puGetProduct(productId)
      .then((detail) => {
        setProduct(detail);
        setLoading(false);

        // Load supplementary data in parallel
        setCardsLoading(true);
        Promise.all([
          puGetCards(productId).then((r) => setCards(r.cards)).catch(() => {}),
          puGetMaterials(productId).then((r) => setMaterials(r.materials)).catch(() => {}),
          puGetRelated(productId).then((r) => setRelated(r.related)).catch(() => {}),
        ]).finally(() => setCardsLoading(false));
      })
      .catch((err) => {
        setError(err.message);
        setLoading(false);
      });
  }, [productId]);

  if (loading) return <LoadingSpinner message="Loading product..." />;
  if (error) return <ErrorDisplay message={error} />;
  if (!product) return <ErrorDisplay message="Product not found" />;

  return (
    <div className="pu-product-explore">
      <div className="pu-product-header">
        <div className="pu-product-img">
          {product.imageUrl ? (
            <img src={`/api/image/${product.id}`} alt={product.title} />
          ) : (
            <div className="pu-product-placeholder">No Image</div>
          )}
        </div>
        <div className="pu-product-info">
          <h1>{product.title}</h1>
          {product.category && <span className="pu-tag">{product.category}</span>}
          {product.manufacturer && <span className="pu-tag">{product.manufacturer}</span>}
          <p className="pu-product-price">${(product.priceCents / 100).toFixed(2)}</p>
          {product.description && <p className="pu-product-desc">{product.description}</p>}
          <EnrichmentStatus enriched={product.puEnriched} enrichedAt={product.puEnrichedAt} />
        </div>
      </div>

      <SummaryCards cards={cards} loading={cardsLoading} />

      <div className="pu-product-sections">
        <MaterialBreakdown materials={materials} />

        <div className="pu-product-links">
          <Link to={`/universe/product/${productId}/map`} className="pu-btn">
            View Supply Chain Map
          </Link>
          <Link to={`/universe/galaxy`} className="pu-btn">
            View in Galaxy
          </Link>
        </div>

        <RelatedProducts products={related} />
      </div>
    </div>
  );
}
