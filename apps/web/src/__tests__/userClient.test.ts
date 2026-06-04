import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  userRegister,
  userLogin,
  userLogout,
  userGetMe,
  userUpdateEmail,
  userUpdatePassword,
  userResendVerification,
  userGetHistory,
  userGetStats,
} from "../api/userClient";

describe("User API client", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  function mockFetch(data: unknown, status = 200) {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify(data), {
        status,
        headers: { "Content-Type": "application/json" },
      })
    );
  }

  function mockFetchError(data: unknown, status: number) {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify(data), {
        status,
        headers: { "Content-Type": "application/json" },
      })
    );
  }

  const mockUser = {
    id: "user-1",
    username: "testuser",
    email: "test@example.com",
    emailVerified: true,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    lastLoginAt: null,
    isActive: true,
    lifetimeScore: 0,
  };

  describe("userRegister", () => {
    it("sends POST with username/email/password and returns user data", async () => {
      mockFetch({ user: mockUser, emailVerificationPending: true });
      const result = await userRegister("testuser", "test@example.com", "password123!");
      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/user/register",
        expect.objectContaining({
          method: "POST",
          credentials: "same-origin",
        })
      );
      const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
      expect(body.username).toBe("testuser");
      expect(body.email).toBe("test@example.com");
      expect(body.password).toBe("password123!");
      expect(result.user.username).toBe("testuser");
      expect(result.emailVerificationPending).toBe(true);
    });

    it("throws on validation error", async () => {
      mockFetchError({ error: "Username already taken" }, 400);
      await expect(userRegister("taken", "test@example.com", "password123!")).rejects.toThrow(
        "Username already taken"
      );
    });
  });

  describe("userLogin", () => {
    it("sends POST with identifier/password and returns user data", async () => {
      mockFetch({ user: mockUser });
      const result = await userLogin("testuser", "password123!");
      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/user/login",
        expect.objectContaining({
          method: "POST",
          credentials: "same-origin",
        })
      );
      const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
      expect(body.identifier).toBe("testuser");
      expect(body.password).toBe("password123!");
      expect(result.user.username).toBe("testuser");
    });

    it("throws on invalid credentials", async () => {
      mockFetchError({ error: "Invalid credentials" }, 401);
      await expect(userLogin("testuser", "wrong")).rejects.toThrow("Invalid credentials");
    });

    // ── Stay logged in ─────────────────────────────────────────────
    // The flag must be serialized into the JSON body only when the
    // caller explicitly set it. When omitted we leave the field off
    // entirely so the server's backwards-compat default kicks in.

    it("omits stayLoggedIn from the body when the caller does not pass it", async () => {
      mockFetch({ user: mockUser });
      await userLogin("testuser", "password123!");
      const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
      expect("stayLoggedIn" in body).toBe(false);
    });

    it("sends stayLoggedIn=true in the body", async () => {
      mockFetch({ user: mockUser });
      await userLogin("testuser", "password123!", true);
      const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
      expect(body.stayLoggedIn).toBe(true);
    });

    it("sends stayLoggedIn=false in the body", async () => {
      mockFetch({ user: mockUser });
      await userLogin("testuser", "password123!", false);
      const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
      expect(body.stayLoggedIn).toBe(false);
    });
  });

  describe("userLogout", () => {
    it("sends POST to /logout", async () => {
      mockFetch({});
      await userLogout();
      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/user/logout",
        expect.objectContaining({
          method: "POST",
          credentials: "same-origin",
        })
      );
    });
  });

  describe("userGetMe", () => {
    it("sends GET and returns user data", async () => {
      mockFetch({ user: mockUser });
      const result = await userGetMe();
      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/user/me",
        expect.objectContaining({
          credentials: "same-origin",
        })
      );
      expect(result.user.id).toBe("user-1");
      expect(result.user.username).toBe("testuser");
    });

    it("throws on 401", async () => {
      mockFetchError({ error: "Not authenticated" }, 401);
      await expect(userGetMe()).rejects.toThrow("Not authenticated");
    });
  });

  describe("userUpdateEmail", () => {
    it("sends PUT with new email and password", async () => {
      mockFetch({ user: { ...mockUser, email: "new@example.com" } });
      const result = await userUpdateEmail("new@example.com", "password123!");
      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/user/email",
        expect.objectContaining({
          method: "PUT",
          credentials: "same-origin",
        })
      );
      const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
      expect(body.newEmail).toBe("new@example.com");
      expect(body.password).toBe("password123!");
      expect(result.user.email).toBe("new@example.com");
    });

    it("throws on invalid password", async () => {
      mockFetchError({ error: "Invalid password" }, 401);
      await expect(userUpdateEmail("new@example.com", "wrong")).rejects.toThrow("Invalid password");
    });
  });

  describe("userUpdatePassword", () => {
    it("sends PUT with current and new password", async () => {
      mockFetch({});
      await userUpdatePassword("oldpass1234", "newpass12345");
      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/user/password",
        expect.objectContaining({
          method: "PUT",
          credentials: "same-origin",
        })
      );
      const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
      expect(body.currentPassword).toBe("oldpass1234");
      expect(body.newPassword).toBe("newpass12345");
    });

    it("throws on invalid current password", async () => {
      mockFetchError({ error: "Invalid current password" }, 401);
      await expect(userUpdatePassword("wrong", "newpass12345")).rejects.toThrow("Invalid current password");
    });
  });

  describe("userResendVerification", () => {
    it("sends POST to /resend-verification", async () => {
      mockFetch({});
      await userResendVerification();
      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/user/resend-verification",
        expect.objectContaining({
          method: "POST",
          credentials: "same-origin",
        })
      );
    });
  });

  describe("userGetHistory", () => {
    it("sends GET with query parameters", async () => {
      mockFetch({ entries: [], total: 0 });
      await userGetHistory(10, 20, "single");
      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/user/history?limit=10&offset=20&gameType=single",
        expect.objectContaining({
          credentials: "same-origin",
        })
      );
    });

    it("sends GET without query parameters when none provided", async () => {
      mockFetch({ entries: [], total: 0 });
      await userGetHistory();
      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/user/history",
        expect.objectContaining({
          credentials: "same-origin",
        })
      );
    });

    it("returns entries and total", async () => {
      const mockEntries = [
        { id: 1, gameType: "single", gameMode: "classic", score: 500, placement: null, playersCount: null, playedAt: "2026-03-10T12:00:00Z" },
      ];
      mockFetch({ entries: mockEntries, total: 1 });
      const result = await userGetHistory();
      expect(result.entries).toHaveLength(1);
      expect(result.total).toBe(1);
    });
  });

  describe("userGetStats", () => {
    it("sends GET to /stats", async () => {
      const mockStats = { totalGames: 10, totalScore: 5000, bestScore: 900, averageScore: 500, gamesByMode: { classic: 5 }, multiplayerWins: 2 };
      mockFetch(mockStats);
      const result = await userGetStats();
      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/user/stats",
        expect.objectContaining({
          credentials: "same-origin",
        })
      );
      expect(result.totalGames).toBe(10);
      expect(result.bestScore).toBe(900);
    });
  });
});
