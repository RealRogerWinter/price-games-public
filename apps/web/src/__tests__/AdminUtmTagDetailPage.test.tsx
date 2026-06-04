/**
 * Tests for AdminUtmTagDetailPage — loading, funnel display, zero-state
 * handling, threshold footnote, and navigation.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import type { AdminUtmTag, AdminUtmTagStats } from "../api/adminClient";

vi.mock("../api/adminClient", () => ({
  getUtmTag: vi.fn(),
  getUtmTagStats: vi.fn(),
  getUtmTagTimeSeries: vi.fn(),
  getUtmTagComparison: vi.fn(),
}));

import * as adminClient from "../api/adminClient";
import AdminUtmTagDetailPage from "../pages/admin/AdminUtmTagDetailPage";

const mockGetTag = vi.mocked(adminClient.getUtmTag);
const mockGetStats = vi.mocked(adminClient.getUtmTagStats);
const mockGetTimeSeries = vi.mocked(adminClient.getUtmTagTimeSeries);
const mockGetComparison = vi.mocked(adminClient.getUtmTagComparison);

const mockNavigate = vi.fn();
vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual("react-router-dom");
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

const sampleTag: AdminUtmTag = {
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
};

const sampleStats: AdminUtmTagStats = {
  tagId: "t-1",
  signups: 47,
  playedFirstGame: 38,
  giveawayEligible: 29,
  wonReward: 3,
  giveawayThreshold: 20000,
  clicks: 0,
  hasShortCode: false,
  anonymousPlays: 12,
};

function renderDetailPage(id = "t-1") {
  return render(
    <MemoryRouter initialEntries={[`/admin/utm-tags/${id}`]}>
      <Routes>
        <Route path="/admin/utm-tags/:id" element={<AdminUtmTagDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

function defaultComparison() {
  return {
    rows: [
      {
        tagId: "t-1",
        name: "reddit-gw-v1",
        utmSource: "reddit",
        utmMedium: "cpc",
        utmCampaign: "giveaway_v1",
        utmContent: null,
        utmTerm: null,
        status: "active" as const,
        originKey: null,
        hasShortCode: false,
        clicksLifetime: 0,
        sessions: 100,
        signups: 47,
        anonymousPlays: 12,
        conversionRate: 0.47,
        ciLow: 0.37,
        ciHigh: 0.57,
        isLowSample: false,
        isSignificantlyAboveAverage: false,
        isSignificantlyBelowAverage: false,
        sparkline: [1, 2, 3, 4, 5, 6, 7],
      },
    ],
    summary: {
      totalClicksLifetime: 0,
      totalSessions: 200,
      totalSignups: 90,
      totalAnonymousPlays: 25,
      globalConversionRate: 0.45,
      globalConversionCi: { point: 0.45, lo: 0.38, hi: 0.52, halfWidth: 0.07 },
      rangeDays: 28,
      activeTagCount: 2,
    },
  };
}

describe("AdminUtmTagDetailPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetTag.mockResolvedValue(sampleTag);
    mockGetStats.mockResolvedValue(sampleStats);
    mockGetTimeSeries.mockResolvedValue([
      { date: "2026-04-28", sessions: 5, signups: 1, anonymousPlays: 0 },
      { date: "2026-04-29", sessions: 8, signups: 2, anonymousPlays: 1 },
    ]);
    mockGetComparison.mockResolvedValue(defaultComparison());
  });

  it("shows loading state while fetching", () => {
    mockGetTag.mockReturnValue(new Promise(() => {}));
    mockGetStats.mockReturnValue(new Promise(() => {}));
    renderDetailPage();
    expect(screen.getByTestId("utm-tag-detail-loading")).toBeInTheDocument();
  });

  it("renders the tag name and the 4-row funnel after loading", async () => {
    renderDetailPage();
    await waitFor(() => {
      expect(screen.getByTestId("utm-tag-detail-page")).toBeInTheDocument();
    });
    expect(screen.getByText("reddit-gw-v1")).toBeInTheDocument();

    // Funnel rows
    expect(screen.getByTestId("utm-funnel-signups")).toHaveTextContent("47");
    expect(screen.getByTestId("utm-funnel-played")).toHaveTextContent("38");
    expect(screen.getByTestId("utm-funnel-giveaway")).toHaveTextContent("29");
    expect(screen.getByTestId("utm-funnel-won")).toHaveTextContent("3");
  });

  it("renders percentages relative to signups", async () => {
    renderDetailPage();
    await waitFor(() => screen.getByTestId("utm-funnel-signups"));

    // 47 / 47 = 100%
    expect(screen.getByTestId("utm-funnel-signups-pct")).toHaveTextContent("100%");
    // 38 / 47 ≈ 81%
    expect(screen.getByTestId("utm-funnel-played-pct")).toHaveTextContent("81%");
    // 29 / 47 ≈ 62%
    expect(screen.getByTestId("utm-funnel-giveaway-pct")).toHaveTextContent("62%");
    // 3 / 47 ≈ 6%
    expect(screen.getByTestId("utm-funnel-won-pct")).toHaveTextContent("6%");
  });

  it("renders em-dashes instead of percentages when signups=0", async () => {
    mockGetStats.mockResolvedValue({
      ...sampleStats,
      signups: 0,
      playedFirstGame: 0,
      giveawayEligible: 0,
      wonReward: 0,
    });
    renderDetailPage();
    await waitFor(() => screen.getByTestId("utm-funnel-signups"));
    expect(screen.getByTestId("utm-funnel-signups-pct")).toHaveTextContent("—");
    expect(screen.getByTestId("utm-funnel-played-pct")).toHaveTextContent("—");
  });

  it("shows the giveaway threshold in a footnote", async () => {
    renderDetailPage();
    await waitFor(() => {
      expect(screen.getByTestId("utm-funnel-threshold-note")).toBeInTheDocument();
    });
    const note = screen.getByTestId("utm-funnel-threshold-note");
    expect(note.textContent).toContain("20000");
  });

  it("navigates back to the list when the back button is clicked", async () => {
    renderDetailPage();
    await waitFor(() => screen.getByTestId("utm-tag-detail-back"));
    fireEvent.click(screen.getByTestId("utm-tag-detail-back"));
    expect(mockNavigate).toHaveBeenCalledWith("/admin/utm-tags");
  });

  it("displays the error banner when tag load fails", async () => {
    mockGetTag.mockRejectedValueOnce(new Error("UTM tag not found"));
    renderDetailPage("missing");
    await waitFor(() => {
      expect(screen.getByTestId("utm-tag-detail-error")).toHaveTextContent(
        "UTM tag not found",
      );
    });
  });

  it("displays the error banner when stats load fails", async () => {
    mockGetStats.mockRejectedValueOnce(new Error("Stats unavailable"));
    renderDetailPage();
    await waitFor(() => {
      expect(screen.getByTestId("utm-tag-detail-error")).toHaveTextContent(
        "Stats unavailable",
      );
    });
  });

  it("shows the tag UTM tuple details", async () => {
    renderDetailPage();
    await waitFor(() => screen.getByTestId("utm-tag-detail-page"));
    expect(screen.getByTestId("utm-tag-detail-tuple")).toHaveTextContent("reddit");
    expect(screen.getByTestId("utm-tag-detail-tuple")).toHaveTextContent("cpc");
    expect(screen.getByTestId("utm-tag-detail-tuple")).toHaveTextContent("giveaway_v1");
  });

  // ── Short-link support ──────────────────────────────────────────────────

  it("does NOT render a Clicks row when hasShortCode is false", async () => {
    renderDetailPage();
    await waitFor(() => screen.getByTestId("utm-funnel-signups"));
    expect(screen.queryByTestId("utm-funnel-clicks")).not.toBeInTheDocument();
    expect(screen.queryByTestId("utm-funnel-clicks-pct")).not.toBeInTheDocument();
  });

  it("renders a Clicks row at the top of the funnel when hasShortCode is true", async () => {
    mockGetTag.mockResolvedValue({ ...sampleTag, shortCode: "red-gw-1" });
    mockGetStats.mockResolvedValue({
      ...sampleStats,
      clicks: 1234,
      hasShortCode: true,
    });
    renderDetailPage();
    await waitFor(() => screen.getByTestId("utm-funnel-clicks"));
    // The v2 funnel renders counts via toLocaleString() so 1234 → "1,234".
    expect(screen.getByTestId("utm-funnel-clicks")).toHaveTextContent("1,234");
    // Percent column for clicks shows em-dash (no denominator).
    expect(screen.getByTestId("utm-funnel-clicks-pct")).toHaveTextContent("—");
  });

  it("shows the short URL in the tuple view when set", async () => {
    mockGetTag.mockResolvedValue({ ...sampleTag, shortCode: "red-gw-1" });
    mockGetStats.mockResolvedValue({
      ...sampleStats,
      clicks: 0,
      hasShortCode: true,
    });
    renderDetailPage();
    await waitFor(() => screen.getByTestId("utm-tag-detail-tuple"));
    const tuple = screen.getByTestId("utm-tag-detail-tuple");
    expect(tuple).toHaveTextContent("/go/red-gw-1");
  });

  it("shows an em-dash for the Short URL row when no code is set", async () => {
    renderDetailPage();
    await waitFor(() => screen.getByTestId("utm-tag-detail-tuple"));
    // The row is present with a dash; existing "Source" etc. rows must keep
    // rendering exactly as before.
    expect(screen.getByTestId("utm-tag-detail-short-url")).toHaveTextContent("—");
  });

  it("preserves existing funnel percentages (unchanged by the clicks row)", async () => {
    mockGetTag.mockResolvedValue({ ...sampleTag, shortCode: "red-gw-1" });
    mockGetStats.mockResolvedValue({
      ...sampleStats,
      clicks: 100,
      hasShortCode: true,
    });
    renderDetailPage();
    await waitFor(() => screen.getByTestId("utm-funnel-signups"));
    // Percentages still relative to signups (47), not clicks (100).
    expect(screen.getByTestId("utm-funnel-signups-pct")).toHaveTextContent("100%");
    expect(screen.getByTestId("utm-funnel-played-pct")).toHaveTextContent("81%");
    expect(screen.getByTestId("utm-funnel-giveaway-pct")).toHaveTextContent("62%");
    expect(screen.getByTestId("utm-funnel-won-pct")).toHaveTextContent("6%");
  });

  // ── Anonymous plays row (pre-signup attribution) ────────────────────────

  it("renders the anonymous plays row with the count from stats", async () => {
    renderDetailPage();
    await waitFor(() => screen.getByTestId("utm-funnel-anon-plays"));
    expect(screen.getByTestId("utm-funnel-anon-plays")).toHaveTextContent("12");
    // No denominator for the anon row (no percent)
    expect(screen.getByTestId("utm-funnel-anon-plays-pct")).toHaveTextContent("—");
  });

  it("renders the anonymous plays footnote", async () => {
    renderDetailPage();
    await waitFor(() =>
      expect(screen.getByTestId("utm-funnel-anon-plays-note")).toBeInTheDocument(),
    );
    const note = screen.getByTestId("utm-funnel-anon-plays-note");
    expect(note.textContent).toContain("visitor_id");
  });

  it("shows zero for anonymous plays when the tag has none", async () => {
    mockGetStats.mockResolvedValue({ ...sampleStats, anonymousPlays: 0 });
    renderDetailPage();
    await waitFor(() => screen.getByTestId("utm-funnel-anon-plays"));
    expect(screen.getByTestId("utm-funnel-anon-plays")).toHaveTextContent("0");
  });

  // ── Dashboard upgrade: range pills, time series, vs-avg block ───────────

  it("renders the range pills and the traffic-over-time chart", async () => {
    renderDetailPage();
    await waitFor(() => {
      expect(screen.getByTestId("utm-detail-range-pills")).toBeInTheDocument();
    });
    expect(screen.getByTestId("utm-detail-range-7d")).toBeInTheDocument();
    expect(screen.getByTestId("utm-detail-range-28d")).toBeInTheDocument();
    expect(screen.getByTestId("utm-detail-range-90d")).toBeInTheDocument();
    expect(screen.getByTestId("utm-detail-range-lifetime")).toBeInTheDocument();
    expect(screen.getByTestId("utm-tag-detail-timeseries")).toBeInTheDocument();
  });

  it("clicking a range pill refetches stats with the new range", async () => {
    renderDetailPage();
    await waitFor(() => screen.getByTestId("utm-detail-range-7d"));
    fireEvent.click(screen.getByTestId("utm-detail-range-7d"));
    await waitFor(() => {
      expect(mockGetStats).toHaveBeenLastCalledWith("t-1", "7d");
    });
  });

  it("Lifetime range calls getUtmTagStats with no range argument", async () => {
    renderDetailPage();
    await waitFor(() => screen.getByTestId("utm-detail-range-lifetime"));
    fireEvent.click(screen.getByTestId("utm-detail-range-lifetime"));
    await waitFor(() => {
      expect(mockGetStats).toHaveBeenLastCalledWith("t-1", undefined);
    });
  });

  it("renders the vs-average comparison block when comparison data is available", async () => {
    renderDetailPage();
    await waitFor(() => {
      expect(screen.getByTestId("utm-tag-detail-vs-avg")).toBeInTheDocument();
    });
    const block = screen.getByTestId("utm-tag-detail-vs-avg");
    expect(block).toHaveTextContent("Session → Signup");
    // Tag CR (47%), avg CR (45%) — should both surface in the block.
    expect(block.textContent).toMatch(/47\.0%/);
    expect(block.textContent).toMatch(/45\.0%/);
  });

  it("hides the vs-average block when comparison data has not loaded", async () => {
    mockGetComparison.mockReturnValue(new Promise(() => {}));
    renderDetailPage();
    await waitFor(() => screen.getByTestId("utm-tag-detail-page"));
    expect(screen.queryByTestId("utm-tag-detail-vs-avg")).not.toBeInTheDocument();
  });
});
