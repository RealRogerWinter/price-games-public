import { Component, type ReactNode } from "react";
import type React from "react";

interface Props { children: ReactNode; }
interface State { hasError: boolean; error: Error | null; }

/**
 * Returns true if the error looks like a failed dynamic chunk import — the
 * typical symptom when a user's cached index.html references JS chunks that
 * were replaced by a new deployment.
 */
function isChunkLoadError(error: Error): boolean {
  const msg = error.message || "";
  return (
    msg.includes("Failed to fetch dynamically imported module") ||
    msg.includes("Loading chunk") ||
    msg.includes("Loading CSS chunk") ||
    error.name === "ChunkLoadError"
  );
}

/**
 * Top-level React error boundary.
 *
 * When a chunk-load failure is detected (stale deploy), it automatically
 * reloads the page once to pick up the new assets. For all other errors
 * it shows a friendly fallback with a manual reload button.
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("ErrorBoundary caught:", error, info.componentStack);

    // Auto-reload once for stale-chunk errors (deployment race).
    // Timestamp guard allows retries after 30s while preventing tight loops.
    if (isChunkLoadError(error)) {
      const key = "chunk-error-reload";
      const lastReload = Number(sessionStorage.getItem(key) || "0");
      if (Date.now() - lastReload > 30_000) {
        sessionStorage.setItem(key, String(Date.now()));
        window.location.reload();
        return;
      }
    }
  }

  render() {
    if (this.state.hasError) {
      const isChunk = this.state.error ? isChunkLoadError(this.state.error) : false;
      return (
        <div style={{ padding: "2rem", textAlign: "center" }}>
          <h2>Something went wrong</h2>
          <p>
            {isChunk
              ? "A new version of the site is available. Please reload to continue."
              : "An unexpected error occurred. Please try reloading."}
          </p>
          <button onClick={() => { this.setState({ hasError: false, error: null }); window.location.reload(); }}>
            Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
