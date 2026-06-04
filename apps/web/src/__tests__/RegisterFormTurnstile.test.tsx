/**
 * Regression tests for Turnstile widget rendering when the site key IS configured.
 *
 * This file is separate from RegisterForm.test.tsx because VITE_TURNSTILE_SITE_KEY
 * is read at module scope — we need to stub the env var before the component loads.
 * If the key is ever missing from .env.production again, the build-time config test
 * (envProductionConfig.test.ts) catches it; these tests verify the component-level
 * rendering contract.
 */

import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import { screen, fireEvent, waitFor, render } from "@testing-library/react";

// Stub the env var BEFORE importing the component so the module-level constant
// picks up the value. vi.stubEnv must run before the dynamic import.
beforeAll(() => {
  vi.stubEnv("VITE_TURNSTILE_SITE_KEY", "0xTEST_SITE_KEY");
});

vi.mock("../api/userClient", () => ({
  userGetMe: vi.fn(),
  userLogin: vi.fn(),
  userLogout: vi.fn(),
  userRegister: vi.fn(),
  userGetOAuthProviders: vi.fn(),
  userAttributeSignup: vi.fn().mockResolvedValue({ wasAttributed: false }),
}));

vi.mock("../utils/redditPixel", () => ({
  loadRedditPixel: vi.fn(),
  grantRedditConsent: vi.fn(),
  revokeRedditConsent: vi.fn(),
  trackRedditEvent: vi.fn(),
}));

import {
  userGetMe,
  userRegister,
  userGetOAuthProviders,
} from "../api/userClient";
import { UserAuthProvider } from "../context/UserAuthContext";
import { makeUser } from "./testUtils";

const mockGetMe = vi.mocked(userGetMe);
const mockRegister = vi.mocked(userRegister);
const mockGetOAuthProviders = vi.mocked(userGetOAuthProviders);

// Dynamically import after env stub. The import at module top would also work
// in Vitest since vi.stubEnv in beforeAll runs before module evaluation in the
// same file, but the dynamic import makes the dependency chain explicit.
let RegisterForm: typeof import("../components/auth/RegisterForm").default;

beforeAll(async () => {
  const mod = await import("../components/auth/RegisterForm");
  RegisterForm = mod.default;
});

function renderRegisterForm() {
  const onSwitchToLogin = vi.fn();
  const result = render(
    <UserAuthProvider>
      <RegisterForm onSwitchToLogin={onSwitchToLogin} />
    </UserAuthProvider>
  );
  return { ...result, onSwitchToLogin };
}

describe("RegisterForm — Turnstile widget with site key configured", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    mockGetMe.mockRejectedValue(new Error("401"));
    mockGetOAuthProviders.mockResolvedValue({ google: false, facebook: false });

    // Provide a minimal turnstile stub on window so the component's
    // useEffect can call render() without errors.
    (window as any).turnstile = {
      render: vi.fn().mockReturnValue("widget-123"),
      reset: vi.fn(),
      remove: vi.fn(),
    };
  });

  it("renders the Turnstile widget container when site key is configured", async () => {
    renderRegisterForm();
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Create Account" })).toBeInTheDocument();
    });
    expect(screen.getByTestId("turnstile-widget")).toBeInTheDocument();
  });

  it("calls window.turnstile.render with the site key", async () => {
    renderRegisterForm();
    await waitFor(() => {
      expect((window as any).turnstile.render).toHaveBeenCalled();
    });
    const renderCall = (window as any).turnstile.render.mock.calls[0];
    expect(renderCall[1].sitekey).toBe("0xTEST_SITE_KEY");
  });

  it("hides the Turnstile widget when /api/user/auth-config reports the challenge is disabled", async () => {
    // Sandbox posture: server has SKIP_TURNSTILE=1 so auth-config reports
    // turnstileEnabled=false. Even though VITE_TURNSTILE_SITE_KEY is set at
    // build time, the widget should NOT render.
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.includes("/api/user/auth-config")) {
        return new Response(JSON.stringify({ turnstileEnabled: false }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    });

    renderRegisterForm();

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/user/auth-config",
        expect.any(Object),
      );
    });
    await waitFor(() => {
      expect(screen.queryByTestId("turnstile-widget")).not.toBeInTheDocument();
    });
    expect((window as any).turnstile.render).not.toHaveBeenCalled();

    fetchSpy.mockRestore();
  });

  it("includes the Turnstile token in the register call after challenge completion", async () => {
    mockRegister.mockResolvedValue({ user: makeUser(), emailVerificationPending: true });

    // When turnstile.render is called, capture the callback and invoke it
    // with a fake token to simulate the user completing the challenge.
    (window as any).turnstile.render = vi.fn().mockImplementation(
      (_container: HTMLElement, options: Record<string, any>) => {
        // Simulate async challenge completion
        setTimeout(() => options.callback("fake-turnstile-token-abc"), 0);
        return "widget-456";
      },
    );

    renderRegisterForm();
    await waitFor(() => {
      expect(screen.getByLabelText("Username")).toBeInTheDocument();
    });

    // Wait for the turnstile callback to fire
    await waitFor(() => {
      expect((window as any).turnstile.render).toHaveBeenCalled();
    });
    // Give the setTimeout callback time to execute
    await new Promise((r) => setTimeout(r, 10));

    fireEvent.change(screen.getByLabelText("Username"), { target: { value: "turnuser" } });
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "turn@example.com" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "password123!" } });
    fireEvent.change(screen.getByLabelText("Confirm Password"), { target: { value: "password123!" } });
    fireEvent.submit(screen.getByLabelText("Username").closest("form")!);

    await waitFor(() => {
      expect(mockRegister).toHaveBeenCalledWith(
        "turnuser",
        "turn@example.com",
        "password123!",
        expect.objectContaining({ turnstileToken: "fake-turnstile-token-abc" }),
      );
    });
  });
});
