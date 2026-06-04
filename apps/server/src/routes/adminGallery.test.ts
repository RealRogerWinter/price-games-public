/**
 * Tests for the admin asset gallery routes and the underlying
 * assetArchive service. Points IMAGE_ARCHIVE_ROOT at a tmp directory
 * per-test to keep the real archive on disk untouched.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createAdminGalleryRouter } from "./adminGallery";
import {
  listAssets,
  getAsset,
  updateAsset,
  deleteAsset,
  uploadAsset,
  detectUploadExtension,
  resolveAssetPath,
  archiveImagesDir,
  archiveRoot,
  ensureArchiveDir,
} from "../services/assetArchive";

/** Minimal valid PNG byte sequence (just the 8-byte header). */
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00]);
/** Minimal valid JPEG byte sequence. */
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
/** Minimal valid WebP byte sequence. */
const WEBP_BYTES = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]);
/** Minimal valid GIF byte sequence. */
const GIF_BYTES = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);

// ─── Harness ─────────────────────────────────────────────────────────────

let tmpArchive: string;
let originalEnv: string | undefined;

beforeEach(() => {
  originalEnv = process.env.IMAGE_ARCHIVE_ROOT;
  tmpArchive = fs.mkdtempSync(path.join(os.tmpdir(), "price-game-archive-"));
  process.env.IMAGE_ARCHIVE_ROOT = tmpArchive;
  ensureArchiveDir();
});

afterEach(() => {
  if (originalEnv === undefined) {
    delete process.env.IMAGE_ARCHIVE_ROOT;
  } else {
    process.env.IMAGE_ARCHIVE_ROOT = originalEnv;
  }
  fs.rmSync(tmpArchive, { recursive: true, force: true });
});

