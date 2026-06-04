/**
 * Enrichment status indicator.
 *
 * Shows whether a product has been enriched and when.
 */

interface EnrichmentStatusProps {
  enriched: boolean;
  enrichedAt: string | null;
}

export default function EnrichmentStatus({ enriched, enrichedAt }: EnrichmentStatusProps) {
  return (
    <div className={`pu-enrichment-status ${enriched ? "enriched" : "pending"}`}>
      <span className="pu-enrichment-dot" />
      <span className="pu-enrichment-text">
        {enriched
          ? `Enriched${enrichedAt ? ` on ${new Date(enrichedAt).toLocaleDateString()}` : ""}`
          : "Enrichment pending — data will appear as it's processed"}
      </span>
    </div>
  );
}
