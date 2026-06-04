import { describe, it, expect } from "vitest";
import {
  validateUsername,
  validateEmail,
  validatePassword,
  validatePasswordMatch,
} from "../utils/validation";

describe("validateUsername", () => {
  it("returns error for empty username", () => {
    expect(validateUsername("")).toBe("Username is required");
  });

  it("returns error for short username", () => {
    expect(validateUsername("ab")).toBe("Username must be at least 3 characters");
  });

  it("returns error for long username", () => {
    expect(validateUsername("a".repeat(21))).toBe("Username must be at most 20 characters");
  });

  it("returns error for invalid characters", () => {
    expect(validateUsername("user name")).toBe("Username can only contain letters, numbers, and underscores");
    expect(validateUsername("user@name")).toBe("Username can only contain letters, numbers, and underscores");
    expect(validateUsername("user-name")).toBe("Username can only contain letters, numbers, and underscores");
  });

  it("returns null for valid username", () => {
    expect(validateUsername("abc")).toBeNull();
    expect(validateUsername("test_user")).toBeNull();
    expect(validateUsername("User123")).toBeNull();
    expect(validateUsername("a".repeat(20))).toBeNull();
  });
});

describe("validateEmail", () => {
  it("returns error for empty email", () => {
    expect(validateEmail("")).toBe("Email is required");
  });

  it("returns error for email without @", () => {
    expect(validateEmail("notanemail")).toBe("Please enter a valid email address");
    expect(validateEmail("missing.at.sign")).toBe("Please enter a valid email address");
  });

  it("returns error for email without valid domain", () => {
    expect(validateEmail("a@b")).toBe("Please enter a valid email address");
    expect(validateEmail("@example.com")).toBe("Please enter a valid email address");
    expect(validateEmail("user@")).toBe("Please enter a valid email address");
  });

  it("returns null for valid email", () => {
    expect(validateEmail("test@example.com")).toBeNull();
    expect(validateEmail("user@sub.domain.com")).toBeNull();
  });
});

describe("validatePassword", () => {
  it("returns error for empty password", () => {
    expect(validatePassword("")).toBe("Password is required");
  });

  it("returns error for short password", () => {
    expect(validatePassword("short")).toBe("Password must be at least 10 characters");
    expect(validatePassword("123456789")).toBe("Password must be at least 10 characters");
  });

  it("returns error for long password", () => {
    expect(validatePassword("a".repeat(129))).toBe("Password must be at most 128 characters");
  });

  it("returns null for valid password", () => {
    expect(validatePassword("1234567890")).toBeNull();
    expect(validatePassword("a".repeat(128))).toBeNull();
  });
});

describe("validatePasswordMatch", () => {
  it("returns error when passwords do not match", () => {
    expect(validatePasswordMatch("password1", "password2")).toBe("Passwords do not match");
  });

  it("returns null when passwords match", () => {
    expect(validatePasswordMatch("samepassword", "samepassword")).toBeNull();
  });

  it("returns null when both are empty", () => {
    expect(validatePasswordMatch("", "")).toBeNull();
  });
});
