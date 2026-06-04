/**
 * Client-side diagnostics for product image load failures.
 *
 * iOS Safari is known to silently drop the `error` event on some image load
 * cancellations (when React mutates `src` on an in-flight image), and to evict
 * decoded bitmaps under memory pressure without re-decoding. Before we can
 * know which failure mode dominates for our users, we need to emit signals
 * from the client when an image fails to render.
 *
 * This module is intentionally cheap and dependency-light: it forwards events
 * to GA4 via `trackEvent` when available, and always logs a structured line
 * to the console so errors appear in Web Inspector / Sentry / other collectors.
 *
 * @module imageDiagnostics
 */
import { trackEvent } from "../utils/analytics";

interface ImageFailureInput {
  productId?: number;
  src?: string;
  phase: "error" | "placeholder" | "timeout";
  durationMs?: number;
}

function isIos(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  return /iPad|iPhone|iPod/.test(ua) || (ua.includes("Macintosh") && "ontouchend" in document);
}

/**
 * Report a product image failure. Fires a GA4 `image_load_fail` event (when
 * consent is granted and gtag is loaded) and logs a structured console line.
 *
 * @param input - Failure context (productId, src, phase, optional duration).
 */
export function reportImageFailure(input: ImageFailureInput): void {
  const payload = {
    product_id: input.productId ?? 0,
    phase: input.phase,
    duration_ms: input.durationMs ?? 0,
    is_ios: isIos(),
    visibility: typeof document !== "undefined" ? document.visibilityState : "unknown",
    src_host: safeHost(input.src),
  };

  try {
    trackEvent("image_load_fail", payload);
  } catch {
    // GA may be absent in tests; swallow.
  }

  // Keep a console trail regardless of analytics consent so the signal is
  // visible in Web Inspector during manual iOS Safari repro sessions.
  // eslint-disable-next-line no-console
  console.warn("[image-diagnostics]", payload);
}

function safeHost(src: string | undefined): string {
  if (!src) return "";
  try {
    return new URL(src, typeof location !== "undefined" ? location.origin : "http://localhost").host;
  } catch {
    return "invalid";
  }
}
