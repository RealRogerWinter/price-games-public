/**
 * Extended tests for adminClient.ts covering the Rewards, Promo Banner, Legal,
 * Game Mode, Daily Drill-Down, User Analytics, and User Management sections.
 * The base coverage (auth + analytics + products + manufacturers) lives in
 * adminClient.test.ts; this file adds the remaining ~58% of the file.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  // Rewards
  getRewards,
  createReward,
  getRewardById,
  deleteReward,
  awardReward,
  getQualifyingPlayers,
  previewRandomRoll,
  confirmPendingAward,
  discardPendingAward,
  searchUsersForReward,
  // Promo Banner
  getPromoBanner,
  updatePromoBanner,
  // Legal
  getLegalDocument,
  updateLegalDocument,
  // Game Mode Settings
  getGameModeSettings,
  updateGameModeSettings,
  // User Management
  getAdminUsers,
  getAdminUser,
  updateAdminUser,
  deleteAdminUser,
  deactivateAdminUser,
  reactivateAdminUser,
  resetAdminUserPassword,
  getAdminUserGameHistory,
  getAdminUserStats,
  getAdminUserActivity,
  // Also verify bulk/archive helpers from products section not in first file
  bulkSetProductStatus,
  bulkSetProductArchived,
  setAdminProductArchived,
} from "../api/adminClient";

describe("Admin API client — extended coverage", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  /** Return a successful JSON response. */
  function mockOk(data: unknown) {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify(data), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
  }

  /** Return a failed JSON response to trigger an error throw. */
  function mockError(status: number, error: string) {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ error }), {
        status,
        headers: { "Content-Type": "application/json" },
      })
    );
  }

  // ===== Rewards =====

  describe("getRewards", () => {
    it("sends GET to /rewards with no params by default", async () => {
      mockOk({ rewards: [], total: 0, page: 1, pageSize: 20, totalPages: 0 });
      const result = await getRewards();
      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/admin/rewards",
        expect.objectContaining({ credentials: "same-origin" })
      );
      expect(result.total).toBe(0);
    });

    it("sends GET to /rewards with page, pageSize, and status params", async () => {
      mockOk({ rewards: [], total: 5, page: 2, pageSize: 10, totalPages: 1 });
      await getRewards({ page: 2, pageSize: 10, status: "available" });
      const url = fetchSpy.mock.calls[0][0] as string;
      expect(url).toContain("/api/admin/rewards?");
      expect(url).toContain("page=2");
      expect(url).toContain("pageSize=10");
      expect(url).toContain("status=available");
    });
  });

  describe("createReward", () => {
    it("sends POST to /rewards with body", async () => {
      const reward = { id: "r1", name: "Gift Card", description: "A gift card", status: "available" };
      mockOk(reward);
      const result = await createReward({ name: "Gift Card", description: "A gift card" });
      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/admin/rewards",
        expect.objectContaining({ method: "POST", credentials: "same-origin" })
      );
      const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
      expect(body.name).toBe("Gift Card");
      expect(result.id).toBe("r1");
    });
  });

  describe("getRewardById", () => {
    it("sends GET to /rewards/:id", async () => {
      const reward = { id: "r42", name: "Mystery Box", status: "available" };
      mockOk(reward);
      const result = await getRewardById("r42");
      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/admin/rewards/r42",
        expect.objectContaining({ credentials: "same-origin" })
      );
      expect(result.id).toBe("r42");
    });
  });

  describe("deleteReward", () => {
    it("sends DELETE to /rewards/:id", async () => {
      mockOk({ ok: true });
      const result = await deleteReward("r10");
      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/admin/rewards/r10",
        expect.objectContaining({ method: "DELETE", credentials: "same-origin" })
      );
      expect(result.ok).toBe(true);
    });
  });

  describe("awardReward", () => {
    it("sends POST to /rewards/:rewardId/award with userId body", async () => {
      const reward = { id: "r5", name: "Prize", status: "awarded", awardedTo: "user-99" };
      mockOk(reward);
      const result = await awardReward("r5", "user-99");
      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/admin/rewards/r5/award",
        expect.objectContaining({ method: "POST", credentials: "same-origin" })
      );
      const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
      expect(body.userId).toBe("user-99");
      expect(result.id).toBe("r5");
    });
  });

  describe("getQualifyingPlayers", () => {
    it("sends GET to /rewards/qualifying-players with criteria params", async () => {
      mockOk({ players: [], total: 0 });
      const criteria = { minPoints: 5000, period: "monthly" as const, useLifetimePoints: false };
      await getQualifyingPlayers(criteria);
      const url = fetchSpy.mock.calls[0][0] as string;
      expect(url).toContain("/api/admin/rewards/qualifying-players?");
      expect(url).toContain("minPoints=5000");
      expect(url).toContain("period=monthly");
      expect(url).toContain("useLifetimePoints=false");
    });

    it("encodes useLifetimePoints=true correctly", async () => {
      mockOk({ players: [{ id: "u1", username: "alice" }], total: 1 });
      const criteria = { minPoints: 1000, period: "alltime" as const, useLifetimePoints: true };
      const result = await getQualifyingPlayers(criteria);
      const url = fetchSpy.mock.calls[0][0] as string;
      expect(url).toContain("useLifetimePoints=true");
      expect(result.total).toBe(1);
    });
  });

  describe("previewRandomRoll", () => {
    it("sends POST to /rewards/random-roll with rewardId and criteria", async () => {
      const rollResult = {
        candidateAward: { id: "a1", userId: "u99", username: "bob", email: "bob@x.com" },
        reward: { id: "r7", name: "Prize" },
        totalQualifying: 3,
        nonWinnerNotifyCount: 2,
      };
      mockOk(rollResult);
      const criteria = { minPoints: 3000, period: "all_time" as const, useLifetimePoints: false };
      const result = await previewRandomRoll("r7", criteria);
      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/admin/rewards/random-roll",
        expect.objectContaining({ method: "POST", credentials: "same-origin" })
      );
      const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
      expect(body.rewardId).toBe("r7");
      expect(body.criteria.minPoints).toBe(3000);
      expect(result.candidateAward.username).toBe("bob");
    });
  });

  describe("confirmPendingAward / discardPendingAward", () => {
    it("confirms via /rewards/awards/:id/confirm", async () => {
      mockOk({ ok: true, reward: { id: "r" } });
      await confirmPendingAward("a-1");
      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/admin/rewards/awards/a-1/confirm",
        expect.objectContaining({ method: "POST" }),
      );
    });

    it("discards via /rewards/awards/:id/discard", async () => {
      mockOk({ ok: true });
      await discardPendingAward("a-2");
      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/admin/rewards/awards/a-2/discard",
        expect.objectContaining({ method: "POST" }),
      );
    });
  });

  describe("searchUsersForReward", () => {
    it("sends GET to /rewards/search-users with encoded query", async () => {
      const users = [{ id: "u1", username: "alice", email: "alice@ex.com", lifetimeScore: 8000 }];
      mockOk(users);
      const result = await searchUsersForReward("alice");
      const url = fetchSpy.mock.calls[0][0] as string;
      expect(url).toBe("/api/admin/rewards/search-users?q=alice");
      expect(result[0].username).toBe("alice");
    });

    it("URL-encodes special characters in query", async () => {
      mockOk([]);
      await searchUsersForReward("alice & bob");
      const url = fetchSpy.mock.calls[0][0] as string;
      expect(url).toContain("q=alice%20%26%20bob");
    });
  });

  // ===== Promo Banner =====

  describe("getPromoBanner", () => {
    it("sends GET to /banner", async () => {
      const banner = {
        enabled: true,
        audienceMode: "all",
        text: "Win prizes!",
        showLink: false,
        linkText: "",
        linkUrl: "",
        showGiveawayModal: true,
        showTracker: true,
        giveawayMinPoints: 20000,
        qualifiedMessage: "You're entered!",
      };
      mockOk(banner);
      const result = await getPromoBanner();
      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/admin/banner",
        expect.objectContaining({ credentials: "same-origin" })
      );
      expect(result.enabled).toBe(true);
      expect(result.text).toBe("Win prizes!");
    });
  });

  describe("updatePromoBanner", () => {
    it("sends PUT to /banner with partial data", async () => {
      const updated = { enabled: false, text: "Disabled" };
      mockOk(updated);
      const result = await updatePromoBanner({ enabled: false, text: "Disabled" });
      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/admin/banner",
        expect.objectContaining({ method: "PUT", credentials: "same-origin" })
      );
      const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
      expect(body.enabled).toBe(false);
      expect(result.enabled).toBe(false);
    });

    it("throws on server error", async () => {
      mockError(500, "Internal error");
      await expect(updatePromoBanner({ enabled: true })).rejects.toThrow("Internal error");
    });
  });

  // ===== Legal Documents =====

  describe("getLegalDocument", () => {
    it("sends GET to /legal/:key", async () => {
      mockOk({ key: "privacy_policy", content: "# Privacy\n\nYour data is safe." });
      const result = await getLegalDocument("privacy_policy");
      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/admin/legal/privacy_policy",
        expect.objectContaining({ credentials: "same-origin" })
      );
      expect(result.key).toBe("privacy_policy");
      expect(result.content).toContain("Privacy");
    });

    it("sends GET to /legal/terms_of_service", async () => {
      mockOk({ key: "terms_of_service", content: "# Terms" });
      const result = await getLegalDocument("terms_of_service");
      const url = fetchSpy.mock.calls[0][0] as string;
      expect(url).toBe("/api/admin/legal/terms_of_service");
      expect(result.key).toBe("terms_of_service");
    });
  });

  describe("updateLegalDocument", () => {
    it("sends PUT to /legal/:key with content body", async () => {
      mockOk({ key: "privacy_policy", ok: true });
      const result = await updateLegalDocument("privacy_policy", "# New Privacy Content");
      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/admin/legal/privacy_policy",
        expect.objectContaining({ method: "PUT", credentials: "same-origin" })
      );
      const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
      expect(body.content).toBe("# New Privacy Content");
      expect(result.ok).toBe(true);
    });
  });

  // ===== Game Mode Settings =====

  describe("getGameModeSettings", () => {
    it("sends GET to /game-modes", async () => {
      const settings = { modes: [{ mode: "classic", name: "Precision", description: "" }], disabledModes: [] };
      mockOk(settings);
      const result = await getGameModeSettings();
      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/admin/game-modes",
        expect.objectContaining({ credentials: "same-origin" })
      );
      expect(result.disabledModes).toEqual([]);
    });
  });

  describe("updateGameModeSettings", () => {
    it("sends PUT to /game-modes with disabledModes body", async () => {
      const settings = { modes: [], disabledModes: ["higher-lower"] };
      mockOk(settings);
      const result = await updateGameModeSettings(["higher-lower"]);
      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/admin/game-modes",
        expect.objectContaining({ method: "PUT", credentials: "same-origin" })
      );
      const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
      expect(body.disabledModes).toEqual(["higher-lower"]);
      expect(result.disabledModes).toEqual(["higher-lower"]);
    });

    it("sends empty array when no modes disabled", async () => {
      mockOk({ modes: [], disabledModes: [] });
      await updateGameModeSettings([]);
      const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
      expect(body.disabledModes).toEqual([]);
    });
  });

  // ===== User Management =====

  describe("getAdminUsers", () => {
    it("sends GET to /users with no params by default", async () => {
      mockOk({ users: [], total: 0, page: 1, pageSize: 50, totalPages: 0 });
      const result = await getAdminUsers();
      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/admin/users",
        expect.objectContaining({ credentials: "same-origin" })
      );
      expect(result.total).toBe(0);
    });

    it("sends GET with search, page, isActive, sortBy, sortOrder params", async () => {
      mockOk({ users: [], total: 2, page: 1, pageSize: 50, totalPages: 1 });
      await getAdminUsers({ search: "bob", page: 1, isActive: true, sortBy: "username", sortOrder: "asc" });
      const url = fetchSpy.mock.calls[0][0] as string;
      expect(url).toContain("search=bob");
      expect(url).toContain("isActive=true");
      expect(url).toContain("sortBy=username");
      expect(url).toContain("sortOrder=asc");
    });
  });

  describe("getAdminUser", () => {
    it("sends GET to /users/:id", async () => {
      const user = { id: "u55", username: "charlie", email: "c@ex.com", isActive: true };
      mockOk(user);
      const result = await getAdminUser("u55");
      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/admin/users/u55",
        expect.objectContaining({ credentials: "same-origin" })
      );
      expect(result.id).toBe("u55");
    });
  });

  describe("updateAdminUser", () => {
    it("sends PUT to /users/:id with data body", async () => {
      const user = { id: "u55", username: "charlie-updated", email: "c@ex.com", isActive: true };
      mockOk(user);
      const result = await updateAdminUser("u55", { username: "charlie-updated" });
      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/admin/users/u55",
        expect.objectContaining({ method: "PUT", credentials: "same-origin" })
      );
      const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
      expect(body.username).toBe("charlie-updated");
      expect(result.username).toBe("charlie-updated");
    });
  });

  describe("deleteAdminUser", () => {
    it("sends DELETE to /users/:id", async () => {
      mockOk({ ok: true });
      const result = await deleteAdminUser("u55");
      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/admin/users/u55",
        expect.objectContaining({ method: "DELETE", credentials: "same-origin" })
      );
      expect(result.ok).toBe(true);
    });

    it("throws when server returns an error", async () => {
      mockError(404, "User not found");
      await expect(deleteAdminUser("u99")).rejects.toThrow("User not found");
    });
  });

  describe("deactivateAdminUser", () => {
    it("sends POST to /users/:id/deactivate", async () => {
      const user = { id: "u55", username: "charlie", isActive: false };
      mockOk(user);
      const result = await deactivateAdminUser("u55");
      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/admin/users/u55/deactivate",
        expect.objectContaining({ method: "POST", credentials: "same-origin" })
      );
      expect(result.isActive).toBe(false);
    });
  });

  describe("reactivateAdminUser", () => {
    it("sends POST to /users/:id/reactivate", async () => {
      const user = { id: "u55", username: "charlie", isActive: true };
      mockOk(user);
      const result = await reactivateAdminUser("u55");
      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/admin/users/u55/reactivate",
        expect.objectContaining({ method: "POST", credentials: "same-origin" })
      );
      expect(result.isActive).toBe(true);
    });
  });

  describe("resetAdminUserPassword", () => {
    it("sends POST to /users/:id/reset-password and returns temporary password", async () => {
      mockOk({ temporaryPassword: "Temp1234!" });
      const result = await resetAdminUserPassword("u55");
      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/admin/users/u55/reset-password",
        expect.objectContaining({ method: "POST", credentials: "same-origin" })
      );
      expect(result.temporaryPassword).toBe("Temp1234!");
    });
  });

  describe("getAdminUserGameHistory", () => {
    it("sends GET to /users/:id/game-history with no params", async () => {
      mockOk({ games: [], total: 0, page: 1, pageSize: 20, totalPages: 0 });
      const result = await getAdminUserGameHistory("u55");
      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/admin/users/u55/game-history",
        expect.objectContaining({ credentials: "same-origin" })
      );
      expect(result.total).toBe(0);
    });

    it("appends page and pageSize when provided", async () => {
      mockOk({ games: [], total: 0, page: 2, pageSize: 10, totalPages: 0 });
      await getAdminUserGameHistory("u55", 2, 10);
      const url = fetchSpy.mock.calls[0][0] as string;
      expect(url).toContain("page=2");
      expect(url).toContain("pageSize=10");
    });
  });

  describe("getAdminUserStats", () => {
    it("sends GET to /users/:id/stats", async () => {
      const stats = { totalGames: 42, avgScore: 350, bestScore: 800, gamesThisMonth: 5 };
      mockOk(stats);
      const result = await getAdminUserStats("u55");
      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/admin/users/u55/stats",
        expect.objectContaining({ credentials: "same-origin" })
      );
      expect(result.totalGames).toBe(42);
    });
  });

  describe("getAdminUserActivity", () => {
    it("sends GET to /users/:id/activity without days by default", async () => {
      mockOk([{ date: "2026-03-01", gamesPlayed: 3 }]);
      const result = await getAdminUserActivity("u55");
      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/admin/users/u55/activity",
        expect.objectContaining({ credentials: "same-origin" })
      );
      expect(result[0].gamesPlayed).toBe(3);
    });

    it("appends days param when provided", async () => {
      mockOk([]);
      await getAdminUserActivity("u55", 14);
      const url = fetchSpy.mock.calls[0][0] as string;
      expect(url).toBe("/api/admin/users/u55/activity?days=14");
    });
  });

  // ===== Bulk product helpers (also uncovered) =====

  describe("bulkSetProductStatus", () => {
    it("sends PATCH to /products/bulk-status with ids and isActive", async () => {
      mockOk({ updated: 3 });
      const result = await bulkSetProductStatus([1, 2, 3], false);
      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/admin/products/bulk-status",
        expect.objectContaining({ method: "PATCH", credentials: "same-origin" })
      );
      const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
      expect(body.ids).toEqual([1, 2, 3]);
      expect(body.isActive).toBe(false);
      expect(result.updated).toBe(3);
    });
  });

  describe("bulkSetProductArchived", () => {
    it("sends PATCH to /products/bulk-archive with ids and isArchived", async () => {
      mockOk({ updated: 2 });
      const result = await bulkSetProductArchived([4, 5], true);
      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/admin/products/bulk-archive",
        expect.objectContaining({ method: "PATCH", credentials: "same-origin" })
      );
      const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
      expect(body.ids).toEqual([4, 5]);
      expect(body.isArchived).toBe(true);
      expect(result.updated).toBe(2);
    });
  });

  describe("setAdminProductArchived", () => {
    it("sends PATCH to /products/:id/archive", async () => {
      mockOk({ id: 7, isArchived: true });
      const result = await setAdminProductArchived(7, true);
      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/admin/products/7/archive",
        expect.objectContaining({ method: "PATCH", credentials: "same-origin" })
      );
      const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
      expect(body.isArchived).toBe(true);
      expect(result.id).toBe(7);
    });
  });

  // ===== Error handling =====

  describe("error handling", () => {
    it("throws Error with server error message on non-ok response", async () => {
      mockError(403, "Forbidden");
      await expect(getAdminUsers()).rejects.toThrow("Forbidden");
    });

    it("uses fallback message when server returns no error field", async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response("{}", { status: 500, headers: { "Content-Type": "application/json" } })
      );
      await expect(getAdminUsers()).rejects.toThrow("API error 500");
    });
  });
});
