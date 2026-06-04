/**
 * Stats display component for Product Universe homepage.
 *
 * Shows aggregate counts for the knowledge graph.
 */

import type { PUStats } from "@price-game/shared";

interface StatsDisplayProps {
  stats: PUStats | null;
  loading?: boolean;
}

export default function StatsDisplay({ stats, loading }: StatsDisplayProps) {
  if (loading) return <div className="pu-stats pu-loading">Loading stats...</div>;
  if (!stats) return null;

  const items = [
    { label: "Products", value: stats.totalProducts },
    { label: "Enriched", value: stats.enrichedProducts },
    { label: "Materials", value: stats.totalMaterials },
    { label: "Companies", value: stats.totalCompanies },
    { label: "Locations", value: stats.totalLocations },
    { label: "Supply Chain Nodes", value: stats.totalSupplyChainNodes },
  ];

  return (
    <div className="pu-stats">
      {items.map((item) => (
        <div key={item.label} className="pu-stat-item">
          <span className="pu-stat-value">{item.value.toLocaleString()}</span>
          <span className="pu-stat-label">{item.label}</span>
        </div>
      ))}
    </div>
  );
}
