import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from "react";
import type { AdminUser } from "@price-game/shared";
import { adminLogin as apiLogin, adminLogout as apiLogout, adminGetMe, adminVerify2fa as apiVerify2fa } from "../api/adminClient";

interface PendingTwoFactor {
  pendingToken: string;
  user: AdminUser;
}

interface AdminAuthContextValue {
  user: AdminUser | null;
  isAuthenticated: boolean;
  loading: boolean;
  error: string | null;
  pendingTwoFactor: PendingTwoFactor | null;
  needsTotpSetup: boolean;
  login: (username: string, password: string) => Promise<void>;
  verify2fa: (code: string, isRecoveryCode?: boolean) => Promise<void>;
  cancelTwoFactor: () => void;
  logout: () => Promise<void>;
  refreshUser: () => Promise<void>;
}

const AdminAuthContext = createContext<AdminAuthContextValue | null>(null);

/**
 * Provides admin authentication state to the component tree.
 * Checks for an existing session on mount via adminGetMe().
 * @param children - React children to render within the provider.
 */
export function AdminAuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AdminUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pendingTwoFactor, setPendingTwoFactor] = useState<PendingTwoFactor | null>(null);
  // Whether the server is signaling `skip2fa` — true only on sandbox/dev
  // deployments that run with SKIP_ADMIN_2FA=1. Gates the mandatory 2FA
  // enrollment redirect in ProtectedRoute.
  const [skip2fa, setSkip2fa] = useState(false);

  useEffect(() => {
    adminGetMe()
      .then((res) => {
        setUser(res.user);
        setSkip2fa(Boolean(res.skip2fa));
      })
      .catch((err: unknown) => {
        if (err instanceof Error && err.message.includes("401")) {
          return;
        }
      })
      .finally(() => {
        setLoading(false);
      });
  }, []);

  /**
   * Logs in with username and password. If 2FA is required, sets pendingTwoFactor
   * state instead of user state.
   */
  const login = useCallback(async (username: string, password: string): Promise<void> => {
    try {
      setError(null);
      setPendingTwoFactor(null);
      const res = await apiLogin(username, password);

      setSkip2fa(Boolean(res.skip2fa));
      if (res.requiresTwoFactor && res.pendingToken) {
        setPendingTwoFactor({ pendingToken: res.pendingToken, user: res.user });
      } else {
        setUser(res.user);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Login failed";
      setError(message);
      throw err;
    }
  }, []);

  /**
   * Completes 2FA verification. On success, sets user state and clears pending state.
   */
  const verify2fa = useCallback(async (code: string, isRecoveryCode?: boolean): Promise<void> => {
    if (!pendingTwoFactor) throw new Error("No pending 2FA verification");
    try {
      setError(null);
      const res = await apiVerify2fa(pendingTwoFactor.pendingToken, code, isRecoveryCode);
      setUser(res.user);
      setPendingTwoFactor(null);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Verification failed";
      setError(message);
      throw err;
    }
  }, [pendingTwoFactor]);

  /**
   * Cancels the pending 2FA flow, returning to the login form.
   */
  const cancelTwoFactor = useCallback(() => {
    setPendingTwoFactor(null);
    setError(null);
  }, []);

  /**
   * Refreshes the current admin user from the server.
   */
  const refreshUser = useCallback(async (): Promise<void> => {
    try {
      const res = await adminGetMe();
      setUser(res.user);
      setSkip2fa(Boolean(res.skip2fa));
    } catch (err: unknown) {
      // Only clear session on 401 (unauthorized); transient errors leave state unchanged
      if (err instanceof Error && err.message.includes("401")) {
        setUser(null);
      }
    }
  }, []);

  /**
   * Logs out the current admin user, clearing local state.
   */
  const logout = useCallback(async (): Promise<void> => {
    try {
      setError(null);
      await apiLogout();
      setUser(null);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Logout failed";
      setError(message);
      throw err;
    }
  }, []);

  return (
    <AdminAuthContext.Provider
      value={{
        user,
        isAuthenticated: user !== null,
        loading,
        error,
        pendingTwoFactor,
        needsTotpSetup: user !== null && !user.totpEnabled && !skip2fa,
        login,
        verify2fa,
        cancelTwoFactor,
        logout,
        refreshUser,
      }}
    >
      {children}
    </AdminAuthContext.Provider>
  );
}

/**
 * Returns the admin auth context value. Must be used within an AdminAuthProvider.
 * @returns The current AdminAuthContextValue.
 * @throws If called outside of an AdminAuthProvider.
 */
export function useAdminAuth(): AdminAuthContextValue {
  const context = useContext(AdminAuthContext);
  if (context === null) {
    throw new Error("useAdminAuth must be used within an AdminAuthProvider");
  }
  return context;
}
