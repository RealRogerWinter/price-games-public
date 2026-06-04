/**
 * Related products list for Product Universe.
 *
 * Shows products similar to the current one, based on precomputed scores.
 */

import { Link } from "react-router-dom";

interface RelatedProduct {
  id: number;
  title: string;
  imageUrl: string | null;
  category: string | null;
  manufacturer: string | null;
  score: number;
  reason: string | null;
}

interface RelatedProductsProps {
  products: RelatedProduct[];
  loading?: boolean;
}

export default function RelatedProducts({ products, loading }: RelatedProductsProps) {
  if (loading) return <div className="pu-related pu-loading">Finding similar products...</div>;
  if (products.length === 0) return <p className="pu-muted">No related products found yet.</p>;

  return (
    <div className="pu-related">
      <h3>Related Products</h3>
      <div className="pu-related-list">
        {products.map((p) => (
          <Link key={p.id} to={`/universe/product/${p.id}`} className="pu-related-item">
            <div className="pu-related-info">
              <span className="pu-related-title">{p.title}</span>
              {p.reason && <span className="pu-related-reason">{p.reason}</span>}
            </div>
            <span className="pu-related-score">{Math.round(p.score * 100)}%</span>
          </Link>
        ))}
      </div>
    </div>
  );
}
