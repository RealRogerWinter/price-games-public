import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import ReferralDashboard from "../components/ReferralDashboard";
import { userGetReferralDashboard } from "../api/userClient";

vi.mock("../api/userClient", () => ({
  userGetReferralDashboard: vi.fn(),
}));

const mockGetDashboard = userGetReferralDashboard as ReturnType<typeof vi.fn>;

const baseDashboard = {
  referralCode: "ABC123XY",
  referralUrl: "http://localhost:5173/r/ABC123XY",
  totalReferrals: 2,
  creditedReferrals: 1,
  pendingReferrals: 1,
  referrals: [
    {
      id: "r1",
      referredUsername: "friend1",
      status: "credited",
      rejectionReason: null,
      createdAt: "2026-03-01T00:00:00Z",
      creditedAt: "2026-03-02T00:00:00Z",
    },
    {
      id: "r2",
      referredUsername: "friend2",
      status: "pending",
      rejectionReason: null,
      createdAt: "2026-03-10T00:00:00Z",
      creditedAt: null,
    },
  ],
  multiAccountWarning: false,
};

describe("ReferralDashboard", () => {
  beforeEach(() => {
    mockGetDashboard.mockReset();
  });

  it("shows loading state initially", () => {
    // Never resolve to keep the component in loading state
    mockGetDashboard.mockReturnValue(new Promise(() => {}));

    render(<ReferralDashboard />);

    expect(screen.getByText("Loading referrals...")).toBeInTheDocument();
  });

  it("renders referral link and stats after loading", async () => {
    mockGetDashboard.mockResolvedValue(baseDashboard);

    render(<ReferralDashboard />);

    // Wait for loading to finish and dashboard to render
    const linkInput = await screen.findByDisplayValue(
      "http://localhost:5173/r/ABC123XY",
    );
    expect(linkInput).toBeInTheDocument();

    // Stats are displayed — query by label, then check sibling stat value
    expect(screen.getByText("Credited")).toBeInTheDocument();
    expect(screen.getByText("Pending")).toBeInTheDocument();
    expect(screen.getByText("Total")).toBeInTheDocument();

    // Verify stat values by checking parent containers
    const creditedLabel = screen.getByText("Credited");
    expect(creditedLabel.parentElement?.querySelector(".referral-stat-value")?.textContent).toBe("1");
    const pendingLabel = screen.getByText("Pending");
    expect(pendingLabel.parentElement?.querySelector(".referral-stat-value")?.textContent).toBe("1");
    const totalLabel = screen.getByText("Total");
    expect(totalLabel.parentElement?.querySelector(".referral-stat-value")?.textContent).toBe("2");

    // Copy and Share buttons are present
    expect(screen.getByText("Copy")).toBeInTheDocument();
    expect(screen.getByText("Share")).toBeInTheDocument();
  });

  it("shows referral table when there are referrals", async () => {
    mockGetDashboard.mockResolvedValue(baseDashboard);

    render(<ReferralDashboard />);

    // Wait for the table to appear
    await screen.findByText("friend1");

    expect(screen.getByText("friend1")).toBeInTheDocument();
    expect(screen.getByText("friend2")).toBeInTheDocument();
    expect(screen.getByText("credited")).toBeInTheDocument();
    expect(screen.getByText("pending")).toBeInTheDocument();

    // Table headers
    expect(screen.getByText("User")).toBeInTheDocument();
    expect(screen.getByText("Status")).toBeInTheDocument();
    expect(screen.getByText("Date")).toBeInTheDocument();
  });

  it("shows empty state when no referrals", async () => {
    mockGetDashboard.mockResolvedValue({
      ...baseDashboard,
      totalReferrals: 0,
      creditedReferrals: 0,
      pendingReferrals: 0,
      referrals: [],
    });

    render(<ReferralDashboard />);

    const emptyMessage = await screen.findByText(
      "No referrals yet. Share your link to invite friends!",
    );
    expect(emptyMessage).toBeInTheDocument();
  });

  it("does not show multi-account warning even when multiAccountWarning is true", async () => {
    mockGetDashboard.mockResolvedValue({
      ...baseDashboard,
      multiAccountWarning: true,
    });

    render(<ReferralDashboard />);

    await screen.findByTestId("referral-dashboard");

    expect(
      screen.queryByTestId("multi-account-warning"),
    ).not.toBeInTheDocument();
  });

  it("copy button copies referral URL to clipboard", async () => {
    mockGetDashboard.mockResolvedValue(baseDashboard);

    const writeTextMock = vi.fn().mockResolvedValue(undefined);

    // Define clipboard on navigator (jsdom does not provide it by default)
    Object.defineProperty(window.navigator, "clipboard", {
      value: { writeText: writeTextMock },
      writable: true,
      configurable: true,
    });

    render(<ReferralDashboard />);

    const copyButton = await screen.findByTestId("copy-referral-link");
    fireEvent.click(copyButton);

    // writeText is async, so wait for it to be called
    await waitFor(() => {
      expect(writeTextMock).toHaveBeenCalledWith(
        "http://localhost:5173/r/ABC123XY",
      );
    });

    // Button text changes to "Copied!" after clicking
    await waitFor(() => {
      expect(screen.getByTestId("copy-referral-link")).toHaveTextContent(
        "Copied!",
      );
    });
  });
});
