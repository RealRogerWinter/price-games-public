import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { AdminAuthProvider, useAdminAuth } from "../context/AdminAuthContext";
import type { AdminUser } from "@price-game/shared";

vi.mock("../api/adminClient", () => ({
  adminLogin: vi.fn(),
  adminLogout: vi.fn(),
  adminGetMe: vi.fn(),
}));

import { adminLogin, adminLogout, adminGetMe } from "../api/adminClient";
const mockLogin = vi.mocked(adminLogin);
const mockLogout = vi.mocked(adminLogout);
const mockGetMe = vi.mocked(adminGetMe);

const fakeAdmin: AdminUser = {
  id: "admin-1",
  username: "testadmin",
  createdAt: "2025-01-01T00:00:00Z",
  updatedAt: "2025-01-01T00:00:00Z",
  lastLoginAt: null,
  isActive: true,
};

function wrapper({ children }: { children: React.ReactNode }) {
  return <AdminAuthProvider>{children}</AdminAuthProvider>;
}

describe("AdminAuthContext", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetMe.mockResolvedValue({ user: fakeAdmin });
  });

  it("starts with user=null, isAuthenticated=false, loading=true", () => {
    // Prevent getMe from resolving during this test so loading stays true
    mockGetMe.mockReturnValue(new Promise(() => {}));

    const { result } = renderHook(() => useAdminAuth(), { wrapper });

    expect(result.current.user).toBeNull();
    expect(result.current.isAuthenticated).toBe(false);
    expect(result.current.loading).toBe(true);
  });

  it("checks session on mount by calling getMe()", () => {
    renderHook(() => useAdminAuth(), { wrapper });

    expect(mockGetMe).toHaveBeenCalledTimes(1);
  });

  it("sets user and isAuthenticated=true after successful session check", async () => {
    const { result } = renderHook(() => useAdminAuth(), { wrapper });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.user).toEqual(fakeAdmin);
    expect(result.current.isAuthenticated).toBe(true);
  });

  it("login() calls API and sets user on success", async () => {
    mockGetMe.mockRejectedValue(new Error("401"));
    mockLogin.mockResolvedValue({ user: fakeAdmin });

    const { result } = renderHook(() => useAdminAuth(), { wrapper });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    await act(async () => {
      await result.current.login("testadmin", "password123");
    });

    expect(mockLogin).toHaveBeenCalledWith("testadmin", "password123");
    expect(result.current.user).toEqual(fakeAdmin);
    expect(result.current.isAuthenticated).toBe(true);
    expect(result.current.error).toBeNull();
  });

  it("login() sets error on failure", async () => {
    mockGetMe.mockRejectedValue(new Error("401"));
    mockLogin.mockRejectedValue(new Error("Invalid credentials"));

    const { result } = renderHook(() => useAdminAuth(), { wrapper });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    await act(async () => {
      await expect(result.current.login("bad", "creds")).rejects.toThrow("Invalid credentials");
    });

    expect(result.current.error).toBe("Invalid credentials");
    expect(result.current.user).toBeNull();
    expect(result.current.isAuthenticated).toBe(false);
  });

  it("logout() calls API and clears user", async () => {
    mockLogout.mockResolvedValue(undefined);

    const { result } = renderHook(() => useAdminAuth(), { wrapper });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    // User should be set from getMe
    expect(result.current.user).toEqual(fakeAdmin);

    await act(async () => {
      await result.current.logout();
    });

    expect(mockLogout).toHaveBeenCalledTimes(1);
    expect(result.current.user).toBeNull();
    expect(result.current.isAuthenticated).toBe(false);
  });

  it("sets loading=false after session check completes", async () => {
    const { result } = renderHook(() => useAdminAuth(), { wrapper });

    // Initially loading
    expect(result.current.loading).toBe(true);

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
  });

  it("handles 401 from getMe() gracefully (no user, no error)", async () => {
    mockGetMe.mockRejectedValue(new Error("401"));

    const { result } = renderHook(() => useAdminAuth(), { wrapper });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.user).toBeNull();
    expect(result.current.isAuthenticated).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it("throws when useAdminAuth is used outside provider", () => {
    expect(() => {
      renderHook(() => useAdminAuth());
    }).toThrow("useAdminAuth must be used within an AdminAuthProvider");
  });
});
