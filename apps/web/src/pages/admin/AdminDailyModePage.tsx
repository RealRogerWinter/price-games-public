/**
 * Admin page for managing the daily challenge mode (v2).
 *
 * Card-based week view with:
 *   1. Enable/disable toggle
 *   2. Week navigation bar (prev/next, today)
 *   3. 7 day cards showing mode, status, product count
 *   4. Round detail panel for the selected day
 *   5. Product picker modal for swapping products
 *   6. Stats section (total plays, unique players, top streaks)
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AdminDailyOverviewResponse,
  AdminDailyStatsResponse,
  AdminProduct,
  GameMode,
} from "@price-game/shared";
import { addDays, COMPARISON_PRODUCTS_PER_ROUND } from "@price-game/shared";
import {
  fetchAdminDailyOverview,
  fetchAdminDailyStats,
  updateAdminDailyEnabled,
  updateAdminDailySchedule,
  setAdminDailyProducts,
  regenerateAdminDailyPuzzle,
} from "../../api/adminClient";
import WeekNavigationBar from "./daily/WeekNavigationBar";
import DayCardStrip from "./daily/DayCardStrip";
import RoundDetailPanel from "./daily/RoundDetailPanel";
import ProductPickerModal from "./daily/ProductPickerModal";
import DailyStatsSection from "./daily/DailyStatsSection";

/** Compute the Monday of the week containing the given YYYY-MM-DD. */
function getWeekStart(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  const dow = d.getUTCDay(); // 0=Sun
  const mondayOffset = dow === 0 ? -6 : 1 - dow;
  return addDays(dateStr, mondayOffset);
}

/**
 * Admin daily challenge management page (v2).
 */
