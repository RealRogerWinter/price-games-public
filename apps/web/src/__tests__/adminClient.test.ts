import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  adminLogin,
  adminLogout,
  adminGetMe,
  getActiveRooms,
  getAdminProducts,
  getAdminProduct,
  createAdminProduct,
  updateAdminProduct,
  setAdminProductStatus,
  getProductCategories,
  getManufacturerContacts,
  addManufacturerContact,
  updateManufacturerContact,
  deleteManufacturerContact,
} from "../api/adminClient";

describe("Admin API client", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  function mockFetch(data: unknown, status = 200) {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify(data), {
        status,
        headers: { "Content-Type": "application/json" },
      })
    );
  }

  function mockFetchError(data: unknown, status: number) {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify(data), {
        status,
        headers: { "Content-Type": "application/json" },
      })
    );
  }

  const mockUser = {
    id: "admin-1",
    username: "admin",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    lastLoginAt: null,
    isActive: true,
  };

  describe("adminLogin", () => {
    it("sends POST with username/password body and returns user data", async () => {
      mockFetch({ user: mockUser });
      const result = await adminLogin("admin", "secret");
      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/admin/login",
        expect.objectContaining({
          method: "POST",
          credentials: "same-origin",
        })
      );
      const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
      expect(body.username).toBe("admin");
      expect(body.password).toBe("secret");
      expect(result.user.username).toBe("admin");
    });

    it("includes credentials: same-origin", async () => {
      mockFetch({ user: mockUser });
      await adminLogin("admin", "secret");
      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/admin/login",
        expect.objectContaining({
          credentials: "same-origin",
        })
      );
    });

    it("throws on 401 with error message", async () => {
      mockFetchError({ error: "Invalid credentials" }, 401);
      await expect(adminLogin("admin", "wrong")).rejects.toThrow(
        "Invalid credentials"
      );
    });
  });

  describe("adminLogout", () => {
    it("sends POST to /logout", async () => {
      mockFetch({});
      await adminLogout();
      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/admin/logout",
        expect.objectContaining({
          method: "POST",
          credentials: "same-origin",
        })
      );
    });
  });

  describe("adminGetMe", () => {
    it("sends GET and returns user data", async () => {
      mockFetch({ user: mockUser });
      const result = await adminGetMe();
      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/admin/me",
        expect.objectContaining({
          credentials: "same-origin",
        })
      );
      expect(result.user.id).toBe("admin-1");
      expect(result.user.username).toBe("admin");
    });

    it("throws on 401", async () => {
      mockFetchError({ error: "Not authenticated" }, 401);
      await expect(adminGetMe()).rejects.toThrow("Not authenticated");
    });
  });

  describe("getActiveRooms", () => {
    it("sends GET to correct URL", async () => {
      const room = { code: "ABCD", gameMode: "classic", status: "playing", playerCount: 4, currentRound: 2, totalRounds: 10, createdAt: "2026-03-11T00:00:00Z" };
      mockFetch([room]);
      const result = await getActiveRooms();
      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/admin/analytics/active-rooms",
        expect.objectContaining({
          credentials: "same-origin",
        })
      );
      expect(result[0].code).toBe("ABCD");
    });
  });

  // ===== Product Management =====

  describe("getAdminProducts", () => {
    it("sends GET with query params", async () => {
      const mockResponse = { products: [], total: 0, page: 1, pageSize: 50, totalPages: 0 };
      mockFetch(mockResponse);
      const result = await getAdminProducts({ page: 2, search: "widget", category: "Electronics" });
      const url = fetchSpy.mock.calls[0][0] as string;
      expect(url).toContain("/api/admin/products?");
      expect(url).toContain("page=2");
      expect(url).toContain("search=widget");
      expect(url).toContain("category=Electronics");
      expect(result.totalPages).toBe(0);
    });

    it("sends GET without params when none provided", async () => {
      mockFetch({ products: [], total: 0, page: 1, pageSize: 50, totalPages: 0 });
      await getAdminProducts();
      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/admin/products",
        expect.objectContaining({ credentials: "same-origin" })
      );
    });
  });

  describe("getAdminProduct", () => {
    it("sends GET to correct URL", async () => {
      const mockProduct = { id: 42, title: "Widget", priceCents: 999 };
      mockFetch(mockProduct);
      const result = await getAdminProduct(42);
      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/admin/products/42",
        expect.objectContaining({ credentials: "same-origin" })
      );
      expect(result.id).toBe(42);
    });
  });

  describe("createAdminProduct", () => {
    it("sends POST with body", async () => {
      mockFetch({ id: 1, title: "New", priceCents: 500 });
      const result = await createAdminProduct({ title: "New", priceCents: 500 });
      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/admin/products",
        expect.objectContaining({ method: "POST", credentials: "same-origin" })
      );
      const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
      expect(body.title).toBe("New");
      expect(result.title).toBe("New");
    });
  });

  describe("updateAdminProduct", () => {
    it("sends PUT with body", async () => {
      mockFetch({ id: 5, title: "Updated" });
      await updateAdminProduct(5, { title: "Updated" });
      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/admin/products/5",
        expect.objectContaining({ method: "PUT" })
      );
    });
  });

  describe("setAdminProductStatus", () => {
    it("sends PATCH with isActive body", async () => {
      mockFetch({ id: 3, isActive: false });
      await setAdminProductStatus(3, false);
      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/admin/products/3/status",
        expect.objectContaining({ method: "PATCH" })
      );
      const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
      expect(body.isActive).toBe(false);
    });
  });

  describe("getProductCategories", () => {
    it("sends GET to correct URL", async () => {
      mockFetch(["Electronics", "Home & Kitchen"]);
      const result = await getProductCategories();
      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/admin/products/categories",
        expect.objectContaining({ credentials: "same-origin" })
      );
      expect(result).toEqual(["Electronics", "Home & Kitchen"]);
    });
  });

  // ===== Manufacturer Contacts =====

  describe("getManufacturerContacts", () => {
    it("sends GET with encoded name", async () => {
      const mockData = { manufacturer: { id: 1, name: "Sony" }, contacts: [] };
      mockFetch(mockData);
      const result = await getManufacturerContacts("Sony");
      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/admin/manufacturers/by-name/Sony",
        expect.objectContaining({ credentials: "same-origin" })
      );
      expect(result.manufacturer.name).toBe("Sony");
    });
  });

  describe("addManufacturerContact", () => {
    it("sends POST with body", async () => {
      mockFetch({ id: 10, contactType: "media", email: "a@b.com" });
      await addManufacturerContact(1, { contactType: "media", confidence: "high", email: "a@b.com" });
      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/admin/manufacturers/1/contacts",
        expect.objectContaining({ method: "POST" })
      );
    });
  });

  describe("updateManufacturerContact", () => {
    it("sends PUT with body", async () => {
      mockFetch({ id: 10, email: "updated@b.com" });
      await updateManufacturerContact(1, 10, { email: "updated@b.com" });
      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/admin/manufacturers/1/contacts/10",
        expect.objectContaining({ method: "PUT" })
      );
    });
  });

  describe("deleteManufacturerContact", () => {
    it("sends DELETE to correct URL", async () => {
      mockFetch({ ok: true });
      await deleteManufacturerContact(1, 10);
      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/admin/manufacturers/1/contacts/10",
        expect.objectContaining({ method: "DELETE" })
      );
    });
  });
});