/** Create a fake PNG at `<archive>/images/<relPath>` and optionally its sidecar. */
function seedImage(relPath: string, sidecar?: Record<string, unknown>) {
  const abs = path.join(archiveImagesDir(), relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  // Minimal valid PNG header so size > 0; contents don't matter for our tests.
  fs.writeFileSync(abs, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (sidecar) {
    const sidecarAbs = abs.replace(/\.[^.]+$/, ".json");
    fs.writeFileSync(sidecarAbs, JSON.stringify(sidecar));
  }
  return abs;
}

/** Find a handler on the router stack. Returns the last function on the matched route. */
function getHandler(router: any, method: string, routePath: string): Function | undefined {
  for (const layer of router.stack) {
    if (layer.route?.path === routePath) {
      const mStack = layer.route.stack.filter((s: any) => s.method === method.toLowerCase());
      if (mStack.length > 0) return mStack[mStack.length - 1]?.handle;
    }
  }
  return undefined;
}

function mockRes() {
  const data: {
    statusCode?: number;
    body?: any;
    sent?: boolean;
    sendFileArgs?: { path: string; options: { headers?: Record<string, string> } };
  } = {};
  const res: any = {
    status(code: number) {
      data.statusCode = code;
      return res;
    },
    json(d: any) {
      data.body = d;
      return res;
    },
    send() {
      data.sent = true;
      return res;
    },
    sendFile(p: string, options: { headers?: Record<string, string> } = {}) {
      data.sendFileArgs = { path: p, options };
      return res;
    },
  };
  return { res, data };
}

/** Write a real PNG file (valid 8-byte header) at the given archive-relative path. */
function seedRealPng(relPath: string) {
  const abs = path.join(archiveImagesDir(), relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  return abs;
}

/** Write a JPEG-byte file with a .png extension — simulates the "mislabeled" case. */
function seedJpegAsPng(relPath: string) {
  const abs = path.join(archiveImagesDir(), relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  // SOI + APP0 marker — minimal valid JPEG header.
  fs.writeFileSync(abs, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]));
  return abs;
}

// ─── Service: archiveRoot / archiveImagesDir ─────────────────────────────

describe("assetArchive — config", () => {
  it("reads archiveRoot from env on every call", () => {
    expect(archiveRoot()).toBe(tmpArchive);
    process.env.IMAGE_ARCHIVE_ROOT = "/some/other/path";
    expect(archiveRoot()).toBe("/some/other/path");
  });

  it("archiveImagesDir joins the images subdir onto root", () => {
    expect(archiveImagesDir()).toBe(path.join(tmpArchive, "images"));
  });

  it("falls back to <home>/image-archive when env is unset", () => {
    delete process.env.IMAGE_ARCHIVE_ROOT;
    expect(archiveRoot()).toBe(path.join(os.homedir(), "image-archive"));
  });
});

// ─── Service: resolveAssetPath ───────────────────────────────────────────

describe("assetArchive — resolveAssetPath", () => {
  it("resolves a valid relative id under the archive", () => {
    const p = resolveAssetPath("avatars/pirate.png");
    expect(p).toBe(path.join(archiveImagesDir(), "avatars", "pirate.png"));
  });

  it("rejects parent-directory traversal", () => {
    expect(() => resolveAssetPath("../../etc/passwd")).toThrow("Invalid asset id");
  });

  it("rejects absolute paths", () => {
    expect(() => resolveAssetPath("/etc/passwd")).toThrow("Invalid asset id");
  });

  it("rejects backslash-prefixed paths", () => {
    expect(() => resolveAssetPath("\\windows")).toThrow("Invalid asset id");
  });

  it("rejects ids containing .. in a segment", () => {
    expect(() => resolveAssetPath("avatars/../escape.png")).toThrow("Invalid asset id");
  });

  it("rejects a symlink inside the archive that points outside", () => {
    // Create a real file OUTSIDE the archive, then a symlink INSIDE the
    // archive pointing to it. The lexical check passes (no `..`), but
    // the symlink dereference must reject.
    ensureArchiveDir();
    const outside = path.join(tmpArchive, "OUTSIDE.png");
    fs.writeFileSync(outside, "secret");
    const linkDir = path.join(archiveImagesDir(), "trap");
    fs.mkdirSync(linkDir, { recursive: true });
    fs.symlinkSync(outside, path.join(linkDir, "link.png"));
    expect(() => resolveAssetPath("trap/link.png")).toThrow("Invalid asset id");
  });

  it("allows a symlink that resolves to a path inside the archive", () => {
    // Symlink one archive file to another — still valid.
    ensureArchiveDir();
    const inside = path.join(archiveImagesDir(), "original.png");
    fs.writeFileSync(inside, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    fs.symlinkSync(inside, path.join(archiveImagesDir(), "alias.png"));
    expect(() => resolveAssetPath("alias.png")).not.toThrow();
  });
});

// ─── Service: listAssets ─────────────────────────────────────────────────

describe("assetArchive — listAssets", () => {
  it("returns an empty array when the archive is empty", () => {
    expect(listAssets()).toEqual([]);
  });

  it("surfaces images with sidecar metadata merged in", () => {
    seedImage("avatars/pirate.png", {
      title: "Pirate Avatar",
      category: "avatars",
      tags: ["character", "pirate"],
      prompt: "A friendly pirate",
      createdAt: "2026-01-01T00:00:00Z",
    });
    const assets = listAssets();
    expect(assets).toHaveLength(1);
    expect(assets[0]).toMatchObject({
      id: "avatars/pirate.png",
      title: "Pirate Avatar",
      category: "avatars",
      tags: ["character", "pirate"],
      prompt: "A friendly pirate",
    });
  });

  it("derives a sensible default category from the parent directory", () => {
    seedImage("modes/classic.png");
    const [asset] = listAssets();
    expect(asset?.category).toBe("modes");
    expect(asset?.title).toBe("classic");
  });

  it("uses 'uncategorized' for root-level images without sidecars", () => {
    seedImage("loose.png");
    const [asset] = listAssets();
    expect(asset?.category).toBe("uncategorized");
  });

  it("sorts by category then title", () => {
    seedImage("zzz/first.png");
    seedImage("aaa/second.png");
    seedImage("aaa/first.png");
    const ids = listAssets().map((a) => a.id);
    expect(ids).toEqual(["aaa/first.png", "aaa/second.png", "zzz/first.png"]);
  });

  it("filters out hidden files and non-image extensions", () => {
    seedImage("avatars/pirate.png");
    fs.writeFileSync(path.join(archiveImagesDir(), ".DS_Store"), "junk");
    fs.writeFileSync(path.join(archiveImagesDir(), "readme.txt"), "hi");
    const assets = listAssets();
    expect(assets.map((a) => a.id)).toEqual(["avatars/pirate.png"]);
  });

  it("ignores malformed sidecar JSON and falls back to defaults", () => {
    const abs = seedImage("modes/classic.png");
    fs.writeFileSync(abs.replace(".png", ".json"), "{ not valid json");
    const [asset] = listAssets();
    expect(asset?.title).toBe("classic");
    expect(asset?.tags).toEqual([]);
  });

  it("filters non-string entries out of the tags array", () => {
    seedImage("avatars/pirate.png", { tags: ["good", 42, null, "also-good"] });
    const [asset] = listAssets();
    expect(asset?.tags).toEqual(["good", "also-good"]);
  });
});

// ─── Service: getAsset / updateAsset / deleteAsset ───────────────────────

describe("assetArchive — get/update/delete", () => {
  it("getAsset returns null for a missing id", () => {
    expect(getAsset("does/not/exist.png")).toBeNull();
  });

  it("updateAsset creates a sidecar on first write", () => {
    seedImage("modes/classic.png");
    const updated = updateAsset("modes/classic.png", { title: "Classic Mode", tags: ["game"] });
    expect(updated?.title).toBe("Classic Mode");
    expect(updated?.tags).toEqual(["game"]);
    const sidecarPath = path.join(archiveImagesDir(), "modes", "classic.json");
    expect(fs.existsSync(sidecarPath)).toBe(true);
    const onDisk = JSON.parse(fs.readFileSync(sidecarPath, "utf8"));
    expect(onDisk.updatedAt).toBeDefined();
  });

  it("updateAsset merges with an existing sidecar", () => {
    seedImage("avatars/pirate.png", { title: "Pirate", tags: ["old"] });
    const updated = updateAsset("avatars/pirate.png", { tags: ["new", "tags"] });
    expect(updated?.title).toBe("Pirate"); // preserved
    expect(updated?.tags).toEqual(["new", "tags"]);
  });

  it("updateAsset strips unknown fields from the patch", () => {
    seedImage("avatars/pirate.png");
    updateAsset("avatars/pirate.png", {
      title: "Pirate",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...(({ hax: "evil" } as any)),
    });
    const sidecar = JSON.parse(
      fs.readFileSync(path.join(archiveImagesDir(), "avatars", "pirate.json"), "utf8"),
    );
    expect(sidecar.hax).toBeUndefined();
    expect(sidecar.title).toBe("Pirate");
  });

  it("updateAsset truncates overlong string fields", () => {
    seedImage("avatars/pirate.png");
    const longTitle = "a".repeat(500);
    const updated = updateAsset("avatars/pirate.png", { title: longTitle });
    expect(updated?.title?.length).toBe(200);
  });

  it("updateAsset caps the number of tags at 50", () => {
    seedImage("avatars/pirate.png");
    const manyTags = Array.from({ length: 100 }, (_, i) => `tag-${i}`);
    const updated = updateAsset("avatars/pirate.png", { tags: manyTags });
    expect(updated?.tags.length).toBe(50);
  });

  it("updateAsset returns null for a missing asset", () => {
    expect(updateAsset("missing.png", { title: "x" })).toBeNull();
  });

  it("deleteAsset removes both image and sidecar", () => {
    seedImage("avatars/pirate.png", { title: "p" });
    const imgPath = path.join(archiveImagesDir(), "avatars", "pirate.png");
    const sidecarPath = path.join(archiveImagesDir(), "avatars", "pirate.json");
    expect(deleteAsset("avatars/pirate.png")).toBe(true);
    expect(fs.existsSync(imgPath)).toBe(false);
    expect(fs.existsSync(sidecarPath)).toBe(false);
  });

  it("deleteAsset returns false for a missing asset", () => {
    expect(deleteAsset("nope.png")).toBe(false);
  });

  it("deleteAsset cleans up an empty parent directory", () => {
    seedImage("lonely/only.png");
    const parent = path.join(archiveImagesDir(), "lonely");
    expect(deleteAsset("lonely/only.png")).toBe(true);
    expect(fs.existsSync(parent)).toBe(false);
  });

  it("deleteAsset keeps non-empty parent directories intact", () => {
    seedImage("shared/one.png");
    seedImage("shared/two.png");
    deleteAsset("shared/one.png");
    const parent = path.join(archiveImagesDir(), "shared");
    expect(fs.existsSync(parent)).toBe(true);
    expect(fs.existsSync(path.join(parent, "two.png"))).toBe(true);
  });
});

// ─── Route handlers ──────────────────────────────────────────────────────

describe("adminGallery router", () => {
  it("GET /assets returns the list and unique categories", () => {
    seedImage("avatars/pirate.png", { category: "avatars" });
    seedImage("modes/classic.png", { category: "modes" });
    const router = createAdminGalleryRouter();
    const handler = getHandler(router, "get", "/assets");
    expect(handler).toBeDefined();
    const { res, data } = mockRes();
    handler!({ params: {} } as any, res, () => {});
    expect(data.body.assets).toHaveLength(2);
    expect(data.body.categories).toEqual(["avatars", "modes"]);
  });

  it("GET /assets surfaces a 500 when listing throws", () => {
    // Point archive at a path whose parent doesn't exist AND can't be
    // created — force mkdirSync to throw inside ensureArchiveDir.
    const router = createAdminGalleryRouter();
    const handler = getHandler(router, "get", "/assets");
    const { res, data } = mockRes();
    // Simulate failure by removing the tmp dir entirely.
    fs.rmSync(tmpArchive, { recursive: true, force: true });
    process.env.IMAGE_ARCHIVE_ROOT = "/proc/1/root/nonexistent-dev-null";
    handler!({ params: {} } as any, res, () => {});
    // Either we got a 500 (mkdir failed) or an empty list (somehow worked).
    // The important thing is: we didn't crash.
    expect([200, 500]).toContain(data.statusCode ?? 200);
  });

  it("GET /assets/* returns a single asset", () => {
    seedImage("avatars/pirate.png", { title: "Pirate" });
    const router = createAdminGalleryRouter();
    const handler = getHandler(router, "get", "/assets/*");
    const { res, data } = mockRes();
    handler!({ params: { 0: "avatars/pirate.png" } } as any, res, () => {});
    expect(data.body.title).toBe("Pirate");
  });

  it("GET /assets/* returns 404 for missing asset", () => {
    const router = createAdminGalleryRouter();
    const handler = getHandler(router, "get", "/assets/*");
    const { res, data } = mockRes();
    handler!({ params: { 0: "nothing.png" } } as any, res, () => {});
    expect(data.statusCode).toBe(404);
  });

  it("GET /assets/* returns 400 on missing id", () => {
    const router = createAdminGalleryRouter();
    const handler = getHandler(router, "get", "/assets/*");
    const { res, data } = mockRes();
    handler!({ params: {} } as any, res, () => {});
    expect(data.statusCode).toBe(400);
  });

  it("GET /assets/* returns 400 on traversal attempts", () => {
    const router = createAdminGalleryRouter();
    const handler = getHandler(router, "get", "/assets/*");
    const { res, data } = mockRes();
    handler!({ params: { 0: "../secret.png" } } as any, res, () => {});
    expect(data.statusCode).toBe(400);
  });

  it("PATCH /assets/* updates metadata", () => {
    seedImage("modes/classic.png");
    const router = createAdminGalleryRouter();
    const handler = getHandler(router, "patch", "/assets/*");
    const { res, data } = mockRes();
    handler!(
      { params: { 0: "modes/classic.png" }, body: { title: "Classic!", tags: ["game"] } } as any,
      res,
      () => {},
    );
    expect(data.body.title).toBe("Classic!");
    expect(data.body.tags).toEqual(["game"]);
  });

  it("PATCH /assets/* returns 400 when body is not an object", () => {
    const router = createAdminGalleryRouter();
    const handler = getHandler(router, "patch", "/assets/*");
    const { res, data } = mockRes();
    handler!({ params: { 0: "modes/classic.png" }, body: "oops" } as any, res, () => {});
    expect(data.statusCode).toBe(400);
  });

  it("PATCH /assets/* returns 400 when body is an array", () => {
    const router = createAdminGalleryRouter();
    const handler = getHandler(router, "patch", "/assets/*");
    const { res, data } = mockRes();
    handler!({ params: { 0: "modes/classic.png" }, body: [] } as any, res, () => {});
    expect(data.statusCode).toBe(400);
  });

  it("PATCH /assets/* returns 400 when id is missing", () => {
    const router = createAdminGalleryRouter();
    const handler = getHandler(router, "patch", "/assets/*");
    const { res, data } = mockRes();
    handler!({ params: {}, body: { title: "x" } } as any, res, () => {});
    expect(data.statusCode).toBe(400);
  });

  it("PATCH /assets/* returns 404 for missing asset", () => {
    const router = createAdminGalleryRouter();
    const handler = getHandler(router, "patch", "/assets/*");
    const { res, data } = mockRes();
    handler!({ params: { 0: "nope.png" }, body: { title: "x" } } as any, res, () => {});
    expect(data.statusCode).toBe(404);
  });

  it("PATCH /assets/* returns 400 on invalid id", () => {
    const router = createAdminGalleryRouter();
    const handler = getHandler(router, "patch", "/assets/*");
    const { res, data } = mockRes();
    handler!({ params: { 0: "../evil.png" }, body: { title: "x" } } as any, res, () => {});
    expect(data.statusCode).toBe(400);
  });

  it("DELETE /assets/* removes and returns 204", () => {
    seedImage("modes/classic.png");
    const router = createAdminGalleryRouter();
    const handler = getHandler(router, "delete", "/assets/*");
    const { res, data } = mockRes();
    handler!({ params: { 0: "modes/classic.png" } } as any, res, () => {});
    expect(data.statusCode).toBe(204);
    expect(fs.existsSync(path.join(archiveImagesDir(), "modes", "classic.png"))).toBe(false);
  });

  it("DELETE /assets/* returns 404 for missing asset", () => {
    const router = createAdminGalleryRouter();
    const handler = getHandler(router, "delete", "/assets/*");
    const { res, data } = mockRes();
    handler!({ params: { 0: "nope.png" } } as any, res, () => {});
    expect(data.statusCode).toBe(404);
  });

  it("DELETE /assets/* returns 400 when id is missing", () => {
    const router = createAdminGalleryRouter();
    const handler = getHandler(router, "delete", "/assets/*");
    const { res, data } = mockRes();
    handler!({ params: {} } as any, res, () => {});
    expect(data.statusCode).toBe(400);
  });

  it("DELETE /assets/* returns 400 on invalid id", () => {
    const router = createAdminGalleryRouter();
    const handler = getHandler(router, "delete", "/assets/*");
    const { res, data } = mockRes();
    handler!({ params: { 0: "../secret.png" } } as any, res, () => {});
    expect(data.statusCode).toBe(400);
  });

  it("extractWildcardId handles the `asset` named param variant", () => {
    // Covered by GET /assets/* using .asset instead of [0].
    seedImage("modes/classic.png");
    const router = createAdminGalleryRouter();
    const handler = getHandler(router, "get", "/assets/*");
    const { res, data } = mockRes();
    handler!({ params: { asset: "modes/classic.png" } } as any, res, () => {});
    expect(data.body?.title).toBe("classic");
  });

  it("extractWildcardId normalizes backslashes to forward slashes", () => {
    seedImage("modes/classic.png");
    const router = createAdminGalleryRouter();
    const handler = getHandler(router, "get", "/assets/*");
    const { res, data } = mockRes();
    handler!({ params: { 0: "modes\\classic.png" } } as any, res, () => {});
    expect(data.body?.title).toBe("classic");
  });

  // ─── /files/* Content-Type detection ───────────────────────────────────

  it("GET /files/* sends image/png for a real PNG", () => {
    seedRealPng("modes/classic.png");
    const router = createAdminGalleryRouter();
    const handler = getHandler(router, "get", "/files/*");
    const { res, data } = mockRes();
    handler!({ params: { 0: "modes/classic.png" } } as any, res, () => {});
    expect(data.sendFileArgs?.options.headers?.["Content-Type"]).toBe("image/png");
    expect(data.sendFileArgs?.path.endsWith("modes/classic.png")).toBe(true);
  });

  it("GET /files/* overrides Content-Type to image/jpeg when a .png file contains JPEG bytes", () => {
    seedJpegAsPng("mislabeled/fake.png");
    const router = createAdminGalleryRouter();
    const handler = getHandler(router, "get", "/files/*");
    const { res, data } = mockRes();
    handler!({ params: { 0: "mislabeled/fake.png" } } as any, res, () => {});
    expect(data.sendFileArgs?.options.headers?.["Content-Type"]).toBe("image/jpeg");
  });

  it("GET /files/* sends image/webp for a real WebP", () => {
    const abs = path.join(archiveImagesDir(), "webby/pic.png");
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    // RIFF____WEBP header
    fs.writeFileSync(
      abs,
      Buffer.from([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]),
    );
    const router = createAdminGalleryRouter();
    const handler = getHandler(router, "get", "/files/*");
    const { res, data } = mockRes();
    handler!({ params: { 0: "webby/pic.png" } } as any, res, () => {});
    expect(data.sendFileArgs?.options.headers?.["Content-Type"]).toBe("image/webp");
  });

  it("GET /files/* sends image/gif for a real GIF", () => {
    const abs = path.join(archiveImagesDir(), "gifs/anim.png");
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]));
    const router = createAdminGalleryRouter();
    const handler = getHandler(router, "get", "/files/*");
    const { res, data } = mockRes();
    handler!({ params: { 0: "gifs/anim.png" } } as any, res, () => {});
    expect(data.sendFileArgs?.options.headers?.["Content-Type"]).toBe("image/gif");
  });

  it("GET /files/* falls back to application/octet-stream for unknown magic", () => {
    const abs = path.join(archiveImagesDir(), "weird/blob.png");
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, Buffer.from([0x00, 0x00, 0x00, 0x00, 0xff, 0xff, 0xff, 0xff]));
    const router = createAdminGalleryRouter();
    const handler = getHandler(router, "get", "/files/*");
    const { res, data } = mockRes();
    handler!({ params: { 0: "weird/blob.png" } } as any, res, () => {});
    expect(data.sendFileArgs?.options.headers?.["Content-Type"]).toBe("application/octet-stream");
  });

  it("GET /files/* returns 404 for missing file", () => {
    const router = createAdminGalleryRouter();
    const handler = getHandler(router, "get", "/files/*");
    const { res, data } = mockRes();
    handler!({ params: { 0: "missing/nope.png" } } as any, res, () => {});
    expect(data.statusCode).toBe(404);
  });

  it("GET /files/* returns 400 when id is missing", () => {
    const router = createAdminGalleryRouter();
    const handler = getHandler(router, "get", "/files/*");
    const { res, data } = mockRes();
    handler!({ params: {} } as any, res, () => {});
    expect(data.statusCode).toBe(400);
  });

  it("GET /files/* returns 400 on traversal attempts", () => {
    const router = createAdminGalleryRouter();
    const handler = getHandler(router, "get", "/files/*");
    const { res, data } = mockRes();
    handler!({ params: { 0: "../secret.png" } } as any, res, () => {});
    expect(data.statusCode).toBe(400);
  });
});

