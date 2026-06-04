import { useEffect, useMemo, useRef, useState } from "react";
import type { ShareGridInput, SharedRoundSnapshot } from "@price-game/shared";
import {
  buildShareText,
  buildShareAccessibleText,
  normalizeRoundScores,
  scoreToTier,
} from "@price-game/shared";
import { renderShareImage } from "./shareCanvas";
import {
  canCopyText,
  canCopyImage,
  canShareNative,
  copyTextToClipboard,
  copyImageToClipboard,
  shareNative,
} from "./clipboard";
import { createShare } from "../../api/client";
import { useCurrency } from "../../context/CurrencyContext";
import SharedRoundCard from "./SharedRoundCard";

interface ShareModalProps {
  /** The derived share grid input (usually from useShareData). */
  shareInput: ShareGridInput;
  /**
   * Optional per-round snapshots. When provided, the modal POSTs to
   * `/api/share` on mount to mint a short URL and uses it in the footer.
   * When absent, the modal behaves like Phase 1: footer stays `play at
   * price.games` and no server call happens.
   */
  roundSnapshots?: SharedRoundSnapshot[];
  /** Optional display name stored alongside the share record. Sanitized server-side. */
  playerName?: string | null;
  /** Called when the modal should close (overlay click, Escape, close button). */
  onClose: () => void;
}

type ActionStatus =
  | { kind: "idle" }
  | { kind: "pending"; message: string }
  | { kind: "success"; message: string }
  | { kind: "error"; message: string };

/**
 * Wordle-style share modal. Renders a text preview of the emoji grid, a PNG
 * preview of the branded share card, and feature-detected action buttons for
 * copying, sharing, and downloading the results.
 *
 * Closes on Escape, overlay click, and close-button click. Follows the same
 * overlay pattern as AuthModal.
 */
