/**
 * End-to-end integration tests for the admin gallery router. These spin
 * up a real express listener on an ephemeral port and use Node's native
 * fetch() to exercise the full request pipeline: multer for multipart
 * uploads, magic-byte detection for file serving, express.sendFile for
 * binary responses, and the metadata CRUD endpoints. The requireAdmin +
 * require2faEnrolled middleware are stubbed via vi.mock so these tests
 * cover gallery logic, not auth (that's covered by the route-level unit
 * tests in adminGallery.test.ts).
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from "vitest";
import express from "express";
import type { Server } from "http";
import fs from "fs";
import os from "os";
import path from "path";

// Stub the admin auth middleware BEFORE importing the router — vitest
// hoists vi.mock calls to the top of the module.
vi.mock("../middleware/adminAuth", () => ({
  requireAdmin: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
  require2faEnrolled: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}));

import { createAdminGalleryRouter } from "./adminGallery";
import { archiveImagesDir } from "../services/assetArchive";

let tmpArchive: string;
let originalEnv: string | undefined;
let app: express.Express;
let server: Server;
let baseUrl: string;

/** Valid 8-byte PNG header — enough for the magic-byte detector. */
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00]);
/** Valid JPEG SOI + APP0. */
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
/** Bytes that look nothing like an image. */
const BAD_BYTES = Buffer.from("not an image, just text\n", "utf8");

beforeAll(() => {
  app = express();
  app.use(express.json());
  app.use("/api/admin/gallery", createAdminGalleryRouter());
  return new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
});

afterAll(() => {
  return new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  originalEnv = process.env.IMAGE_ARCHIVE_ROOT;
  tmpArchive = fs.mkdtempSync(path.join(os.tmpdir(), "gallery-integ-"));
  process.env.IMAGE_ARCHIVE_ROOT = tmpArchive;
});

afterEach(() => {
  if (originalEnv === undefined) {
    delete process.env.IMAGE_ARCHIVE_ROOT;
  } else {
    process.env.IMAGE_ARCHIVE_ROOT = originalEnv;
  }
  fs.rmSync(tmpArchive, { recursive: true, force: true });
});

/** Seed a file directly on disk for listing/reading tests. */
function seedDisk(relPath: string, bytes: Buffer, sidecar?: Record<string, unknown>) {
  const abs = path.join(archiveImagesDir(), relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, bytes);
  if (sidecar) {
    fs.writeFileSync(abs.replace(/\.[^.]+$/, ".json"), JSON.stringify(sidecar));
  }
}

// ─── POST /upload — full multer integration ──────────────────────────────

describe("POST /upload (integration)", () => {
  it("accepts a single valid PNG and lands on disk + sidecar", async () => {
    const form = new FormData();
    form.append("files", new Blob([PNG_BYTES], { type: "image/png" }), "hello.png");
    form.append("namespace", "uploads");
    form.append("category", "custom");
    form.append("tags", "x,y,z");
    form.append("title", "Hello");
    form.append("description", "Just a test");

    const res = await fetch(`${baseUrl}/api/admin/gallery/upload`, { method: "POST", body: form });
    expect(res.status).toBe(201);
    const body = await res.json() as { assets: { id: string; title: string; tags: string[] }[]; failures: unknown[] };
    expect(body.assets).toHaveLength(1);
    expect(body.assets[0]!.id).toBe("uploads/hello.png");
    expect(body.assets[0]!.title).toBe("Hello");
    expect(body.assets[0]!.tags).toEqual(["x", "y", "z"]);
    expect(body.failures).toEqual([]);

    // File on disk
    expect(fs.existsSync(path.join(archiveImagesDir(), "uploads/hello.png"))).toBe(true);
    const sidecar = JSON.parse(
      fs.readFileSync(path.join(archiveImagesDir(), "uploads/hello.json"), "utf8"),
    );
    expect(sidecar.source).toBe("imported");
    expect(sidecar.category).toBe("custom");
  });

  it("accepts a multi-file bulk upload and stores each with its own sidecar", async () => {
    const form = new FormData();
    form.append("files", new Blob([PNG_BYTES]), "one.png");
    form.append("files", new Blob([JPEG_BYTES]), "two.jpg");
    form.append("namespace", "bulk");
    form.append("tags", "batch");

    const res = await fetch(`${baseUrl}/api/admin/gallery/upload`, { method: "POST", body: form });
    expect(res.status).toBe(201);
    const body = await res.json() as { assets: { id: string }[] };
    expect(body.assets).toHaveLength(2);
    const ids = body.assets.map((a) => a.id).sort();
    expect(ids).toEqual(["bulk/one.png", "bulk/two.jpg"]);
  });

  it("rejects a non-image file without leaving any byte on disk", async () => {
    const form = new FormData();
    form.append("files", new Blob([BAD_BYTES]), "sneaky.png");
    form.append("namespace", "rejected");

    const res = await fetch(`${baseUrl}/api/admin/gallery/upload`, { method: "POST", body: form });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string; failures: { filename: string; error: string }[] };
    expect(body.error).toMatch(/Unsupported image format/);
    expect(body.failures).toHaveLength(1);
    expect(fs.existsSync(path.join(archiveImagesDir(), "rejected"))).toBe(false);
  });

  it("normalizes the written extension to match actual file bytes", async () => {
    const form = new FormData();
    // JPEG bytes with a lying .gif name — should land as .jpg on disk
    form.append("files", new Blob([JPEG_BYTES]), "liar.gif");
    form.append("namespace", "normalize");

    const res = await fetch(`${baseUrl}/api/admin/gallery/upload`, { method: "POST", body: form });
    expect(res.status).toBe(201);
    const body = await res.json() as { assets: { filename: string }[] };
    expect(body.assets[0]!.filename).toBe("liar.jpg");
    expect(fs.existsSync(path.join(archiveImagesDir(), "normalize/liar.jpg"))).toBe(true);
    expect(fs.existsSync(path.join(archiveImagesDir(), "normalize/liar.gif"))).toBe(false);
  });

  it("returns 400 when no files are attached", async () => {
    const form = new FormData();
    form.append("namespace", "empty");
    const res = await fetch(`${baseUrl}/api/admin/gallery/upload`, { method: "POST", body: form });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("No files provided");
  });

  it("returns partial success + failures when some files are invalid", async () => {
    const form = new FormData();
    form.append("files", new Blob([PNG_BYTES]), "good.png");
    form.append("files", new Blob([BAD_BYTES]), "bad.png");
    form.append("namespace", "partial");

    const res = await fetch(`${baseUrl}/api/admin/gallery/upload`, { method: "POST", body: form });
    expect(res.status).toBe(201);
    const body = await res.json() as { assets: unknown[]; failures: { filename: string }[] };
    expect(body.assets).toHaveLength(1);
    expect(body.failures).toHaveLength(1);
    expect(body.failures[0]!.filename).toBe("bad.png");
  });
});

