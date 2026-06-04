import { useState } from "react";
import type { Product } from "@price-game/shared";
import ImageModal from "./ImageModal";
import ProductTooltip from "./ProductTooltip";
import { reportImageFailure } from "../lib/imageDiagnostics";

interface ProductCardProps {
  product: Product;
  /**
   * Hide the "View on Amazon" CTA in the product-name tooltip. Set true for
   * in-round displays so clicking the affiliate link can't reveal the price
   * before the user has locked in their guess.
   */
  hideAmazonLink?: boolean;
}

const FALLBACK_SVG =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300"><rect width="300" height="300" fill="#1a1a2e"/><text x="50%" y="45%" text-anchor="middle" font-size="48" fill="#4ecca3">$?</text><text x="50%" y="62%" text-anchor="middle" font-size="14" fill="#6b6b80">Guess the price!</text></svg>'
  );

function handleImageIssue(e: React.SyntheticEvent<HTMLImageElement>, productId?: number) {
  const img = e.target as HTMLImageElement;
  if (img.src !== FALLBACK_SVG) {
    reportImageFailure({ productId, src: img.src, phase: "error" });
    img.src = FALLBACK_SVG;
  }
}

export default function ProductCard({ product, hideAmazonLink = false }: ProductCardProps) {
  const [showModal, setShowModal] = useState(false);

  return (
    <div className="product-card">
      <div className="product-image-wrapper" onClick={() => setShowModal(true)}>
        <img
          // iOS Safari: re-key per product so React mounts a fresh HTMLImageElement
          // rather than mutating src on a potentially in-flight load — WebKit's
          // ImageLoader can swallow the error event on cancellation and leave the
          // element stuck blank until a full page refresh.
          key={product.id}
          className="product-image"
          src={product.imageUrl}
          alt={product.title}
          decoding="async"
          // Intrinsic dimensions reserve space before the asset loads, killing
          // the CLS shift that Lighthouse flagged on play-classic / play-closest
          // (PR2 perf F-FE3). Amazon thumbnails are roughly square; the actual
          // rendered size is still bounded by `.product-image` CSS (max-height
          // 260px / max-width 100% with object-fit: contain), so the attributes
          // only affect aspect-ratio reservation, not layout.
          width={500}
          height={500}
          onError={(e) => handleImageIssue(e, product.id)}
          onLoad={(e) => {
            const img = e.target as HTMLImageElement;
            if (img.naturalWidth <= 5 && img.naturalHeight <= 5) {
              handleImageIssue(e, product.id);
            }
          }}
        />
      </div>
      <div className="product-info">
        <span className="category-badge">{product.category}</span>
        <ProductTooltip product={product} showAmazonLink={!hideAmazonLink} disabled={hideAmazonLink}>
          <h2 className="product-title product-name-hoverable">{product.title}</h2>
        </ProductTooltip>
      </div>
      {showModal && (
        <ImageModal
          src={product.imageUrl}
          alt={product.title}
          onClose={() => setShowModal(false)}
        />
      )}
    </div>
  );
}
