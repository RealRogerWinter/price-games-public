import { describe, it, expect, vi, beforeEach } from "vitest";
import { createTestDb } from "../test/dbHelper";
import type { Database as DatabaseType } from "better-sqlite3";
import { fetchProductImage } from "./imageProxy";

let testDb: DatabaseType;

beforeEach(() => {
  testDb = createTestDb();
  vi.restoreAllMocks();
});

describe("fetchProductImage", () => {
  it("returns null when product does not exist", async () => {
    const result = await fetchProductImage("999", testDb);
    expect(result).toBeNull();
  });

  it("fetches image from stored URL", async () => {
    testDb.prepare(
      "INSERT INTO products (id, asin, title, image_url, description, price_cents, category, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, 1)"
    ).run(1, "B12345678X", "Test", "https://m.media-amazon.com/images/I/test.jpg", "desc", 1999, "Electronics");

    const fakeBuffer = Buffer.from("fake-image-data-that-is-longer-than-1000-bytes" + "x".repeat(1000));
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: true,
      arrayBuffer: async () => fakeBuffer.buffer.slice(fakeBuffer.byteOffset, fakeBuffer.byteOffset + fakeBuffer.byteLength),
      headers: new Headers({ "content-type": "image/jpeg" }),
    } as Response);

    const result = await fetchProductImage("1", testDb);
    expect(result).not.toBeNull();
    expect(result!.contentType).toBe("image/jpeg");
    expect(result!.buffer.length).toBeGreaterThan(0);
  });

  it("returns null when image fetch fails", async () => {
    testDb.prepare(
      "INSERT INTO products (id, asin, title, image_url, description, price_cents, category, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, 1)"
    ).run(1, "B12345678X", "Test", "https://m.media-amazon.com/images/I/test.jpg", "desc", 1999, "Electronics");

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: false,
      status: 404,
    } as Response);

    const result = await fetchProductImage("1", testDb);
    expect(result).toBeNull();
  });

  it("returns null when product has no image URL and no ASIN", async () => {
    testDb.prepare(
      "INSERT INTO products (id, asin, title, image_url, description, price_cents, category, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, 1)"
    ).run(1, null, "Test", null, "desc", 1999, "Electronics");

    const result = await fetchProductImage("1", testDb);
    expect(result).toBeNull();
  });

  it("defaults content-type to image/jpeg when not provided", async () => {
    testDb.prepare(
      "INSERT INTO products (id, asin, title, image_url, description, price_cents, category, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, 1)"
    ).run(1, "B12345678X", "Test", "https://m.media-amazon.com/images/I/test.jpg", "desc", 1999, "Electronics");

    const fakeBuffer = Buffer.from("x".repeat(1100));
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: true,
      arrayBuffer: async () => fakeBuffer.buffer.slice(fakeBuffer.byteOffset, fakeBuffer.byteOffset + fakeBuffer.byteLength),
      headers: new Headers({}),
    } as Response);

    const result = await fetchProductImage("1", testDb);
    expect(result).not.toBeNull();
    expect(result!.contentType).toBe("image/jpeg");
  });

  it("returns null when image URL is not in allowed domains (SSRF prevention)", async () => {
    testDb.prepare(
      "INSERT INTO products (id, asin, title, image_url, description, price_cents, category, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, 1)"
    ).run(1, null, "Test", "https://evil.com/image.jpg", "desc", 1999, "Electronics");

    const result = await fetchProductImage("1", testDb);
    expect(result).toBeNull();
  });

  it("returns null when content-length exceeds size limit", async () => {
    testDb.prepare(
      "INSERT INTO products (id, asin, title, image_url, description, price_cents, category, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, 1)"
    ).run(1, "B12345678X", "Test", "https://m.media-amazon.com/images/I/test.jpg", "desc", 1999, "Electronics");

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(0),
      headers: new Headers({ "content-length": "10000000", "content-type": "image/jpeg" }),
    } as Response);

    const result = await fetchProductImage("1", testDb);
    expect(result).toBeNull();
  });

  it("falls back to image/jpeg for non-image content-type", async () => {
    testDb.prepare(
      "INSERT INTO products (id, asin, title, image_url, description, price_cents, category, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, 1)"
    ).run(1, "B12345678X", "Test", "https://m.media-amazon.com/images/I/test.jpg", "desc", 1999, "Electronics");

    const fakeBuffer = Buffer.from("x".repeat(1100));
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: true,
      arrayBuffer: async () => fakeBuffer.buffer.slice(fakeBuffer.byteOffset, fakeBuffer.byteOffset + fakeBuffer.byteLength),
      headers: new Headers({ "content-type": "text/html" }),
    } as Response);

    const result = await fetchProductImage("1", testDb);
    expect(result).not.toBeNull();
    expect(result!.contentType).toBe("image/jpeg");
  });
});