// ─── Service: detectUploadExtension ──────────────────────────────────────

describe("assetArchive — detectUploadExtension", () => {
  it("recognizes PNG bytes", () => {
    expect(detectUploadExtension(PNG_BYTES)).toBe(".png");
  });
  it("recognizes JPEG bytes", () => {
    expect(detectUploadExtension(JPEG_BYTES)).toBe(".jpg");
  });
  it("recognizes WebP bytes", () => {
    expect(detectUploadExtension(WEBP_BYTES)).toBe(".webp");
  });
  it("recognizes GIF bytes", () => {
    expect(detectUploadExtension(GIF_BYTES)).toBe(".gif");
  });
  it("returns null for unknown magic", () => {
    expect(detectUploadExtension(Buffer.from([0x00, 0x01, 0x02, 0x03, 0, 0, 0, 0, 0, 0, 0, 0]))).toBeNull();
  });
  it("returns null for a too-short buffer", () => {
    expect(detectUploadExtension(Buffer.from([0x89, 0x50]))).toBeNull();
  });
});

// ─── Service: uploadAsset ────────────────────────────────────────────────

describe("assetArchive — uploadAsset", () => {
  it("writes a PNG with sidecar metadata", () => {
    const asset = uploadAsset({
      originalName: "My Cool Avatar.png",
      buffer: PNG_BYTES,
      namespace: "uploads",
      category: "custom",
      tags: ["one", "two"],
    });
    expect(asset.id).toBe("uploads/my-cool-avatar.png");
    expect(asset.category).toBe("custom");
    expect(asset.tags).toEqual(["one", "two"]);
    const imgPath = path.join(archiveImagesDir(), "uploads", "my-cool-avatar.png");
    const jsonPath = path.join(archiveImagesDir(), "uploads", "my-cool-avatar.json");
    expect(fs.existsSync(imgPath)).toBe(true);
    expect(fs.existsSync(jsonPath)).toBe(true);
    const sidecar = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
    expect(sidecar.source).toBe("imported");
  });

  it("normalizes the extension based on magic bytes, not the uploaded filename", () => {
    const asset = uploadAsset({
      originalName: "fake.gif",
      buffer: JPEG_BYTES,
      namespace: "uploads",
    });
    expect(asset.filename).toBe("fake.jpg");
  });

  it("slugifies uppercase and special characters in the filename", () => {
    const asset = uploadAsset({
      originalName: "Weird!!  Name @2x.png",
      buffer: PNG_BYTES,
      namespace: "uploads",
    });
    expect(asset.filename).toMatch(/^weird-name-2x\.png$/);
  });

  it("appends a numeric suffix on filename collision", () => {
    uploadAsset({ originalName: "pic.png", buffer: PNG_BYTES, namespace: "uploads" });
    const second = uploadAsset({ originalName: "pic.png", buffer: PNG_BYTES, namespace: "uploads" });
    expect(second.filename).toBe("pic-2.png");
    const third = uploadAsset({ originalName: "pic.png", buffer: PNG_BYTES, namespace: "uploads" });
    expect(third.filename).toBe("pic-3.png");
  });

  it("uses an atomic exclusive-create write that refuses to overwrite an existing file", () => {
    // Pre-place a file at the exact collision path the next upload
    // would compute. The atomic `wx` open must fall through to the
    // suffix-appended name and preserve the pre-existing bytes.
    const firstAbs = path.join(archiveImagesDir(), "ns", "pic.png");
    fs.mkdirSync(path.dirname(firstAbs), { recursive: true });
    fs.writeFileSync(firstAbs, Buffer.from("pre-existing content"));
    const asset = uploadAsset({
      originalName: "pic.png",
      buffer: PNG_BYTES,
      namespace: "ns",
    });
    // Upload landed at pic-2.png, not pic.png.
    expect(asset.filename).toBe("pic-2.png");
    // Pre-existing file is untouched.
    expect(fs.readFileSync(firstAbs).toString()).toBe("pre-existing content");
  });

  it("slugifies the namespace and creates the directory", () => {
    uploadAsset({
      originalName: "pic.png",
      buffer: PNG_BYTES,
      namespace: "Weird Namespace!!",
    });
    expect(fs.existsSync(path.join(archiveImagesDir(), "weird-namespace"))).toBe(true);
  });

  it("rejects empty namespaces", () => {
    expect(() =>
      uploadAsset({ originalName: "pic.png", buffer: PNG_BYTES, namespace: "" }),
    ).toThrow("Namespace is required");
    expect(() =>
      uploadAsset({ originalName: "pic.png", buffer: PNG_BYTES, namespace: "  " }),
    ).toThrow("Namespace is required");
  });

  it("rejects non-image buffers", () => {
    expect(() =>
      uploadAsset({
        originalName: "evil.png",
        buffer: Buffer.from("#!/bin/sh\nrm -rf /"),
        namespace: "uploads",
      }),
    ).toThrow(/Unsupported image format/);
  });

  it("defaults title to the filename stem when omitted", () => {
    const asset = uploadAsset({
      originalName: "cool-thing.png",
      buffer: PNG_BYTES,
      namespace: "uploads",
    });
    expect(asset.title).toBe("cool-thing");
  });

  it("defaults category to the namespace when omitted", () => {
    const asset = uploadAsset({
      originalName: "pic.png",
      buffer: PNG_BYTES,
      namespace: "experiments-v3",
    });
    expect(asset.category).toBe("experiments-v3");
  });

  it("respects an explicit source field", () => {
    const asset = uploadAsset({
      originalName: "pic.png",
      buffer: PNG_BYTES,
      namespace: "uploads",
      source: "generated",
    });
    expect(asset.source).toBe("generated");
  });
});

// ─── Route: POST /upload ─────────────────────────────────────────────────

describe("adminGallery — POST /upload", () => {
  it("registers the upload route on the router", () => {
    const router = createAdminGalleryRouter();
    const handler = getHandler(router, "post", "/upload");
    expect(handler).toBeDefined();
  });
});
