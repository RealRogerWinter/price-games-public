/**
 * React Testing Library tests for the admin asset gallery page.
 *
 * Mocks the gallery API functions so we can drive the component through
 * representative states without any real network calls:
 *   - loading
 *   - fetched with assets across multiple categories
 *   - tab filtering
 *   - search filtering
 *   - pagination controls + auto-reset on filter change
 *   - detail modal open/close
 *   - upload modal double-submit guard and success banner
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";

vi.mock("../api/adminClient", () => ({
  fetchGalleryAssets: vi.fn(),
  updateGalleryAsset: vi.fn(),
  deleteGalleryAsset: vi.fn(),
  uploadGalleryAssets: vi.fn(),
  verifyAdminSessionDebounced: vi.fn(),
  galleryAssetImageUrl: (id: string) => `/api/admin/gallery/files/${id}`,
}));

import * as adminClient from "../api/adminClient";
import AdminAssetGalleryPage from "../pages/admin/AdminAssetGalleryPage";
import type { GalleryAsset } from "../api/adminClient";

const mockFetch = vi.mocked(adminClient.fetchGalleryAssets);
const mockUpdate = vi.mocked(adminClient.updateGalleryAsset);
const mockDelete = vi.mocked(adminClient.deleteGalleryAsset);
const mockUpload = vi.mocked(adminClient.uploadGalleryAssets);

function makeAsset(id: string, overrides: Partial<GalleryAsset> = {}): GalleryAsset {
  const filename = id.split("/").pop() || id;
  return {
    id,
    filename,
    title: filename.replace(/\.[^.]+$/, ""),
    category: id.includes("/") ? id.split("/")[0]! : "misc",
    tags: [],
    createdAt: "2026-01-01T00:00:00Z",
    sizeBytes: 1024,
    ...overrides,
  };
}

/** Build a fixture with N assets spread across two categories. */
function makeFixture(avatarCount: number, modeCount: number) {
  const assets: GalleryAsset[] = [];
  for (let i = 0; i < avatarCount; i++) {
    assets.push(makeAsset(`avatars/avatar-${String(i).padStart(3, "0")}.png`));
  }
  for (let i = 0; i < modeCount; i++) {
    assets.push(makeAsset(`modes/mode-${String(i).padStart(3, "0")}.png`));
  }
  return {
    assets,
    categories: ["avatars", "modes"],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── Loading / initial render ────────────────────────────────────────────

describe("AdminAssetGalleryPage — loading", () => {
  it("shows a loading message while the initial fetch is pending", () => {
    mockFetch.mockReturnValue(new Promise(() => { /* never resolves */ }));
    render(<AdminAssetGalleryPage />);
    expect(screen.getByText(/loading\.\.\./i)).toBeInTheDocument();
  });

  it("renders the fetched asset count after the list loads", async () => {
    mockFetch.mockResolvedValue(makeFixture(3, 2));
    render(<AdminAssetGalleryPage />);
    await waitFor(() => {
      expect(screen.getByTestId("admin-gallery-total")).toHaveTextContent(/5 assets/);
    });
    expect(screen.getByTestId("admin-gallery-total")).toHaveTextContent(/2 categories/);
  });

  it("surfaces a fetch error in the error banner", async () => {
    mockFetch.mockRejectedValue(new Error("boom"));
    render(<AdminAssetGalleryPage />);
    await waitFor(() => {
      expect(screen.getByTestId("admin-gallery-error")).toHaveTextContent(/boom/);
    });
  });
});

// ─── Category tabs + search filter ───────────────────────────────────────

describe("AdminAssetGalleryPage — filters", () => {
  it("switches the grid to a single category when a tab is clicked", async () => {
    mockFetch.mockResolvedValue(makeFixture(3, 5));
    render(<AdminAssetGalleryPage />);
    await waitFor(() => screen.getByTestId("admin-gallery-grid"));

    // All → 8 cards
    expect(screen.getAllByTestId(/^admin-gallery-card-/)).toHaveLength(8);

    fireEvent.click(screen.getByTestId("admin-gallery-tab-avatars"));
    expect(screen.getAllByTestId(/^admin-gallery-card-/)).toHaveLength(3);

    fireEvent.click(screen.getByTestId("admin-gallery-tab-modes"));
    expect(screen.getAllByTestId(/^admin-gallery-card-/)).toHaveLength(5);

    fireEvent.click(screen.getByTestId("admin-gallery-tab-all"));
    expect(screen.getAllByTestId(/^admin-gallery-card-/)).toHaveLength(8);
  });

  it("filters the grid when typing in the search box", async () => {
    mockFetch.mockResolvedValue(makeFixture(3, 3));
    render(<AdminAssetGalleryPage />);
    await waitFor(() => screen.getByTestId("admin-gallery-grid"));

    fireEvent.change(screen.getByTestId("admin-gallery-search"), {
      target: { value: "mode" },
    });
    expect(screen.getAllByTestId(/^admin-gallery-card-/)).toHaveLength(3);

    fireEvent.change(screen.getByTestId("admin-gallery-search"), {
      target: { value: "avatar-001" },
    });
    expect(screen.getAllByTestId(/^admin-gallery-card-/)).toHaveLength(1);
  });

  it("shows an empty state when no assets match the filters", async () => {
    mockFetch.mockResolvedValue(makeFixture(3, 3));
    render(<AdminAssetGalleryPage />);
    await waitFor(() => screen.getByTestId("admin-gallery-grid"));

    fireEvent.change(screen.getByTestId("admin-gallery-search"), {
      target: { value: "nonexistent-token-xyz" },
    });
    expect(screen.getByTestId("admin-gallery-empty")).toBeInTheDocument();
  });
});

// ─── Pagination ──────────────────────────────────────────────────────────

describe("AdminAssetGalleryPage — pagination", () => {
  it("only renders the current page's cards when the filtered list exceeds the page size", async () => {
    // 80 avatars > default page size of 60
    mockFetch.mockResolvedValue(makeFixture(80, 0));
    render(<AdminAssetGalleryPage />);
    await waitFor(() => screen.getByTestId("admin-gallery-grid"));
    expect(screen.getAllByTestId(/^admin-gallery-card-/)).toHaveLength(60);
    // Pagination bar shows "Showing 1-60 of 80"
    const bar = screen.getByTestId("admin-gallery-pagination");
    expect(bar).toHaveTextContent(/Showing.*1.*60.*of.*80/);
    expect(bar).toHaveTextContent(/Page\s*1\s*\/\s*2/);
  });

  it("advances to page 2 when Next is clicked", async () => {
    mockFetch.mockResolvedValue(makeFixture(80, 0));
    render(<AdminAssetGalleryPage />);
    await waitFor(() => screen.getByTestId("admin-gallery-grid"));

    fireEvent.click(screen.getByTestId("admin-gallery-page-next"));
    expect(screen.getAllByTestId(/^admin-gallery-card-/)).toHaveLength(20); // 80 - 60
    expect(screen.getByTestId("admin-gallery-pagination")).toHaveTextContent(/Page\s*2\s*\/\s*2/);
  });

  it("disables Prev on the first page and Next on the last page", async () => {
    mockFetch.mockResolvedValue(makeFixture(80, 0));
    render(<AdminAssetGalleryPage />);
    await waitFor(() => screen.getByTestId("admin-gallery-grid"));

    expect(screen.getByTestId("admin-gallery-page-prev")).toBeDisabled();
    expect(screen.getByTestId("admin-gallery-page-next")).not.toBeDisabled();
    fireEvent.click(screen.getByTestId("admin-gallery-page-next"));
    expect(screen.getByTestId("admin-gallery-page-prev")).not.toBeDisabled();
    expect(screen.getByTestId("admin-gallery-page-next")).toBeDisabled();
  });

  it("resets the page to 1 when a category tab is clicked", async () => {
    mockFetch.mockResolvedValue(makeFixture(80, 30));
    render(<AdminAssetGalleryPage />);
    await waitFor(() => screen.getByTestId("admin-gallery-grid"));

    // Jump to page 2, then switch categories.
    fireEvent.click(screen.getByTestId("admin-gallery-page-next"));
    expect(screen.getByTestId("admin-gallery-pagination")).toHaveTextContent(/Page\s*2/);
    fireEvent.click(screen.getByTestId("admin-gallery-tab-modes"));
    expect(screen.getByTestId("admin-gallery-pagination")).toHaveTextContent(/Page\s*1/);
  });

  it("changes page size when a new value is selected", async () => {
    mockFetch.mockResolvedValue(makeFixture(100, 0));
    render(<AdminAssetGalleryPage />);
    await waitFor(() => screen.getByTestId("admin-gallery-grid"));

    fireEvent.change(screen.getByTestId("admin-gallery-page-size"), { target: { value: "30" } });
    expect(screen.getAllByTestId(/^admin-gallery-card-/)).toHaveLength(30);
  });
});

// ─── Detail modal ────────────────────────────────────────────────────────

describe("AdminAssetGalleryPage — detail modal", () => {
  it("opens the detail modal when a card is clicked", async () => {
    mockFetch.mockResolvedValue(makeFixture(2, 2));
    render(<AdminAssetGalleryPage />);
    await waitFor(() => screen.getByTestId("admin-gallery-grid"));

    const firstCard = screen.getAllByTestId(/^admin-gallery-card-/)[0]!;
    fireEvent.click(firstCard);
    expect(screen.getByTestId("admin-gallery-detail-modal")).toBeInTheDocument();
  });

  it("closes the modal when ESC is pressed", async () => {
    mockFetch.mockResolvedValue(makeFixture(2, 2));
    render(<AdminAssetGalleryPage />);
    await waitFor(() => screen.getByTestId("admin-gallery-grid"));
    fireEvent.click(screen.getAllByTestId(/^admin-gallery-card-/)[0]!);
    expect(screen.getByTestId("admin-gallery-detail-modal")).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("admin-gallery-detail-modal")).not.toBeInTheDocument();
  });

  it("closes the modal when the × button is clicked", async () => {
    mockFetch.mockResolvedValue(makeFixture(2, 2));
    render(<AdminAssetGalleryPage />);
    await waitFor(() => screen.getByTestId("admin-gallery-grid"));
    fireEvent.click(screen.getAllByTestId(/^admin-gallery-card-/)[0]!);
    fireEvent.click(screen.getByTestId("admin-gallery-panel-close"));
    expect(screen.queryByTestId("admin-gallery-detail-modal")).not.toBeInTheDocument();
  });

  it("saves metadata updates via the PATCH client", async () => {
    mockFetch.mockResolvedValue(makeFixture(1, 0));
    mockUpdate.mockResolvedValue(
      makeAsset("avatars/avatar-000.png", { title: "Renamed" }),
    );
    render(<AdminAssetGalleryPage />);
    await waitFor(() => screen.getByTestId("admin-gallery-grid"));
    fireEvent.click(screen.getAllByTestId(/^admin-gallery-card-/)[0]!);

    const titleInput = screen.getByTestId("admin-gallery-panel-title") as HTMLInputElement;
    fireEvent.change(titleInput, { target: { value: "Renamed" } });
    fireEvent.click(screen.getByTestId("admin-gallery-panel-save"));

    await waitFor(() => expect(mockUpdate).toHaveBeenCalledTimes(1));
    expect(mockUpdate).toHaveBeenCalledWith(
      "avatars/avatar-000.png",
      expect.objectContaining({ title: "Renamed" }),
    );
  });

  it("deletes the asset via the DELETE client after confirmation", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    mockFetch.mockResolvedValue(makeFixture(1, 0));
    mockDelete.mockResolvedValue(undefined);

    render(<AdminAssetGalleryPage />);
    await waitFor(() => screen.getByTestId("admin-gallery-grid"));
    fireEvent.click(screen.getAllByTestId(/^admin-gallery-card-/)[0]!);
    fireEvent.click(screen.getByTestId("admin-gallery-panel-delete"));

    await waitFor(() => expect(mockDelete).toHaveBeenCalledWith("avatars/avatar-000.png"));
    expect(confirmSpy).toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it("does NOT delete when the user cancels the confirm dialog", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    mockFetch.mockResolvedValue(makeFixture(1, 0));

    render(<AdminAssetGalleryPage />);
    await waitFor(() => screen.getByTestId("admin-gallery-grid"));
    fireEvent.click(screen.getAllByTestId(/^admin-gallery-card-/)[0]!);
    fireEvent.click(screen.getByTestId("admin-gallery-panel-delete"));

    expect(mockDelete).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });
});

// ─── Upload modal ────────────────────────────────────────────────────────

describe("AdminAssetGalleryPage — upload modal", () => {
  it("opens the upload modal when the header Upload button is clicked", async () => {
    mockFetch.mockResolvedValue(makeFixture(2, 2));
    render(<AdminAssetGalleryPage />);
    await waitFor(() => screen.getByTestId("admin-gallery-grid"));

    fireEvent.click(screen.getByTestId("admin-gallery-upload-open"));
    expect(screen.getByTestId("admin-gallery-upload-modal")).toBeInTheDocument();
  });

  it("rejects submit when no files are selected", async () => {
    mockFetch.mockResolvedValue(makeFixture(1, 0));
    render(<AdminAssetGalleryPage />);
    await waitFor(() => screen.getByTestId("admin-gallery-grid"));

    fireEvent.click(screen.getByTestId("admin-gallery-upload-open"));
    // Provide a namespace so we isolate the file-required error
    fireEvent.change(screen.getByTestId("admin-gallery-upload-namespace"), {
      target: { value: "test-ns" },
    });
    fireEvent.click(screen.getByTestId("admin-gallery-upload-submit"));
    // The submit button is also disabled when files.length === 0, but
    // the guard message should still show if forced.
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it("keeps the modal open and shows a success banner after a successful upload", async () => {
    mockFetch.mockResolvedValue(makeFixture(1, 0));
    mockUpload.mockResolvedValue({
      assets: [makeAsset("uploads/new.png", { category: "uploads" })],
      failures: [],
    });

    render(<AdminAssetGalleryPage />);
    await waitFor(() => screen.getByTestId("admin-gallery-grid"));
    fireEvent.click(screen.getByTestId("admin-gallery-upload-open"));

    // Provide a fake file via the hidden file input.
    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "new.png", {
      type: "image/png",
    });
    const input = screen.getByTestId("admin-gallery-file-input") as HTMLInputElement;
    fireEvent.change(input, { target: { files: [file] } });

    fireEvent.change(screen.getByTestId("admin-gallery-upload-namespace"), {
      target: { value: "uploads" },
    });
    fireEvent.click(screen.getByTestId("admin-gallery-upload-submit"));

    await waitFor(() =>
      expect(screen.getByTestId("admin-gallery-upload-success")).toBeInTheDocument(),
    );
    // Modal is still open.
    expect(screen.getByTestId("admin-gallery-upload-modal")).toBeInTheDocument();
    // Uploaded file shows in the grid.
    expect(
      screen.getByTestId("admin-gallery-card-uploads/new.png"),
    ).toBeInTheDocument();
  });

  it("shows a server error in the upload modal without closing it", async () => {
    mockFetch.mockResolvedValue(makeFixture(1, 0));
    mockUpload.mockRejectedValue(new Error("server said no"));

    render(<AdminAssetGalleryPage />);
    await waitFor(() => screen.getByTestId("admin-gallery-grid"));
    fireEvent.click(screen.getByTestId("admin-gallery-upload-open"));

    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "new.png", {
      type: "image/png",
    });
    fireEvent.change(screen.getByTestId("admin-gallery-file-input"), {
      target: { files: [file] },
    });
    fireEvent.change(screen.getByTestId("admin-gallery-upload-namespace"), {
      target: { value: "uploads" },
    });
    fireEvent.click(screen.getByTestId("admin-gallery-upload-submit"));

    await waitFor(() => {
      const modal = screen.getByTestId("admin-gallery-upload-modal");
      expect(within(modal).getByText(/server said no/i)).toBeInTheDocument();
    });
    expect(screen.getByTestId("admin-gallery-upload-modal")).toBeInTheDocument();
  });
});