// ─── GET /files/* — magic-byte Content-Type detection end-to-end ─────────

describe("GET /files/* (integration)", () => {
  it("serves a PNG with Content-Type: image/png and full byte content", async () => {
    seedDisk("modes/classic.png", PNG_BYTES);
    const res = await fetch(`${baseUrl}/api/admin/gallery/files/modes/classic.png`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/image\/png/);
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.length).toBe(PNG_BYTES.length);
    expect(buf.slice(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  });

  it("overrides Content-Type to image/jpeg for JPEG bytes stored with a .png extension", async () => {
    seedDisk("mismatched/fake.png", JPEG_BYTES);
    const res = await fetch(`${baseUrl}/api/admin/gallery/files/mismatched/fake.png`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/image\/jpeg/);
  });

  it("returns a JSON 404 when the file doesn't exist", async () => {
    const res = await fetch(`${baseUrl}/api/admin/gallery/files/missing/nothing.png`);
    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("Asset not found");
  });

  it("returns a JSON 400 on path traversal attempts", async () => {
    const res = await fetch(`${baseUrl}/api/admin/gallery/files/..%2Fsecret.png`);
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/Invalid asset id/);
  });

  it("serves a freshly-written file without any server restart", async () => {
    // First request: file doesn't exist → 404
    const first = await fetch(`${baseUrl}/api/admin/gallery/files/live/drop.png`);
    expect(first.status).toBe(404);

    // Drop the file on disk (simulates the image-generation skill writing it).
    seedDisk("live/drop.png", PNG_BYTES);

    // Second request hits the same running server — should now return 200.
    const second = await fetch(`${baseUrl}/api/admin/gallery/files/live/drop.png`);
    expect(second.status).toBe(200);
    expect(second.headers.get("content-type")).toMatch(/image\/png/);
  });
});

// ─── GET /assets + /assets/:id round-trip with real disk state ───────────

describe("gallery metadata endpoints (integration)", () => {
  it("listing reflects sidecar contents written directly on disk", async () => {
    seedDisk("avatars/pirate.png", PNG_BYTES, {
      title: "Pirate Avatar",
      category: "avatars",
      tags: ["character", "pirate"],
    });
    seedDisk("modes/classic.png", PNG_BYTES, {
      title: "Classic Mode",
      category: "modes",
      tags: ["game"],
    });

    const res = await fetch(`${baseUrl}/api/admin/gallery/assets`);
    expect(res.status).toBe(200);
    const body = await res.json() as { assets: { title: string; category: string }[]; categories: string[] };
    expect(body.assets).toHaveLength(2);
    expect(body.categories).toEqual(["avatars", "modes"]);
    const titles = body.assets.map((a) => a.title).sort();
    expect(titles).toEqual(["Classic Mode", "Pirate Avatar"]);
  });

  it("PATCH updates the on-disk sidecar and subsequent listing reflects the change", async () => {
    seedDisk("avatars/pirate.png", PNG_BYTES, { title: "pirate", category: "avatars", tags: [] });

    const patchRes = await fetch(`${baseUrl}/api/admin/gallery/assets/avatars/pirate.png`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Renamed", tags: ["new", "tags"] }),
    });
    expect(patchRes.status).toBe(200);

    // Listing should reflect the update immediately — no cache.
    const listRes = await fetch(`${baseUrl}/api/admin/gallery/assets`);
    const body = await listRes.json() as { assets: { title: string; tags: string[] }[] };
    expect(body.assets[0]!.title).toBe("Renamed");
    expect(body.assets[0]!.tags).toEqual(["new", "tags"]);
  });

  it("DELETE removes the file + sidecar from disk", async () => {
    seedDisk("cleanup/file.png", PNG_BYTES, { title: "x" });
    const imgPath = path.join(archiveImagesDir(), "cleanup/file.png");
    const sidecarPath = path.join(archiveImagesDir(), "cleanup/file.json");
    expect(fs.existsSync(imgPath)).toBe(true);
    expect(fs.existsSync(sidecarPath)).toBe(true);

    const res = await fetch(`${baseUrl}/api/admin/gallery/assets/cleanup/file.png`, {
      method: "DELETE",
    });
    expect(res.status).toBe(204);
    expect(fs.existsSync(imgPath)).toBe(false);
    expect(fs.existsSync(sidecarPath)).toBe(false);
  });
});