export default function AdminDailyModePage() {
  // --- Data state ---
  const [overview, setOverview] = useState<AdminDailyOverviewResponse | null>(null);
  const [stats, setStats] = useState<AdminDailyStatsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // --- UI state ---
  const [weekStartDate, setWeekStartDate] = useState<string>("");
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [pendingOverrides, setPendingOverrides] = useState<Map<string, number[]>>(new Map());
  const [pickerContext, setPickerContext] = useState<{
    date: string;
    roundIdx: number;
    slotIdx: number;
  } | null>(null);
  const [saving, setSaving] = useState(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  // --- Derived values ---
  const currentDate = overview?.currentDate ?? "";
  const todayWeekStart = currentDate ? getWeekStart(currentDate) : "";

  // Max navigable future: one week from today's Monday
  const maxWeekStart = todayWeekStart ? addDays(todayWeekStart, 7) : "";
  const canNavigateNext = weekStartDate !== "" && maxWeekStart !== "" && weekStartDate < maxWeekStart;
  const canNavigatePrev = true; // Can always go back

  // Build a set of dates with pending changes
  const pendingDates = useMemo(() => new Set(pendingOverrides.keys()), [pendingOverrides]);

  // --- Data loading ---
  const loadOverview = useCallback(async (start: string) => {
    setLoading(true);
    setError(null);
    try {
      const ov = await fetchAdminDailyOverview(7, start);
      setOverview(ov);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load daily overview");
    } finally {
      setLoading(false);
    }
  }, []);

  const loadStats = useCallback(async () => {
    try {
      const st = await fetchAdminDailyStats();
      setStats(st);
    } catch {
      // Stats are non-critical; silently ignore
    }
  }, []);

  // Initial load: single fetch, then compute week start from server date.
  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const ov = await fetchAdminDailyOverview(7);
        const ws = getWeekStart(ov.currentDate);
        setWeekStartDate(ws);
        // If the server's default window already starts on Monday, use it
        // directly. Otherwise refetch with the aligned start date.
        if (ov.rows.length > 0 && ov.rows[0].date === ws) {
          setOverview(ov);
        } else {
          const aligned = await fetchAdminDailyOverview(7, ws);
          setOverview(aligned);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load daily settings");
      } finally {
        setLoading(false);
      }
    })();
    loadStats();
  }, [loadStats]);

  // Refetch when week changes via navigation (skip initial load).
  const [initialLoadDone, setInitialLoadDone] = useState(false);
  useEffect(() => {
    if (!initialLoadDone && weekStartDate) {
      setInitialLoadDone(true);
      return;
    }
    if (weekStartDate && initialLoadDone) {
      loadOverview(weekStartDate);
    }
  }, [weekStartDate, initialLoadDone, loadOverview]);

  // --- Handlers ---
  async function handleToggleEnabled() {
    if (!overview) return;
    try {
      await updateAdminDailyEnabled(!overview.enabled);
      if (weekStartDate) await loadOverview(weekStartDate);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update");
    }
  }

  function handlePrevWeek() {
    setWeekStartDate((prev) => addDays(prev, -7));
    setSelectedDate(null);
  }

  function handleNextWeek() {
    if (canNavigateNext) {
      setWeekStartDate((prev) => addDays(prev, 7));
      setSelectedDate(null);
    }
  }

  function handleToday() {
    if (todayWeekStart) {
      setWeekStartDate(todayWeekStart);
      setSelectedDate(currentDate);
    }
  }

  function handleSelectDate(date: string) {
    setSelectedDate((prev) => (prev === date ? null : date));
  }

  async function handleModeChange(date: string, newMode: GameMode) {
    if (!overview) return;
    const d = new Date(`${date}T00:00:00Z`);
    const dayName = d.toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
    // Changing a day card's mode updates the global weekly schedule for that
    // day-of-week (all future instances), so confirm with the admin first.
    if (!window.confirm(`This will change the mode for all future ${dayName}s. Continue?`)) {
      return;
    }
    const dow = d.getUTCDay(); // 0=Sun
    const newSchedule = [...overview.schedule];
    newSchedule[dow] = newMode;

    try {
      await updateAdminDailySchedule(newSchedule);
      // Clear pending overrides for this date (product count may have changed)
      setPendingOverrides((prev) => {
        const next = new Map(prev);
        next.delete(date);
        return next;
      });
      showToast(`Schedule updated: ${new Date(`${date}T00:00:00Z`).toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" })}s now use ${newMode}`);
      await loadOverview(weekStartDate);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update schedule");
    }
  }

  function handleSwapProduct(roundIdx: number, slotIdx: number) {
    if (!selectedDate) return;
    setPickerContext({ date: selectedDate, roundIdx, slotIdx });
  }

  function handleProductSelected(product: AdminProduct) {
    if (!pickerContext || !selectedDate || !overview) return;
    const row = overview.rows.find((r) => r.date === selectedDate);
    if (!row) return;

    const perRound = row.gameMode === "comparison" ? COMPARISON_PRODUCTS_PER_ROUND : 1;
    const globalIdx = pickerContext.roundIdx * perRound + pickerContext.slotIdx;

    // Start from pending or current product IDs
    const currentIds = pendingOverrides.get(selectedDate) ?? [...row.productIds];
    const updated = [...currentIds];
    updated[globalIdx] = product.id;

    setPendingOverrides((prev) => {
      const next = new Map(prev);
      next.set(selectedDate, updated);
      return next;
    });

    // Update the row's parallel arrays AND productIds in the overview for
    // immediate UI feedback. productIds must stay in sync so that
    // buildRounds' indexOf-based lookup resolves correctly.
    setOverview((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        rows: prev.rows.map((r) => {
          if (r.date !== selectedDate) return r;
          const newIds = [...r.productIds];
          const newTitles = [...r.productTitles];
          const newImages = [...r.productImageUrls];
          const newPrices = [...r.productPriceCents];
          newIds[globalIdx] = product.id;
          newTitles[globalIdx] = product.title;
          newImages[globalIdx] = product.imageUrl ?? "";
          newPrices[globalIdx] = product.priceCents;
          return {
            ...r,
            productIds: newIds,
            productTitles: newTitles,
            productImageUrls: newImages,
            productPriceCents: newPrices,
          };
        }),
      };
    });

    setPickerContext(null);
  }

  async function handleSaveProducts() {
    if (!selectedDate || !overview) return;
    const row = overview.rows.find((r) => r.date === selectedDate);
    if (!row) return;
    const productIds = pendingOverrides.get(selectedDate);
    if (!productIds) return;

    setSaving(true);
    try {
      await setAdminDailyProducts(selectedDate, row.gameMode, productIds);
      setPendingOverrides((prev) => {
        const next = new Map(prev);
        next.delete(selectedDate);
        return next;
      });
      showToast("Products saved successfully");
      await loadOverview(weekStartDate);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save products");
    } finally {
      setSaving(false);
    }
  }

  function handleRevertProducts() {
    if (!selectedDate) return;
    setPendingOverrides((prev) => {
      const next = new Map(prev);
      next.delete(selectedDate);
      return next;
    });
    // Reload to restore original data
    if (weekStartDate) loadOverview(weekStartDate);
  }

  async function handleRegenerate() {
    if (!selectedDate) return;
    const row = overview?.rows.find((r) => r.date === selectedDate);
    if (!row) return;

    const force = row.isManualOverride;
    if (force && !window.confirm("This will discard the manual override and regenerate from seed. Continue?")) {
      return;
    }

    try {
      await regenerateAdminDailyPuzzle(selectedDate, force);
      showToast("Puzzle regenerated from seed");
      await loadOverview(weekStartDate);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to regenerate puzzle");
    }
  }

  const toastTimer = useRef<ReturnType<typeof setTimeout>>();
  function showToast(message: string) {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToastMessage(message);
    toastTimer.current = setTimeout(() => setToastMessage(null), 3000);
  }

  // --- Selected row ---
  const selectedRow = overview?.rows.find((r) => r.date === selectedDate) ?? null;
  const isSelectedReadOnly = selectedDate ? selectedDate < currentDate : true;
  const selectedPending = selectedDate ? pendingOverrides.get(selectedDate) : undefined;

  // Exclude IDs for the product picker: all products used in the selected day's puzzle
  const pickerExcludeIds = useMemo(() => {
    if (!selectedRow) return [];
    return selectedPending ?? selectedRow.productIds;
  }, [selectedRow, selectedPending]);

  // --- Render ---
  if (loading && !overview) {
    return (
      <div className="admin-page">
        <div className="admin-loading" style={{ minHeight: "200px" }}>
          <span className="admin-loading-spinner" />
          Loading daily challenge settings...
        </div>
      </div>
    );
  }

  if (error && !overview) {
    return (
      <div className="admin-page">
        <h2>Daily Challenge</h2>
        <div className="admin-error">{error}</div>
        <button className="admin-btn-primary" onClick={() => weekStartDate && loadOverview(weekStartDate)}>
          Retry
        </button>
      </div>
    );
  }

  if (!overview) return null;

  return (
    <div className="admin-page admin-daily-mode-page" data-testid="admin-daily-mode-page">
      <div className="daily-page-header">
        <h2>Daily Challenge</h2>
        <label className="daily-enable-toggle">
          <input
            type="checkbox"
            checked={overview.enabled}
            onChange={handleToggleEnabled}
          />
          <span>{overview.enabled ? "Enabled" : "Disabled"}</span>
        </label>
      </div>

      {!overview.enabled && (
        <div className="daily-disabled-banner">
          Daily challenge is currently hidden from all players.
        </div>
      )}

      {error && (
        <div className="admin-error" style={{ marginBottom: "1rem" }}>
          {error}
          <button
            className="admin-btn-sm"
            style={{ marginLeft: 8 }}
            onClick={() => setError(null)}
          >
            Dismiss
          </button>
        </div>
      )}

      {toastMessage && (
        <div className="daily-toast">{toastMessage}</div>
      )}

      <WeekNavigationBar
        weekStart={weekStartDate}
        currentDate={currentDate}
        onPrev={handlePrevWeek}
        onNext={handleNextWeek}
        canPrev={canNavigatePrev}
        canNext={canNavigateNext}
        onToday={handleToday}
      />

      <DayCardStrip
        rows={overview.rows}
        currentDate={currentDate}
        selectedDate={selectedDate}
        pendingDates={pendingDates}
        onSelectDate={handleSelectDate}
        onModeChange={handleModeChange}
      />

      {selectedRow && (
        <RoundDetailPanel
          row={selectedRow}
          isReadOnly={isSelectedReadOnly}
          pendingProductIds={selectedPending}
          onSwapProduct={handleSwapProduct}
          onSave={handleSaveProducts}
          onRevert={handleRevertProducts}
          onRegenerate={handleRegenerate}
          saving={saving}
        />
      )}

      <ProductPickerModal
        isOpen={pickerContext !== null}
        onClose={() => setPickerContext(null)}
        onSelect={handleProductSelected}
        excludeProductIds={pickerExcludeIds}
      />

      {stats && <DailyStatsSection stats={stats} />}
    </div>
  );
}
