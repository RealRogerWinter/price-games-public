/**
 * Panel showing 5 round cards for the selected day's puzzle.
 * Includes a save/revert action bar when there are pending changes.
 */

import type { AdminDailyPuzzleRow, GameMode } from "@price-game/shared";
import { DAILY_TOTAL_ROUNDS, getDailyProductsPerRound } from "@price-game/shared";
import RoundCard from "./RoundCard";

interface RoundDetailPanelProps {
  row: AdminDailyPuzzleRow;
  isReadOnly: boolean;
  pendingProductIds: number[] | undefined;
  onSwapProduct: (roundIndex: number, slotIndex: number) => void;
  onSave: () => void;
  onRevert: () => void;
  onRegenerate: () => void;
  saving: boolean;
}

/**
 * Builds the product slot arrays for each round from the flat parallel arrays.
 */
function buildRounds(row: AdminDailyPuzzleRow, overrideIds?: number[]) {
  const perRound = getDailyProductsPerRound(row.gameMode as GameMode);
  const ids = overrideIds ?? row.productIds;
  const rounds: { id: number; title: string; imageUrl: string; priceCents: number }[][] = [];

  for (let r = 0; r < DAILY_TOTAL_ROUNDS; r++) {
    const roundProducts: { id: number; title: string; imageUrl: string; priceCents: number }[] = [];
    for (let s = 0; s < perRound; s++) {
      const idx = r * perRound + s;
      if (idx < ids.length) {
        // Look up product data by ID from the row's parallel arrays.
        const origIdx = row.productIds.indexOf(ids[idx]);
        roundProducts.push({
          id: ids[idx],
          title: origIdx !== -1 ? row.productTitles[origIdx] : row.productTitles[idx] ?? "Loading...",
          imageUrl: origIdx !== -1 ? row.productImageUrls[origIdx] : row.productImageUrls[idx] ?? "",
          priceCents: origIdx !== -1 ? row.productPriceCents[origIdx] : row.productPriceCents[idx] ?? 0,
        });
      }
    }
    rounds.push(roundProducts);
  }

  return rounds;
}

/**
 * Detail panel for the selected day. Shows 5 round cards horizontally with
 * a save bar when changes are pending.
 */
export default function RoundDetailPanel({
  row,
  isReadOnly,
  pendingProductIds,
  onSwapProduct,
  onSave,
  onRevert,
  onRegenerate,
  saving,
}: RoundDetailPanelProps) {
  const rounds = buildRounds(row, pendingProductIds);
  const hasPending = pendingProductIds !== undefined;

  return (
    <div className="daily-round-panel-wrapper" data-testid="round-detail-panel">
      <div className="daily-round-panel-header">
        <h4>
          Rounds for {row.date}
          {row.isManualOverride && <span className="daily-status-badge daily-status-manual" style={{ marginLeft: 8 }}>Manual Override</span>}
        </h4>
        {!isReadOnly && !hasPending && (
          <button
            className="admin-btn-secondary admin-btn-sm"
            onClick={onRegenerate}
            title="Regenerate from seed (discards manual overrides)"
          >
            Regenerate
          </button>
        )}
      </div>

      {row.productIds.length === 0 ? (
        <div className="daily-round-panel-empty">
          No products assigned. {!isReadOnly ? "This day has not been seeded yet." : "No puzzle was generated for this date."}
        </div>
      ) : (
        <div className="daily-round-panel">
          {rounds.map((products, roundIdx) => (
            <RoundCard
              key={roundIdx}
              roundNumber={roundIdx + 1}
              products={products}
              isReadOnly={isReadOnly}
              onSwapProduct={(slotIdx) => onSwapProduct(roundIdx, slotIdx)}
            />
          ))}
        </div>
      )}

      {hasPending && (
        <div className="daily-save-bar">
          <span className="daily-save-bar-label">You have unsaved product changes</span>
          <div className="daily-save-bar-actions">
            <button
              className="admin-btn-secondary admin-btn-sm"
              onClick={onRevert}
              disabled={saving}
            >
              Revert
            </button>
            <button
              className="admin-btn-primary admin-btn-sm"
              onClick={onSave}
              disabled={saving}
            >
              {saving ? "Saving..." : "Save Products"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
