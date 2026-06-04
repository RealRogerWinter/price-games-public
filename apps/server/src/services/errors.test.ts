import { describe, it, expect, vi } from "vitest";
import { UserFacingError, safeErrorMessage } from "./errors";

describe("UserFacingError", () => {
  it("creates an error with the correct name", () => {
    const err = new UserFacingError("test message");
    expect(err.name).toBe("UserFacingError");
    expect(err.message).toBe("test message");
    expect(err instanceof Error).toBe(true);
  });
});

describe("safeErrorMessage", () => {
  it("returns the message for UserFacingError", () => {
    const err = new UserFacingError("Room not found");
    expect(safeErrorMessage(err)).toBe("Room not found");
  });

  it("returns generic message for regular Error and logs it", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const err = new Error("SQLITE_ERROR: no such table");
    expect(safeErrorMessage(err)).toBe("Something went wrong");
    expect(spy).toHaveBeenCalledWith("[UnexpectedError]", err);
    spy.mockRestore();
  });

  it("returns generic message for non-Error values", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(safeErrorMessage("string error")).toBe("Something went wrong");
    expect(safeErrorMessage(null)).toBe("Something went wrong");
    expect(safeErrorMessage(undefined)).toBe("Something went wrong");
    spy.mockRestore();
  });
});
