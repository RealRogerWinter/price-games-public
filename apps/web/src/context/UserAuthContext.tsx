import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from "react";
import type { UserAccount } from "@price-game/shared";
import {
  userLogin as apiLogin,
  userLogout as apiLogout,
  userGetMe,
  userRegister as apiRegister,
  userGetOAuthProviders,
  userAttributeSignup,
} from "../api/userClient";
import {
  getStoredAttribution,
  clearStoredAttribution,
  type Attribution,
} from "../utils/attribution";
import { trackRedditEvent } from "../utils/redditPixel";

interface OAuthProviders {
  google: boolean;
  facebook: boolean;
  amazon: boolean;
}

interface UserAuthContextValue {
  user: UserAccount | null;
  isAuthenticated: boolean;
  loading: boolean;
  error: string | null;
  oauthProviders: OAuthProviders;
  login: (identifier: string, password: string, stayLoggedIn?: boolean) => Promise<void>;
  logout: () => Promise<void>;
  register: (
    username: string,
    email: string,
    password: string,
    options?: {
      referralCode?: string;
      turnstileToken?: string;
    },
  ) => Promise<void>;
  updateUser: (user: UserAccount) => void;
  refreshUser: () => Promise<void>;
  usernamePending: boolean;
}

const UserAuthContext = createContext<UserAuthContextValue | null>(null);

/**
 * Provides user authentication state to the component tree.
 * Checks for an existing session on mount via userGetMe().
 * @param children - React children to render within the provider.
 */
export function UserAuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<UserAccount | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [oauthProviders, setOAuthProviders] = useState<OAuthProviders>({ google: false, facebook: false, amazon: false });

  useEffect(() => {
    userGetMe()
      .then((res) => {
        if (res.user) setUser(res.user);
      })
      .catch(() => {
        // Network errors — user stays unauthenticated
      })
      .finally(() => {
        setLoading(false);
      });

    userGetOAuthProviders()
      .then(setOAuthProviders)
      .catch(() => {
        // Silently fail — buttons stay hidden
      });
  }, []);

  // OAuth UTM attribution: when the user becomes authenticated and we
  // still have a stored attribution payload, post it to /attribute-signup.
  // This catches the OAuth redirect path, where the server can't carry
  // attribution through the provider callback. First-touch wins is
  // enforced server-side; this useEffect clears local storage after the
  // call regardless so we don't keep retrying.
  useEffect(() => {
    if (user === null) return;

    const attribution = getStoredAttribution();
    if (attribution === null) return;

    // Attribution has `string | undefined` fields; JSON serialization drops
    // undefined values, which matches the server's validation contract.
    userAttributeSignup(attribution as Partial<Record<string, string>>)
      .then((res) => {
        if (res.wasAttributed) {
          trackRedditEvent("SignUp");
        }
      })
      .catch((err) => {
        console.error("[attribute-signup] Failed:", err);
      })
      .finally(() => {
        // Always clear — success or failure, we don't want to retry on every
        // auth state change.
        clearStoredAttribution();
      });
  }, [user]);

  /**
   * Logs in with identifier (email or username) and password, setting user state on success.
   * @param identifier - Email or username.
   * @param password - User password.
   * @param stayLoggedIn - Optional "stay logged in" flag forwarded to the
   *                      server. When omitted the server applies its
   *                      backwards-compat default (persistent cookie).
   */
  const login = useCallback(async (
    identifier: string,
    password: string,
    stayLoggedIn?: boolean,
  ): Promise<void> => {
    try {
      setError(null);
      const res = await apiLogin(identifier, password, stayLoggedIn);
      setUser(res.user);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Login failed";
      setError(message);
      throw err;
    }
  }, []);

  /**
   * Logs out the current user, clearing local state.
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

  /**
   * Registers a new user account and auto-logs in by setting user from response.
   *
   * Attribution is handled **atomically** here: we read stored attribution
   * and clear sessionStorage BEFORE awaiting the API call, so the OAuth
   * `[user]` useEffect below cannot also fire a duplicate /attribute-signup
   * call after setUser triggers a re-render. On failure we restore
   * sessionStorage so the user can retry (including via OAuth).
   *
   * @param username - Desired username.
   * @param email - User email address.
   * @param password - User password.
   * @param options - Optional referral code and Turnstile token. Attribution
   *                  is read from sessionStorage automatically.
   */
  const register = useCallback(
    async (
      username: string,
      email: string,
      password: string,
      options?: {
        referralCode?: string;
        turnstileToken?: string;
      },
    ): Promise<void> => {
      // Snapshot & clear attribution BEFORE awaiting to prevent the
      // OAuth [user] useEffect from double-firing /attribute-signup.
      const attribution = getStoredAttribution();
      if (attribution !== null) {
        clearStoredAttribution();
      }

      try {
        setError(null);
        const res = await apiRegister(username, email, password, {
          referralCode: options?.referralCode,
          turnstileToken: options?.turnstileToken,
          attribution: attribution as Partial<Record<string, string>> | null,
        });
        setUser(res.user);
        // Attribution (if any) was written server-side during /register.
        // Fire the Reddit SignUp conversion event — no-op if the pixel
        // isn't loaded or consent is denied.
        if (attribution !== null) {
          trackRedditEvent("SignUp");
        }
      } catch (err: unknown) {
        // Restore attribution so the user can retry (e.g. via OAuth)
        // with the original campaign source still intact.
        if (attribution !== null) {
          try {
            sessionStorage.setItem(
              "utm_attribution",
              JSON.stringify(attribution),
            );
          } catch {
            /* storage disabled — attribution lost, acceptable */
          }
        }
        const message = err instanceof Error ? err.message : "Registration failed";
        setError(message);
        throw err;
      }
    },
    [],
  );

  /**
   * Updates the local user state directly (e.g., after email/password change).
   * @param updatedUser - The updated user object.
   */
  const updateUser = useCallback((updatedUser: UserAccount) => {
    setUser(updatedUser);
  }, []);

  /**
   * Re-fetches the current user from the server to refresh stale data
   * (e.g., lifetime score after a game).
   */
  const refreshUser = useCallback(async () => {
    try {
      const res = await userGetMe();
      if (res.user) setUser(res.user);
    } catch {
      // Silently fail — user stays with cached data
    }
  }, []);

  return (
    <UserAuthContext.Provider
      value={{
        user,
        isAuthenticated: user !== null,
        loading,
        error,
        oauthProviders,
        login,
        logout,
        register,
        updateUser,
        refreshUser,
        usernamePending: user?.usernamePending ?? false,
      }}
    >
      {children}
    </UserAuthContext.Provider>
  );
}

/**
 * Returns the user auth context value. Must be used within a UserAuthProvider.
 * @returns The current UserAuthContextValue.
 * @throws If called outside of a UserAuthProvider.
 */
export function useUserAuth(): UserAuthContextValue {
  const context = useContext(UserAuthContext);
  if (context === null) {
    throw new Error("useUserAuth must be used within a UserAuthProvider");
  }
  return context;
}
