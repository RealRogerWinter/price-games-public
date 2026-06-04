import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import {
  buildShortUrl,
  type AdminUtmTag,
} from "../../api/adminClient";
import { getPublicSiteOrigin } from "../../utils/publicSiteOrigin";

interface QrCodeModalProps {
  tag: AdminUtmTag;
  onClose: () => void;
}

/**
 * Build the long UTM URL for a tag on the client side. Mirrors the
 * server-side `buildTagUrl` helper — kept as a small local function to avoid
 * circular imports with AdminUtmTagsPage.
 */
function buildLongUrl(tag: AdminUtmTag, baseUrl: string): string {
  try {
    const url = new URL(tag.destinationUrl, baseUrl);
    const setIfPresent = (key: string, value: string | null | undefined) => {
      if (value && value.length > 0) url.searchParams.set(key, value);
    };
    setIfPresent("utm_source", tag.utmSource);
    setIfPresent("utm_medium", tag.utmMedium);
    setIfPresent("utm_campaign", tag.utmCampaign);
    setIfPresent("utm_content", tag.utmContent);
    setIfPresent("utm_term", tag.utmTerm);
    return url.toString();
  } catch {
    return tag.destinationUrl;
  }
}

/** Sanitize a tag name for use in a download filename. */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "qr-code";
}

/**
 * Modal that renders a QR code for a UTM tag's shareable URL.
 *
 * The QR prefers the short URL (`/go/:code`) when the tag has a short code
 * because it produces a lower-density QR — easier to scan from a distance.
 * Falls back to the long UTM URL when no short code is set.
 *
 * Provides PNG (from the canvas) and SVG (from `QRCode.toString`) download
 * buttons. The `qrcode` npm package is pure-JS and makes no network calls.
 *
 * @param tag - The UTM tag to encode.
 * @param onClose - Callback fired when the admin dismisses the modal.
 */
export default function QrCodeModal({ tag, onClose }: QrCodeModalProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Use the canonical public origin, NOT window.location.origin — admins
  // typically reach the panel via Tailscale, so window.location.origin
  // would encode a Tailscale hostname into QR codes that the public can't reach.
  const baseUrl = getPublicSiteOrigin();
  const url = buildShortUrl(tag, baseUrl) ?? buildLongUrl(tag, baseUrl);

  useEffect(() => {
    let cancelled = false;
    const canvas = canvasRef.current;
    if (!canvas) return;
    // Error-correction level M tolerates ~15% damage without scan failures —
    // the right default for printed/physical media without being overkill.
    QRCode.toCanvas(canvas, url, { errorCorrectionLevel: "M", margin: 2, width: 256 })
      .then(() => {
        if (!cancelled) setError(null);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to generate QR code");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [url]);

  function handleDownloadPng() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    try {
      const dataUrl = canvas.toDataURL("image/png");
      const anchor = document.createElement("a");
      anchor.href = dataUrl;
      anchor.download = `${slugify(tag.name)}-qr.png`;
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to download PNG");
    }
  }

  async function handleDownloadSvg() {
    try {
      const svg = await QRCode.toString(url, {
        type: "svg",
        errorCorrectionLevel: "M",
        margin: 2,
      });
      const blob = new Blob([svg], { type: "image/svg+xml" });
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = `${slugify(tag.name)}-qr.svg`;
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      URL.revokeObjectURL(objectUrl);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to download SVG");
    }
  }

  return (
    <div
      className="modal-overlay"
      data-testid="qr-modal-overlay"
      onClick={onClose}
    >
      <div
        className="modal-content qr-modal-content"
        data-testid="qr-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          className="modal-close"
          onClick={onClose}
          data-testid="qr-modal-close"
          aria-label="Close"
        >
          &times;
        </button>
        <header className="qr-modal-header">
          <h3 className="modal-title">QR code</h3>
          <p className="qr-modal-tag-name">{tag.name}</p>
        </header>

        <div className="qr-modal-canvas-wrap">
          <canvas ref={canvasRef} data-testid="qr-modal-canvas" />
        </div>

        <div className="qr-modal-url-chip" data-testid="qr-modal-url">
          <span className="qr-modal-url-label">Encodes</span>
          <code>{url}</code>
        </div>

        {error && (
          <p className="admin-error" data-testid="qr-modal-error">
            {error}
          </p>
        )}

        <div className="qr-modal-actions">
          <button
            type="button"
            className="admin-btn-primary qr-modal-download-btn"
            onClick={handleDownloadPng}
            data-testid="qr-modal-download-png"
          >
            Download PNG
          </button>
          <button
            type="button"
            className="admin-btn-primary qr-modal-download-btn qr-modal-download-btn-secondary"
            onClick={handleDownloadSvg}
            data-testid="qr-modal-download-svg"
          >
            Download SVG
          </button>
          <button
            type="button"
            className="admin-btn-cancel"
            onClick={onClose}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
