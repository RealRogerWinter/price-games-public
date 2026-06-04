/**
 * Tests for AdminUtmTagsPage — list, create, edit, archive, delete,
 * status filter, copy-link, and error/success handling.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { AdminUtmTag, AdminUtmTagListResponse } from "../api/adminClient";

vi.mock("../api/adminClient", async () => {
  // Keep the real buildShortUrl helper — it's a pure function that the page
  // imports and mocking it would mean reimplementing the same logic.
  const actual = await vi.importActual<typeof import("../api/adminClient")>(
    "../api/adminClient",
  );
  return {
    ...actual,
    listUtmTags: vi.fn(),
    createUtmTag: vi.fn(),
    updateUtmTag: vi.fn(),
    setUtmTagStatus: vi.fn(),
    deleteUtmTag: vi.fn(),
    suggestShortCode: vi.fn(),
    getUtmTagComparison: vi.fn(),
  };
});

// Stub QrCodeModal so AdminUtmTagsPage tests don't pull in the qrcode package.
vi.mock("../pages/admin/QrCodeModal", () => ({
  default: ({ tag, onClose }: { tag: { id: string }; onClose: () => void }) => (
    <div data-testid="qr-modal-stub" data-tag-id={tag.id}>
      <button onClick={onClose}>stub-close</button>
    </div>
  ),
}));

import * as adminClient from "../api/adminClient";
import AdminUtmTagsPage from "../pages/admin/AdminUtmTagsPage";

const mockList = vi.mocked(adminClient.listUtmTags);
const mockCreate = vi.mocked(adminClient.createUtmTag);
const mockUpdate = vi.mocked(adminClient.updateUtmTag);
const mockSetStatus = vi.mocked(adminClient.setUtmTagStatus);
const mockDelete = vi.mocked(adminClient.deleteUtmTag);
const mockSuggest = vi.mocked(adminClient.suggestShortCode);
const mockComparison = vi.mocked(adminClient.getUtmTagComparison);

const mockNavigate = vi.fn();
vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual("react-router-dom");
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

function makeTag(overrides: Partial<AdminUtmTag> = {}): AdminUtmTag {
  return {
    id: "t-1",
    name: "reddit-gw-v1",
    utmSource: "reddit",
    utmMedium: "cpc",
    utmCampaign: "giveaway_v1",
    utmContent: null,
    utmTerm: null,
    destinationUrl: "/giveaway",
    status: "active",
    createdAt: "2026-04-01T00:00:00Z",
    updatedAt: "2026-04-01T00:00:00Z",
    createdBy: "admin-1",
    shortCode: null,
    clickCount: 0,
    lastClickedAt: null,
    ...overrides,
  };
}

function makeList(tags: AdminUtmTag[]): AdminUtmTagListResponse {
  return {
    tags,
    total: tags.length,
    page: 1,
    pageSize: 25,
    totalPages: Math.max(1, Math.ceil(tags.length / 25)),
  };
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/admin/utm-tags"]}>
      <AdminUtmTagsPage />
    </MemoryRouter>,
  );
}

function emptyComparison() {
  return {
    rows: [],
    summary: {
      totalClicksLifetime: 0,
      totalSessions: 0,
      totalSignups: 0,
      totalAnonymousPlays: 0,
      globalConversionRate: 0,
      globalConversionCi: { point: null, lo: 0, hi: 1, halfWidth: 0.5 },
      rangeDays: 28,
      activeTagCount: 0,
    },
  };
}

describe("AdminUtmTagsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: resolve every mock with reasonable values.
    mockList.mockResolvedValue(makeList([]));
    mockCreate.mockResolvedValue(makeTag());
    mockUpdate.mockResolvedValue(makeTag());
    mockSetStatus.mockResolvedValue(makeTag());
    mockDelete.mockResolvedValue({ ok: true });
    mockSuggest.mockResolvedValue({ code: "gen-abc" });
    mockComparison.mockResolvedValue(emptyComparison());
  });

  it("shows loading state initially, then the empty state", async () => {
    renderPage();
    expect(screen.getByTestId("utm-tags-loading")).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByTestId("utm-tags-empty")).toBeInTheDocument();
    });
    expect(mockList).toHaveBeenCalledWith(
      expect.objectContaining({ status: "active" }),
    );
  });

  it("renders tag rows when tags exist", async () => {
    mockList.mockResolvedValue(makeList([makeTag(), makeTag({ id: "t-2", name: "twitter-v1" })]));
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId("utm-tags-table")).toBeInTheDocument();
    });
    expect(screen.getByText("reddit-gw-v1")).toBeInTheDocument();
    expect(screen.getByText("twitter-v1")).toBeInTheDocument();
  });

  it("shows the generated URL preview for each tag", async () => {
    mockList.mockResolvedValue(makeList([makeTag()]));
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId("utm-tag-url-t-1")).toBeInTheDocument();
    });
    const urlCell = screen.getByTestId("utm-tag-url-t-1");
    const text = urlCell.textContent || "";
    // Should contain both the path and the UTM params.
    expect(text).toContain("/giveaway");
    expect(text).toContain("utm_source=reddit");
    expect(text).toContain("utm_medium=cpc");
    expect(text).toContain("utm_campaign=giveaway_v1");
  });

  it("copies the generated URL to the clipboard when the copy button is clicked", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(globalThis, "navigator", {
      value: { clipboard: { writeText } },
      configurable: true,
    });

    mockList.mockResolvedValue(makeList([makeTag()]));
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId("utm-tag-copy-t-1")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("utm-tag-copy-t-1"));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalled();
    });
    const copied = writeText.mock.calls[0][0] as string;
    expect(copied).toContain("/giveaway");
    expect(copied).toContain("utm_source=reddit");
  });

  it("opens the create modal when Add button is clicked", async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId("utm-tags-add-button")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("utm-tags-add-button"));
    expect(screen.getByTestId("utm-tag-create-modal")).toBeInTheDocument();
  });

  it("creates a tag when the create form is submitted", async () => {
    renderPage();
    await waitFor(() => screen.getByTestId("utm-tags-add-button"));
    fireEvent.click(screen.getByTestId("utm-tags-add-button"));

    fireEvent.change(screen.getByTestId("utm-tag-form-name"), {
      target: { value: "new-tag" },
    });
    fireEvent.change(screen.getByTestId("utm-tag-form-source"), {
      target: { value: "reddit" },
    });
    fireEvent.change(screen.getByTestId("utm-tag-form-medium"), {
      target: { value: "cpc" },
    });
    fireEvent.change(screen.getByTestId("utm-tag-form-campaign"), {
      target: { value: "launch" },
    });
    fireEvent.change(screen.getByTestId("utm-tag-form-destination"), {
      target: { value: "/giveaway" },
    });

    fireEvent.submit(screen.getByTestId("utm-tag-form"));

    await waitFor(() => {
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "new-tag",
          utmSource: "reddit",
          utmMedium: "cpc",
          utmCampaign: "launch",
          destinationUrl: "/giveaway",
        }),
      );
    });
    // List is refetched.
    expect(mockList).toHaveBeenCalledTimes(2);
  });

  it("displays the server error message when creation fails", async () => {
    mockCreate.mockRejectedValueOnce(new Error("A UTM tag with this name already exists"));
    renderPage();
    await waitFor(() => screen.getByTestId("utm-tags-add-button"));
    fireEvent.click(screen.getByTestId("utm-tags-add-button"));
    fireEvent.change(screen.getByTestId("utm-tag-form-name"), { target: { value: "dupe" } });
    fireEvent.change(screen.getByTestId("utm-tag-form-source"), { target: { value: "reddit" } });
    fireEvent.change(screen.getByTestId("utm-tag-form-destination"), {
      target: { value: "/giveaway" },
    });
    fireEvent.submit(screen.getByTestId("utm-tag-form"));

    await waitFor(() => {
      expect(screen.getByTestId("utm-tags-error")).toHaveTextContent(
        "A UTM tag with this name already exists",
      );
    });
  });

  it("opens the edit modal prefilled with existing values", async () => {
    mockList.mockResolvedValue(makeList([makeTag()]));
    renderPage();
    await waitFor(() => screen.getByTestId("utm-tag-edit-t-1"));
    fireEvent.click(screen.getByTestId("utm-tag-edit-t-1"));
    expect(screen.getByTestId("utm-tag-edit-modal")).toBeInTheDocument();
    expect((screen.getByTestId("utm-tag-form-name") as HTMLInputElement).value).toBe(
      "reddit-gw-v1",
    );
    expect((screen.getByTestId("utm-tag-form-source") as HTMLInputElement).value).toBe("reddit");
  });

  it("submits an edit and refreshes the list", async () => {
    mockList.mockResolvedValue(makeList([makeTag()]));
    renderPage();
    await waitFor(() => screen.getByTestId("utm-tag-edit-t-1"));
    fireEvent.click(screen.getByTestId("utm-tag-edit-t-1"));
    fireEvent.change(screen.getByTestId("utm-tag-form-name"), {
      target: { value: "renamed" },
    });
    fireEvent.submit(screen.getByTestId("utm-tag-form"));

    await waitFor(() => {
      expect(mockUpdate).toHaveBeenCalledWith(
        "t-1",
        expect.objectContaining({ name: "renamed" }),
      );
    });
  });

  it("archives an active tag when the archive button is clicked", async () => {
    mockList.mockResolvedValue(makeList([makeTag()]));
    renderPage();
    await waitFor(() => screen.getByTestId("utm-tag-archive-t-1"));
    fireEvent.click(screen.getByTestId("utm-tag-archive-t-1"));
    await waitFor(() => {
      expect(mockSetStatus).toHaveBeenCalledWith("t-1", "archived");
    });
  });

  it("unarchives an archived tag when the unarchive button is clicked", async () => {
    mockList.mockResolvedValue(makeList([makeTag({ status: "archived" })]));
    renderPage();
    // Switch filter to show archived tags first.
    await waitFor(() => screen.getByTestId("utm-tags-status-filter"));
    fireEvent.change(screen.getByTestId("utm-tags-status-filter"), {
      target: { value: "archived" },
    });
    await waitFor(() => screen.getByTestId("utm-tag-archive-t-1"));
    fireEvent.click(screen.getByTestId("utm-tag-archive-t-1"));
    await waitFor(() => {
      expect(mockSetStatus).toHaveBeenCalledWith("t-1", "active");
    });
  });

  it("deletes a tag after confirmation", async () => {
    const confirmSpy = vi.spyOn(globalThis, "confirm").mockReturnValue(true);
    mockList.mockResolvedValue(makeList([makeTag()]));
    renderPage();
    await waitFor(() => screen.getByTestId("utm-tag-delete-t-1"));
    fireEvent.click(screen.getByTestId("utm-tag-delete-t-1"));
    await waitFor(() => {
      expect(mockDelete).toHaveBeenCalledWith("t-1");
    });
    confirmSpy.mockRestore();
  });

  it("does not delete when the user cancels the confirmation", async () => {
    const confirmSpy = vi.spyOn(globalThis, "confirm").mockReturnValue(false);
    mockList.mockResolvedValue(makeList([makeTag()]));
    renderPage();
    await waitFor(() => screen.getByTestId("utm-tag-delete-t-1"));
    fireEvent.click(screen.getByTestId("utm-tag-delete-t-1"));
    expect(mockDelete).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it("shows the server error when delete returns 409", async () => {
    const confirmSpy = vi.spyOn(globalThis, "confirm").mockReturnValue(true);
    mockList.mockResolvedValue(makeList([makeTag()]));
    mockDelete.mockRejectedValueOnce(
      new Error("Cannot delete UTM tag with matched signups"),
    );
    renderPage();
    await waitFor(() => screen.getByTestId("utm-tag-delete-t-1"));
    fireEvent.click(screen.getByTestId("utm-tag-delete-t-1"));
    await waitFor(() => {
      expect(screen.getByTestId("utm-tags-error")).toHaveTextContent(
        "Cannot delete UTM tag with matched signups",
      );
    });
    confirmSpy.mockRestore();
  });

  it("changes status filter and refetches", async () => {
    renderPage();
    await waitFor(() => screen.getByTestId("utm-tags-status-filter"));
    fireEvent.change(screen.getByTestId("utm-tags-status-filter"), {
      target: { value: "archived" },
    });
    await waitFor(() => {
      expect(mockList).toHaveBeenLastCalledWith(
        expect.objectContaining({ status: "archived" }),
      );
    });
  });

  it("navigates to the detail page when 'View results' is clicked", async () => {
    mockList.mockResolvedValue(makeList([makeTag()]));
    renderPage();
    await waitFor(() => screen.getByTestId("utm-tag-view-t-1"));
    fireEvent.click(screen.getByTestId("utm-tag-view-t-1"));
    expect(mockNavigate).toHaveBeenCalledWith("/admin/utm-tags/t-1");
  });

  it("shows the server error banner on load failure", async () => {
    mockList.mockRejectedValueOnce(new Error("Service down"));
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId("utm-tags-error")).toHaveTextContent("Service down");
    });
  });

  // ── Short-code support (feat/admin-utm-short-links) ─────────────────────

  it("renders a short code input in the create modal", async () => {
    renderPage();
    await waitFor(() => screen.getByTestId("utm-tags-add-button"));
    fireEvent.click(screen.getByTestId("utm-tags-add-button"));
    expect(screen.getByTestId("utm-tag-form-short-code")).toBeInTheDocument();
    expect(screen.getByTestId("utm-tag-form-short-code-generate")).toBeInTheDocument();
  });

  it("populates the short code input when Generate is clicked", async () => {
    renderPage();
    await waitFor(() => screen.getByTestId("utm-tags-add-button"));
    fireEvent.click(screen.getByTestId("utm-tags-add-button"));
    fireEvent.click(screen.getByTestId("utm-tag-form-short-code-generate"));
    await waitFor(() => {
      expect(
        (screen.getByTestId("utm-tag-form-short-code") as HTMLInputElement).value,
      ).toBe("gen-abc");
    });
    expect(mockSuggest).toHaveBeenCalled();
  });

  it("sends shortCode in the create payload when present", async () => {
    renderPage();
    await waitFor(() => screen.getByTestId("utm-tags-add-button"));
    fireEvent.click(screen.getByTestId("utm-tags-add-button"));
    fireEvent.change(screen.getByTestId("utm-tag-form-name"), {
      target: { value: "sc-tag" },
    });
    fireEvent.change(screen.getByTestId("utm-tag-form-source"), {
      target: { value: "reddit" },
    });
    fireEvent.change(screen.getByTestId("utm-tag-form-destination"), {
      target: { value: "/giveaway" },
    });
    fireEvent.change(screen.getByTestId("utm-tag-form-short-code"), {
      target: { value: "reddit-gw-1" },
    });
    fireEvent.submit(screen.getByTestId("utm-tag-form"));
    await waitFor(() => {
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({ shortCode: "reddit-gw-1" }),
      );
    });
  });

  it("sends shortCode: null when the edit form clears the code", async () => {
    mockList.mockResolvedValue(
      makeList([makeTag({ shortCode: "clear-me" })]),
    );
    renderPage();
    await waitFor(() => screen.getByTestId("utm-tag-edit-t-1"));
    fireEvent.click(screen.getByTestId("utm-tag-edit-t-1"));
    fireEvent.change(screen.getByTestId("utm-tag-form-short-code"), {
      target: { value: "" },
    });
    fireEvent.submit(screen.getByTestId("utm-tag-form"));
    await waitFor(() => {
      expect(mockUpdate).toHaveBeenCalledWith(
        "t-1",
        expect.objectContaining({ shortCode: null }),
      );
    });
  });

  it("renders the Short URL column (— when null)", async () => {
    mockList.mockResolvedValue(
      makeList([
        makeTag({ id: "t-1", shortCode: null }),
        makeTag({ id: "t-2", name: "with-code", shortCode: "has-it" }),
      ]),
    );
    renderPage();
    await waitFor(() => screen.getByTestId("utm-tag-short-url-t-1"));
    expect(screen.getByTestId("utm-tag-short-url-t-1")).toHaveTextContent("—");
    expect(screen.getByTestId("utm-tag-short-url-t-2")).toHaveTextContent("/go/has-it");
  });

  it("Copy button copies the short URL when the tag has a short code", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(globalThis, "navigator", {
      value: { clipboard: { writeText } },
      configurable: true,
    });
    mockList.mockResolvedValue(makeList([makeTag({ shortCode: "has-it" })]));
    renderPage();
    await waitFor(() => screen.getByTestId("utm-tag-copy-t-1"));
    fireEvent.click(screen.getByTestId("utm-tag-copy-t-1"));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    const copied = writeText.mock.calls[0][0] as string;
    expect(copied).toContain("/go/has-it");
    // Should NOT be the long UTM URL when short code is present.
    expect(copied).not.toContain("utm_source=");
  });

  it("Copy button copies the long URL when the tag has no short code", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(globalThis, "navigator", {
      value: { clipboard: { writeText } },
      configurable: true,
    });
    mockList.mockResolvedValue(makeList([makeTag({ shortCode: null })]));
    renderPage();
    await waitFor(() => screen.getByTestId("utm-tag-copy-t-1"));
    fireEvent.click(screen.getByTestId("utm-tag-copy-t-1"));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    const copied = writeText.mock.calls[0][0] as string;
    expect(copied).toContain("utm_source=reddit");
  });

  it("opens the QR modal when the QR button is clicked", async () => {
    mockList.mockResolvedValue(makeList([makeTag({ shortCode: "qr-code" })]));
    renderPage();
    await waitFor(() => screen.getByTestId("utm-tag-qr-t-1"));
    fireEvent.click(screen.getByTestId("utm-tag-qr-t-1"));
    expect(screen.getByTestId("qr-modal-stub")).toBeInTheDocument();
  });

  // ── Dashboard upgrade: KPI strip, leaderboard chart, stat-rigor flags ──

  it("renders the KPI strip with summary numbers from the comparison API", async () => {
    mockComparison.mockResolvedValue({
      rows: [],
      summary: {
        totalClicksLifetime: 1234,
        totalSessions: 5678,
        totalSignups: 90,
        totalAnonymousPlays: 12,
        globalConversionRate: 0.0159,
        globalConversionCi: { point: 0.0159, lo: 0.013, hi: 0.019, halfWidth: 0.003 },
        rangeDays: 28,
        activeTagCount: 4,
      },
    });
    renderPage();
    // The KPI strip renders immediately with "—" placeholders while the
    // comparison query is in flight; assert on the resolved values inside
    // waitFor to avoid racing the React Query resolution.
    await waitFor(() => {
      const strip = screen.getByTestId("utm-summary-strip");
      expect(strip).toHaveTextContent("1,234"); // clicks lifetime
    });
    const strip = screen.getByTestId("utm-summary-strip");
    expect(strip).toHaveTextContent("5,678"); // sessions
    expect(strip).toHaveTextContent("90"); // signups
    expect(strip).toHaveTextContent("1.59%"); // CR
  });

  it("renders the hero leaderboard chart when comparison data has rows", async () => {
    mockComparison.mockResolvedValue({
      rows: [
        {
          tagId: "t-99",
          name: "reddit-launch",
          utmSource: "reddit",
          utmMedium: "cpc",
          utmCampaign: "launch",
          utmContent: null,
          utmTerm: null,
          status: "active",
          originKey: null,
          hasShortCode: true,
          clicksLifetime: 50,
          sessions: 100,
          signups: 7,
          anonymousPlays: 0,
          conversionRate: 0.07,
          ciLow: 0.034,
          ciHigh: 0.139,
          isLowSample: false,
          isSignificantlyAboveAverage: false,
          isSignificantlyBelowAverage: false,
          sparkline: [0, 1, 2, 1, 2, 0, 1],
        },
      ],
      summary: {
        totalClicksLifetime: 50,
        totalSessions: 100,
        totalSignups: 7,
        totalAnonymousPlays: 0,
        globalConversionRate: 0.07,
        globalConversionCi: { point: 0.07, lo: 0.034, hi: 0.139, halfWidth: 0.05 },
        rangeDays: 28,
        activeTagCount: 1,
      },
    });
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId("utm-leaderboard-chart")).toBeInTheDocument();
    });
  });

  it("renders the empty 'No traffic' fallback (not zero-width bars) when every tag has 0 sessions in the window", async () => {
    // Regression: pre-fix, the chart still rendered when comparison rows
    // existed but every row had sessions=0 — recharts then drew zero-width
    // bars under the YAxis labels and the section read as broken. The
    // chart now filters out zero-session rows up front, so this scenario
    // routes to the "No traffic for active tags" fallback message
    // covered by the same conditional path as the truly-empty case.
    mockList.mockResolvedValue(makeList([makeTag({ id: "t-q", name: "quiet" })]));
    mockComparison.mockResolvedValue({
      rows: [
        {
          tagId: "t-q",
          name: "quiet",
          utmSource: "reddit",
          utmMedium: "cpc",
          utmCampaign: "launch",
          utmContent: null,
          utmTerm: null,
          status: "active",
          originKey: null,
          hasShortCode: false,
          clicksLifetime: 0,
          sessions: 0,
          signups: 0,
          anonymousPlays: 0,
          conversionRate: 0,
          ciLow: 0,
          ciHigh: 1,
          isLowSample: false,
          isSignificantlyAboveAverage: false,
          isSignificantlyBelowAverage: false,
          sparkline: [0, 0, 0, 0, 0, 0, 0],
        },
      ],
      summary: {
        totalClicksLifetime: 0,
        totalSessions: 0,
        totalSignups: 0,
        totalAnonymousPlays: 0,
        globalConversionRate: 0,
        globalConversionCi: { point: null, lo: 0, hi: 1, halfWidth: 0.5 },
        rangeDays: 28,
        activeTagCount: 1,
      },
    });
    renderPage();
    // The chart card (utm-leaderboard-chart testid) renders immediately in
    // a "Loading leaderboard…" state while the comparison query is in
    // flight, so asserting on the testid alone races against query
    // resolution. Wait for the resolved fallback text instead.
    await waitFor(() => {
      const chart = screen.getByTestId("utm-leaderboard-chart");
      expect(chart.textContent).toMatch(/No traffic for active tags/i);
    });
    // The actual recharts wrapper should NOT mount when every row is
    // zero-traffic — we route to the inline fallback above instead.
    expect(screen.queryByTestId("hbar-chart")).not.toBeInTheDocument();
  });

  it("changes the range pill and refetches comparison data with the new range", async () => {
    renderPage();
    await waitFor(() => screen.getByTestId("utm-range-7d"));
    fireEvent.click(screen.getByTestId("utm-range-7d"));
    await waitFor(() => {
      expect(mockComparison).toHaveBeenLastCalledWith(
        expect.objectContaining({ range: "7d" }),
      );
    });
  });

  it("renders ★ for tags significantly above average", async () => {
    mockList.mockResolvedValue(makeList([makeTag({ id: "t-1", name: "winner" })]));
    mockComparison.mockResolvedValue({
      rows: [
        {
          tagId: "t-1",
          name: "winner",
          utmSource: "reddit",
          utmMedium: "cpc",
          utmCampaign: "giveaway_v1",
          utmContent: null,
          utmTerm: null,
          status: "active",
          originKey: null,
          hasShortCode: false,
          clicksLifetime: 0,
          sessions: 200,
          signups: 50,
          anonymousPlays: 0,
          conversionRate: 0.25,
          ciLow: 0.196,
          ciHigh: 0.314,
          isLowSample: false,
          isSignificantlyAboveAverage: true,
          isSignificantlyBelowAverage: false,
          sparkline: [1, 2, 3, 4, 5, 6, 7],
        },
      ],
      summary: {
        totalClicksLifetime: 0,
        totalSessions: 200,
        totalSignups: 50,
        totalAnonymousPlays: 0,
        globalConversionRate: 0.05,
        globalConversionCi: { point: 0.05, lo: 0.04, hi: 0.06, halfWidth: 0.01 },
        rangeDays: 28,
        activeTagCount: 1,
      },
    });
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId("utm-flag-above-t-1")).toBeInTheDocument();
    });
  });

  it("renders ⚠ for low-sample tags", async () => {
    mockList.mockResolvedValue(makeList([makeTag({ id: "t-1", name: "tiny" })]));
    mockComparison.mockResolvedValue({
      rows: [
        {
          tagId: "t-1",
          name: "tiny",
          utmSource: "reddit",
          utmMedium: "cpc",
          utmCampaign: "giveaway_v1",
          utmContent: null,
          utmTerm: null,
          status: "active",
          originKey: null,
          hasShortCode: false,
          clicksLifetime: 0,
          sessions: 5,
          signups: 1,
          anonymousPlays: 0,
          conversionRate: 0.2,
          ciLow: 0.036,
          ciHigh: 0.624,
          isLowSample: true,
          isSignificantlyAboveAverage: false,
          isSignificantlyBelowAverage: false,
          sparkline: [0, 0, 0, 0, 0, 0, 1],
        },
      ],
      summary: {
        totalClicksLifetime: 0,
        totalSessions: 5,
        totalSignups: 1,
        totalAnonymousPlays: 0,
        globalConversionRate: 0.2,
        globalConversionCi: { point: 0.2, lo: 0.036, hi: 0.624, halfWidth: 0.294 },
        rangeDays: 28,
        activeTagCount: 1,
      },
    });
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId("utm-flag-lowsample-t-1")).toBeInTheDocument();
    });
  });

  it("does not render the hero chart when status filter is not 'active'", async () => {
    renderPage();
    // Wait for initial load; chart is shown initially because filter starts as "active".
    await waitFor(() => screen.getByTestId("utm-leaderboard-chart"));
    fireEvent.click(screen.getByTestId("utm-tags-filter-archived"));
    await waitFor(() => {
      expect(screen.queryByTestId("utm-leaderboard-chart")).not.toBeInTheDocument();
    });
  });

  it("clicking the table 'Sessions' header toggles the sort indicator", async () => {
    mockList.mockResolvedValue(makeList([makeTag({ id: "t-1" })]));
    renderPage();
    await waitFor(() => screen.getByTestId("utm-sort-sessions"));
    const header = screen.getByTestId("utm-sort-sessions");
    fireEvent.click(header);
    expect(header.textContent).toContain("▼");
    fireEvent.click(header);
    expect(header.textContent).toContain("▲");
  });
});
