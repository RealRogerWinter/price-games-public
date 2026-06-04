import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import AdminDailyModePage from "../pages/admin/AdminDailyModePage";
import * as adminClient from "../api/adminClient";

/** Helper to build a 7-day row set starting from a Monday. */
function makeRows(startDate: string, currentDate: string) {
  const rows = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(`${startDate}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + i);
    const date = d.toISOString().slice(0, 10);
    const modes = ["classic", "higher-lower", "comparison"] as const;
    const mode = modes[i % 3];
    const isPast = date < currentDate;
    const count = mode === "comparison" ? 10 : 5;
    rows.push({
      date,
      gameMode: mode,
      productIds: Array.from({ length: count }, (_, j) => i * 10 + j + 1),
      productTitles: Array.from({ length: count }, (_, j) => `Product ${i * 10 + j + 1}`),
      productImageUrls: Array.from({ length: count }, () => "https://example.com/img.jpg"),
      productPriceCents: Array.from({ length: count }, () => 1999),
      isManualOverride: false,
      playCount: isPast ? 25 : 0,
      averageScore: isPast ? 3500 : null,
      cachedAt: isPast ? `${date}T00:00:00Z` : null,
    });
  }
  return rows;
}

// 2026-04-13 is a Monday, 2026-04-15 (Wed) is "today"
const CURRENT_DATE = "2026-04-15";
const WEEK_START = "2026-04-13";

function mockOverview(overrides: Partial<adminClient.AdminDailyOverviewResponse> = {}) {
  return {
    enabled: false,
    schedule: [
      "higher-lower", "classic", "higher-lower", "comparison",
      "classic", "higher-lower", "comparison",
    ] as adminClient.AdminDailyOverviewResponse["schedule"],
    currentDate: CURRENT_DATE,
    rows: makeRows(WEEK_START, CURRENT_DATE),
    ...overrides,
  } satisfies adminClient.AdminDailyOverviewResponse;
}

beforeEach(() => {
  // The page calls fetchAdminDailyOverview twice on mount (initial + aligned)
  vi.spyOn(adminClient, "fetchAdminDailyOverview").mockResolvedValue(mockOverview());
  vi.spyOn(adminClient, "fetchAdminDailyStats").mockResolvedValue({
    totalPlays: 42,
    uniquePlayers: 20,
    last30Days: [],
    topStreaks: [],
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("AdminDailyModePage", () => {
  it("renders the 'Daily Challenge' heading", async () => {
    render(<AdminDailyModePage />);
    await waitFor(() => {
      expect(screen.getByText(/Daily Challenge/)).toBeInTheDocument();
    });
  });

  it("shows 'disabled' banner when enabled=false", async () => {
    render(<AdminDailyModePage />);
    await waitFor(() => {
      expect(screen.getByText(/currently hidden/i)).toBeInTheDocument();
    });
  });

  it("does not show 'disabled' banner when enabled=true", async () => {
    vi.spyOn(adminClient, "fetchAdminDailyOverview").mockResolvedValue(
      mockOverview({ enabled: true }),
    );
    render(<AdminDailyModePage />);
    await waitFor(() => {
      expect(screen.getByText(/Daily Challenge/)).toBeInTheDocument();
    });
    expect(screen.queryByText(/currently hidden/i)).toBeNull();
  });

  it("calls updateAdminDailyEnabled when the toggle is clicked", async () => {
    const enableSpy = vi.spyOn(adminClient, "updateAdminDailyEnabled").mockResolvedValue(undefined);
    render(<AdminDailyModePage />);
    await waitFor(() => {
      expect(screen.getByText(/Daily Challenge/)).toBeInTheDocument();
    });
    const toggle = screen.getByRole("checkbox");
    fireEvent.click(toggle);
    await waitFor(() => {
      expect(enableSpy).toHaveBeenCalledWith(true);
    });
  });

  it("renders 7 day cards", async () => {
    render(<AdminDailyModePage />);
    await waitFor(() => {
      expect(screen.getByTestId("day-card-strip")).toBeInTheDocument();
    });
    // Should have 7 day cards
    for (let i = 0; i < 7; i++) {
      const d = new Date(`${WEEK_START}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() + i);
      const date = d.toISOString().slice(0, 10);
      expect(screen.getByTestId(`day-card-${date}`)).toBeInTheDocument();
    }
  });

  it("shows round detail panel when a day card is clicked", async () => {
    render(<AdminDailyModePage />);
    await waitFor(() => {
      expect(screen.getByTestId(`day-card-${CURRENT_DATE}`)).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId(`day-card-${CURRENT_DATE}`));
    await waitFor(() => {
      expect(screen.getByTestId("round-detail-panel")).toBeInTheDocument();
    });
  });

  it("renders stats section with total plays", async () => {
    render(<AdminDailyModePage />);
    await waitFor(() => {
      expect(screen.getByText("42")).toBeInTheDocument(); // totalPlays
    });
  });

  it("renders the week navigation bar", async () => {
    render(<AdminDailyModePage />);
    await waitFor(() => {
      // The nav should show the week date range
      expect(screen.getByLabelText("Previous week")).toBeInTheDocument();
      expect(screen.getByLabelText("Next week")).toBeInTheDocument();
    });
  });

  it("shows 'Today' badge on the current date card", async () => {
    render(<AdminDailyModePage />);
    await waitFor(() => {
      expect(screen.getByText("Today")).toBeInTheDocument();
    });
  });
});
