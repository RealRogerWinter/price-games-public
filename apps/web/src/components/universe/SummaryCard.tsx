/**
 * Individual summary card component.
 *
 * Displays a single AI-generated insight card with icon, title, and content.
 */

import type { PUSummaryCard } from "@price-game/shared";
import SourceList from "./SourceList";

interface SummaryCardProps {
  card: PUSummaryCard;
}

export default function SummaryCard({ card }: SummaryCardProps) {
  return (
    <div className={`pu-summary-card pu-card-${card.category}`}>
      <div className="pu-summary-card-header">
        <span className="pu-summary-card-icon">{card.icon}</span>
        <h3 className="pu-summary-card-title">{card.title}</h3>
      </div>
      <p className="pu-summary-card-content">{card.content}</p>
      <span className="pu-summary-card-category">{card.category}</span>
      {card.sources && card.sources.length > 0 && (
        <SourceList sources={card.sources} />
      )}
    </div>
  );
}
