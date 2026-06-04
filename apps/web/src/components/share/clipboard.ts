/**
 * Thin, feature-detecting wrappers around the Clipboard and Web Share APIs.
 * Keeping these in one file makes it easy to (a) stub in tests, and (b) hide
 * share-related UI buttons when the platform can't support them.
 *
 * All detection checks are defensive: we check for `navigator` itself before
 * touching it so the module can be imported in non-browser environments
 * (SSR, tests) without throwing.
 */

/** @returns true when `navigator.clipboard.writeText` is available. */
export function canCopyText(): boolean {
  return (
    typeof navigator !== "undefined" &&
    typeof navigator.clipboard !== "undefined" &&
    typeof navigator.clipboard.writeText === "function"
  );
}

/**
 * @returns true when both `navigator.clipboard.write` AND the `ClipboardItem`
 *          constructor are available. Firefox ships `write` but not image
 *          support for ClipboardItem, so callers should still handle rejection.
 */
export function canCopyImage(): boolean {
  return (
    typeof navigator !== "undefined" &&
    typeof navigator.clipboard !== "undefined" &&
    typeof navigator.clipboard.write === "function" &&
    typeof globalThis.ClipboardItem !== "undefined"
  );
}

/** @returns true when `navigator.share` is available (usually mobile browsers). */
export function canShareNative(): boolean {
  return typeof navigator !== "undefined" && typeof navigator.share === "function";
}

/**
 * Copy plain text to the system clipboard.
 *
 * @param text - The text to copy
 * @returns Promise that resolves once the copy succeeds
 * @throws Error if the Clipboard API is not available or the browser rejects the write
 */
export async function copyTextToClipboard(text: string): Promise<void> {
  if (!canCopyText()) {
    throw new Error("Clipboard text API is not available in this environment");
  }
  await navigator.clipboard.writeText(text);
}

/**
 * Copy an image blob (typically PNG) to the system clipboard as a ClipboardItem.
 *
 * @param blob - The image blob
 * @returns Promise that resolves once the copy succeeds
 * @throws Error if the Clipboard image API is not available or the browser rejects the write
 */
export async function copyImageToClipboard(blob: Blob): Promise<void> {
  if (!canCopyImage()) {
    throw new Error("Clipboard image API is not available in this environment");
  }
  const item = new ClipboardItem({ [blob.type]: blob });
  await navigator.clipboard.write([item]);
}

/** Data passed to the native Web Share API. Matches the subset we actually use. */
export interface ShareNativeData {
  title?: string;
  text?: string;
  url?: string;
  files?: File[];
}

/**
 * Invoke the browser's native share sheet (Web Share API) with the given payload.
 * On platforms without Web Share, throws so callers can fall back to clipboard.
 * User-cancellation ("AbortError") is swallowed silently — cancelling a share
 * sheet is a normal flow, not an error.
 *
 * @param data - The share payload
 * @returns Promise that resolves once the user completes or dismisses the share
 * @throws Error if the Web Share API is not available or the browser rejects for non-abort reasons
 */
export async function shareNative(data: ShareNativeData): Promise<void> {
  if (!canShareNative()) {
    throw new Error("Web Share API is not available in this environment");
  }
  try {
    await navigator.share(data);
  } catch (err) {
    // User dismissed the share sheet — treat as success.
    if (err instanceof DOMException && err.name === "AbortError") return;
    // Some browsers throw a plain Error with "AbortError" as the name/message.
    if (err && typeof err === "object" && (err as { name?: string }).name === "AbortError") return;
    throw err;
  }
}
