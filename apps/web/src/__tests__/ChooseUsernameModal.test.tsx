import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, fireEvent, act } from "@testing-library/react";
import ChooseUsernameModal from "../components/auth/ChooseUsernameModal";
import * as userClient from "../api/userClient";
import * as validation from "../utils/validation";
import { renderWithProviders, makeUser, flushMicrotasks } from "./testUtils";

vi.mock("../utils/validation", () => ({
  validateUsername: vi.fn(() => null), // null = valid
}));

// Partial mock: forward every real export (userGetMe, userGetOAuthProviders,
// etc. the providers reach for on mount) and only stub the method the test
// asserts on. A whole-module replacement would silently miss any new export
// added to userClient later.
vi.mock("../api/userClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/userClient")>();
  return {
    ...actual,
    userSetUsername: vi.fn(),
  };
});

const mockedValidation = vi.mocked(validation);
const mockedUserClient = vi.mocked(userClient);

describe("ChooseUsernameModal", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  const defaultProps = {
    onComplete: vi.fn(),
  };

  const mockUser = makeUser({ username: "testuser", email: "test@example.com" });

  beforeEach(() => {
    localStorage.clear();
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ rates: {} }))
    );
    mockedValidation.validateUsername.mockReturnValue(null);
    mockedUserClient.userSetUsername.mockResolvedValue({
      ok: true,
      user: mockUser,
    });
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    vi.clearAllMocks();
  });

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  describe("rendering", () => {
    it("renders modal with title 'Choose Your Username'", () => {
      renderWithProviders(<ChooseUsernameModal {...defaultProps} />);
      expect(screen.getByText("Choose Your Username")).toBeInTheDocument();
    });

    it("has the correct data-testid attribute", () => {
      renderWithProviders(<ChooseUsernameModal {...defaultProps} />);
      expect(screen.getByTestId("choose-username-modal")).toBeInTheDocument();
    });

    it("renders username input field", () => {
      renderWithProviders(<ChooseUsernameModal {...defaultProps} />);
      expect(screen.getByLabelText("Username")).toBeInTheDocument();
    });

    it("renders Continue button", () => {
      renderWithProviders(<ChooseUsernameModal {...defaultProps} />);
      expect(screen.getByRole("button", { name: "Continue" })).toBeInTheDocument();
    });
  });

  // ---------------------------------------------------------------------------
  // Button disabled state
  // ---------------------------------------------------------------------------

  describe("Continue button disabled state", () => {
    it("is disabled when username input is empty", () => {
      renderWithProviders(<ChooseUsernameModal {...defaultProps} />);
      expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
    });

    it("is enabled after typing a username", () => {
      renderWithProviders(<ChooseUsernameModal {...defaultProps} />);
      fireEvent.change(screen.getByLabelText("Username"), {
        target: { value: "newuser" },
      });
      expect(screen.getByRole("button", { name: "Continue" })).not.toBeDisabled();
    });

    it("is disabled again after clearing the input", () => {
      renderWithProviders(<ChooseUsernameModal {...defaultProps} />);
      const input = screen.getByLabelText("Username");
      fireEvent.change(input, { target: { value: "newuser" } });
      fireEvent.change(input, { target: { value: "" } });
      expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
    });
  });

  // ---------------------------------------------------------------------------
  // Client-side validation
  // ---------------------------------------------------------------------------

  describe("client-side validation", () => {
    it("shows validation error when validateUsername returns a message", async () => {
      mockedValidation.validateUsername.mockReturnValue("Username must be 3-20 characters");

      renderWithProviders(<ChooseUsernameModal {...defaultProps} />);
      fireEvent.change(screen.getByLabelText("Username"), {
        target: { value: "ab" },
      });

      await act(async () => {
        fireEvent.submit(screen.getByRole("button", { name: "Continue" }).closest("form")!);
        await flushMicrotasks();
      });

      expect(screen.getByText("Username must be 3-20 characters")).toBeInTheDocument();
    });

    it("does not call userSetUsername when validation fails", async () => {
      mockedValidation.validateUsername.mockReturnValue("Too short");

      renderWithProviders(<ChooseUsernameModal {...defaultProps} />);
      fireEvent.change(screen.getByLabelText("Username"), {
        target: { value: "ab" },
      });

      await act(async () => {
        fireEvent.submit(screen.getByRole("button", { name: "Continue" }).closest("form")!);
        await flushMicrotasks();
      });

      expect(mockedUserClient.userSetUsername).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Successful submit
  // ---------------------------------------------------------------------------

  describe("successful submit", () => {
    it("calls onComplete with the user when submit succeeds", async () => {
      const onComplete = vi.fn();
      renderWithProviders(<ChooseUsernameModal onComplete={onComplete} />);

      fireEvent.change(screen.getByLabelText("Username"), {
        target: { value: "newuser" },
      });

      await act(async () => {
        fireEvent.submit(screen.getByRole("button", { name: "Continue" }).closest("form")!);
        await flushMicrotasks();
      });

      expect(onComplete).toHaveBeenCalledWith(mockUser);
    });

    it("calls userSetUsername with the trimmed username", async () => {
      renderWithProviders(<ChooseUsernameModal {...defaultProps} />);

      fireEvent.change(screen.getByLabelText("Username"), {
        target: { value: "  newuser  " },
      });

      await act(async () => {
        fireEvent.submit(screen.getByRole("button", { name: "Continue" }).closest("form")!);
        await flushMicrotasks();
      });

      expect(mockedUserClient.userSetUsername).toHaveBeenCalledWith("newuser");
    });
  });

  // ---------------------------------------------------------------------------
  // Email verification flow
  // ---------------------------------------------------------------------------

  describe("email verification flow", () => {
    it("shows email verification screen when emailVerificationSent is true", async () => {
      const pendingUser = makeUser({ email: "pending@example.com" });
      mockedUserClient.userSetUsername.mockResolvedValue({
        ok: true,
        user: pendingUser,
        emailVerificationSent: true,
      });

      renderWithProviders(<ChooseUsernameModal {...defaultProps} />);
      fireEvent.change(screen.getByLabelText("Username"), {
        target: { value: "newuser" },
      });

      await act(async () => {
        fireEvent.submit(screen.getByRole("button", { name: "Continue" }).closest("form")!);
        await flushMicrotasks();
      });

      expect(screen.getByText("Confirm Your Email")).toBeInTheDocument();
      expect(screen.getByText("pending@example.com")).toBeInTheDocument();
    });

    it("shows 'Got it' button on email verification screen", async () => {
      const pendingUser = makeUser({ email: "pending@example.com" });
      mockedUserClient.userSetUsername.mockResolvedValue({
        ok: true,
        user: pendingUser,
        emailVerificationSent: true,
      });

      renderWithProviders(<ChooseUsernameModal {...defaultProps} />);
      fireEvent.change(screen.getByLabelText("Username"), {
        target: { value: "newuser" },
      });

      await act(async () => {
        fireEvent.submit(screen.getByRole("button", { name: "Continue" }).closest("form")!);
        await flushMicrotasks();
      });

      expect(screen.getByRole("button", { name: "Got it" })).toBeInTheDocument();
    });

    it("calls onComplete with pending user when 'Got it' is clicked", async () => {
      const onComplete = vi.fn();
      const pendingUser = makeUser({ email: "pending@example.com" });
      mockedUserClient.userSetUsername.mockResolvedValue({
        ok: true,
        user: pendingUser,
        emailVerificationSent: true,
      });

      renderWithProviders(<ChooseUsernameModal onComplete={onComplete} />);
      fireEvent.change(screen.getByLabelText("Username"), {
        target: { value: "newuser" },
      });

      await act(async () => {
        fireEvent.submit(screen.getByRole("button", { name: "Continue" }).closest("form")!);
        await flushMicrotasks();
      });

      fireEvent.click(screen.getByRole("button", { name: "Got it" }));
      expect(onComplete).toHaveBeenCalledWith(pendingUser);
    });

    it("still shows data-testid on email verification screen", async () => {
      const pendingUser = makeUser({ email: "pending@example.com" });
      mockedUserClient.userSetUsername.mockResolvedValue({
        ok: true,
        user: pendingUser,
        emailVerificationSent: true,
      });

      renderWithProviders(<ChooseUsernameModal {...defaultProps} />);
      fireEvent.change(screen.getByLabelText("Username"), {
        target: { value: "newuser" },
      });

      await act(async () => {
        fireEvent.submit(screen.getByRole("button", { name: "Continue" }).closest("form")!);
        await flushMicrotasks();
      });

      expect(screen.getByTestId("choose-username-modal")).toBeInTheDocument();
    });
  });

  // ---------------------------------------------------------------------------
  // Loading state
  // ---------------------------------------------------------------------------

  describe("loading state", () => {
    it("shows 'Saving...' during submit", async () => {
      // Never resolve so we can observe the loading state
      mockedUserClient.userSetUsername.mockReturnValue(new Promise(() => {}));

      renderWithProviders(<ChooseUsernameModal {...defaultProps} />);
      fireEvent.change(screen.getByLabelText("Username"), {
        target: { value: "newuser" },
      });

      await act(async () => {
        fireEvent.submit(screen.getByRole("button", { name: "Continue" }).closest("form")!);
      });

      expect(screen.getByRole("button", { name: "Saving..." })).toBeInTheDocument();
    });

    it("Continue button is disabled during submit", async () => {
      mockedUserClient.userSetUsername.mockReturnValue(new Promise(() => {}));

      renderWithProviders(<ChooseUsernameModal {...defaultProps} />);
      fireEvent.change(screen.getByLabelText("Username"), {
        target: { value: "newuser" },
      });

      await act(async () => {
        fireEvent.submit(screen.getByRole("button", { name: "Continue" }).closest("form")!);
      });

      expect(screen.getByRole("button", { name: "Saving..." })).toBeDisabled();
    });
  });

  // ---------------------------------------------------------------------------
  // API error handling
  // ---------------------------------------------------------------------------

  describe("API error handling", () => {
    it("shows error message when API call fails", async () => {
      mockedUserClient.userSetUsername.mockRejectedValue(new Error("Username already taken"));

      renderWithProviders(<ChooseUsernameModal {...defaultProps} />);
      fireEvent.change(screen.getByLabelText("Username"), {
        target: { value: "takenuser" },
      });

      await act(async () => {
        fireEvent.submit(screen.getByRole("button", { name: "Continue" }).closest("form")!);
        await flushMicrotasks();
      });

      expect(screen.getByText("Username already taken")).toBeInTheDocument();
    });

    it("shows fallback error message when API error has no message", async () => {
      mockedUserClient.userSetUsername.mockRejectedValue("unexpected error");

      renderWithProviders(<ChooseUsernameModal {...defaultProps} />);
      fireEvent.change(screen.getByLabelText("Username"), {
        target: { value: "newuser" },
      });

      await act(async () => {
        fireEvent.submit(screen.getByRole("button", { name: "Continue" }).closest("form")!);
        await flushMicrotasks();
      });

      expect(screen.getByText("Failed to set username")).toBeInTheDocument();
    });

    it("re-enables the button after API error", async () => {
      mockedUserClient.userSetUsername.mockRejectedValue(new Error("Failed"));

      renderWithProviders(<ChooseUsernameModal {...defaultProps} />);
      fireEvent.change(screen.getByLabelText("Username"), {
        target: { value: "newuser" },
      });

      await act(async () => {
        fireEvent.submit(screen.getByRole("button", { name: "Continue" }).closest("form")!);
        await flushMicrotasks();
      });

      expect(screen.getByRole("button", { name: "Continue" })).not.toBeDisabled();
    });
  });

  // ---------------------------------------------------------------------------
  // Escape key blocked
  // ---------------------------------------------------------------------------

  describe("Escape key handling", () => {
    it("blocks Escape key from dismissing the modal", () => {
      renderWithProviders(<ChooseUsernameModal {...defaultProps} />);

      const event = new KeyboardEvent("keydown", { key: "Escape", cancelable: true, bubbles: true });
      const preventDefaultSpy = vi.spyOn(event, "preventDefault");
      document.dispatchEvent(event);

      expect(preventDefaultSpy).toHaveBeenCalled();
    });
  });
});
