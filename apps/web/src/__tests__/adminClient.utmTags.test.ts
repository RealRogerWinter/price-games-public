/**
 * Tests for the UTM tag functions on the admin API client.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  listUtmTags,
  createUtmTag,
  getUtmTag,
  updateUtmTag,
  setUtmTagStatus,
  deleteUtmTag,
  getUtmTagStats,
  getUtmTagTimeSeries,
  getUtmTagComparison,
  suggestShortCode,
  buildShortUrl,
} from "../api/adminClient";
import type { AdminUtmTag } from "../api/adminClient";

describe("Admin API client — UTM tags", () => {
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
      }),
    );
  }

  const sampleTag: AdminUtmTag = {
    id: "t-1",
    name: "reddit-v1",
    utmSource: "reddit",
    utmMedium: "cpc",
    utmCampaign: "launch",
    utmContent: null,
    utmTerm: null,
    destinationUrl: "/giveaway",
    status: "active",
    createdAt: "2026-04-01T00:00:00Z",
    updatedAt: "2026-04-01T00:00:00Z",
    createdBy: "admin-1",
    shortCode: null,
    clickCount: 0,
    lastClickedAt: null,
  };

  describe("listUtmTags", () => {
    it("sends GET /utm-tags without query string when no params", async () => {
      mockFetch({ tags: [sampleTag], total: 1, page: 1, pageSize: 25, totalPages: 1 });
      const result = await listUtmTags();
      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/admin/utm-tags",
        expect.objectContaining({ credentials: "same-origin" }),
      );
      expect(result.total).toBe(1);
      expect(result.tags[0].name).toBe("reddit-v1");
    });

    it("appends status, page, and pageSize query params when provided", async () => {
      mockFetch({ tags: [], total: 0, page: 2, pageSize: 10, totalPages: 0 });
      await listUtmTags({ status: "archived", page: 2, pageSize: 10 });
      const url = fetchSpy.mock.calls[0][0] as string;
      expect(url).toContain("status=archived");
      expect(url).toContain("page=2");
      expect(url).toContain("pageSize=10");
    });

    it("propagates server error messages as thrown Errors", async () => {
      mockFetch({ error: "Invalid status filter" }, 400);
      await expect(listUtmTags({ status: "bogus" })).rejects.toThrow(
        "Invalid status filter",
      );
    });
  });

  describe("createUtmTag", () => {
    it("sends POST /utm-tags with a JSON body", async () => {
      mockFetch(sampleTag, 201);
      const result = await createUtmTag({
        name: "reddit-v1",
        utmSource: "reddit",
        utmMedium: "cpc",
        utmCampaign: "launch",
        destinationUrl: "/giveaway",
      });
      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/admin/utm-tags",
        expect.objectContaining({ method: "POST" }),
      );
      const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
      expect(body).toMatchObject({
        name: "reddit-v1",
        utmSource: "reddit",
        destinationUrl: "/giveaway",
      });
      expect(result.id).toBe("t-1");
    });

    it("rethrows validation errors from the server", async () => {
      mockFetch({ error: "UTM tag name is required" }, 400);
      await expect(
        createUtmTag({ name: "", utmSource: "reddit", destinationUrl: "/giveaway" }),
      ).rejects.toThrow("UTM tag name is required");
    });
  });

  describe("getUtmTag", () => {
    it("sends GET /utm-tags/:id", async () => {
      mockFetch(sampleTag);
      const result = await getUtmTag("t-1");
      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/admin/utm-tags/t-1",
        expect.objectContaining({ credentials: "same-origin" }),
      );
      expect(result.name).toBe("reddit-v1");
    });

    it("throws on 404", async () => {
      mockFetch({ error: "UTM tag not found" }, 404);
      await expect(getUtmTag("missing")).rejects.toThrow("UTM tag not found");
    });
  });

  describe("updateUtmTag", () => {
    it("sends PUT /utm-tags/:id with the update body", async () => {
      mockFetch({ ...sampleTag, name: "renamed" });
      const result = await updateUtmTag("t-1", { name: "renamed" });
      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/admin/utm-tags/t-1",
        expect.objectContaining({ method: "PUT" }),
      );
      const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
      expect(body).toEqual({ name: "renamed" });
      expect(result.name).toBe("renamed");
    });
  });

  describe("setUtmTagStatus", () => {
    it("sends PATCH /utm-tags/:id/status with the status body", async () => {
      mockFetch({ ...sampleTag, status: "archived" });
      const result = await setUtmTagStatus("t-1", "archived");
      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/admin/utm-tags/t-1/status",
        expect.objectContaining({ method: "PATCH" }),
      );
      const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
      expect(body).toEqual({ status: "archived" });
      expect(result.status).toBe("archived");
    });
  });

  describe("deleteUtmTag", () => {
    it("sends DELETE /utm-tags/:id and returns the ok response", async () => {
      mockFetch({ ok: true });
      const result = await deleteUtmTag("t-1");
      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/admin/utm-tags/t-1",
        expect.objectContaining({ method: "DELETE" }),
      );
      expect(result.ok).toBe(true);
    });

    it("rethrows 409 Conflict errors", async () => {
      mockFetch({ error: "Cannot delete UTM tag with matched signups" }, 409);
      await expect(deleteUtmTag("t-1")).rejects.toThrow(
        "Cannot delete UTM tag with matched signups",
      );
    });
  });

  describe("getUtmTagStats", () => {
    it("sends GET /utm-tags/:id/stats and returns the funnel", async () => {
      mockFetch({
        tagId: "t-1",
        signups: 47,
        playedFirstGame: 38,
        giveawayEligible: 29,
        wonReward: 3,
        giveawayThreshold: 20000,
        clicks: 0,
        hasShortCode: false,
        anonymousPlays: 12,
      });
      const stats = await getUtmTagStats("t-1");
      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/admin/utm-tags/t-1/stats",
        expect.objectContaining({ credentials: "same-origin" }),
      );
      expect(stats.signups).toBe(47);
      expect(stats.playedFirstGame).toBe(38);
      expect(stats.giveawayEligible).toBe(29);
      expect(stats.wonReward).toBe(3);
      expect(stats.giveawayThreshold).toBe(20000);
      expect(stats.clicks).toBe(0);
      expect(stats.hasShortCode).toBe(false);
      expect(stats.anonymousPlays).toBe(12);
    });

    it("returns clicks and hasShortCode=true when the tag has a short code", async () => {
      mockFetch({
        tagId: "t-1",
        signups: 5,
        playedFirstGame: 3,
        giveawayEligible: 1,
        wonReward: 0,
        giveawayThreshold: 20000,
        clicks: 123,
        hasShortCode: true,
        anonymousPlays: 0,
      });
      const stats = await getUtmTagStats("t-1");
      expect(stats.clicks).toBe(123);
      expect(stats.hasShortCode).toBe(true);
    });

    it("throws on 404", async () => {
      mockFetch({ error: "UTM tag not found" }, 404);
      await expect(getUtmTagStats("missing")).rejects.toThrow("UTM tag not found");
    });

    it("appends ?range= when a window is requested", async () => {
      mockFetch({
        tagId: "t-1",
        signups: 1,
        playedFirstGame: 0,
        giveawayEligible: 0,
        wonReward: 0,
        giveawayThreshold: 20000,
        clicks: 0,
        hasShortCode: false,
        anonymousPlays: 0,
      });
      await getUtmTagStats("t-1", "28d");
      const url = fetchSpy.mock.calls[0][0] as string;
      expect(url).toBe("/api/admin/utm-tags/t-1/stats?range=28d");
    });
  });

  describe("getUtmTagTimeSeries", () => {
    it("sends GET /utm-tags/:id/timeseries with the range param", async () => {
      mockFetch([
        { date: "2026-04-28", sessions: 0, signups: 0, anonymousPlays: 0 },
        { date: "2026-04-29", sessions: 5, signups: 1, anonymousPlays: 2 },
      ]);
      const points = await getUtmTagTimeSeries("t-1", "7d");
      const url = fetchSpy.mock.calls[0][0] as string;
      expect(url).toBe("/api/admin/utm-tags/t-1/timeseries?range=7d");
      expect(points).toHaveLength(2);
      expect(points[1]).toMatchObject({
        date: "2026-04-29",
        sessions: 5,
        signups: 1,
        anonymousPlays: 2,
      });
    });

    it("throws on 400 (bad range)", async () => {
      mockFetch({ error: "range must be 7, 28, or 90" }, 400);
      await expect(
        getUtmTagTimeSeries("t-1", "7d" as "7d"),
      ).rejects.toThrow("range must be 7, 28, or 90");
    });
  });

  describe("getUtmTagComparison", () => {
    it("sends GET /utm-tags/comparison with range and origin", async () => {
      mockFetch({
        rows: [],
        summary: {
          totalClicksLifetime: 0,
          totalSessions: 0,
          totalSignups: 0,
          totalAnonymousPlays: 0,
          globalConversionRate: 0,
          globalConversionCi: { point: null, lo: 0, hi: 1, halfWidth: 0.5 },
          rangeDays: 7,
          activeTagCount: 0,
        },
      });
      await getUtmTagComparison({ range: "7d", origin: "admin" });
      const url = fetchSpy.mock.calls[0][0] as string;
      expect(url).toContain("/api/admin/utm-tags/comparison?");
      expect(url).toContain("range=7d");
      expect(url).toContain("origin=admin");
    });

    it("omits the origin param when not given (server default applies)", async () => {
      mockFetch({
        rows: [],
        summary: {
          totalClicksLifetime: 0,
          totalSessions: 0,
          totalSignups: 0,
          totalAnonymousPlays: 0,
          globalConversionRate: 0,
          globalConversionCi: { point: null, lo: 0, hi: 1, halfWidth: 0.5 },
          rangeDays: 28,
          activeTagCount: 0,
        },
      });
      await getUtmTagComparison({ range: "28d" });
      const url = fetchSpy.mock.calls[0][0] as string;
      expect(url).toBe("/api/admin/utm-tags/comparison?range=28d");
    });

    it("returns the rows + summary shape", async () => {
      mockFetch({
        rows: [
          {
            tagId: "t-1",
            name: "reddit-v1",
            utmSource: "reddit",
            utmMedium: "cpc",
            utmCampaign: "launch",
            utmContent: null,
            utmTerm: null,
            status: "active",
            originKey: null,
            hasShortCode: false,
            clicksLifetime: 0,
            sessions: 100,
            signups: 7,
            anonymousPlays: 12,
            conversionRate: 0.07,
            ciLow: 0.034,
            ciHigh: 0.139,
            isLowSample: false,
            isSignificantlyAboveAverage: false,
            isSignificantlyBelowAverage: false,
            sparkline: [0, 1, 2, 1, 2, 0, 1],
          },
        ],
        summary: {
          totalClicksLifetime: 5,
          totalSessions: 100,
          totalSignups: 7,
          totalAnonymousPlays: 12,
          globalConversionRate: 0.07,
          globalConversionCi: { point: 0.07, lo: 0.034, hi: 0.139, halfWidth: 0.05 },
          rangeDays: 7,
          activeTagCount: 1,
        },
      });
      const result = await getUtmTagComparison({ range: "7d" });
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].sparkline).toHaveLength(7);
      expect(result.summary.activeTagCount).toBe(1);
    });
  });

  describe("createUtmTag with shortCode", () => {
    it("includes shortCode in the POST body when set", async () => {
      mockFetch({ ...sampleTag, shortCode: "reddit-gw-1" }, 201);
      await createUtmTag({
        name: "reddit-gw-1",
        utmSource: "reddit",
        destinationUrl: "/giveaway",
        shortCode: "reddit-gw-1",
      });
      const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
      expect(body.shortCode).toBe("reddit-gw-1");
    });

    it("rethrows duplicate-short-code errors from the server", async () => {
      mockFetch({ error: "A UTM tag with this short code already exists" }, 400);
      await expect(
        createUtmTag({
          name: "dup",
          utmSource: "reddit",
          destinationUrl: "/giveaway",
          shortCode: "dup-sc",
        }),
      ).rejects.toThrow("A UTM tag with this short code already exists");
    });
  });

  describe("updateUtmTag with shortCode", () => {
    it("sends shortCode in the PUT body", async () => {
      mockFetch({ ...sampleTag, shortCode: "new-code" });
      await updateUtmTag("t-1", { shortCode: "new-code" });
      const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
      expect(body.shortCode).toBe("new-code");
    });

    it("sends shortCode: null to clear the code", async () => {
      mockFetch({ ...sampleTag, shortCode: null });
      await updateUtmTag("t-1", { shortCode: null });
      const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
      // Must be present as null (not omitted), so the server knows to clear.
      expect(Object.prototype.hasOwnProperty.call(body, "shortCode")).toBe(true);
      expect(body.shortCode).toBeNull();
    });
  });

  describe("suggestShortCode", () => {
    it("sends GET /utm-tags/short-code/suggest and returns the code", async () => {
      mockFetch({ code: "abc123" });
      const result = await suggestShortCode();
      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/admin/utm-tags/short-code/suggest",
        expect.objectContaining({ credentials: "same-origin" }),
      );
      expect(result.code).toBe("abc123");
    });

    it("rethrows server errors", async () => {
      mockFetch({ error: "Failed to generate short code" }, 500);
      await expect(suggestShortCode()).rejects.toThrow("Failed to generate short code");
    });
  });

  describe("buildShortUrl", () => {
    it("returns null when the tag has no short code", () => {
      const tag: AdminUtmTag = { ...sampleTag, shortCode: null };
      expect(buildShortUrl(tag, "https://pricegames.app")).toBeNull();
    });

    it("builds a /go/:code URL from the origin", () => {
      const tag: AdminUtmTag = { ...sampleTag, shortCode: "abc-1" };
      expect(buildShortUrl(tag, "https://pricegames.app")).toBe(
        "https://pricegames.app/go/abc-1",
      );
    });

    it("strips a trailing slash on the base", () => {
      const tag: AdminUtmTag = { ...sampleTag, shortCode: "abc" };
      expect(buildShortUrl(tag, "https://pricegames.app/")).toBe(
        "https://pricegames.app/go/abc",
      );
    });
  });
});
