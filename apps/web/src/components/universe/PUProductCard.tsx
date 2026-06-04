/**
 * Product card for search results in Product Universe.
 *
 * Shows product image, title, category, manufacturer, and enrichment status.
 */

import { Link } from "react-router-dom";

interface PUProductCardProps {
  id: number;
  title: string;
  imageUrl: string | null;
  category: string | null;
  manufacturer: string | null;
  enriched: boolean;
}

export default function PUProductCard({ id, title, imageUrl, category, manufacturer, enriched }: PUProductCardProps) {
  return (
    <Link to={`/universe/product/${id}`} className="pu-product-card">
      <div className="pu-product-card-img">
        {imageUrl ? (
          <img src={`/api/image/${id}`} alt={title} loading="lazy" />
        ) : (
          <div className="pu-product-card-placeholder">No Image</div>
        )}
      </div>
      <div className="pu-product-card-info">
        <h3 className="pu-product-card-title">{title}</h3>
        {category && <span className="pu-product-card-category">{category}</span>}
        {manufacturer && <span className="pu-product-card-mfg">{manufacturer}</span>}
        <span className={`pu-enrichment-badge ${enriched ? "enriched" : "pending"}`}>
          {enriched ? "Enriched" : "Pending"}
        </span>
      </div>
    </Link>
  );
}
