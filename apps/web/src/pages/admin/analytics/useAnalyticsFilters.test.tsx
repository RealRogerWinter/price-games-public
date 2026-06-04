import { describe, it, expect } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { useAnalyticsFilters } from "./useAnalyticsFilters";

function wrapper(initial: string) {
  return ({ children }: { children: React.ReactNode }) => (
    <MemoryRouter initialEntries={[initial]}>{children}</MemoryRouter>
  );
}

describe("useAnalyticsFilters", () => {
  it("defaults when no params are present", () => {
    const { result } = renderHook(() => useAnalyticsFilters(), {
      wrapper: wrapper("/admin/analytics/overview"),
    });
    expect(result.current.filters).toEqual({ range: "7d", audience: "all", device: "all" });
  });

  it("reads valid params from the URL", () => {
    const { result } = renderHook(() => useAnalyticsFilters(), {
      wrapper: wrapper("/admin/analytics/overview?range=28d&audience=anon&device=mobile"),
    });
    expect(result.current.filters).toEqual({
      range: "28d",
      audience: "anon",
      device: "mobile",
    });
  });

  it("falls back to defaults for invalid values", () => {
    const { result } = renderHook(() => useAnalyticsFilters(), {
      wrapper: wrapper("/admin/analytics/overview?range=forever&audience=nope"),
    });
    expect(result.current.filters.range).toBe("7d");
    expect(result.current.filters.audience).toBe("all");
  });

  it("updateFilter writes to the URL", () => {
    const { result } = renderHook(() => useAnalyticsFilters(), {
      wrapper: wrapper("/admin/analytics/overview"),
    });
    act(() => result.current.updateFilter("range", "28d"));
    expect(result.current.filters.range).toBe("28d");
  });

  it("updateFilter omits the default so the URL stays clean", () => {
    const { result } = renderHook(() => useAnalyticsFilters(), {
      wrapper: wrapper("/admin/analytics/overview?range=90d"),
    });
    act(() => result.current.updateFilter("range", "7d"));
    expect(result.current.filters.range).toBe("7d");
  });
});
