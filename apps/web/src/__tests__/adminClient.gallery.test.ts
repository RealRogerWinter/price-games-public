/**
 * Tests for the gallery-specific admin API client functions plus the
 * shared 401-redirect-to-login behavior in adminRequest. Mocks the
 * global fetch so no real network round-trips, and stubs
 * window.location.href to observe the redirect.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  fetchGalleryAssets,
  updateGalleryAsset,
  deleteGalleryAsset,
  uploadGalleryAssets,
  galleryAssetImageUrl,
  verifyAdminSessionDebounced,
  adminGetMe,
  adminLogin,
  type GalleryAsset,
} from "../api/adminClient";

// ─── Test harness ────────────────────────────────────────────────────────

let fetchSpy: ReturnType<typeof vi.spyOn>;
/** Tracks writes to window.location.href without navigating the test env. */
let locationHrefWrites: string[] = [];
let originalLocation: Location;

beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, "fetch");
  locationHrefWrites = [];
  // Replace window.location with a minimal stub that captures href writes
  // and lets the tests read `pathname` as any value they want.
  originalLocation = window.location;
  const stub: Partial<Location> & { _pathname: string } = {
    _pathname: "/admin/gallery",
    get href() {
      return `${stub.origin}${stub._pathname}`;
    },
    set href(v: string) {
      locationHrefWrites.push(v);
    },
    get pathname() {
      return stub._pathname;
    },
    origin: "http://localhost:3000",
    assign: vi.fn(),
    replace: vi.fn(),
    reload: vi.fn(),
  };
  Object.defineProperty(window, "location", {
    configurable: true,
    writable: true,
    value: stub as unknown as Location,
  });
});

afterEach(() => {
  fetchSpy.mockRestore();
  Object.defineProperty(window, "location", {
    configurable: true,
    writable: true,
    value: originalLocation,
  });
});

function mockJson(data: unknown, status = 200): void {
  fetchSpy.mockResolvedValueOnce(
    new Response(JSON.stringify(data), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

function mockStatus(status: number, body: unknown = { error: "nope" }): void {
  fetchSpy.mockResolvedValueOnce(
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

function fakeAsset(overrides: Partial<GalleryAsset> = {}): GalleryAsset {
  return {
    id: "avatars/pirate.png",
    filename: "pirate.png",
    title: "pirate",
    category: "avatars",
    tags: ["avatar"],
    createdAt: "2026-01-01T00:00:00Z",
    sizeBytes: 1000,
    ...overrides,
  };
}

// ─── galleryAssetImageUrl / encodeAssetId ────────────────────────────────

describe("galleryAssetImageUrl", () => {
  it("builds a same-origin URL under /api/admin/gallery/files", () => {
    expect(galleryAssetImageUrl("avatars/pirate.png")).toBe(
      "/api/admin/gallery/files/avatars/pirate.png",
    );
  });

  it("preserves slashes between path segments (does not double-encode them)", () => {
    expect(galleryAssetImageUrl("ns/sub/file.png")).toBe(
      "/api/admin/gallery/files/ns/sub/file.png",
    );
  });

  it("encodes special characters within segments", () => {
    expect(galleryAssetImageUrl("weird dir/hello world.png")).toBe(
      "/api/admin/gallery/files/weird%20dir/hello%20world.png",
    );
  });

  it("handles a single-segment id with no slash", () => {
    expect(galleryAssetImageUrl("loose.png")).toBe(
      "/api/admin/gallery/files/loose.png",
    );
  });
});

// ─── fetchGalleryAssets ──────────────────────────────────────────────────

describe("fetchGalleryAssets", () => {
  it("GETs /api/admin/gallery/assets and returns the parsed body", async () => {
    const body = { assets: [fakeAsset()], categories: ["avatars"] };
    mockJson(body);
    const result = await fetchGalleryAssets();
    expect(result).toEqual(body);
    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/admin/gallery/assets",
      expect.objectContaining({ credentials: "same-origin" }),
    );
  });

  it("throws with the server's error message on non-ok status", async () => {
    mockStatus(500, { error: "disk full" });
    await expect(fetchGalleryAssets()).rejects.toThrow("disk full");
  });

  it("redirects to /admin/login on 401", async () => {
    mockStatus(401, { error: "Authentication required" });
    await expect(fetchGalleryAssets()).rejects.toThrow();
    expect(locationHrefWrites).toContain("/admin/login");
  });
});

// ─── updateGalleryAsset ──────────────────────────────────────────────────

describe("updateGalleryAsset", () => {
  it("PATCHes /assets/:id with a JSON body", async () => {
    mockJson(fakeAsset({ title: "Updated" }));
    const result = await updateGalleryAsset("avatars/pirate.png", { title: "Updated" });
    expect(result.title).toBe("Updated");
    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/admin/gallery/assets/avatars/pirate.png",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ title: "Updated" }),
      }),
    );
  });

  it("encodes each path segment of the id in the URL", async () => {
    mockJson(fakeAsset({ id: "weird dir/file.png" }));
    await updateGalleryAsset("weird dir/file.png", { title: "x" });
    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/admin/gallery/assets/weird%20dir/file.png",
      expect.anything(),
    );
  });

  it("throws on server error", async () => {
    mockStatus(400, { error: "bad patch" });
    await expect(updateGalleryAsset("avatars/pirate.png", {})).rejects.toThrow("bad patch");
  });
});

