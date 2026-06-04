import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { UserAuthProvider, useUserAuth } from "../context/UserAuthContext";
import type { UserAccount } from "@price-game/shared";

vi.mock("../api/userClient", () => ({
  userLogin: vi.fn(),
  userLogout: vi.fn(),
  userGetMe: vi.fn(),
  userRegister: vi.fn(),
  userGetOAuthProviders: vi.fn().mockResolvedValue({ google: false, facebook: false }),
  userAttributeSignup: vi.fn().mockResolvedValue({ wasAttributed: false }),
}));

vi.mock("../utils/redditPixel", () => ({
  loadRedditPixel: vi.fn(),
  grantRedditConsent: vi.fn(),
  revokeRedditConsent: vi.fn(),
  trackRedditEvent: vi.fn(),
}));

import {
  userLogin,
  userLogout,
  userGetMe,
  userRegister,
  userAttributeSignup,
} from "../api/userClient";
import { trackRedditEvent } from "../utils/redditPixel";
const mockLogin = vi.mocked(userLogin);
const mockLogout = vi.mocked(userLogout);
const mockGetMe = vi.mocked(userGetMe);
const mockRegister = vi.mocked(userRegister);
const mockAttributeSignup = vi.mocked(userAttributeSignup);
const mockTrackRedditEvent = vi.mocked(trackRedditEvent);

const fakeUser: UserAccount = {
  id: "user-1",
  username: "testuser",
  email: "test@example.com",
  emailVerified: true,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  lastLoginAt: null,
  isActive: true,
  lifetimeScore: 5000,
  referralCode: "TEST1234",
  usernamePending: false,
};

function wrapper({ children }: { children: React.ReactNode }) {
  return <UserAuthProvider>{children}</UserAuthProvider>;
}

