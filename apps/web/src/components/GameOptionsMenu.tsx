import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import type { RoundCountOption } from "@price-game/shared";
import { ROUND_COUNT_OPTIONS } from "@price-game/shared";
import CurrencySelector from "./CurrencySelector";
import { getCategories } from "../api/client";
import { useSound } from "../audio/SoundContext";
import { useModalHistory } from "../hooks/useModalHistory";

interface GameOptionsMenuProps {
  selectedRounds: RoundCountOption;
  onSelectRounds: (rounds: RoundCountOption) => void;
  /**
   * Applies the given category selection. On home / round-1, the parent
   * should just save the selection; mid-game the parent restarts the game.
   * When omitted, the Categories row is hidden.
   */
  onApplyCategories?: (categories: string[]) => void;
  /** The currently-applied category selection — used to pre-seed the draft. */
  currentCategories?: string[];
  /**
   * If true, Apply routes through an inline confirmation view warning that
   * the user's in-progress game will be restarted.
   */
  requireRestartConfirm?: boolean;
  /** "home" opens the dropdown upward (default); "topbar" opens downward with btn-top styling. */
  variant?: "home" | "topbar";
}

interface CategoryInfo {
  name: string;
  count: number;
}

type View = "main" | "categories" | "confirm";

/**
 * Dropdown menu combining game settings: round count, categories, and currency.
 *
 * The categories panel expands INLINE (v2 design) — clicking the Categories
 * row swaps the dropdown's contents in place instead of opening a modal. If
 * `requireRestartConfirm` is set (active mid-game), Apply routes through a
 * confirmation view before invoking `onApplyCategories`.
 */
