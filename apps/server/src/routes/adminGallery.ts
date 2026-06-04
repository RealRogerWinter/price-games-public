/**
 * Admin asset gallery REST API.
 *
 * Exposes CRUD over the host-level image archive at `IMAGE_ARCHIVE_ROOT`.
 * All routes require an authenticated admin session with 2FA enrolled —
 * same gate as the rest of the admin API. Image binaries are served by a
 * custom handler that detects Content-Type from magic bytes (not file
 * extension) so that files mislabeled with the wrong extension still
 * render in browsers with `X-Content-Type-Options: nosniff` enforced.
 */

import { Router, Request, Response } from "express";
import fs from "fs";
import multer from "multer";
import { requireAdmin, require2faEnrolled } from "../middleware/adminAuth";
import {
  listAssets,
  getAsset,
  updateAsset,
  deleteAsset,
  uploadAsset,
  resolveAssetPath,
  type AssetMetadata,
  type AssetMetadataPatch,
} from "../services/assetArchive";

/**
 * Max individual file size for uploads (20 MB). Covers generous image
 * generation output sizes without letting a single request drag the
 * server's memory too far.
 */
const UPLOAD_MAX_FILE_SIZE = 20 * 1024 * 1024;

/** Max number of files accepted in a single upload request. */
const UPLOAD_MAX_FILE_COUNT = 50;

/**
 * Multer instance for in-memory uploads. We keep files in a Buffer so
 * the service layer can magic-byte-validate them before any filesystem
 * write — nothing untrusted touches disk until we know it's an image.
 */
const uploadMiddleware = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: UPLOAD_MAX_FILE_SIZE,
    files: UPLOAD_MAX_FILE_COUNT,
  },
}).array("files", UPLOAD_MAX_FILE_COUNT);

/**
 * Detect an image file's true MIME type from its first 12 bytes. Many
 * of our archived images were saved with the wrong file extension (the
 * image-generation CLI sometimes writes JPEG bytes into .png files),
 * and helmet's nosniff policy means we cannot rely on extension-based
 * content-type detection — the browser would refuse to render a JPEG
 * declared as image/png. Sniffing on the server fixes this.
 *
 * Falls back to application/octet-stream for unrecognized headers.
 */
function detectImageContentType(absPath: string): string {
  try {
    const fd = fs.openSync(absPath, "r");
    const buf = Buffer.alloc(12);
    fs.readSync(fd, buf, 0, 12, 0);
    fs.closeSync(fd);
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
      return "image/png";
    }
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
      return "image/jpeg";
    }
    if (
      buf.slice(0, 4).toString("ascii") === "RIFF" &&
      buf.slice(8, 12).toString("ascii") === "WEBP"
    ) {
      return "image/webp";
    }
    if (
      buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38
    ) {
      return "image/gif";
    }
  } catch {
    // Fall through to the generic fallback.
  }
  return "application/octet-stream";
}

/**
 * Extract the `*` wildcard segment from an Express route into a normalized
 * forward-slash path. Works whether Express attached it as `req.params[0]`
 * (Express 4 style) or `req.params.asset` when a named capture is used.
 */
function extractWildcardId(req: Request): string {
  const raw =
    (req.params as { 0?: string; asset?: string })[0] ??
    (req.params as { 0?: string; asset?: string }).asset ??
    "";
  // Normalize any backslashes (Windows hosts) and strip leading slashes.
  return raw.replace(/\\/g, "/").replace(/^\/+/, "");
}

/**
 * Build the admin gallery router. Mounted at `/api/admin/gallery` from
 * `apps/server/src/index.ts`. The archive directory is created lazily
 * on first write (see `uploadAsset` and `listAssets`), not at router
 * construction time, so tests and CI environments can mount the router
 * before setting `IMAGE_ARCHIVE_ROOT` to a writable temp directory.
 */