export default function ShareModal({
  shareInput,
  roundSnapshots,
  playerName,
  onClose,
}: ShareModalProps) {
  const { formatPrice } = useCurrency();
  const contentRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const [imageBlob, setImageBlob] = useState<Blob | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [imageError, setImageError] = useState<string | null>(null);
  const [status, setStatus] = useState<ActionStatus>({ kind: "idle" });
  /** Short URL minted by POST /api/share. null until the request resolves (or if it fails). */
  const [shareUrl, setShareUrl] = useState<string | null>(null);

  // Full absolute URL for clipboard / Web Share consumption.
  const absoluteShareUrl = useMemo(() => {
    if (!shareUrl) return null;
    if (typeof window === "undefined") return shareUrl;
    return `${window.location.origin}${shareUrl}`;
  }, [shareUrl]);

  // Footer options object passed to buildShareText / renderShareImage so both
  // re-render with the real short URL once the POST resolves. We prefer the
  // display-friendly host-relative form `price.games/s/<id>` over the full
  // https URL so the share text stays compact; the absolute URL is used
  // separately by the "Copy Share URL" button.
  const footerOptions = useMemo(() => {
    if (!shareUrl) return undefined;
    const host =
      typeof window !== "undefined" ? window.location.host : "price.games";
    return { shareUrl: `${host}${shareUrl}` };
  }, [shareUrl]);

  const shareText = buildShareText(shareInput, footerOptions);
  // Native-share variant of the text. Web Share API consumers (iMessage,
  // Discord, mail clients) typically concatenate `text` and `url` when both
  // are provided — if the URL also lives inside `text`, the recipient sees
  // the link twice. Strip the footer for the native flow so the URL only
  // travels via the dedicated `url` field, where the receiving app can also
  // build a rich link preview from the page's OG meta tags.
  const shareTextForNative = buildShareText(shareInput, {
    ...footerOptions,
    omitFooter: true,
  });
  const a11yText = buildShareAccessibleText(shareInput);

  // Derive per-round tiers from the share input so each SharedRoundCard
  // below renders with the right color/emoji band, mirroring the public
  // /s/:id view. Only used when roundSnapshots are provided.
  const roundTiers = useMemo(
    () =>
      normalizeRoundScores(shareInput.roundScores).map((s) =>
        scoreToTier(s, shareInput.perRoundMax),
      ),
    [shareInput.roundScores, shareInput.perRoundMax],
  );

  // Focus the close button on mount for keyboard users.
  useEffect(() => {
    closeButtonRef.current?.focus();
  }, []);

  // Close on Escape, and trap Tab/Shift-Tab focus inside the modal content so
  // keyboard users can't walk focus out to the inert background page. Wraps
  // from the last focusable descendant to the first (and vice-versa).
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (e.key !== "Tab" || !contentRef.current) return;
      const focusables = contentRef.current.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
      );
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey) {
        if (active === first || !contentRef.current.contains(active)) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (active === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  // Render the PNG share card once (and whenever the input or footer
  // changes). The object URL is revoked on cleanup to avoid leaks. When
  // shareUrl resolves after mount, this effect re-runs (via footerOptions
  // dependency) so the PNG shows the real short link.
  useEffect(() => {
    let cancelled = false;
    setImageError(null);
    setImageBlob(null);
    setImageUrl(null);
    renderShareImage(shareInput, footerOptions)
      .then((blob) => {
        if (cancelled) return;
        setImageBlob(blob);
        const url = URL.createObjectURL(blob);
        setImageUrl(url);
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setImageError(err.message);
      });
    return () => {
      cancelled = true;
      setImageUrl((current) => {
        if (current) URL.revokeObjectURL(current);
        return null;
      });
    };
  }, [shareInput, footerOptions]);

  // Mint a shareable URL by POSTing to /api/share. Runs once on mount when
  // the caller supplied roundSnapshots. On success, shareUrl resolves and
  // the text/canvas footers re-render. On failure (network, 4xx, 5xx, rate
  // limit), we silently fall back to Phase 1 behavior — no user-visible
  // error, no blocking.
  useEffect(() => {
    if (!roundSnapshots || roundSnapshots.length === 0) return;
    let cancelled = false;
    createShare({
      gameMode: shareInput.gameMode,
      totalScore: shareInput.totalScore,
      perRoundMax: shareInput.perRoundMax,
      playerName: playerName ?? null,
      roundData: roundSnapshots,
    })
      .then((r) => {
        if (!cancelled) setShareUrl(r.url);
      })
      .catch(() => {
        // Silent fallback — share text/image stay on the default footer.
      });
    return () => {
      cancelled = true;
    };
    // We intentionally don't depend on `playerName` — we only mint one URL
    // per modal open, and changes to playerName after mount shouldn't retrigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    roundSnapshots,
    shareInput.gameMode,
    shareInput.totalScore,
    shareInput.perRoundMax,
  ]);

  async function handleCopyText() {
    setStatus({ kind: "pending", message: "Copying text…" });
    try {
      await copyTextToClipboard(shareText);
      setStatus({ kind: "success", message: "Text copied!" });
    } catch (err) {
      setStatus({
        kind: "error",
        message: err instanceof Error ? err.message : "Failed to copy text",
      });
    }
  }

  async function handleCopyImage() {
    if (!imageBlob) return;
    setStatus({ kind: "pending", message: "Copying image…" });
    try {
      await copyImageToClipboard(imageBlob);
      setStatus({ kind: "success", message: "Image copied!" });
    } catch (err) {
      setStatus({
        kind: "error",
        message: err instanceof Error ? err.message : "Failed to copy image",
      });
    }
  }

  async function handleShareNative() {
    setStatus({ kind: "pending", message: "Opening share…" });
    try {
      // Skip the file attachment when we have a real share URL — attaching
      // the PNG defeats the link preview on iMessage/Discord (the file
      // displaces the URL embed). Falling back to files-only when there's
      // no shareUrl preserves the legacy behavior so the canvas image still
      // ships when /api/share fails or roundSnapshots weren't passed.
      const useUrl = absoluteShareUrl !== null;
      const files: File[] = [];
      if (!useUrl && imageBlob) {
        files.push(new File([imageBlob], "price-games.png", { type: "image/png" }));
      }
      await shareNative({
        title: "Price Games",
        text: useUrl ? shareTextForNative : shareText,
        url: useUrl ? absoluteShareUrl ?? undefined : undefined,
        files: files.length > 0 ? files : undefined,
      });
      setStatus({ kind: "success", message: "Shared!" });
    } catch (err) {
      setStatus({
        kind: "error",
        message: err instanceof Error ? err.message : "Failed to share",
      });
    }
  }

  function handleDownloadImage() {
    if (!imageUrl) return;
    const a = document.createElement("a");
    a.href = imageUrl;
    a.download = "price-games.png";
    document.body.appendChild(a);
    try {
      a.click();
      setStatus({ kind: "success", message: "Image downloaded!" });
    } finally {
      // Ensure the anchor never leaks, even if click() throws (some
      // ad-blockers / older browsers).
      document.body.removeChild(a);
    }
  }

  async function handleCopyShareUrl() {
    if (!absoluteShareUrl) return;
    setStatus({ kind: "pending", message: "Copying link…" });
    try {
      await copyTextToClipboard(absoluteShareUrl);
      setStatus({ kind: "success", message: "Link copied!" });
    } catch (err) {
      setStatus({
        kind: "error",
        message: err instanceof Error ? err.message : "Failed to copy link",
      });
    }
  }

  const showCopyText = canCopyText();
  const showCopyImage = canCopyImage() && imageBlob !== null;
  const showNativeShare = canShareNative();
  const showDownload = imageUrl !== null;
  const showCopyShareUrl = canCopyText() && absoluteShareUrl !== null;

  return (
    <div
      className="share-modal-overlay"
      onClick={onClose}
      data-testid="share-modal-overlay"
    >
      <div
        ref={contentRef}
        className="share-modal-content"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Share your results"
      >
        <button
          ref={closeButtonRef}
          className="share-modal-close"
          onClick={onClose}
          aria-label="Close"
        >
          &times;
        </button>

        <h2 className="share-modal-title">Share your results</h2>
        {roundSnapshots && roundSnapshots.length > 0 && (
          <p className="share-modal-caption">
            Share links are public — anyone with the URL can view your game.
          </p>
        )}

        <div className="share-modal-previews">
          <div className="share-modal-preview share-modal-text-preview">
            {showCopyText && (
              <button
                className="share-modal-text-copy"
                onClick={handleCopyText}
                type="button"
                aria-label="Copy share text"
                title="Copy share text"
              >
                {/* Inline SVG — no external asset, no CSP concern, scales cleanly. */}
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                </svg>
              </button>
            )}
            <pre aria-hidden="true">{shareText}</pre>
            <span className="sr-only">{a11yText}</span>
          </div>

          <div className="share-modal-preview share-modal-image-preview">
            {imageUrl ? (
              <img src={imageUrl} alt="Price Games share card" />
            ) : imageError ? (
              <p className="share-modal-error-text">
                Could not render share card: {imageError}
              </p>
            ) : (
              <p className="share-modal-loading">Rendering…</p>
            )}
          </div>
        </div>

        {roundSnapshots && roundSnapshots.length > 0 && (
          <div className="share-modal-rounds">
            <h3 className="share-modal-rounds-title">Round-by-round</h3>
            {roundSnapshots.map((snap, i) => (
              <SharedRoundCard
                key={i}
                snap={snap}
                tier={roundTiers[i] ?? "miss"}
                perRoundMax={shareInput.perRoundMax}
                formatPrice={formatPrice}
              />
            ))}
          </div>
        )}

        <div className="share-modal-actions">
          {showCopyText && (
            <button
              className="btn btn-primary share-modal-btn"
              onClick={handleCopyText}
              type="button"
            >
              Copy Text
            </button>
          )}
          {showCopyImage && (
            <button
              className="btn btn-secondary share-modal-btn"
              onClick={handleCopyImage}
              type="button"
            >
              Copy Image
            </button>
          )}
          {showNativeShare && (
            <button
              className="btn btn-secondary share-modal-btn"
              onClick={handleShareNative}
              type="button"
            >
              Share…
            </button>
          )}
          {showDownload && (
            <button
              className="btn btn-secondary share-modal-btn"
              onClick={handleDownloadImage}
              type="button"
            >
              Download Image
            </button>
          )}
          {showCopyShareUrl && (
            <button
              className="btn btn-secondary share-modal-btn"
              onClick={handleCopyShareUrl}
              type="button"
            >
              Copy Link
            </button>
          )}
        </div>

        {status.kind !== "idle" && (
          <p
            className={`share-modal-status share-modal-status-${status.kind}`}
            role="status"
            aria-live="polite"
          >
            {status.message}
          </p>
        )}
      </div>
    </div>
  );
}
