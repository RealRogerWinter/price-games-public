import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import AdminLeaderboardPage from "./AdminLeaderboardPage";

// Mock the admin client; resolve with deterministic fixture data so the
// page can render and we can assert on visible content.
vi.mock("../../api/adminClient", () => ({
  getLbStats: vi.fn(),
  getLbEntries: vi.fn(),
  getLbBannedUsers: vi.fn(),
  getLbAuditLog: vi.fn(),
  getLbUserSummary: vi.fn(),
  excludeLbEntry: vi.fn(),
  restoreLbEntry: vi.fn(),
  bulkExcludeLbEntries: vi.fn(),
  banLbUser: vi.fn(),
  banLbUserHistory: vi.fn(),
  unbanLbUser: vi.fn(),
  setLbTestAccountFlag: vi.fn(),
}));

import * as client from "../../api/adminClient";

const mocks = client as unknown as Record<string, ReturnType<typeof vi.fn>>;

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getLbStats.mockResolvedValue({
    totalEntries: 100,
    excludedEntries: 4,
    bannedUsers: 2,
    testAccounts: 1,
  });
  mocks.getLbEntries.mockResolvedValue({
    entries: [
      {
        id: 1,
        playerName: "alice",
        score: 8000,
        playedAt: "2026-01-01T00:00:00Z",
        gameMode: "classic",
        sessionId: "s-1",
        userId: "u-alice",
        username: "alice",
        isExcluded: false,
        excludedAt: null,
        excludedByAdminId: null,
        excludedReason: null,
        userBanned: false,
        userIsTest: false,
      },
      {
        id: 2,
        playerName: "bob",
        score: 6000,
        playedAt: "2026-01-02T00:00:00Z",
        gameMode: "classic",
        sessionId: "s-2",
        userId: null,
        username: null,
        isExcluded: true,
        excludedAt: "2026-01-03T00:00:00Z",
        excludedByAdminId: "admin-1",
        excludedReason: "duplicate",
        userBanned: false,
        userIsTest: false,
      },
    ],
    total: 2,
    limit: 50,
    offset: 0,
  });
  mocks.getLbBannedUsers.mockResolvedValue({ users: [], total: 0 });
  mocks.getLbAuditLog.mockResolvedValue({ entries: [], total: 0 });
});

function renderPage(initial: string = "/admin/leaderboard") {
  return render(
    <MemoryRouter initialEntries={[initial]}>
      <AdminLeaderboardPage />
    </MemoryRouter>,
  );
}

describe("AdminLeaderboardPage", () => {
  it("renders header and stats", async () => {
    renderPage();
    expect(screen.getByText("Leaderboard moderation")).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByText("100")).toBeInTheDocument();
    });
  });

  it("renders entries table with active and excluded rows", async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("alice")).toBeInTheDocument();
      expect(screen.getByText("bob")).toBeInTheDocument();
    });
    expect(screen.getByText("excluded")).toBeInTheDocument();
    expect(screen.getByText("active")).toBeInTheDocument();
  });

  it("switches to banned tab and shows empty state", async () => {
    renderPage();
    await waitFor(() => screen.getByText("alice"));
    fireEvent.click(screen.getByRole("tab", { name: /banned accounts/i }));
    await waitFor(() => {
      expect(screen.getByText(/no banned accounts/i)).toBeInTheDocument();
    });
  });

  it("switches to audit tab and shows empty state", async () => {
    renderPage();
    await waitFor(() => screen.getByText("alice"));
    fireEvent.click(screen.getByRole("tab", { name: /audit log/i }));
    await waitFor(() => {
      expect(screen.getByText(/no audit events/i)).toBeInTheDocument();
    });
  });

  it("ban+wipe-history button calls banLbUserHistory after confirm", async () => {
    mocks.getLbUserSummary.mockResolvedValue({
      userId: "u-alice",
      username: "alice",
      email: "alice@example.com",
      lifetimeScore: 1000,
      totalEntries: 5,
      excludedEntries: 0,
      bestScore: 8000,
      banned: false,
      bannedAt: null,
      bannedUntil: null,
      bannedReason: null,
      bannedBy: null,
      isTestAccount: false,
      recentEntries: [],
    });
    mocks.banLbUserHistory.mockResolvedValue({});

    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const promptSpy = vi.spyOn(window, "prompt")
      .mockReturnValueOnce("wholesale fraud")
      .mockReturnValueOnce("");

    renderPage("/admin/leaderboard?player=u-alice");
    const btn = await screen.findByTestId("admin-lb-ban-history");
    expect(btn.textContent).toContain("(5)");

    fireEvent.click(btn);

    await waitFor(() => {
      expect(mocks.banLbUserHistory).toHaveBeenCalledWith("u-alice", {
        reason: "wholesale fraud",
        durationDays: undefined,
      });
    });
    confirmSpy.mockRestore();
    promptSpy.mockRestore();
  });

  it("ban+wipe-history button no-ops when user declines confirm", async () => {
    mocks.getLbUserSummary.mockResolvedValue({
      userId: "u-alice",
      username: "alice",
      email: "alice@example.com",
      lifetimeScore: 1000,
      totalEntries: 5,
      excludedEntries: 0,
      bestScore: 8000,
      banned: false,
      bannedAt: null,
      bannedUntil: null,
      bannedReason: null,
      bannedBy: null,
      isTestAccount: false,
      recentEntries: [],
    });
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);

    renderPage("/admin/leaderboard?player=u-alice");
    const btn = await screen.findByTestId("admin-lb-ban-history");
    fireEvent.click(btn);

    expect(mocks.banLbUserHistory).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it("syncs status filter to URL", async () => {
    renderPage();
    await waitFor(() => screen.getByText("alice"));
    const select = screen.getByDisplayValue("All statuses") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "excluded" } });
    await waitFor(() => {
      expect(mocks.getLbEntries).toHaveBeenLastCalledWith(
        expect.objectContaining({ status: "excluded" }),
      );
    });
  });
});