// ─── deleteGalleryAsset ──────────────────────────────────────────────────

describe("deleteGalleryAsset", () => {
  it("issues a DELETE and resolves on 204", async () => {
    fetchSpy.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await expect(deleteGalleryAsset("avatars/pirate.png")).resolves.toBeUndefined();
    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/admin/gallery/assets/avatars/pirate.png",
      expect.objectContaining({ method: "DELETE", credentials: "same-origin" }),
    );
  });

  it("throws with the server's error message on non-ok status", async () => {
    mockStatus(404, { error: "Asset not found" });
    await expect(deleteGalleryAsset("missing.png")).rejects.toThrow("Asset not found");
  });

  it("redirects to /admin/login on 401", async () => {
    mockStatus(401, { error: "Authentication required" });
    await expect(deleteGalleryAsset("x.png")).rejects.toThrow();
    expect(locationHrefWrites).toContain("/admin/login");
  });
});

// ─── uploadGalleryAssets ─────────────────────────────────────────────────

describe("uploadGalleryAssets", () => {
  it("POSTs multipart/form-data with files and metadata fields", async () => {
    const body = { assets: [fakeAsset({ id: "uploads/new.png" })], failures: [] };
    mockJson(body, 201);

    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "new.png", {
      type: "image/png",
    });
    const result = await uploadGalleryAssets([file], {
      namespace: "uploads",
      category: "custom",
      tags: ["a", "b"],
      description: "desc",
      title: "The New",
    });

    expect(result).toEqual(body);
    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/admin/gallery/upload",
      expect.objectContaining({
        method: "POST",
        credentials: "same-origin",
        body: expect.any(FormData),
      }),
    );

    // Inspect the FormData that was passed in.
    const call = fetchSpy.mock.calls[0]!;
    const init = call[1] as RequestInit;
    const form = init.body as FormData;
    expect(form.getAll("files")).toHaveLength(1);
    expect(form.get("namespace")).toBe("uploads");
    expect(form.get("category")).toBe("custom");
    expect(form.get("tags")).toBe("a,b");
    expect(form.get("description")).toBe("desc");
    expect(form.get("title")).toBe("The New");
  });

  it("skips optional fields that weren't supplied", async () => {
    mockJson({ assets: [], failures: [] }, 201);
    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "n.png");
    await uploadGalleryAssets([file], { namespace: "uploads" });
    const form = (fetchSpy.mock.calls[0]![1] as RequestInit).body as FormData;
    expect(form.get("namespace")).toBe("uploads");
    expect(form.get("category")).toBeNull();
    expect(form.get("title")).toBeNull();
    expect(form.get("tags")).toBeNull();
    expect(form.get("description")).toBeNull();
  });

  it("appends multiple files under the same 'files' key", async () => {
    mockJson({ assets: [], failures: [] }, 201);
    const f1 = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "a.png");
    const f2 = new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], "b.jpg");
    await uploadGalleryAssets([f1, f2], { namespace: "bulk" });
    const form = (fetchSpy.mock.calls[0]![1] as RequestInit).body as FormData;
    expect(form.getAll("files")).toHaveLength(2);
  });

  it("joins tags with commas (server splits them back)", async () => {
    mockJson({ assets: [], failures: [] }, 201);
    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "n.png");
    await uploadGalleryAssets([file], { namespace: "uploads", tags: ["one", "two", "three"] });
    const form = (fetchSpy.mock.calls[0]![1] as RequestInit).body as FormData;
    expect(form.get("tags")).toBe("one,two,three");
  });

  it("throws with the server's error message on non-ok status", async () => {
    mockStatus(413, { error: "file too big" });
    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "n.png");
    await expect(uploadGalleryAssets([file], { namespace: "x" })).rejects.toThrow("file too big");
  });

  it("redirects to /admin/login on 401", async () => {
    mockStatus(401, { error: "Authentication required" });
    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "n.png");
    await expect(uploadGalleryAssets([file], { namespace: "x" })).rejects.toThrow();
    expect(locationHrefWrites).toContain("/admin/login");
  });
});

