import { useState, useMemo, useRef, useCallback, useEffect } from "react";
import { PROFILE_AVATARS, AVATAR_LABELS } from "@price-game/shared";
import type { Avatar } from "@price-game/shared";
import AvatarIcon from "./multiplayer/AvatarIcon";

interface AvatarPickerProps {
  selected: Avatar | null;
  onSelect: (avatar: Avatar) => void;
  loading?: boolean;
  error?: string | null;
  /** When provided, only these avatars are shown (plus the user's current selection if disabled). */
  enabledAvatars?: string[];
}

/** Number of avatars rendered per page. */
const PAGE_SIZE = 10;

/** Minimum horizontal distance (px) a touch must travel to count as a swipe. */
const SWIPE_THRESHOLD = 40;

/**
 * Card with a paginated grid of selectable avatar icons. Shows {@link PAGE_SIZE}
 * avatars per page with prev/next controls. All options appear greyed out
 * until selected; hover highlights. On first render, the picker opens on the
 * page containing the currently selected avatar so the user sees their current
 * choice highlighted without having to page over to it.
 *
 * @param selected - Currently selected avatar, or null.
 * @param onSelect - Callback when an avatar is clicked.
 * @param loading - Disables buttons while saving.
 * @param error - Error message to display below the grid.
 * @param enabledAvatars - When provided, filters the avatar list to only enabled ones.
 */
export default function AvatarPicker({ selected, onSelect, loading, error, enabledAvatars }: AvatarPickerProps) {
  // Build display list: enabled avatars only (if provided), keeping user's
  // current selection visible even if it's now disabled.
  const displayAvatars: readonly string[] = useMemo(() => {
    if (!enabledAvatars) return PROFILE_AVATARS;
    const enabledSet = new Set(enabledAvatars);
    const filtered = PROFILE_AVATARS.filter((a) => enabledSet.has(a));
    // If user's current avatar was disabled, prepend it so they see their selection
    if (selected && !enabledSet.has(selected) && (PROFILE_AVATARS as readonly string[]).includes(selected)) {
      return [selected, ...filtered];
    }
    return filtered;
  }, [enabledAvatars, selected]);

  const totalPages = Math.max(1, Math.ceil(displayAvatars.length / PAGE_SIZE));

  // Open on whichever page contains the currently selected avatar so users
  // land on their active pick rather than always on page 1.
  const [page, setPage] = useState(() => {
    if (!selected) return 0;
    const idx = displayAvatars.indexOf(selected);
    return idx >= 0 ? Math.floor(idx / PAGE_SIZE) : 0;
  });

  const start = page * PAGE_SIZE;
  const visible = displayAvatars.slice(start, start + PAGE_SIZE);

  // Slide animation state for page transitions
  const [animClass, setAnimClass] = useState("");
  const animTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clean up timeouts on unmount
  useEffect(() => () => { if (animTimeout.current) clearTimeout(animTimeout.current); }, []);

  const changePage = useCallback((direction: "next" | "prev") => {
    if (animClass) return; // already animating
    const canGo = direction === "next" ? page < totalPages - 1 : page > 0;
    if (!canGo) return;

    const exitClass = direction === "next" ? "avatar-slide-exit-left" : "avatar-slide-exit-right";
    const enterClass = direction === "next" ? "avatar-slide-enter-right" : "avatar-slide-enter-left";

    setAnimClass(exitClass);
    animTimeout.current = setTimeout(() => {
      setPage((p) => direction === "next" ? Math.min(totalPages - 1, p + 1) : Math.max(0, p - 1));
      setAnimClass(enterClass);
      animTimeout.current = setTimeout(() => setAnimClass(""), 200);
    }, 150);
  }, [animClass, page, totalPages]);

  const goPrev = useCallback(() => changePage("prev"), [changePage]);
  const goNext = useCallback(() => changePage("next"), [changePage]);

  // Swipe gesture tracking
  const touchStartX = useRef<number | null>(null);

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    touchStartX.current = e.touches[0].clientX;
  }, []);

  const handleTouchEnd = useCallback((e: React.TouchEvent) => {
    if (touchStartX.current === null) return;
    const dx = e.changedTouches[0].clientX - touchStartX.current;
    touchStartX.current = null;
    if (Math.abs(dx) < SWIPE_THRESHOLD) return;
    if (dx < 0) changePage("next");
    else changePage("prev");
  }, [changePage]);

  return (
    <div className="avatar-picker-card">
      <h3 className="avatar-picker-title">Choose Your Avatar</h3>
      <div
        className="avatar-picker-viewport"
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
      >
      <div
        className={`avatar-picker ${animClass}`}
        role="radiogroup"
        aria-label="Choose your avatar"
      >
        {visible.map((avatar) => {
          const isSelected = selected === avatar;
          const label = AVATAR_LABELS[avatar as Avatar] ?? avatar;
          return (
            <button
              key={avatar}
              className={`avatar-picker-option${isSelected ? " avatar-picker-selected" : ""}`}
              onClick={() => onSelect(avatar as Avatar)}
              disabled={loading}
              aria-label={`Select ${avatar} avatar`}
              aria-pressed={isSelected}
              type="button"
            >
              {isSelected && <span className="avatar-picker-check" aria-hidden="true" />}
              <AvatarIcon avatar={avatar as Avatar} size={72} />
              <span className="avatar-picker-label">{label}</span>
            </button>
          );
        })}
      </div>
      </div>
      {totalPages > 1 && (
        <div className="avatar-picker-pagination">
          <button
            type="button"
            className="avatar-picker-page-btn"
            onClick={goPrev}
            disabled={page === 0 || loading}
            aria-label="Previous avatar page"
          >
            &larr;
          </button>
          <span className="avatar-picker-page-label" aria-live="polite">
            Page {page + 1} of {totalPages}
          </span>
          <button
            type="button"
            className="avatar-picker-page-btn"
            onClick={goNext}
            disabled={page >= totalPages - 1 || loading}
            aria-label="Next avatar page"
          >
            &rarr;
          </button>
        </div>
      )}
      {error && <p className="avatar-picker-error">{error}</p>}
    </div>
  );
}
