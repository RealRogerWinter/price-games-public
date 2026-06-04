/**
 * Summary cards container for Product Universe.
 *
 * Displays a grid of AI-generated summary cards for a product.
 */

import type { PUSummaryCard } from "@price-game/shared";
import SummaryCard from "./SummaryCard";

interface SummaryCardsProps {
  cards: PUSummaryCard[];
  loading?: boolean;
}

export default function SummaryCards({ cards, loading }: SummaryCardsProps) {
  if (loading) {
    return (
      <div className="pu-summary-cards">
        <div className="pu-loading">Generating summary cards...</div>
      </div>
    );
  }

  if (cards.length === 0) {
    return (
      <div className="pu-summary-cards">
        <p className="pu-muted">No summary cards available yet. Enrichment may still be in progress.</p>
      </div>
    );
  }

  return (
    <div className="pu-summary-cards">
      {cards.map((card, i) => (
        <SummaryCard key={i} card={card} />
      ))}
    </div>
  );
}