// ─── adminRequest 401 redirect behavior ──────────────────────────────────

describe("adminRequest — 401 redirect", () => {
  it("redirects when /me returns 401 and user is not on the login page", async () => {
    mockStatus(401, { error: "Authentication required" });
    await expect(adminGetMe()).rejects.toThrow();
    expect(locationHrefWrites).toContain("/admin/login");
  });

  it("does NOT redirect when /login itself returns 401", async () => {
    mockStatus(401, { error: "Invalid credentials" });
    await expect(adminLogin("wrong", "wrong")).rejects.toThrow("Invalid credentials");
    expect(locationHrefWrites).toEqual([]);
  });

  it("does NOT redirect when already on the login page", async () => {
    (window.location as unknown as { _pathname: string })._pathname = "/admin/login";
    mockStatus(401, { error: "Authentication required" });
    await expect(adminGetMe()).rejects.toThrow();
    expect(locationHrefWrites).toEqual([]);
  });
});

// ─── verifyAdminSessionDebounced ─────────────────────────────────────────

describe("verifyAdminSessionDebounced", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(async () => {
    // Advance past the 5s debounce lock so module-level state doesn't
    // leak into the next test (sessionCheckInFlight is module-scoped).
    await vi.advanceTimersByTimeAsync(6000);
    vi.useRealTimers();
  });

  it("fires /me once and coalesces repeat calls across rapid succession + clears lock after cool-down", async () => {
    // Fire three rapid-succession calls; the first triggers a fetch,
    // the other two coalesce into the same in-flight promise.
    mockJson({ user: { id: "a", username: "admin", totpEnabled: true }, skip2fa: false });
    verifyAdminSessionDebounced();
    verifyAdminSessionDebounced();
    verifyAdminSessionDebounced();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/admin/me",
      expect.any(Object),
    );

    // Another call within the cool-down window: still debounced.
    verifyAdminSessionDebounced();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Advance past the 5s cool-down — the next call should fire a
    // fresh fetch.
    await vi.advanceTimersByTimeAsync(5100);
    mockJson({ user: { id: "a", username: "admin", totpEnabled: true } });
    verifyAdminSessionDebounced();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});
