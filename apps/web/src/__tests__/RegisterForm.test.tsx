import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import RegisterForm from "../components/auth/RegisterForm";
import { makeUser } from "./testUtils";

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
  userAttributeSignup,
} from "../api/userClient";
import { trackRedditEvent } from "../utils/redditPixel";
const mockGetMe = vi.mocked(userGetMe);
const mockRegister = vi.mocked(userRegister);
const mockGetOAuthProviders = vi.mocked(userGetOAuthProviders);
const mockAttributeSignup = vi.mocked(userAttributeSignup);
const mockTrackRedditEvent = vi.mocked(trackRedditEvent);

import { render } from "@testing-library/react";
import { UserAuthProvider } from "../context/UserAuthContext";

function renderRegisterForm() {
  const onSwitchToLogin = vi.fn();
  const result = render(
    <UserAuthProvider>
      <RegisterForm onSwitchToLogin={onSwitchToLogin} />
    </UserAuthProvider>
  );
  return { ...result, onSwitchToLogin };
}

describe("RegisterForm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    mockGetMe.mockRejectedValue(new Error("401"));
    mockGetOAuthProviders.mockResolvedValue({ google: false, facebook: false });
  });

  afterEach(() => {
    // Revert any per-test env stubs (e.g. Turnstile-empty test below).
    vi.unstubAllEnvs();
  });

  it("renders registration form with all fields", async () => {
    renderRegisterForm();
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Create Account" })).toBeInTheDocument();
    });
    expect(screen.getByLabelText("Username")).toBeInTheDocument();
    expect(screen.getByLabelText("Email")).toBeInTheDocument();
    expect(screen.getByLabelText("Password")).toBeInTheDocument();
    expect(screen.getByLabelText("Confirm Password")).toBeInTheDocument();
  });

  it("shows validation error on username blur with short value", async () => {
    renderRegisterForm();
    await waitFor(() => {
      expect(screen.getByLabelText("Username")).toBeInTheDocument();
    });

    const usernameInput = screen.getByLabelText("Username");
    fireEvent.change(usernameInput, { target: { value: "ab" } });
    fireEvent.blur(usernameInput);

    expect(screen.getByText("Username must be at least 3 characters")).toBeInTheDocument();
  });

  it("shows validation error on email blur with invalid value", async () => {
    renderRegisterForm();
    await waitFor(() => {
      expect(screen.getByLabelText("Email")).toBeInTheDocument();
    });

    const emailInput = screen.getByLabelText("Email");
    fireEvent.change(emailInput, { target: { value: "notanemail" } });
    fireEvent.blur(emailInput);

    expect(screen.getByText("Please enter a valid email address")).toBeInTheDocument();
  });

  it("shows validation error on password blur with short value", async () => {
    renderRegisterForm();
    await waitFor(() => {
      expect(screen.getByLabelText("Password")).toBeInTheDocument();
    });

    const passwordInput = screen.getByLabelText("Password");
    fireEvent.change(passwordInput, { target: { value: "short" } });
    fireEvent.blur(passwordInput);

    expect(screen.getByText("Password must be at least 10 characters")).toBeInTheDocument();
  });

  it("shows password match error on confirm blur", async () => {
    renderRegisterForm();
    await waitFor(() => {
      expect(screen.getByLabelText("Password")).toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "password123!" } });
    const confirmInput = screen.getByLabelText("Confirm Password");
    fireEvent.change(confirmInput, { target: { value: "different12!" } });
    fireEvent.blur(confirmInput);

    expect(screen.getByText("Passwords do not match")).toBeInTheDocument();
  });

  it("calls register on valid submit", async () => {
    mockRegister.mockResolvedValue({ user: makeUser(), emailVerificationPending: true });
    renderRegisterForm();
    await waitFor(() => {
      expect(screen.getByLabelText("Username")).toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText("Username"), { target: { value: "testuser" } });
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "test@example.com" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "password123!" } });
    fireEvent.change(screen.getByLabelText("Confirm Password"), { target: { value: "password123!" } });
    fireEvent.submit(screen.getByLabelText("Username").closest("form")!);

    await waitFor(() => {
      expect(mockRegister).toHaveBeenCalledWith(
        "testuser",
        "test@example.com",
        "password123!",
        { referralCode: undefined, turnstileToken: undefined, attribution: null },
      );
    });
  });

  // ── UTM attribution (Reddit ads prep) ──────────────────────────────

  it("passes stored UTM attribution into the register call", async () => {
    const attribution = {
      utm_source: "reddit",
      utm_medium: "cpc",
      utm_campaign: "giveaway_test",
      landing_page: "/giveaway",
    };
    sessionStorage.setItem("utm_attribution", JSON.stringify(attribution));

    mockRegister.mockResolvedValue({
      user: makeUser(),
      emailVerificationPending: true,
    });

    renderRegisterForm();
    await waitFor(() => {
      expect(screen.getByLabelText("Username")).toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText("Username"), { target: { value: "utmuser" } });
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "utm@example.com" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "password123!" } });
    fireEvent.change(screen.getByLabelText("Confirm Password"), { target: { value: "password123!" } });
    fireEvent.submit(screen.getByLabelText("Username").closest("form")!);

    await waitFor(() => {
      expect(mockRegister).toHaveBeenCalledWith(
        "utmuser",
        "utm@example.com",
        "password123!",
        expect.objectContaining({ attribution }),
      );
    });
  });

  it("fires the Reddit SignUp pixel event and clears attribution on success", async () => {
    sessionStorage.setItem(
      "utm_attribution",
      JSON.stringify({ utm_source: "reddit" }),
    );
    mockRegister.mockResolvedValue({
      user: makeUser(),
      emailVerificationPending: true,
    });

    renderRegisterForm();
    await waitFor(() => {
      expect(screen.getByLabelText("Username")).toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText("Username"), { target: { value: "signupuser" } });
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "s@example.com" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "password123!" } });
    fireEvent.change(screen.getByLabelText("Confirm Password"), { target: { value: "password123!" } });
    fireEvent.submit(screen.getByLabelText("Username").closest("form")!);

    await waitFor(() => {
      expect(mockTrackRedditEvent).toHaveBeenCalledWith("SignUp");
    });
    expect(sessionStorage.getItem("utm_attribution")).toBeNull();
  });

  it("does not call /attribute-signup from the password register path", async () => {
    // Attribution is handled atomically inside UserAuthContext.register()
    // for the email/password path — the OAuth useEffect should not fire
    // a duplicate round-trip to /api/user/attribute-signup. This regression
    // test pins that invariant.
    sessionStorage.setItem(
      "utm_attribution",
      JSON.stringify({ utm_source: "reddit" }),
    );
    mockRegister.mockResolvedValue({
      user: makeUser(),
      emailVerificationPending: true,
    });

    renderRegisterForm();
    await waitFor(() => {
      expect(screen.getByLabelText("Username")).toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText("Username"), { target: { value: "dedup" } });
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "dedup@example.com" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "password123!" } });
    fireEvent.change(screen.getByLabelText("Confirm Password"), { target: { value: "password123!" } });
    fireEvent.submit(screen.getByLabelText("Username").closest("form")!);

    await waitFor(() => {
      expect(mockRegister).toHaveBeenCalled();
    });
    // Flush the microtask queue so any trailing useEffect would have run.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mockAttributeSignup).not.toHaveBeenCalled();
    // Pixel was fired exactly once (by UserAuthContext.register) — not twice.
    expect(mockTrackRedditEvent).toHaveBeenCalledTimes(1);
    expect(mockTrackRedditEvent).toHaveBeenCalledWith("SignUp");
  });

  it("does not fire the Reddit SignUp event when registration fails", async () => {
    sessionStorage.setItem(
      "utm_attribution",
      JSON.stringify({ utm_source: "reddit" }),
    );
    mockRegister.mockRejectedValue(new Error("Email already in use"));

    renderRegisterForm();
    await waitFor(() => {
      expect(screen.getByLabelText("Username")).toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText("Username"), { target: { value: "failuser" } });
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "fail@example.com" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "password123!" } });
    fireEvent.change(screen.getByLabelText("Confirm Password"), { target: { value: "password123!" } });
    fireEvent.submit(screen.getByLabelText("Username").closest("form")!);

    await waitFor(() => {
      expect(screen.getByText("Email already in use")).toBeInTheDocument();
    });

    expect(mockTrackRedditEvent).not.toHaveBeenCalled();
    // Attribution should still be in storage so OAuth retry can still attribute
    expect(sessionStorage.getItem("utm_attribution")).not.toBeNull();
  });

  it("does not submit when there are validation errors", async () => {
    renderRegisterForm();
    await waitFor(() => {
      expect(screen.getByLabelText("Username")).toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText("Username"), { target: { value: "ab" } });
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "test@example.com" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "password123!" } });
    fireEvent.change(screen.getByLabelText("Confirm Password"), { target: { value: "password123!" } });
    fireEvent.submit(screen.getByLabelText("Username").closest("form")!);

    expect(mockRegister).not.toHaveBeenCalled();
    expect(screen.getByText("Username must be at least 3 characters")).toBeInTheDocument();
  });

  it("shows server error on registration failure", async () => {
    mockRegister.mockRejectedValue(new Error("Email already in use"));
    renderRegisterForm();
    await waitFor(() => {
      expect(screen.getByLabelText("Username")).toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText("Username"), { target: { value: "testuser" } });
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "used@example.com" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "password123!" } });
    fireEvent.change(screen.getByLabelText("Confirm Password"), { target: { value: "password123!" } });
    fireEvent.submit(screen.getByLabelText("Username").closest("form")!);

    await waitFor(() => {
      expect(screen.getByText("Email already in use")).toBeInTheDocument();
    });
  });

  it("shows Log In link that calls onSwitchToLogin", async () => {
    const { onSwitchToLogin } = renderRegisterForm();
    await waitFor(() => {
      expect(screen.getByText("Log In")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Log In"));
    expect(onSwitchToLogin).toHaveBeenCalledOnce();
  });

  // ── Turnstile widget rendering ───────────────────────────────────────

  it("does NOT render the Turnstile widget when VITE_TURNSTILE_SITE_KEY is empty", async () => {
    // `apps/web/.env` ships a real Turnstile site key for local dev,
    // and vitest's import.meta.env picks it up at module-eval time
    // (RegisterForm captures it in a top-level const). Re-import the
    // form module fresh after stubbing the env so the const re-evaluates
    // against the empty value. afterEach's `vi.unstubAllEnvs()` reverts
    // the stub for the rest of the suite.
    vi.stubEnv("VITE_TURNSTILE_SITE_KEY", "");
    vi.resetModules();
    const { default: FreshRegisterForm } = await import("../components/auth/RegisterForm");
    const { UserAuthProvider: FreshProvider } = await import("../context/UserAuthContext");
    render(
      <FreshProvider>
        <FreshRegisterForm onSwitchToLogin={() => {}} />
      </FreshProvider>,
    );
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Create Account" })).toBeInTheDocument();
    });
    expect(screen.queryByTestId("turnstile-widget")).not.toBeInTheDocument();
  });

  it("sends turnstileToken as undefined when no Turnstile widget is present", async () => {
    // Regression: even without the widget, the register call must still fire
    // with turnstileToken: undefined (not null, not omitted) so the backend
    // can apply its own enforcement logic.
    mockRegister.mockResolvedValue({ user: makeUser(), emailVerificationPending: true });
    renderRegisterForm();
    await waitFor(() => {
      expect(screen.getByLabelText("Username")).toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText("Username"), { target: { value: "nowidget" } });
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "nowidget@example.com" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "password123!" } });
    fireEvent.change(screen.getByLabelText("Confirm Password"), { target: { value: "password123!" } });
    fireEvent.submit(screen.getByLabelText("Username").closest("form")!);

    await waitFor(() => {
      expect(mockRegister).toHaveBeenCalledWith(
        "nowidget",
        "nowidget@example.com",
        "password123!",
        expect.objectContaining({ turnstileToken: undefined }),
      );
    });
  });

  // ── OAuth button visibility ─────────────────────────────────────────

  it("hides OAuth buttons when no providers are configured", async () => {
    mockGetOAuthProviders.mockResolvedValue({ google: false, facebook: false });
    renderRegisterForm();
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Create Account" })).toBeInTheDocument();
    });
    expect(screen.queryByText("Continue with Google")).not.toBeInTheDocument();
    expect(screen.queryByText("Continue with Facebook")).not.toBeInTheDocument();
  });

  it("shows OAuth buttons when providers are configured", async () => {
    mockGetOAuthProviders.mockResolvedValue({ google: true, facebook: true });
    renderRegisterForm();
    await waitFor(() => {
      expect(screen.getByText("Continue with Google")).toBeInTheDocument();
    });
    expect(screen.getByText("Continue with Facebook")).toBeInTheDocument();
  });
});
