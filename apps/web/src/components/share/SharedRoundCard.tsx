import { useState } from "react";
import type { SharedRoundSnapshot, ShareTier, ProductWithPrice } from "@price-game/shared";
import ImageModal from "../ImageModal";
import ProductTooltip from "../ProductTooltip";
import { AmazonCTA } from "../AmazonCTA";

interface SharedRoundCardProps {
  snap: SharedRoundSnapshot;
  tier: ShareTier;
  perRoundMax: number;
  formatPrice: (cents: number) => string;
}

/**
 * Per-round card showing product(s), actual price, player guess (when known),
 * and a tier-colored score badge. Handles missing/optional fields gracefully
 * so every game mode renders even if a future mode adds new shape variants.
 *
 * Shared between {@link SharePage} (the /s/:id viewer) and {@link ShareModal}
 * so the recap modal, the sharing modal preview, and the public share page
 * all render the same round breakdown with the same Amazon affiliate links.
 */
export default function SharedRoundCard({ snap, tier, perRoundMax, formatPrice }: SharedRoundCardProps) {
  const scoreOfMax = `${snap.score.toLocaleString("en-US")} / ${perRoundMax.toLocaleString("en-US")}`;
  const [zoomedImage, setZoomedImage] = useState<{ src: string; alt: string } | null>(null);

  return (
    <div className={`shared-round-card shared-round-card-${tier}`}>
      <div className="shared-round-card-header">
        <span className="shared-round-card-number">Round {snap.roundNumber}</span>
        <span className="shared-round-card-score">{scoreOfMax}</span>
      </div>

      <div className="shared-round-card-products">
        {snap.products.length === 0 ? (
          <span className="shared-round-card-empty">No product data</span>
        ) : (
          snap.products.map((p, i) => (
            <div key={i} className="shared-round-card-product">
              {p.imageUrl && (
                <img
                  src={p.imageUrl}
                  alt={p.title}
                  className="shared-round-card-img"
                  style={{ cursor: "zoom-in" }}
                  onClick={() => setZoomedImage({ src: p.imageUrl, alt: p.title })}
                  onError={(e) => {
                    (e.target as HTMLImageElement).style.display = "none";
                  }}
                />
              )}
              <div className="shared-round-card-info">
                <ProductTooltip product={{ ...p, id: 0, description: "", category: "" } as ProductWithPrice}>
                  <span className="shared-round-card-title">{p.title}</span>
                </ProductTooltip>
                <span className="shared-round-card-price">
                  {formatPrice(p.priceCents)}
                </span>
                {p.amazonUrl && (
                  <AmazonCTA
                    href={p.amazonUrl}
                    variant="inline"
                    productLabel={p.title}
                  />
                )}
              </div>
            </div>
          ))
        )}
      </div>

      {zoomedImage && (
        <ImageModal src={zoomedImage.src} alt={zoomedImage.alt} onClose={() => setZoomedImage(null)} />
      )}

      {/* Render any mode-specific detail lines that are present in the snapshot. */}
      <div className="shared-round-card-details">
        {snap.guessedPriceCents !== undefined && (
          <span className="shared-round-card-detail">
            Guess: {formatPrice(snap.guessedPriceCents)}
            {snap.wentOver ? " (over)" : ""}
          </span>
        )}
        {snap.guess !== undefined && (
          <span className="shared-round-card-detail">
            Picked: {snap.guess === "higher" ? "Higher" : "Lower"}
            {snap.correct !== undefined && (snap.correct ? " ✓" : " ✗")}
          </span>
        )}
        {snap.guessedTotalCents !== undefined && snap.actualTotalCents !== undefined && (
          <span className="shared-round-card-detail">
            Guessed {formatPrice(snap.guessedTotalCents)} of {formatPrice(snap.actualTotalCents)}
          </span>
        )}
        {snap.cartTotalCents !== undefined && snap.budgetCents !== undefined && (
          <span className="shared-round-card-detail">
            Cart {formatPrice(snap.cartTotalCents)} of {formatPrice(snap.budgetCents)} budget
          </span>
        )}
        {snap.correctCount !== undefined && (
          <span className="shared-round-card-detail">
            {snap.correctCount} correct
          </span>
        )}
      </div>
    </div>
  );
}
