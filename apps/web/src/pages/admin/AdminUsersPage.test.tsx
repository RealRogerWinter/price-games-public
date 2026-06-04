import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { AdminUserListResponse } from "@price-game/shared";

vi.mock("../../api/adminClient", () => ({
  getAdminUsers: vi.fn(),
  deactivateAdminUser: vi.fn(),
  reactivateAdminUser: vi.fn(),
  deleteAdminUser: vi.fn(),
}));

import { getAdminUsers } from "../../api/adminClient";
import AdminUsersPage from "./AdminUsersPage";

const mockGet = vi.mocked(getAdminUsers);

function makeResponse(overrides: Partial<AdminUserListResponse["users"][number]>[]): AdminUserListResponse {
  const users = overrides.map((o, i) => ({
    id: o.id ?? `u${i}`,
    username: o.username ?? `user${i}`,
    email: o.email ?? `u${i}@example.com`,
    avatar: null,
    isActive: true,
    lifetimeScore: 0,
    createdAt: "2026-01-01T00:00:00Z",
    lastLoginAt: null,
    totalGames: 0,
    creditedReferrals: 0,
    totalReferrals: 0,
    ...o,
  }));
  return { users, total: users.length, page: 1, pageSize: 50, totalPages: 1 };
}

function renderPage() {
  return render(
    <MemoryRouter>
      <AdminUsersPage />
    </MemoryRouter>,
  );
}

describe("AdminUsersPage referrals column", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders credited / total referrals per user", async () => {
    mockGet.mockResolvedValue(
      makeResponse([
        { id: "alice", username: "alice", creditedReferrals: 3, totalReferrals: 5 },
        { id: "bob", username: "bob", creditedReferrals: 0, totalReferrals: 0 },
      ]),
    );

    renderPage();

    await waitFor(() => expect(screen.getByTestId("admin-users-table")).toBeInTheDocument());

    const aliceCell = screen.getByTestId("referrals-cell-alice");
    expect(aliceCell.textContent).toContain("3");
    expect(aliceCell.textContent).toContain("5");

    const bobCell = screen.getByTestId("referrals-cell-bob");
    expect(bobCell.textContent).toContain("0");
  });

  it("clicking the Referrals header requests sort by 'referrals'", async () => {
    mockGet.mockResolvedValue(makeResponse([{ id: "u1", username: "u1" }]));
    renderPage();

    await waitFor(() => expect(screen.getByTestId("users-th-referrals")).toBeInTheDocument());

    mockGet.mockClear();
    fireEvent.click(screen.getByTestId("users-th-referrals"));

    await waitFor(() => {
      expect(mockGet).toHaveBeenCalled();
      const callArgs = mockGet.mock.calls[0][0] as { sortBy?: string };
      expect(callArgs.sortBy).toBe("referrals");
    });
  });
});
