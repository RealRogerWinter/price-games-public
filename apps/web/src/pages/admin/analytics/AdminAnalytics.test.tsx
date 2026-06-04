import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import AdminAnalytics from "./AdminAnalytics";

// Stub out the actual tab bodies — the URL behavior under test doesn't
// depend on them rendering real content, and avoiding their data hooks
// keeps the test hermetic.
vi.mock("./OverviewTab", () => ({ default: () => <div data-testid="tab-body-overview" /> }));
vi.mock("./AcquisitionTab", () => ({ default: () => <div data-testid="tab-body-acquisition" /> }));
vi.mock("./EngagementTab", () => ({ default: () => <div data-testid="tab-body-engagement" /> }));
vi.mock("./RetentionTab", () => ({ default: () => <div data-testid="tab-body-retention" /> }));
vi.mock("./FunnelsTab", () => ({ default: () => <div data-testid="tab-body-funnels" /> }));
vi.mock("./GeoTab", () => ({ default: () => <div data-testid="tab-body-geo" /> }));
vi.mock("./AnomalyBanner", () => ({ default: () => null }));

function LocationProbe(): React.ReactElement {
  const loc = useLocation();
  return <span data-testid="url">{loc.pathname + loc.search}</span>;
}

function renderAt(initial: string) {
  return render(
    <MemoryRouter initialEntries={[initial]}>
      <Routes>
        <Route path="/admin/analytics/*" element={<AdminAnalytics />} />
      </Routes>
      <LocationProbe />
    </MemoryRouter>,
  );
}

describe("AdminAnalytics tab navigation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the overview tab at /admin/analytics/overview", async () => {
    renderAt("/admin/analytics/overview");
    await waitFor(() => expect(screen.getByTestId("tab-body-overview")).toBeInTheDocument());
    expect(screen.getByTestId("url").textContent).toBe("/admin/analytics/overview");
  });

  it("redirects index to overview without compounding the path", async () => {
    renderAt("/admin/analytics");
    await waitFor(() => expect(screen.getByTestId("tab-body-overview")).toBeInTheDocument());
    expect(screen.getByTestId("url").textContent).toBe("/admin/analytics/overview");
  });

  it("navigates between tabs with absolute paths (regression: no URL compounding)", async () => {
    const user = userEvent.setup();
    renderAt("/admin/analytics/overview");
    await waitFor(() => expect(screen.getByTestId("tab-body-overview")).toBeInTheDocument());

    // Only the exact-match tab should carry the active class (NavLink `end`).
    expect(screen.getByTestId("analytics-tab-overview")).toHaveClass("active");
    expect(screen.getByTestId("analytics-tab-acquisition")).not.toHaveClass("active");

    await user.click(screen.getByTestId("analytics-tab-engagement"));
    await waitFor(() => expect(screen.getByTestId("tab-body-engagement")).toBeInTheDocument());
    expect(screen.getByTestId("url").textContent).toBe("/admin/analytics/engagement");
    expect(screen.getByTestId("analytics-tab-engagement")).toHaveClass("active");
    expect(screen.getByTestId("analytics-tab-overview")).not.toHaveClass("active");

    await user.click(screen.getByTestId("analytics-tab-overview"));
    await waitFor(() => expect(screen.getByTestId("tab-body-overview")).toBeInTheDocument());
    expect(screen.getByTestId("url").textContent).toBe("/admin/analytics/overview");

    // Clicking the active tab again must not append a path segment.
    await user.click(screen.getByTestId("analytics-tab-overview"));
    expect(screen.getByTestId("url").textContent).toBe("/admin/analytics/overview");
  });

  it("recovers from an unknown sub-path by redirecting to overview, not appending", async () => {
    renderAt("/admin/analytics/overview/overview/overview");
    await waitFor(() => expect(screen.getByTestId("tab-body-overview")).toBeInTheDocument());
    expect(screen.getByTestId("url").textContent).toBe("/admin/analytics/overview");
  });

  it("preserves filter search params when switching tabs", async () => {
    const user = userEvent.setup();
    renderAt("/admin/analytics/overview?range=28d&audience=anon");
    await waitFor(() => expect(screen.getByTestId("tab-body-overview")).toBeInTheDocument());

    await user.click(screen.getByTestId("analytics-tab-funnels"));
    await waitFor(() => expect(screen.getByTestId("tab-body-funnels")).toBeInTheDocument());
    expect(screen.getByTestId("url").textContent).toBe(
      "/admin/analytics/funnels?range=28d&audience=anon",
    );
  });
});
