import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import ChangePasswordForm from "../components/auth/ChangePasswordForm";

vi.mock("../api/userClient", () => ({
  userGetMe: vi.fn(),
  userLogin: vi.fn(),
  userLogout: vi.fn(),
  userRegister: vi.fn(),
  userUpdatePassword: vi.fn(),
  userGetOAuthProviders: vi.fn().mockResolvedValue({ google: false, facebook: false }),
}));

import { userUpdatePassword } from "../api/userClient";
const mockUpdatePassword = vi.mocked(userUpdatePassword);

describe("ChangePasswordForm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders all password fields", () => {
    render(<ChangePasswordForm />);
    expect(screen.getByLabelText("Current Password")).toBeInTheDocument();
    expect(screen.getByLabelText("New Password")).toBeInTheDocument();
    expect(screen.getByLabelText("Confirm New Password")).toBeInTheDocument();
  });

  it("shows validation error on new password blur with short value", () => {
    render(<ChangePasswordForm />);
    const input = screen.getByLabelText("New Password");
    fireEvent.change(input, { target: { value: "short" } });
    fireEvent.blur(input);
    expect(screen.getByText("Password must be at least 10 characters")).toBeInTheDocument();
  });

  it("shows password match error on confirm blur", () => {
    render(<ChangePasswordForm />);
    fireEvent.change(screen.getByLabelText("New Password"), { target: { value: "password123!" } });
    const confirm = screen.getByLabelText("Confirm New Password");
    fireEvent.change(confirm, { target: { value: "different12!" } });
    fireEvent.blur(confirm);
    expect(screen.getByText("Passwords do not match")).toBeInTheDocument();
  });

  it("disables submit when fields are empty", () => {
    render(<ChangePasswordForm />);
    expect(screen.getByRole("button", { name: "Update Password" })).toBeDisabled();
  });

  it("submits and shows success message", async () => {
    mockUpdatePassword.mockResolvedValue(undefined);
    render(<ChangePasswordForm />);

    fireEvent.change(screen.getByLabelText("Current Password"), { target: { value: "oldpass12345" } });
    fireEvent.change(screen.getByLabelText("New Password"), { target: { value: "newpass12345" } });
    fireEvent.change(screen.getByLabelText("Confirm New Password"), { target: { value: "newpass12345" } });
    fireEvent.submit(screen.getByLabelText("Current Password").closest("form")!);

    await waitFor(() => {
      expect(screen.getByText("Password updated successfully")).toBeInTheDocument();
    });
    expect(mockUpdatePassword).toHaveBeenCalledWith("oldpass12345", "newpass12345");
  });

  it("shows error message on failure", async () => {
    mockUpdatePassword.mockRejectedValue(new Error("Invalid current password"));
    render(<ChangePasswordForm />);

    fireEvent.change(screen.getByLabelText("Current Password"), { target: { value: "wrongpass12" } });
    fireEvent.change(screen.getByLabelText("New Password"), { target: { value: "newpass12345" } });
    fireEvent.change(screen.getByLabelText("Confirm New Password"), { target: { value: "newpass12345" } });
    fireEvent.submit(screen.getByLabelText("Current Password").closest("form")!);

    await waitFor(() => {
      expect(screen.getByText("Invalid current password")).toBeInTheDocument();
    });
  });

  it("does not submit when passwords do not match", () => {
    render(<ChangePasswordForm />);

    fireEvent.change(screen.getByLabelText("Current Password"), { target: { value: "oldpass12345" } });
    fireEvent.change(screen.getByLabelText("New Password"), { target: { value: "newpass12345" } });
    fireEvent.change(screen.getByLabelText("Confirm New Password"), { target: { value: "mismatch123" } });
    fireEvent.submit(screen.getByLabelText("Current Password").closest("form")!);

    expect(mockUpdatePassword).not.toHaveBeenCalled();
    expect(screen.getByText("Passwords do not match")).toBeInTheDocument();
  });
});
