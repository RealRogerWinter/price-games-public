import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

vi.mock("../../api/adminClient", () => ({
  getReferralAnalyticsSummary: vi.fn(),
  getReferralAnalyticsDaily: vi.fn(),
  getReferralAnalyticsTopReferrers: vi.fn(),
  getReferralAnalyticsRejections: vi.fn(),
  getReferralAnalyticsByReferrer: vi.fn(),
}));

import {
  getReferralAnalyticsSummary,
  getReferralAnalyticsDaily,
  getReferralAnalyticsTopReferrers,
  getReferralAnalyticsRejections,
  getReferralAnalyticsByReferrer,
} from "../../api/adminClient";
import AdminReferralsPage from "./AdminReferralsPage";

const mockSummary = vi.mocked(getReferralAnalyticsSummary);
const mockDaily = vi.mocked(getReferralAnalyticsDaily);
const mockTop = vi.mocked(getReferralAnalyticsTopReferrers);
const mockRejections = vi.mocked(getReferralAnalyticsRejections);
const mockByReferrer = vi.mocked(getReferralAnalyticsByReferrer);

function renderPage() {
  return render(
    <MemoryRouter>
      <AdminReferralsPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSummary.mockResolvedValue({
    total: 10,
    credited: 6,
    pending: 2,
    rejected: 2,
    conversionRate: 0.6,
    uniqueReferrers: 4,
    periodStart: "2026-04-01T00:00:00Z",
    periodEnd: "2026-04-28T00:00:00Z",
  });
  mockDaily.mockResolvedValue([
    { date: "2026-04-26", created: 1, credited: 1 },
    { date: "2026-04-27", created: 2, credited: 1 },
    { date: "2026-04-28", created: 0, credited: 0 },
  ]);
  mockTop.mockResolvedValue([
    { userId: "u1", username: "topper", avatar: null, credited: 5, pending: 1, rejected: 0, total: 6 },
    { userId: "u2", username: "second", avatar: null, credited: 1, pending: 1, rejected: 2, total: 4 },
  ]);
  mockRejections.mockResolvedValue([
    { reason: "ip_match", count: 1 },
    { reason: "disposable_email", count: 1 },
  ]);
  mockByReferrer.mockResolvedValue([
    {
      referralId: "r1",
      userId: "ref1",
      username: "newbie",
      avatar: null,
      status: "credited",
      rejectionReason: null,
      createdAt: "2026-04-25T00:00:00Z",
      creditedAt: "2026-04-25T01:00:00Z",
    },
    {
      referralId: "r2",
      userId: "ref2",
      username: "pendant",
      avatar: null,
      status: "pending",
      rejectionReason: null,
      createdAt: "2026-04-26T00:00:00Z",
      creditedAt: null,
    },
  ]);
});

describe("AdminReferralsPage", () => {
  it("renders KPI tiles from the summary endpoint", async () => {
    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId("referrals-kpi-credited").textContent).toContain("6"),
    );
    expect(screen.getByTestId("referrals-kpi-pending").textContent).toContain("2");
    expect(screen.getByTestId("referrals-kpi-rejected").textContent).toContain("2");
    expect(screen.getByTestId("referrals-kpi-total").textContent).toContain("10");
    expect(screen.getByTestId("referrals-kpi-conversion").textContent).toMatch(/60(\.0)?%/);
  });

  it("renders the top-referrers leaderboard", async () => {
    renderPage();
    await waitFor(() => expect(screen.queryByTestId("referrals-leaderboard-row-u1")).toBeInTheDocument());
    const rows = screen.getAllByTestId(/referrals-leaderboard-row-/);
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain("topper");
    expect(rows[0].textContent).toContain("5");
  });

  it("renders the rejection breakdown", async () => {
    renderPage();
    await waitFor(() =>
      expect(screen.queryByTestId("referrals-rejection-row-ip_match")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("referrals-rejection-row-disposable_email")).toBeInTheDocument();
  });

  it("re-fetches when the range filter changes", async () => {
    renderPage();
    await waitFor(() => expect(mockSummary).toHaveBeenCalledWith("28d"));

    const select = screen.getByTestId("referrals-range-select") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "7d" } });
    expect(select.value).toBe("7d");

    await waitFor(
      () => {
        expect(mockSummary).toHaveBeenCalledWith("7d");
        expect(mockDaily).toHaveBeenCalledWith("7d");
        expect(mockTop).toHaveBeenCalledWith("7d", expect.any(Number));
        expect(mockRejections).toHaveBeenCalledWith("7d");
      },
      { timeout: 3000 },
    );
  });

  it("renders the daily chart with axis labels", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByTestId("referrals-daily-chart")).toBeInTheDocument());
  });

  it("expands a leaderboard row to reveal referred accounts", async () => {
    renderPage();
    await waitFor(() => expect(screen.queryByTestId("referrals-leaderboard-row-u1")).toBeInTheDocument());

    // Detail panel is hidden by default
    expect(screen.queryByTestId("referred-users-table-u1")).not.toBeInTheDocument();
    expect(mockByReferrer).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("referrals-leaderboard-row-u1"));

    await waitFor(() => expect(mockByReferrer).toHaveBeenCalledWith("u1", "28d"));
    await waitFor(() =>
      expect(screen.queryByTestId("referred-users-table-u1")).toBeInTheDocument(),
    );

    expect(screen.getByTestId("referred-user-row-ref1").textContent).toContain("newbie");
    expect(screen.getByTestId("referred-user-row-ref2").textContent).toContain("pendant");
  });

  it("collapses the detail panel when the row is clicked again", async () => {
    renderPage();
    await waitFor(() => expect(screen.queryByTestId("referrals-leaderboard-row-u1")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("referrals-leaderboard-row-u1"));
    await waitFor(() =>
      expect(screen.queryByTestId("referred-users-table-u1")).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByTestId("referrals-leaderboard-row-u1"));
    await waitFor(() =>
      expect(screen.queryByTestId("referred-users-table-u1")).not.toBeInTheDocument(),
    );
  });
});