export default function GameOptionsMenu({
  selectedRounds,
  onSelectRounds,
  onApplyCategories,
  currentCategories,
  requireRestartConfirm = false,
  variant = "home",
}: GameOptionsMenuProps) {
  // Browser-history-aware open/close — back button closes the menu / exits
  // the categories sub-view without navigating away from the page.
  const [open, setOpen] = useModalHistory("game-options");
  const [catViewOpen, setCatViewOpen] = useModalHistory("game-options-cat");
  const [confirmViewOpen, setConfirmViewOpen] = useState(false);
  const [catList, setCatList] = useState<CategoryInfo[] | null>(null);
  const [catLoading, setCatLoading] = useState(false);
  const [catError, setCatError] = useState<string | null>(null);
  const [draftSelected, setDraftSelected] = useState<string[]>([]);
  const menuRef = useRef<HTMLDivElement>(null);
  const { volume, setVolume, muted, setMuted, play } = useSound();

  // Derive the active view from the two history-aware booleans.
  const view: View = confirmViewOpen ? "confirm" : catViewOpen ? "categories" : "main";

  const close = useCallback(() => {
    // Close sub-views first so their history entries are popped in order.
    setConfirmViewOpen(false);
    setCatViewOpen(false);
    setOpen(false);
  }, [setCatViewOpen, setOpen]);

  // When the menu is closed (e.g. via back button), ensure sub-views reset.
  useEffect(() => {
    if (!open) {
      setConfirmViewOpen(false);
      // catViewOpen is also history-aware; if the menu just closed via
      // history.back() the popstate handler already cleared it. Call
      // setCatViewOpen(false) defensively — useModalHistory is a no-op when
      // already closed.
      setCatViewOpen(false);
    }
  }, [open, setCatViewOpen]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        close();
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open, close]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") close();
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [open, close]);

  /**
   * Lazily fetch the category list the first time the categories view is
   * opened. Keeps the home-screen network profile quiet for users who never
   * touch Game Options.
   *
   * The draft is always reconciled against the fresh list — any entries in
   * `currentCategories` that the server no longer surfaces (e.g. a category
   * that dropped below the 15-product threshold since last play) are silently
   * filtered out, so the eventual /start call won't 400.
   */
  const enterCategories = useCallback(() => {
    setCatViewOpen(true);
    const seedDraft = (list: CategoryInfo[]) => {
      const names = new Set(list.map((c) => c.name));
      if (currentCategories && currentCategories.length > 0) {
        const reconciled = currentCategories.filter((c) => names.has(c));
        // If every saved category is now gone, fall back to all-selected
        // rather than stranding the user on a disabled Apply button.
        setDraftSelected(reconciled.length > 0 ? reconciled : list.map((c) => c.name));
      } else {
        setDraftSelected(list.map((c) => c.name));
      }
    };
    if (catList) {
      seedDraft(catList);
      return;
    }
    setCatLoading(true);
    setCatError(null);
    getCategories()
      .then((data) => {
        setCatList(data.categories);
        seedDraft(data.categories);
      })
      .catch((err) => {
        console.error("Failed to load categories", err);
        setCatError("Couldn't load categories. Check your connection and try again.");
      })
      .finally(() => setCatLoading(false));
  }, [catList, currentCategories, setCatViewOpen]);

  function toggleCat(name: string) {
    setDraftSelected((prev) =>
      prev.includes(name) ? prev.filter((c) => c !== name) : [...prev, name]
    );
  }

  const allSelected = useMemo(
    () => !!catList && draftSelected.length === catList.length,
    [draftSelected, catList]
  );

  function selectAllOrNone() {
    if (!catList) return;
    if (allSelected) {
      setDraftSelected([]);
    } else {
      setDraftSelected(catList.map((c) => c.name));
    }
  }

  function handleApply() {
    if (draftSelected.length === 0) return;
    if (requireRestartConfirm) {
      setConfirmViewOpen(true);
      return;
    }
    onApplyCategories?.([...draftSelected]);
    close();
  }

  function handleConfirmYes() {
    onApplyCategories?.([...draftSelected]);
    close();
  }

  function handleConfirmCancel() {
    setConfirmViewOpen(false);
  }

  const isTopbar = variant === "topbar";
  const draftCount = draftSelected.length;
  const draftCountLabel = `${draftCount} ${draftCount === 1 ? "category" : "categories"}`;

  return (
    <div className={`game-options${isTopbar ? " game-options--topbar" : ""}`} ref={menuRef}>
      <button
        className={isTopbar ? "btn-top game-options-toggle" : "home-toolbar-btn game-options-toggle"}
        onClick={() => {
          if (open) {
            close();
          } else {
            setOpen(true);
          }
        }}
        aria-expanded={open}
        aria-haspopup="true"
      >
        {isTopbar ? "Options" : "Game Options"}
      </button>

      {open && (
        <div
          className={`game-options-dropdown${view !== "main" ? " game-options-dropdown--wide" : ""}${view === "confirm" ? " game-options-dropdown--confirm" : ""}`}
          role="menu"
        >
          {view === "main" && (
            <>
              <div className="game-options-header">
                <span className="game-options-header-title">Game Options</span>
                <button
                  type="button"
                  className="game-options-close"
                  onClick={close}
                  aria-label="Close Game Options"
                >
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.6"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <line x1="5" y1="5" x2="19" y2="19" />
                    <line x1="19" y1="5" x2="5" y2="19" />
                  </svg>
                </button>
              </div>

              {/* Rounds selector */}
              <div className="game-options-section game-options-section--rounds">
                <div className="game-options-section-head">
                  <span className="game-options-label">
                    <span className="game-options-label-dot game-options-label-dot--gold" />
                    Rounds
                  </span>
                  <span className="game-options-value">Best of {selectedRounds}</span>
                </div>
                <div className="game-options-rounds" role="radiogroup" aria-label="Number of rounds">
                  {ROUND_COUNT_OPTIONS.map((n) => (
                    <button
                      key={n}
                      role="radio"
                      aria-checked={selectedRounds === n}
                      className={`game-options-round-btn${selectedRounds === n ? " active" : ""}`}
                      onClick={() => onSelectRounds(n)}
                    >
                      {n}
                    </button>
                  ))}
                </div>
              </div>

              {/* Categories */}
              {onApplyCategories && (
                <div className="game-options-section game-options-section--categories">
                  <button
                    className="game-options-link-btn game-options-link-btn--categories"
                    onClick={enterCategories}
                    role="menuitem"
                  >
                    <span className="game-options-link-icon" aria-hidden="true">
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                        <rect x="3" y="3" width="7" height="7" rx="1.5" />
                        <rect x="14" y="3" width="7" height="7" rx="1.5" />
                        <rect x="3" y="14" width="7" height="7" rx="1.5" />
                        <rect x="14" y="14" width="7" height="7" rx="1.5" />
                      </svg>
                    </span>
                    <span className="game-options-link-label">
                      <span className="game-options-link-title">Categories</span>
                      <span className="game-options-link-sub">
                        {currentCategories && currentCategories.length > 0
                          ? `${currentCategories.length} selected`
                          : "All categories"}
                      </span>
                    </span>
                    <span className="game-options-link-chevron" aria-hidden="true">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="9 6 15 12 9 18" />
                      </svg>
                    </span>
                  </button>
                </div>
              )}

              {/* Currency */}
              <div className="game-options-section game-options-section--currency">
                <div className="game-options-link-btn game-options-link-btn--currency">
                  <span className="game-options-link-icon" aria-hidden="true">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="9" />
                      <path d="M15 8.5c-.8-1-2-1.5-3.2-1.4-1.7.1-2.8 1-2.8 2.2 0 1.3 1 2 3 2.4s3 1.1 3 2.4c0 1.3-1.2 2.3-3 2.3-1.3 0-2.5-.5-3.3-1.5" />
                      <line x1="12" y1="5" x2="12" y2="7" />
                      <line x1="12" y1="17" x2="12" y2="19" />
                    </svg>
                  </span>
                  <span className="game-options-link-label">
                    <span className="game-options-link-title">Currency</span>
                    <span className="game-options-link-sub">
                      Display prices in your money
                    </span>
                  </span>
                  <CurrencySelector />
                </div>
              </div>

              {/* Sound */}
              <div className="game-options-section game-options-section--sound">
                <div className="game-options-section-head">
                  <span className="game-options-label">
                    <span className="game-options-link-icon" aria-hidden="true">
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                        <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                        {!muted && <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />}
                        {!muted && <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />}
                        {muted && <line x1="23" y1="9" x2="17" y2="15" />}
                        {muted && <line x1="17" y1="9" x2="23" y2="15" />}
                      </svg>
                    </span>
                    Sound
                  </span>
                  <button
                    className={`sound-toggle-sm ${muted ? "" : "sound-toggle-sm--on"}`}
                    onClick={() => setMuted(!muted)}
                    aria-label={muted ? "Unmute sound effects" : "Mute sound effects"}
                    role="switch"
                    aria-checked={!muted}
                  >
                    {muted ? "Off" : "On"}
                  </button>
                </div>
                {!muted && (
                  <div className="game-options-volume">
                    <input
                      type="range"
                      min="0"
                      max="1"
                      step="0.05"
                      value={volume}
                      onChange={(e) => setVolume(parseFloat(e.target.value))}
                      className="game-options-volume-slider"
                      aria-label="Sound volume"
                    />
                    <span className="game-options-volume-value">{Math.round(volume * 100)}%</span>
                    <button
                      className="game-options-test-btn"
                      onClick={() => play("button_click")}
                      type="button"
                    >
                      Test
                    </button>
                  </div>
                )}
              </div>
            </>
          )}

          {view === "categories" && (
            <div className="game-options-cat">
              <div className="game-options-cat-head">
                <button
                  type="button"
                  className="game-options-cat-back"
                  onClick={() => setCatViewOpen(false)}
                  aria-label="Back to Game Options"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="15 6 9 12 15 18" />
                  </svg>
                </button>
                <span className="game-options-header-title">Categories</span>
                <button
                  type="button"
                  className="game-options-cat-all"
                  onClick={selectAllOrNone}
                  disabled={!catList}
                >
                  {allSelected ? "Deselect All" : "Select All"}
                </button>
              </div>

              {catLoading && (
                <div className="game-options-cat-loading">Loading categories…</div>
              )}

              {!catLoading && catError && (
                <div className="game-options-cat-error" role="alert">{catError}</div>
              )}

              {!catLoading && !catError && catList && (
                <div className="game-options-cat-grid">
                  {catList.map((cat) => {
                    const isSelected = draftSelected.includes(cat.name);
                    return (
                      <button
                        key={cat.name}
                        type="button"
                        className={`game-options-cat-chip${isSelected ? " game-options-cat-chip--active" : ""}`}
                        onClick={() => toggleCat(cat.name)}
                        aria-pressed={isSelected}
                      >
                        <span className="game-options-cat-chip-name">{cat.name}</span>
                        <span className="game-options-cat-chip-count">{cat.count}</span>
                      </button>
                    );
                  })}
                </div>
              )}

              <p className="game-options-cat-hint">
                {requireRestartConfirm
                  ? "Applying will start a new game with only these categories."
                  : "Your selection applies to your next game."}
              </p>

              <button
                type="button"
                className="game-options-apply-btn"
                onClick={handleApply}
                disabled={draftCount === 0 || catLoading || !!catError || !catList}
              >
                {requireRestartConfirm
                  ? `Apply and Start New Game (${draftCountLabel})`
                  : `Apply (${draftCountLabel})`}
              </button>
            </div>
          )}

          {view === "confirm" && (
            <div className="game-options-confirm">
              <div className="game-options-confirm-icon" aria-hidden="true">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 9v4" />
                  <path d="M12 17h.01" />
                  <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                </svg>
              </div>
              <h3 className="game-options-confirm-title">Start a new game?</h3>
              <p className="game-options-confirm-text">
                This will start a new game with only the{" "}
                <strong>{draftCountLabel}</strong> you have selected. Your
                existing progress will be lost.
              </p>
              <div className="game-options-confirm-actions">
                <button
                  type="button"
                  className="game-options-confirm-btn game-options-confirm-btn--cancel"
                  onClick={handleConfirmCancel}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="game-options-confirm-btn game-options-confirm-btn--ok"
                  onClick={handleConfirmYes}
                >
                  Yes, Restart
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
