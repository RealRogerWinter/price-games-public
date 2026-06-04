import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import ErrorBoundary from "../components/ErrorBoundary";

function ThrowingComponent({ error }: { error: Error }) {
  throw error;
}

function SafeOrThrow({ shouldThrow, error }: { shouldThrow: boolean; error?: Error }) {
  if (shouldThrow) throw error ?? new Error("Test explosion");
  return <div>Normal content</div>;
}

describe("ErrorBoundary", () => {
  // Suppress expected console.error output from React's error boundary logging
  // Using vi.spyOn so restoreMocks handles cleanup automatically
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    sessionStorage.clear();
  });

  // Save and restore window.location so mocks don't leak across tests
  const originalLocation = window.location;
  afterEach(() => {
    Object.defineProperty(window, "location", {
      value: originalLocation,
      writable: true,
    });
  });

  it("renders children when no error", () => {
    render(
      <ErrorBoundary>
        <div>Everything is fine</div>
      </ErrorBoundary>
    );
    expect(screen.getByText("Everything is fine")).toBeInTheDocument();
  });

  it("renders fallback UI when a child throws", () => {
    render(
      <ErrorBoundary>
        <SafeOrThrow shouldThrow={true} />
      </ErrorBoundary>
    );
    expect(screen.getByText("Something went wrong")).toBeInTheDocument();
    expect(screen.getByText("An unexpected error occurred. Please try reloading.")).toBeInTheDocument();
  });

  it("shows a reload button in fallback", () => {
    render(
      <ErrorBoundary>
        <SafeOrThrow shouldThrow={true} />
      </ErrorBoundary>
    );
    expect(screen.getByRole("button", { name: "Reload" })).toBeInTheDocument();
  });

  it("logs error to console via componentDidCatch", () => {
    render(
      <ErrorBoundary>
        <SafeOrThrow shouldThrow={true} />
      </ErrorBoundary>
    );
    expect(console.error).toHaveBeenCalledWith(
      "ErrorBoundary caught:",
      expect.any(Error),
      expect.any(String)
    );
  });

  it("shows friendly message for chunk load errors", () => {
    const chunkError = new Error(
      "Failed to fetch dynamically imported module: https://price.games/assets/RiserPage-Bi2LOEnZ.js"
    );
    // Set a recent timestamp to prevent auto-reload from firing in the test
    sessionStorage.setItem("chunk-error-reload", String(Date.now()));

    render(
      <ErrorBoundary>
        <ThrowingComponent error={chunkError} />
      </ErrorBoundary>
    );
    expect(screen.getByText("Something went wrong")).toBeInTheDocument();
    expect(
      screen.getByText("A new version of the site is available. Please reload to continue.")
    ).toBeInTheDocument();
    // Should NOT show the raw error message
    expect(screen.queryByText(/Failed to fetch dynamically imported module/)).not.toBeInTheDocument();
  });

  it("auto-reloads once on chunk load error", () => {
    const reloadMock = vi.fn();
    Object.defineProperty(window, "location", {
      value: { ...window.location, reload: reloadMock },
      writable: true,
    });

    const chunkError = new Error(
      "Failed to fetch dynamically imported module: https://price.games/assets/Foo-abc123.js"
    );

    render(
      <ErrorBoundary>
        <ThrowingComponent error={chunkError} />
      </ErrorBoundary>
    );

    expect(sessionStorage.getItem("chunk-error-reload")).not.toBeNull();
    expect(reloadMock).toHaveBeenCalledOnce();
  });

  it("does not render raw error.message for non-chunk errors", () => {
    render(
      <ErrorBoundary>
        <SafeOrThrow shouldThrow={true} error={new Error("secret internal detail")} />
      </ErrorBoundary>
    );
    expect(screen.queryByText("secret internal detail")).not.toBeInTheDocument();
    expect(screen.getByText("An unexpected error occurred. Please try reloading.")).toBeInTheDocument();
  });
});
