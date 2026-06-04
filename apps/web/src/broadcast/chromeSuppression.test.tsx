/**
 * Tests for the chrome-suppression guards in broadcast mode.
 *
 * In broadcast mode (?broadcast=1) the cookie banner, notification prompt,
 * iOS install prompt, and auth modal must all early-return null so the
 * livestream feed stays free of dismissable banners and CTAs the bot
 * cannot interact with.
 *
 * These guards are belt-and-suspenders alongside the CSS `display: none`
 * rules in broadcast.css — the React-level suppression also prevents the
 * components from running their side-effectful useEffects (push subscribe,
 * permission queries, etc.) on the bot's session.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render } from "@testing-library/react";

function setSearch(search: string): void {
  window.history.replaceState(null, "", `/${search}`);
}

vi.mock("../context/UserAuthContext", () => ({
  useUserAuth: () => ({
    isAuthenticated: false,
    user: null,
    usernamePending: false,
    updateUser: vi.fn(),
  }),
  UserAuthProvider: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock("../hooks/usePushNotifications", () => ({
  usePushNotifications: () => ({
    isSupported: true,
    permission: "default" as const,
    isSubscribed: false,
    subscribe: vi.fn(),
    loading: false,
  }),
}));

vi.mock("../utils/cookieConsent", () => ({
  getPreferences: () => ({ consented: false, necessary: true, analytics: false }),
  savePreferences: vi.fn(),
}));

vi.mock("../utils/analytics", () => ({
  grantAnalyticsConsent: vi.fn(),
  revokeAnalyticsConsent: vi.fn(),
}));

vi.mock("../utils/redditPixel", () => ({
  grantRedditConsent: vi.fn(),
  revokeRedditConsent: vi.fn(),
}));

vi.mock("../utils/attribution", () => ({
  captureUtmFromUrl: vi.fn(),
  trackAttributionOnServer: vi.fn(() => Promise.resolve()),
}));

vi.mock("../context/GamePauseContext", () => ({
  useGamePause: () => ({ pause: vi.fn(), resume: vi.fn() }),
}));

import CookieConsent from "../components/CookieConsent";
import NotificationPrompt from "../components/NotificationPrompt";
import IOSInstallPrompt from "../components/IOSInstallPrompt";
import AuthModal from "../components/auth/AuthModal";
import { MemoryRouter } from "react-router-dom";

describe("chrome suppression in broadcast mode", () => {
  beforeEach(() => {
    setSearch("");
  });

  describe("CookieConsent", () => {
    it("renders the banner when not in broadcast mode", () => {
      setSearch("");
      const { container } = render(<CookieConsent />);
      // Banner shows when consented=false (mocked above).
      expect(container.querySelector(".cookie-banner")).not.toBeNull();
    });

    it("renders nothing when broadcast mode is active", () => {
      setSearch("?broadcast=1");
      const { container } = render(<CookieConsent />);
      expect(container.querySelector(".cookie-banner")).toBeNull();
      expect(container.querySelector(".cookie-modal-overlay")).toBeNull();
    });
  });

  describe("NotificationPrompt", () => {
    it("renders nothing when broadcast mode is active", () => {
      setSearch("?broadcast=1");
      const { container } = render(<NotificationPrompt />);
      expect(container.querySelector(".notif-prompt-overlay")).toBeNull();
    });
  });

  describe("IOSInstallPrompt", () => {
    it("renders nothing when broadcast mode is active", () => {
      setSearch("?broadcast=1");
      const { container } = render(<IOSInstallPrompt />);
      expect(container.querySelector(".ios-install-overlay")).toBeNull();
    });
  });

  describe("AuthModal", () => {
    it("renders nothing when broadcast mode is active", () => {
      setSearch("?broadcast=1");
      const { container } = render(
        <MemoryRouter>
          <AuthModal onClose={vi.fn()} />
        </MemoryRouter>,
      );
      expect(container.querySelector(".auth-modal-overlay")).toBeNull();
    });
  });
});