describe("UserAuthContext", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    mockGetMe.mockResolvedValue({ user: fakeUser });
    mockAttributeSignup.mockResolvedValue({ wasAttributed: false });
  });

  it("starts with user=null, isAuthenticated=false, loading=true", () => {
    mockGetMe.mockReturnValue(new Promise(() => {}));

    const { result } = renderHook(() => useUserAuth(), { wrapper });

    expect(result.current.user).toBeNull();
    expect(result.current.isAuthenticated).toBe(false);
    expect(result.current.loading).toBe(true);
  });

  it("checks session on mount by calling getMe()", () => {
    renderHook(() => useUserAuth(), { wrapper });

    expect(mockGetMe).toHaveBeenCalledTimes(1);
  });

  it("sets user and isAuthenticated=true after successful session check", async () => {
    const { result } = renderHook(() => useUserAuth(), { wrapper });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.user).toEqual(fakeUser);
    expect(result.current.isAuthenticated).toBe(true);
  });

  it("login() calls API and sets user on success", async () => {
    mockGetMe.mockRejectedValue(new Error("401"));
    mockLogin.mockResolvedValue({ user: fakeUser });

    const { result } = renderHook(() => useUserAuth(), { wrapper });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    await act(async () => {
      await result.current.login("testuser", "password123!");
    });

    // When the caller omits stayLoggedIn the context forwards it as
    // undefined — the api client drops undefined from the body so the
    // server applies its backwards-compat default (persistent cookie).
    expect(mockLogin).toHaveBeenCalledWith("testuser", "password123!", undefined);
    expect(result.current.user).toEqual(fakeUser);
    expect(result.current.isAuthenticated).toBe(true);
    expect(result.current.error).toBeNull();
  });

  // The stay-logged-in toggle originates in LoginForm; the context is a
  // thin pass-through. These two cases lock in that contract so future
  // refactors can't silently drop the flag.

  it("login() forwards stayLoggedIn=true to the API", async () => {
    mockGetMe.mockRejectedValue(new Error("401"));
    mockLogin.mockResolvedValue({ user: fakeUser });

    const { result } = renderHook(() => useUserAuth(), { wrapper });
    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    await act(async () => {
      await result.current.login("testuser", "password123!", true);
    });

    expect(mockLogin).toHaveBeenCalledWith("testuser", "password123!", true);
  });

  it("login() forwards stayLoggedIn=false to the API", async () => {
    mockGetMe.mockRejectedValue(new Error("401"));
    mockLogin.mockResolvedValue({ user: fakeUser });

    const { result } = renderHook(() => useUserAuth(), { wrapper });
    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    await act(async () => {
      await result.current.login("testuser", "password123!", false);
    });

    expect(mockLogin).toHaveBeenCalledWith("testuser", "password123!", false);
  });

  it("login() sets error on failure", async () => {
    mockGetMe.mockRejectedValue(new Error("401"));
    mockLogin.mockRejectedValue(new Error("Invalid credentials"));

    const { result } = renderHook(() => useUserAuth(), { wrapper });

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

  it("register() calls API and sets user on success (auto-login)", async () => {
    mockGetMe.mockRejectedValue(new Error("401"));
    mockRegister.mockResolvedValue({ user: fakeUser, emailVerificationPending: true });

    const { result } = renderHook(() => useUserAuth(), { wrapper });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    await act(async () => {
      await result.current.register("testuser", "test@example.com", "password123!");
    });

    expect(mockRegister).toHaveBeenCalledWith(
      "testuser",
      "test@example.com",
      "password123!",
      { referralCode: undefined, turnstileToken: undefined, attribution: null },
    );
    expect(result.current.user).toEqual(fakeUser);
    expect(result.current.isAuthenticated).toBe(true);
  });

  it("register() sets error on failure", async () => {
    mockGetMe.mockRejectedValue(new Error("401"));
    mockRegister.mockRejectedValue(new Error("Username already taken"));

    const { result } = renderHook(() => useUserAuth(), { wrapper });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    await act(async () => {
      await expect(result.current.register("taken", "test@example.com", "password123!")).rejects.toThrow(
        "Username already taken"
      );
    });

    expect(result.current.error).toBe("Username already taken");
    expect(result.current.user).toBeNull();
  });

  it("logout() calls API and clears user", async () => {
    mockLogout.mockResolvedValue(undefined);

    const { result } = renderHook(() => useUserAuth(), { wrapper });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.user).toEqual(fakeUser);

    await act(async () => {
      await result.current.logout();
    });

    expect(mockLogout).toHaveBeenCalledTimes(1);
    expect(result.current.user).toBeNull();
    expect(result.current.isAuthenticated).toBe(false);
  });

  it("sets loading=false after session check completes", async () => {
    const { result } = renderHook(() => useUserAuth(), { wrapper });

    expect(result.current.loading).toBe(true);

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
  });

  it("handles 401 from getMe() gracefully (no user, no error)", async () => {
    mockGetMe.mockRejectedValue(new Error("401"));

    const { result } = renderHook(() => useUserAuth(), { wrapper });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.user).toBeNull();
    expect(result.current.isAuthenticated).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it("updateUser() updates the local user state", async () => {
    const { result } = renderHook(() => useUserAuth(), { wrapper });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    const updatedUser = { ...fakeUser, email: "new@example.com" };
    act(() => {
      result.current.updateUser(updatedUser);
    });

    expect(result.current.user?.email).toBe("new@example.com");
  });

  it("throws when useUserAuth is used outside provider", () => {
    expect(() => {
      renderHook(() => useUserAuth());
    }).toThrow("useUserAuth must be used within a UserAuthProvider");
  });

  // ── OAuth UTM attribution trigger ──────────────────────────────────

  it("calls attribute-signup when authentication flips true with stored attribution", async () => {
    sessionStorage.setItem(
      "utm_attribution",
      JSON.stringify({ utm_source: "reddit", utm_campaign: "oauth" }),
    );
    mockAttributeSignup.mockResolvedValue({ wasAttributed: true });

    renderHook(() => useUserAuth(), { wrapper });

    await waitFor(() => {
      expect(mockAttributeSignup).toHaveBeenCalledWith({
        utm_source: "reddit",
        utm_campaign: "oauth",
      });
    });
  });

  it("fires Reddit SignUp event and clears attribution when wasAttributed is true", async () => {
    sessionStorage.setItem(
      "utm_attribution",
      JSON.stringify({ utm_source: "reddit" }),
    );
    mockAttributeSignup.mockResolvedValue({ wasAttributed: true });

    renderHook(() => useUserAuth(), { wrapper });

    await waitFor(() => {
      expect(mockTrackRedditEvent).toHaveBeenCalledWith("SignUp");
    });
    await waitFor(() => {
      expect(sessionStorage.getItem("utm_attribution")).toBeNull();
    });
  });

  it("does not fire SignUp event when wasAttributed is false (e.g. user already attributed)", async () => {
    sessionStorage.setItem(
      "utm_attribution",
      JSON.stringify({ utm_source: "reddit" }),
    );
    mockAttributeSignup.mockResolvedValue({ wasAttributed: false });

    renderHook(() => useUserAuth(), { wrapper });

    await waitFor(() => {
      expect(mockAttributeSignup).toHaveBeenCalled();
    });
    expect(mockTrackRedditEvent).not.toHaveBeenCalled();
    // Stale attribution is still cleared so it doesn't keep retrying
    expect(sessionStorage.getItem("utm_attribution")).toBeNull();
  });

  it("does not call attribute-signup when nothing is stored", async () => {
    const { result } = renderHook(() => useUserAuth(), { wrapper });

    await waitFor(() => {
      expect(result.current.isAuthenticated).toBe(true);
    });

    expect(mockAttributeSignup).not.toHaveBeenCalled();
  });

  it("does not call attribute-signup when unauthenticated", async () => {
    mockGetMe.mockRejectedValue(new Error("401"));
    sessionStorage.setItem(
      "utm_attribution",
      JSON.stringify({ utm_source: "reddit" }),
    );

    const { result } = renderHook(() => useUserAuth(), { wrapper });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(mockAttributeSignup).not.toHaveBeenCalled();
    expect(sessionStorage.getItem("utm_attribution")).not.toBeNull();
  });
});
