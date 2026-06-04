/**
 * Tests for the AdminRewardsPage component.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";

vi.mock("../api/adminClient", () => ({
  getRewards: vi.fn(),
  createReward: vi.fn(),
  deleteReward: vi.fn(),
  awardReward: vi.fn(),
  getQualifyingPlayers: vi.fn(),
  previewRandomRoll: vi.fn(),
  confirmPendingAward: vi.fn(),
  discardPendingAward: vi.fn(),
  searchUsersForReward: vi.fn(),
}));

import * as adminClient from "../api/adminClient";
import AdminRewardsPage from "../pages/admin/AdminRewardsPage";

const mockGetRewards = vi.mocked(adminClient.getRewards);
const mockCreateReward = vi.mocked(adminClient.createReward);
const mockDeleteReward = vi.mocked(adminClient.deleteReward);
const mockAwardReward = vi.mocked(adminClient.awardReward);
const mockGetQualifyingPlayers = vi.mocked(adminClient.getQualifyingPlayers);
const mockPreviewRandomRoll = vi.mocked(adminClient.previewRandomRoll);
const mockConfirmPendingAward = vi.mocked(adminClient.confirmPendingAward);
const mockDiscardPendingAward = vi.mocked(adminClient.discardPendingAward);
const mockSearchUsersForReward = vi.mocked(adminClient.searchUsersForReward);

const mockReward = {
  id: "r1",
  rewardType: "amazon_gift_card" as const,
  amountCents: 2500,
  code: "ABCD-1234-EFGH",
  description: "Test reward",
  status: "available" as const,
  award: null,
  createdAt: "2026-03-01T00:00:00Z",
};

const mockAwardedReward = {
  ...mockReward,
  id: "r2",
  status: "awarded" as const,
  award: {
    username: "alice",
    awardedAt: "2026-03-15T00:00:00Z",
    awardMethod: "manual",
  },
};

const defaultRewardsResponse = {
  rewards: [mockReward, mockAwardedReward],
  total: 2,
  page: 1,
  pageSize: 25,
  totalPages: 1,
};

describe("AdminRewardsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetRewards.mockResolvedValue(defaultRewardsResponse);
  });

  it("shows loading spinner while fetching rewards", () => {
    mockGetRewards.mockReturnValue(new Promise(() => {}));
    render(<AdminRewardsPage />);
    expect(screen.getByText(/loading rewards/i)).toBeInTheDocument();
  });

  it("renders rewards table after load", async () => {
    render(<AdminRewardsPage />);
    await waitFor(() => {
      expect(screen.getByTestId("rewards-table")).toBeInTheDocument();
    });
    expect(screen.getByTestId("reward-row-r1")).toBeInTheDocument();
    expect(screen.getByTestId("reward-row-r2")).toBeInTheDocument();
  });

  it("shows reward count", async () => {
    render(<AdminRewardsPage />);
    await waitFor(() => {
      expect(screen.getByTestId("rewards-count")).toBeInTheDocument();
    });
    expect(screen.getByTestId("rewards-count")).toHaveTextContent("2 rewards");
  });

  it("shows singular reward count when only one reward", async () => {
    mockGetRewards.mockResolvedValueOnce({ ...defaultRewardsResponse, rewards: [mockReward], total: 1 });
    render(<AdminRewardsPage />);
    await waitFor(() => {
      expect(screen.getByTestId("rewards-count")).toHaveTextContent("1 reward");
    });
  });

  it("shows 'No rewards found' when list is empty", async () => {
    mockGetRewards.mockResolvedValueOnce({ rewards: [], total: 0, page: 1, pageSize: 25, totalPages: 0 });
    render(<AdminRewardsPage />);
    await waitFor(() => {
      expect(screen.getByText("No rewards found")).toBeInTheDocument();
    });
  });

  it("displays formatted price for available reward", async () => {
    render(<AdminRewardsPage />);
    await waitFor(() => {
      expect(screen.getByTestId("reward-row-r1")).toBeInTheDocument();
    });
    expect(screen.getAllByText("$25.00").length).toBeGreaterThanOrEqual(1);
  });

  it("shows Award, Roll, Delete buttons for available reward", async () => {
    render(<AdminRewardsPage />);
    await waitFor(() => {
      expect(screen.getByTestId("award-btn-r1")).toBeInTheDocument();
    });
    expect(screen.getByTestId("roll-btn-r1")).toBeInTheDocument();
    expect(screen.getByTestId("delete-btn-r1")).toBeInTheDocument();
  });

  it("does not show action buttons for awarded reward", async () => {
    render(<AdminRewardsPage />);
    await waitFor(() => {
      expect(screen.getByTestId("reward-row-r2")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("award-btn-r2")).not.toBeInTheDocument();
    expect(screen.queryByTestId("roll-btn-r2")).not.toBeInTheDocument();
    expect(screen.queryByTestId("delete-btn-r2")).not.toBeInTheDocument();
  });

  it("shows awarded username in awarded-to column", async () => {
    render(<AdminRewardsPage />);
    await waitFor(() => {
      expect(screen.getByTestId("reward-row-r2")).toBeInTheDocument();
    });
    expect(screen.getByText("alice")).toBeInTheDocument();
  });

  it("shows status filter buttons", async () => {
    render(<AdminRewardsPage />);
    await waitFor(() => {
      expect(screen.getByTestId("rewards-status-filter")).toBeInTheDocument();
    });
    const filter = screen.getByTestId("rewards-status-filter");
    expect(filter).toHaveTextContent("All");
    expect(filter).toHaveTextContent("Available");
    expect(filter).toHaveTextContent("Awarded");
    expect(filter).toHaveTextContent("Claimed");
  });

  it("clicking Available status filter fetches with status filter", async () => {
    render(<AdminRewardsPage />);
    await waitFor(() => {
      expect(screen.getByTestId("rewards-status-filter")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole("button", { name: "Available" }));
    await waitFor(() => {
      expect(mockGetRewards).toHaveBeenCalledWith(
        expect.objectContaining({ status: "available" })
      );
    });
  });

  it("clicking Awarded status filter fetches with awarded status", async () => {
    render(<AdminRewardsPage />);
    await waitFor(() => {
      expect(screen.getByTestId("rewards-status-filter")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole("button", { name: "Awarded" }));
    await waitFor(() => {
      expect(mockGetRewards).toHaveBeenCalledWith(
        expect.objectContaining({ status: "awarded" })
      );
    });
  });

  it("'Add Gift Card' button opens add modal", async () => {
    render(<AdminRewardsPage />);
    await waitFor(() => {
      expect(screen.getByTestId("add-reward-btn")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("add-reward-btn"));
    expect(screen.getByTestId("add-reward-amount")).toBeInTheDocument();
    expect(screen.getByTestId("add-reward-code")).toBeInTheDocument();
    expect(screen.getByTestId("add-reward-description")).toBeInTheDocument();
  });

  it("add modal form submission creates reward and closes modal", async () => {
    mockCreateReward.mockResolvedValueOnce({ ...mockReward, id: "r3" });
    render(<AdminRewardsPage />);
    await waitFor(() => {
      expect(screen.getByTestId("add-reward-btn")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("add-reward-btn"));

    fireEvent.change(screen.getByTestId("add-reward-amount"), { target: { value: "25.00" } });
    fireEvent.change(screen.getByTestId("add-reward-code"), { target: { value: "TEST-CODE-1234" } });
    fireEvent.change(screen.getByTestId("add-reward-description"), { target: { value: "Test desc" } });

    const form = screen.getByTestId("add-reward-amount").closest("form")!;
    await act(async () => {
      fireEvent.submit(form);
    });

    await waitFor(() => {
      expect(mockCreateReward).toHaveBeenCalledWith({
        rewardType: "amazon_gift_card",
        amountCents: 2500,
        code: "TEST-CODE-1234",
        description: "Test desc",
      });
    });
    await waitFor(() => {
      expect(screen.queryByTestId("add-reward-amount")).not.toBeInTheDocument();
    });
  });

  it("add modal shows error for invalid amount", async () => {
    render(<AdminRewardsPage />);
    await waitFor(() => {
      expect(screen.getByTestId("add-reward-btn")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("add-reward-btn"));

    fireEvent.change(screen.getByTestId("add-reward-amount"), { target: { value: "-5" } });
    fireEvent.change(screen.getByTestId("add-reward-code"), { target: { value: "CODE-1234" } });

    const form = screen.getByTestId("add-reward-amount").closest("form")!;
    await act(async () => {
      fireEvent.submit(form);
    });

    await waitFor(() => {
      expect(screen.getByText(/amount must be a positive number/i)).toBeInTheDocument();
    });
  });

  it("shows success message after reward is added", async () => {
    mockCreateReward.mockResolvedValueOnce({ ...mockReward, id: "r3" });
    render(<AdminRewardsPage />);
    await waitFor(() => {
      expect(screen.getByTestId("add-reward-btn")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("add-reward-btn"));
    fireEvent.change(screen.getByTestId("add-reward-amount"), { target: { value: "10.00" } });
    fireEvent.change(screen.getByTestId("add-reward-code"), { target: { value: "CODE-XXXX" } });

    const form = screen.getByTestId("add-reward-amount").closest("form")!;
    await act(async () => {
      fireEvent.submit(form);
    });

    await waitFor(() => {
      expect(screen.getByText("Reward added to pool")).toBeInTheDocument();
    });
  });

  it("shows error message when createReward API call fails", async () => {
    mockCreateReward.mockRejectedValueOnce(new Error("Server error"));
    render(<AdminRewardsPage />);
    await waitFor(() => {
      expect(screen.getByTestId("add-reward-btn")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("add-reward-btn"));
    fireEvent.change(screen.getByTestId("add-reward-amount"), { target: { value: "10.00" } });
    fireEvent.change(screen.getByTestId("add-reward-code"), { target: { value: "CODE-XXXX" } });

    const form = screen.getByTestId("add-reward-amount").closest("form")!;
    await act(async () => {
      fireEvent.submit(form);
    });

    await waitFor(() => {
      expect(screen.getByText("Server error")).toBeInTheDocument();
    });
  });

  it("shows error message when getRewards fails", async () => {
    mockGetRewards.mockRejectedValueOnce(new Error("Failed to fetch"));
    render(<AdminRewardsPage />);
    await waitFor(() => {
      expect(screen.getByText("Failed to fetch")).toBeInTheDocument();
    });
  });

  it("closes add modal when Cancel is clicked", async () => {
    render(<AdminRewardsPage />);
    await waitFor(() => {
      expect(screen.getByTestId("add-reward-btn")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("add-reward-btn"));
    expect(screen.getByTestId("add-reward-amount")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Cancel"));
    expect(screen.queryByTestId("add-reward-amount")).not.toBeInTheDocument();
  });

  it("Award modal opens with reward amount info", async () => {
    render(<AdminRewardsPage />);
    await waitFor(() => {
      expect(screen.getByTestId("award-btn-r1")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("award-btn-r1"));
    expect(screen.getByTestId("award-user-search")).toBeInTheDocument();
    expect(screen.getByText(/\$25\.00 Amazon Gift Card/)).toBeInTheDocument();
  });

  it("Confirm award button is disabled without a selected user", async () => {
    render(<AdminRewardsPage />);
    await waitFor(() => {
      expect(screen.getByTestId("award-btn-r1")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("award-btn-r1"));
    const confirmBtn = screen.getByTestId("confirm-award-btn");
    expect(confirmBtn).toBeDisabled();
  });

  it("user search results appear after typing, selecting calls awardReward", async () => {
    const mockUser = { id: "u1", username: "bob", email: "bob@test.com", lifetimeScore: 5000 };
    mockSearchUsersForReward.mockResolvedValueOnce([mockUser]);
    mockAwardReward.mockResolvedValueOnce({ ...mockReward, status: "awarded" as const });

    render(<AdminRewardsPage />);
    await waitFor(() => {
      expect(screen.getByTestId("award-btn-r1")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("award-btn-r1"));

    const searchInput = screen.getByTestId("award-user-search");
    fireEvent.change(searchInput, { target: { value: "bob" } });

    await waitFor(() => {
      expect(screen.getByTestId("award-user-results")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("bob"));
    expect(screen.getByTestId("award-selected-user")).toBeInTheDocument();

    const confirmBtn = screen.getByTestId("confirm-award-btn");
    expect(confirmBtn).not.toBeDisabled();

    await act(async () => {
      fireEvent.click(confirmBtn);
    });

    await waitFor(() => {
      expect(mockAwardReward).toHaveBeenCalledWith("r1", "u1");
    });
    await waitFor(() => {
      expect(screen.getByText(/reward awarded to bob/i)).toBeInTheDocument();
    });
  });

  it("Delete calls window.confirm and then deleteReward", async () => {
    vi.stubGlobal("confirm", vi.fn().mockReturnValue(true));
    mockDeleteReward.mockResolvedValueOnce({ ok: true });

    render(<AdminRewardsPage />);
    await waitFor(() => {
      expect(screen.getByTestId("delete-btn-r1")).toBeInTheDocument();
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("delete-btn-r1"));
    });

    expect(window.confirm).toHaveBeenCalled();
    await waitFor(() => {
      expect(mockDeleteReward).toHaveBeenCalledWith("r1");
    });
    await waitFor(() => {
      expect(screen.getByText("Reward removed from pool")).toBeInTheDocument();
    });

    vi.unstubAllGlobals();
  });

  it("Delete does not call deleteReward if confirm is cancelled", async () => {
    vi.stubGlobal("confirm", vi.fn().mockReturnValue(false));

    render(<AdminRewardsPage />);
    await waitFor(() => {
      expect(screen.getByTestId("delete-btn-r1")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("delete-btn-r1"));

    expect(window.confirm).toHaveBeenCalled();
    expect(mockDeleteReward).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  it("Roll modal opens with criteria form", async () => {
    render(<AdminRewardsPage />);
    await waitFor(() => {
      expect(screen.getByTestId("roll-btn-r1")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("roll-btn-r1"));
    expect(screen.getByTestId("roll-min-points")).toBeInTheDocument();
    expect(screen.getByTestId("roll-period")).toBeInTheDocument();
    expect(screen.getByTestId("roll-use-lifetime")).toBeInTheDocument();
    expect(screen.getByTestId("roll-mode")).toBeInTheDocument();
    expect(screen.getByTestId("preview-qualifying-btn")).toBeInTheDocument();
  });

  it("selecting streak_only mode hides points inputs and shows streak input", async () => {
    render(<AdminRewardsPage />);
    await waitFor(() => {
      expect(screen.getByTestId("roll-btn-r1")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("roll-btn-r1"));
    fireEvent.change(screen.getByTestId("roll-mode"), { target: { value: "streak_only" } });

    expect(screen.queryByTestId("roll-min-points")).not.toBeInTheDocument();
    expect(screen.queryByTestId("roll-period")).not.toBeInTheDocument();
    expect(screen.getByTestId("roll-min-streak")).toBeInTheDocument();
  });

  it("points_and_streak mode shows both points and streak inputs", async () => {
    render(<AdminRewardsPage />);
    await waitFor(() => {
      expect(screen.getByTestId("roll-btn-r1")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("roll-btn-r1"));
    fireEvent.change(screen.getByTestId("roll-mode"), { target: { value: "points_and_streak" } });

    expect(screen.getByTestId("roll-min-points")).toBeInTheDocument();
    expect(screen.getByTestId("roll-min-streak")).toBeInTheDocument();
  });

  it("preview sends streak criteria to API when in streak mode", async () => {
    mockGetQualifyingPlayers.mockResolvedValueOnce({ players: [], total: 0 });

    render(<AdminRewardsPage />);
    await waitFor(() => {
      expect(screen.getByTestId("roll-btn-r1")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("roll-btn-r1"));

    fireEvent.change(screen.getByTestId("roll-mode"), { target: { value: "streak_only" } });
    fireEvent.change(screen.getByTestId("roll-min-streak"), { target: { value: "5" } });

    await act(async () => {
      fireEvent.click(screen.getByTestId("preview-qualifying-btn"));
    });

    expect(mockGetQualifyingPlayers).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "streak_only", minStreak: 5 }),
    );
  });

  it("qualifying player row renders streak value", async () => {
    mockGetQualifyingPlayers.mockResolvedValueOnce({
      players: [
        { id: "p1", username: "charlie", email: "c@test.com", points: 2000, gamesPlayed: 10, streak: 12 },
      ],
      total: 1,
    });

    render(<AdminRewardsPage />);
    await waitFor(() => {
      expect(screen.getByTestId("roll-btn-r1")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("roll-btn-r1"));

    await act(async () => {
      fireEvent.click(screen.getByTestId("preview-qualifying-btn"));
    });

    await waitFor(() => {
      expect(screen.getByTestId("qualifying-player-streak")).toHaveTextContent("12");
    });
  });

  it("Preview qualifying players button fetches and shows player count", async () => {
    mockGetQualifyingPlayers.mockResolvedValueOnce({
      players: [
        { id: "p1", username: "charlie", email: "c@test.com", points: 2000, gamesPlayed: 10 },
        { id: "p2", username: "diana", email: "d@test.com", points: 1500, gamesPlayed: 8 },
      ],
      total: 2,
    });

    render(<AdminRewardsPage />);
    await waitFor(() => {
      expect(screen.getByTestId("roll-btn-r1")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("roll-btn-r1"));

    await act(async () => {
      fireEvent.click(screen.getByTestId("preview-qualifying-btn"));
    });

    await waitFor(() => {
      expect(screen.getByText(/2 Qualifying Players/i)).toBeInTheDocument();
    });
    expect(screen.getByText("charlie")).toBeInTheDocument();
    expect(screen.getByTestId("execute-roll-btn")).toBeInTheDocument();
  });

  it("Execute roll opens the review modal with the candidate winner (no email yet)", async () => {
    const mockWinner = { id: "p1", username: "charlie", email: "c@test.com", points: 2000, gamesPlayed: 10, streak: 0 };
    mockGetQualifyingPlayers.mockResolvedValueOnce({ players: [mockWinner], total: 1 });
    mockPreviewRandomRoll.mockResolvedValueOnce({
      candidateAward: { id: "a-1", userId: "p1", username: "charlie", email: "c@test.com" },
      reward: { ...mockReward, status: "awarded" as const },
      totalQualifying: 1,
      nonWinnerNotifyCount: 0,
    });

    render(<AdminRewardsPage />);
    await waitFor(() => {
      expect(screen.getByTestId("roll-btn-r1")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("roll-btn-r1"));

    await act(async () => {
      fireEvent.click(screen.getByTestId("preview-qualifying-btn"));
    });
    await waitFor(() => {
      expect(screen.getByTestId("execute-roll-btn")).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("execute-roll-btn"));
    });

    await waitFor(() => {
      expect(screen.getByText("Review Winner")).toBeInTheDocument();
    });
    expect(screen.getByTestId("review-winner-username")).toHaveTextContent("charlie");
    expect(screen.getByTestId("review-confirm-btn")).toBeInTheDocument();
    expect(screen.getByTestId("review-reroll-btn")).toBeInTheDocument();
    // Crucially: confirmPendingAward has NOT been called yet
    expect(mockConfirmPendingAward).not.toHaveBeenCalled();
  });

  it("clicking Confirm in the review modal calls confirmPendingAward", async () => {
    const mockWinner = { id: "p1", username: "charlie", email: "c@test.com", points: 2000, gamesPlayed: 10, streak: 0 };
    mockGetQualifyingPlayers.mockResolvedValueOnce({ players: [mockWinner], total: 1 });
    mockPreviewRandomRoll.mockResolvedValueOnce({
      candidateAward: { id: "a-1", userId: "p1", username: "charlie", email: "c@test.com" },
      reward: { ...mockReward, status: "awarded" as const },
      totalQualifying: 1,
      nonWinnerNotifyCount: 0,
    });
    mockConfirmPendingAward.mockResolvedValueOnce({ ok: true, reward: { ...mockReward, status: "awarded" as const } });

    render(<AdminRewardsPage />);
    await waitFor(() => expect(screen.getByTestId("roll-btn-r1")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("roll-btn-r1"));
    await act(async () => fireEvent.click(screen.getByTestId("preview-qualifying-btn")));
    await waitFor(() => expect(screen.getByTestId("execute-roll-btn")).toBeInTheDocument());
    await act(async () => fireEvent.click(screen.getByTestId("execute-roll-btn")));
    await waitFor(() => expect(screen.getByTestId("review-confirm-btn")).toBeInTheDocument());

    await act(async () => fireEvent.click(screen.getByTestId("review-confirm-btn")));
    expect(mockConfirmPendingAward).toHaveBeenCalledWith("a-1");
  });

  it("clicking Re-roll in review calls discardPendingAward then previewRandomRoll again", async () => {
    const mockWinner = { id: "p1", username: "charlie", email: "c@test.com", points: 2000, gamesPlayed: 10, streak: 0 };
    mockGetQualifyingPlayers.mockResolvedValueOnce({ players: [mockWinner], total: 1 });
    mockPreviewRandomRoll
      .mockResolvedValueOnce({
        candidateAward: { id: "a-1", userId: "p1", username: "charlie", email: "c@test.com" },
        reward: { ...mockReward, status: "awarded" as const },
        totalQualifying: 1,
        nonWinnerNotifyCount: 0,
      })
      .mockResolvedValueOnce({
        candidateAward: { id: "a-2", userId: "p2", username: "delta", email: "d@test.com" },
        reward: { ...mockReward, status: "awarded" as const },
        totalQualifying: 1,
        nonWinnerNotifyCount: 0,
      });
    mockDiscardPendingAward.mockResolvedValue({ ok: true });

    render(<AdminRewardsPage />);
    await waitFor(() => expect(screen.getByTestId("roll-btn-r1")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("roll-btn-r1"));
    await act(async () => fireEvent.click(screen.getByTestId("preview-qualifying-btn")));
    await waitFor(() => expect(screen.getByTestId("execute-roll-btn")).toBeInTheDocument());
    await act(async () => fireEvent.click(screen.getByTestId("execute-roll-btn")));
    await waitFor(() => expect(screen.getByTestId("review-reroll-btn")).toBeInTheDocument());

    await act(async () => fireEvent.click(screen.getByTestId("review-reroll-btn")));

    expect(mockDiscardPendingAward).toHaveBeenCalledWith("a-1");
    await waitFor(() =>
      expect(screen.getByTestId("review-winner-username")).toHaveTextContent("delta"),
    );
    expect(mockConfirmPendingAward).not.toHaveBeenCalled();
  });

  it("shows pagination when totalPages > 1", async () => {
    mockGetRewards.mockResolvedValueOnce({
      rewards: [mockReward],
      total: 50,
      page: 1,
      pageSize: 25,
      totalPages: 2,
    });
    render(<AdminRewardsPage />);
    await waitFor(() => {
      expect(screen.getByText(/Page 1 of 2/)).toBeInTheDocument();
    });
  });

  it("next page button advances to page 2", async () => {
    mockGetRewards.mockResolvedValue({
      rewards: [mockReward],
      total: 50,
      page: 1,
      pageSize: 25,
      totalPages: 2,
    });
    render(<AdminRewardsPage />);
    await waitFor(() => {
      expect(screen.getByText(/Page 1 of 2/)).toBeInTheDocument();
    });

    const nextBtn = screen.getByRole("button", { name: /›/ });
    await act(async () => {
      fireEvent.click(nextBtn);
    });

    await waitFor(() => {
      expect(mockGetRewards).toHaveBeenCalledWith(
        expect.objectContaining({ page: 2 })
      );
    });
  });

  it("does not show pagination when totalPages <= 1", async () => {
    render(<AdminRewardsPage />);
    await waitFor(() => {
      expect(screen.getByTestId("rewards-table")).toBeInTheDocument();
    });
    expect(screen.queryByText(/Page 1 of/)).not.toBeInTheDocument();
  });

  it("fetchRewards is called on mount with correct initial params", async () => {
    render(<AdminRewardsPage />);
    await waitFor(() => {
      expect(mockGetRewards).toHaveBeenCalledWith({ page: 1, pageSize: 25, status: "all" });
    });
  });

  it("Roll modal - close button dismisses modal", async () => {
    render(<AdminRewardsPage />);
    await waitFor(() => {
      expect(screen.getByTestId("roll-btn-r1")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("roll-btn-r1"));
    expect(screen.getByText("Random Roll")).toBeInTheDocument();

    const closeBtn = screen.getByText("×");
    fireEvent.click(closeBtn);
    expect(screen.queryByText("Random Roll")).not.toBeInTheDocument();
  });

  it("Award modal - close button dismisses modal", async () => {
    render(<AdminRewardsPage />);
    await waitFor(() => {
      expect(screen.getByTestId("award-btn-r1")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("award-btn-r1"));
    expect(screen.getByTestId("award-user-search")).toBeInTheDocument();

    const closeBtn = screen.getByText("×");
    fireEvent.click(closeBtn);
    expect(screen.queryByTestId("award-user-search")).not.toBeInTheDocument();
  });

  it("shows table column headers", async () => {
    render(<AdminRewardsPage />);
    await waitFor(() => {
      expect(screen.getByTestId("rewards-table")).toBeInTheDocument();
    });
    const table = screen.getByTestId("rewards-table");
    expect(table).toHaveTextContent("Type");
    expect(table).toHaveTextContent("Amount");
    expect(table).toHaveTextContent("Code");
    expect(table).toHaveTextContent("Status");
    expect(table).toHaveTextContent("Awarded To");
    expect(table).toHaveTextContent("Actions");
  });
});