export function createAdminGalleryRouter(): Router {
  const router = Router();

  // ─── Image binaries ────────────────────────────────────────────────────
  // Custom file serving with magic-byte-based Content-Type detection so
  // mislabeled files (e.g. JPEG data with a .png extension) still render
  // under the global `X-Content-Type-Options: nosniff` header.
  router.get(
    "/files/*",
    requireAdmin,
    require2faEnrolled,
    (req: Request, res: Response) => {
      const id = extractWildcardId(req);
      if (!id) {
        res.status(400).json({ error: "Asset id required" });
        return;
      }
      let abs: string;
      try {
        abs = resolveAssetPath(id);
      } catch {
        res.status(400).json({ error: "Invalid asset id" });
        return;
      }
      if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
        res.status(404).json({ error: "Asset not found" });
        return;
      }
      const contentType = detectImageContentType(abs);
      res.sendFile(abs, {
        headers: { "Content-Type": contentType },
        maxAge: 0,
      });
    },
  );

  // ─── List all assets ───────────────────────────────────────────────────
  router.get("/assets", requireAdmin, require2faEnrolled, (_req: Request, res: Response) => {
    try {
      const assets = listAssets();
      const categories = Array.from(new Set(assets.map((a) => a.category))).sort();
      res.json({ assets, categories });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : "Failed to list assets" });
    }
  });

  // ─── Get one asset ─────────────────────────────────────────────────────
  router.get("/assets/*", requireAdmin, require2faEnrolled, (req: Request, res: Response) => {
    const id = extractWildcardId(req);
    if (!id) {
      res.status(400).json({ error: "Asset id required" });
      return;
    }
    try {
      const asset = getAsset(id);
      if (!asset) {
        res.status(404).json({ error: "Asset not found" });
        return;
      }
      res.json(asset);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : "Invalid asset id" });
    }
  });

  // ─── Update metadata ───────────────────────────────────────────────────
  router.patch("/assets/*", requireAdmin, require2faEnrolled, (req: Request, res: Response) => {
    const id = extractWildcardId(req);
    if (!id) {
      res.status(400).json({ error: "Asset id required" });
      return;
    }
    if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
      res.status(400).json({ error: "Request body must be an object" });
      return;
    }
    try {
      const updated = updateAsset(id, req.body as AssetMetadataPatch);
      if (!updated) {
        res.status(404).json({ error: "Asset not found" });
        return;
      }
      res.json(updated);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : "Failed to update asset" });
    }
  });

  // ─── Upload new asset(s) ───────────────────────────────────────────────
  // Accepts multipart/form-data with one or more `files` fields plus
  // common metadata fields (namespace, category, tags, title, description).
  // Each uploaded file is magic-byte-validated and written to the archive
  // under the slugified namespace; the response contains the full
  // metadata for every asset that was created.
  router.post(
    "/upload",
    requireAdmin,
    require2faEnrolled,
    (req: Request, res: Response) => {
      uploadMiddleware(req, res, (multerErr: unknown) => {
        if (multerErr) {
          const err = multerErr as { code?: string; message?: string };
          if (err.code === "LIMIT_FILE_SIZE") {
            res.status(413).json({ error: "One or more files exceed the 20MB size limit" });
            return;
          }
          if (err.code === "LIMIT_FILE_COUNT") {
            res.status(413).json({ error: "Too many files (max 50 per request)" });
            return;
          }
          res.status(400).json({ error: err.message || "Upload failed" });
          return;
        }

        const files = (req.files as Express.Multer.File[] | undefined) ?? [];
        if (files.length === 0) {
          res.status(400).json({ error: "No files provided" });
          return;
        }

        // Pull metadata out of the multipart form fields. All are
        // strings; tags comes in as a comma-separated list.
        const body = req.body as Record<string, string | undefined>;
        const namespace = body.namespace ?? "";
        const category = body.category;
        const title = body.title;
        const description = body.description;
        const tagsRaw = body.tags ?? "";
        const tags = tagsRaw
          .split(",")
          .map((t) => t.trim())
          .filter((t) => t.length > 0);

        const created: AssetMetadata[] = [];
        const failures: { filename: string; error: string }[] = [];
        for (const file of files) {
          try {
            const asset = uploadAsset({
              originalName: file.originalname,
              buffer: file.buffer,
              namespace,
              category,
              title: files.length === 1 ? title : undefined,
              tags,
              description,
              source: "imported",
            });
            created.push(asset);
          } catch (err) {
            failures.push({
              filename: file.originalname,
              error: err instanceof Error ? err.message : "Upload failed",
            });
          }
        }

        if (created.length === 0 && failures.length > 0) {
          res.status(400).json({ error: failures[0]!.error, failures });
          return;
        }

        res.status(201).json({ assets: created, failures });
      });
    },
  );

  // ─── Delete asset ──────────────────────────────────────────────────────
  router.delete("/assets/*", requireAdmin, require2faEnrolled, (req: Request, res: Response) => {
    const id = extractWildcardId(req);
    if (!id) {
      res.status(400).json({ error: "Asset id required" });
      return;
    }
    try {
      const removed = deleteAsset(id);
      if (!removed) {
        res.status(404).json({ error: "Asset not found" });
        return;
      }
      res.status(204).send();
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : "Failed to delete asset" });
    }
  });

  return router;
}
