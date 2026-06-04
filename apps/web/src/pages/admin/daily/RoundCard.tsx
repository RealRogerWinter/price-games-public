/**
 * A single round card showing 1-2 product slots with thumbnail, title, price,
 * and an optional "Swap" button for editable days.
 */

interface ProductSlot {
  id: number;
  title: string;
  imageUrl: string;
  priceCents: number;
}

interface RoundCardProps {
  roundNumber: number;
  products: ProductSlot[];
  isReadOnly: boolean;
  onSwapProduct: (slotIndex: number) => void;
}

/** Format cents as $X.XX. */
function formatPrice(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/** Placeholder SVG for missing product images. */
function PlaceholderThumb() {
  return (
    <div className="daily-product-thumb daily-product-thumb--placeholder">
      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#666" strokeWidth="1.5">
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <path d="M3 16l5-5 3 3 4-4 6 6" />
        <circle cx="8.5" cy="8.5" r="1.5" />
      </svg>
    </div>
  );
}

/**
 * Card for a single round, showing each product slot vertically.
 * For comparison mode, two products appear side by side.
 */
export default function RoundCard({
  roundNumber,
  products,
  isReadOnly,
  onSwapProduct,
}: RoundCardProps) {
  return (
    <div className="daily-round-card" data-testid={`round-card-${roundNumber}`}>
      <div className="daily-round-card-header">Round {roundNumber}</div>
      <div className={`daily-round-card-slots ${products.length > 1 ? "daily-round-card-slots--multi" : ""}`}>
        {products.map((product, slotIdx) => (
          <div key={`slot-${slotIdx}-${product.id}`} className="daily-product-slot">
            {product.imageUrl ? (
              <img
                src={product.imageUrl}
                alt=""
                className="daily-product-thumb"
                loading="lazy"
              />
            ) : (
              <PlaceholderThumb />
            )}
            <div className="daily-product-info">
              <span className="daily-product-title" title={product.title}>
                {product.title}
              </span>
              <span className="daily-product-price">{formatPrice(product.priceCents)}</span>
            </div>
            {!isReadOnly && (
              <button
                className="daily-swap-btn"
                onClick={() => onSwapProduct(slotIdx)}
                title="Replace this product"
              >
                Swap
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
