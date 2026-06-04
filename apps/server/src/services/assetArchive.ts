/**
 * Asset archive service.
 *
 * The asset archive lives OUTSIDE the repository at a configurable path
 * (default: `<home>/image-archive/`, overridable via `IMAGE_ARCHIVE_ROOT`).
 * It holds every image we
 * generate via the image-generation skill plus a JSON "sidecar" per image
 * containing metadata (title, category, tags, prompt, etc.). Categories and
 * tags are driven entirely by the sidecar — the physical directory a file
 * lives in is just a namespace to prevent filename collisions.
 *
 * Why outside the repo? Generated images are numerous (hundreds of MB) and
 * storing them in git would bloat history unboundedly as we keep generating
 * new assets. Keeping them on the host filesystem under a well-known root
 * lets the admin gallery scan them at runtime and surface CRUD operations
 * without ever requiring a web rebuild or a git commit.
 */

import fs from "fs";
import os from "os";
import path from "path";

/**
 * Return the absolute path to the archive root. Reads the
 * `IMAGE_ARCHIVE_ROOT` environment variable on every call so tests can
 * repoint it at a temp directory after module load.
 */
export function archiveRoot(): string {
  return process.env.IMAGE_ARCHIVE_ROOT || path.join(os.homedir(), "image-archive");
}

/**
 * Return the absolute path to the `images/` subdirectory where files and
 * their JSON sidecars live.
 */
export function archiveImagesDir(): string {
  return path.join(archiveRoot(), "images");
}

/** Image file extensions the gallery recognizes. */
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);

/**
 * Metadata stored in a sidecar JSON file next to each image.
 * All fields are optional so the gallery can degrade gracefully when a
 * sidecar is missing or partial.
 */
export interface AssetMetadata {
  /** Image relative path under `images/`, e.g. `avatars/pirate.png`. */
  id: string;
  /** Just the basename for display. */
  filename: string;
  /** Human-friendly title. Falls back to filename stem. */
  title: string;
  /** Primary category — drives tab grouping in the gallery UI. */
  category: string;
  /** Free-form tags for fine-grained filtering. */
  tags: string[];
  /** Optional longer description. */
  description?: string;
  /** The prompt the image was generated from, if known. */
  prompt?: string;
  /** Generation model, e.g. `gemini-3-pro-image-preview`. */
  model?: string;
  /** Aspect ratio used during generation, e.g. `16:9`. */
  aspectRatio?: string;
  /** ISO timestamp when the asset was added to the archive. */
  createdAt: string;
  /** ISO timestamp of the last metadata update. */
  updatedAt?: string;
  /** Provenance — was this generated fresh, migrated from /tmp, etc. */
  source?: "generated" | "migrated" | "imported";
  /** File size in bytes. */
  sizeBytes: number;
}

/**
 * Partial metadata that the PATCH endpoint accepts. `id`, `filename`,
 * `sizeBytes`, `createdAt` are immutable and cannot be changed via the API.
 */
export type AssetMetadataPatch = Partial<
  Pick<AssetMetadata, "title" | "category" | "tags" | "description" | "prompt" | "aspectRatio" | "source">
>;

/**
 * Ensure the archive directory exists. Called on service init and before
 * any write so a fresh host doesn't need manual setup.
 */
export function ensureArchiveDir(): void {
  if (!fs.existsSync(archiveImagesDir())) {
    fs.mkdirSync(archiveImagesDir(), { recursive: true });
  }
}

/**
 * Resolve an asset ID (relative path under `images/`) to an absolute path,
 * rejecting any attempt to escape the archive root via `..` traversal,
 * absolute paths, or symlinks that point outside the archive. Throws if
 * the resolved path would escape the archive.
 *
 * Symlink hardening: `path.resolve` normalizes `..` but does not deref
 * symlinks. If any existing path in the chain from the target back up
 * to the archive root is a symlink pointing outside the archive, we
 * reject. Non-existing paths (e.g. a fresh upload destination whose
 * parent dirs don't exist yet) are skipped because there's nothing to
 * dereference — the lexical check plus slugify's slash-stripping in
 * `uploadAsset` already constrain those.
 */
export function resolveAssetPath(id: string): string {
  // Reject obvious traversal attempts before we even touch the filesystem.
  if (id.includes("..") || path.isAbsolute(id) || id.startsWith("/") || id.startsWith("\\")) {
    throw new Error("Invalid asset id");
  }
  const archiveDir = archiveImagesDir();
  const resolved = path.resolve(archiveDir, id);
  // Double-check the resolved path is still under the archive root.
  if (!resolved.startsWith(archiveDir + path.sep) && resolved !== archiveDir) {
    throw new Error("Invalid asset id");
  }
  // Defense-in-depth: if the archive root exists and any path in the
  // chain from the target up to the archive root actually exists, its
  // real path (symlinks dereferenced) must still be under the archive's
  // own real path. This catches a malicious symlink inside the archive
  // that points to /etc/passwd without breaking non-existent upload
  // destinations.
  if (fs.existsSync(archiveDir)) {
    const realArchive = fs.realpathSync(archiveDir);
    let probe = resolved;
    while (probe.length >= archiveDir.length) {
      if (fs.existsSync(probe)) {
        const realProbe = fs.realpathSync(probe);
        if (realProbe !== realArchive && !realProbe.startsWith(realArchive + path.sep)) {
          throw new Error("Invalid asset id");
        }
      }
      if (probe === archiveDir) break;
      const parent = path.dirname(probe);
      if (parent === probe) break;
      probe = parent;
    }
  }
  return resolved;
}

/**
 * Return the sidecar path for a given image path (same basename, `.json`).
 */
function sidecarPathFor(imageAbsPath: string): string {
  const ext = path.extname(imageAbsPath);
  return imageAbsPath.slice(0, -ext.length) + ".json";
}

/**
 * Read a sidecar JSON file. Returns an empty object if the sidecar is
 * missing or unreadable — the caller merges this with computed defaults.
 */
function readSidecar(sidecarAbsPath: string): Partial<AssetMetadata> {
  try {
    const raw = fs.readFileSync(sidecarAbsPath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Partial<AssetMetadata>;
    }
  } catch {
    // Missing or malformed sidecar — fall through to defaults.
  }
  return {};
}

/**
 * Build a complete AssetMetadata record for a single image file by merging
 * its sidecar (if any) with filesystem-derived defaults. The `id` is always
 * the canonical relative path, regardless of what the sidecar claims.
 */
function buildAssetMetadata(imageAbsPath: string): AssetMetadata {
  const id = path.relative(archiveImagesDir(), imageAbsPath).split(path.sep).join("/");
  const filename = path.basename(imageAbsPath);
  const stem = filename.replace(/\.[^.]+$/, "");
  const stat = fs.statSync(imageAbsPath);
  const sidecar = readSidecar(sidecarPathFor(imageAbsPath));

  // Default category = first directory segment in the id, or "uncategorized"
  // for images that live directly in the archive root.
  const segments = id.split("/");
  const defaultCategory = segments.length > 1 ? segments[0]! : "uncategorized";

  return {
    id,
    filename,
    title: sidecar.title ?? stem,
    category: sidecar.category ?? defaultCategory,
    tags: Array.isArray(sidecar.tags) ? sidecar.tags.filter((t) => typeof t === "string") : [],
    description: typeof sidecar.description === "string" ? sidecar.description : undefined,
    prompt: typeof sidecar.prompt === "string" ? sidecar.prompt : undefined,
    model: typeof sidecar.model === "string" ? sidecar.model : undefined,
    aspectRatio: typeof sidecar.aspectRatio === "string" ? sidecar.aspectRatio : undefined,
    createdAt: typeof sidecar.createdAt === "string" ? sidecar.createdAt : stat.birthtime.toISOString(),
    updatedAt: typeof sidecar.updatedAt === "string" ? sidecar.updatedAt : undefined,
    source: sidecar.source === "generated" || sidecar.source === "migrated" || sidecar.source === "imported"
      ? sidecar.source
      : undefined,
    sizeBytes: stat.size,
  };
}

/**
 * Recursively walk the given directory and call `onFile` for every regular
 * file encountered. Skips dotfiles (`.DS_Store` etc); callers are
 * responsible for extension-based filtering — `listAssets` ignores
 * anything outside `IMAGE_EXTENSIONS` so JSON sidecars don't surface as
 * gallery assets.
 */
function walk(dirAbsPath: string, onFile: (absPath: string) => void): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dirAbsPath, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const abs = path.join(dirAbsPath, entry.name);
    if (entry.isDirectory()) {
      walk(abs, onFile);
    } else if (entry.isFile()) {
      onFile(abs);
    }
  }
}

/**
 * List every asset in the archive. Walks the `images/` tree on every call,
 * so freshly-generated files appear as soon as they (and their sidecar)
 * land on disk — no rebuild, no redeploy, no in-memory cache to bust.
 * Sorted by category then title for a stable UI ordering.
 */
export function listAssets(): AssetMetadata[] {
  ensureArchiveDir();
  const assets: AssetMetadata[] = [];
  walk(archiveImagesDir(), (abs) => {
    const ext = path.extname(abs).toLowerCase();
    if (!IMAGE_EXTENSIONS.has(ext)) return;
    assets.push(buildAssetMetadata(abs));
  });
  assets.sort((a, b) =>
    a.category === b.category
      ? a.title.localeCompare(b.title)
      : a.category.localeCompare(b.category),
  );
  return assets;
}

/**
 * Fetch a single asset by id. Returns `null` if the image does not exist.
 */
export function getAsset(id: string): AssetMetadata | null {
  const abs = resolveAssetPath(id);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return null;
  return buildAssetMetadata(abs);
}

/**
 * Merge a partial update into an asset's sidecar JSON. Creates the sidecar
 * if it doesn't exist. Returns the updated metadata or `null` if the image
 * itself doesn't exist.
 */
export function updateAsset(id: string, patch: AssetMetadataPatch): AssetMetadata | null {
  const abs = resolveAssetPath(id);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return null;

  const sidecarAbs = sidecarPathFor(abs);
  const existing = readSidecar(sidecarAbs);
  const merged: Partial<AssetMetadata> = {
    ...existing,
    ...sanitizePatch(patch),
    updatedAt: new Date().toISOString(),
  };
  // Preserve createdAt if already present.
  if (!merged.createdAt) {
    merged.createdAt = fs.statSync(abs).birthtime.toISOString();
  }
  fs.writeFileSync(sidecarAbs, JSON.stringify(merged, null, 2) + "\n", "utf8");
  return buildAssetMetadata(abs);
}

/**
 * Delete both the image file and its sidecar. Returns true if the image
 * was deleted, false if it did not exist.
 */
export function deleteAsset(id: string): boolean {
  const abs = resolveAssetPath(id);
  if (!fs.existsSync(abs)) return false;
  fs.unlinkSync(abs);
  const sidecarAbs = sidecarPathFor(abs);
  if (fs.existsSync(sidecarAbs)) {
    fs.unlinkSync(sidecarAbs);
  }
  // Best-effort cleanup: remove now-empty parent directory so the archive
  // doesn't accumulate empty namespaces as we delete whole batches.
  const parent = path.dirname(abs);
  if (parent !== archiveImagesDir()) {
    try {
      fs.rmdirSync(parent);
    } catch {
      // Directory not empty — fine, leave it.
    }
  }
  return true;
}

/**
 * Fields the upload endpoint accepts alongside each uploaded file.
 * `namespace` decides the physical subdirectory under `images/`; the
 * remaining fields land in the sidecar JSON.
 */
export interface UploadAssetInput {
  /** Original filename as uploaded. Used to derive a slug. */
  originalName: string;
  /** Raw file bytes. */
  buffer: Buffer;
  /** Destination subdirectory under `images/`. Slugified. */
  namespace: string;
  /** Category written into the sidecar (drives gallery tab grouping). */
  category?: string;
  /** Sidecar title. Defaults to the slug. */
  title?: string;
  /** Free-form tags written into the sidecar. */
  tags?: string[];
  /** Optional description. */
  description?: string;
  /** Provenance. Defaults to "imported" for user-uploaded files. */
  source?: "generated" | "migrated" | "imported";
}

/**
 * Magic-byte check to confirm a buffer contains an actual image payload
 * of a format the gallery supports. Prevents users from uploading
 * arbitrary binaries (scripts, executables) under an image extension.
 * Returns the normalized extension (including the dot) or null if the
 * buffer is not a recognized image.
 */
export function detectUploadExtension(buffer: Buffer): string | null {
  if (buffer.length < 12) return null;
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return ".png";
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return ".jpg";
  }
  if (
    buffer.slice(0, 4).toString("ascii") === "RIFF" &&
    buffer.slice(8, 12).toString("ascii") === "WEBP"
  ) {
    return ".webp";
  }
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38) {
    return ".gif";
  }
  return null;
}

/**
 * Slugify an arbitrary string into a safe filename or namespace segment.
 * Lowercase, alphanumeric + dot/underscore/hyphen, collapses whitespace.
 * Returns an empty string if nothing survives sanitization.
 */
function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_.]+|[-_.]+$/g, "");
}

/**
 * Persist an uploaded file into the archive. Validates the magic bytes,
 * picks a safe destination filename inside the requested namespace,
 * handles filename collisions by appending a numeric suffix, and writes
 * both the binary and its sidecar JSON in one step.
 *
 * Throws on invalid inputs (unrecognized image format, empty namespace,
 * path traversal) so the route handler can turn the failure into a 4xx.
 */
export function uploadAsset(input: UploadAssetInput): AssetMetadata {
  const ext = detectUploadExtension(input.buffer);
  if (!ext) {
    throw new Error("Unsupported image format (expected PNG, JPEG, WebP, or GIF)");
  }

  const namespace = slugify(input.namespace || "");
  if (!namespace) {
    throw new Error("Namespace is required");
  }
  // Block namespace traversal via the slugify output (shouldn't happen
  // since slugify strips slashes, but defense in depth).
  if (namespace.includes("..") || namespace.includes("/")) {
    throw new Error("Invalid namespace");
  }

  // Derive a slug from the original filename's stem, falling back to
  // "upload" when nothing survives sanitization (e.g., an uploaded file
  // called "___.png").
  const stem = input.originalName.replace(/\.[^.]+$/, "");
  const baseSlug = slugify(stem) || "upload";

  ensureArchiveDir();
  const nsDir = path.join(archiveImagesDir(), namespace);
  fs.mkdirSync(nsDir, { recursive: true });

  // Atomic collision handling. `existsSync` + `writeFileSync` is not
  // race-free — two concurrent uploads with the same base slug can both
  // read "no collision" and race to overwrite each other. Open with the
  // `wx` flag (fail if exists) and retry on EEXIST until we find a free
  // suffix. The loop is bounded because every iteration increments the
  // numeric suffix, and `wx` gives us the OS-level atomic guarantee.
  let slug = baseSlug;
  let attempt = 1;
  let fd: number | null = null;
  let filename = `${slug}${ext}`;
  let abs = path.join(nsDir, filename);
  // Hard bound so a pathological collision storm can't loop forever.
  for (let tries = 0; tries < 1000; tries++) {
    try {
      fd = fs.openSync(abs, "wx");
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      attempt += 1;
      slug = `${baseSlug}-${attempt}`;
      filename = `${slug}${ext}`;
      abs = path.join(nsDir, filename);
    }
  }
  if (fd === null) {
    throw new Error("Could not find an available filename for upload");
  }
  try {
    fs.writeSync(fd, input.buffer);
  } finally {
    fs.closeSync(fd);
  }

  const now = new Date().toISOString();
  const sidecar: Partial<AssetMetadata> = {
    title: input.title?.slice(0, 200) || stem || slug,
    category: input.category?.slice(0, 100) || namespace,
    tags: Array.isArray(input.tags)
      ? input.tags
          .filter((t): t is string => typeof t === "string")
          .map((t) => t.slice(0, 50))
          .slice(0, 50)
      : [],
    description: input.description?.slice(0, 2000),
    source: input.source ?? "imported",
    createdAt: now,
    updatedAt: now,
  };
  fs.writeFileSync(
    path.join(nsDir, `${slug}.json`),
    JSON.stringify(sidecar, null, 2) + "\n",
    "utf8",
  );

  return buildAssetMetadata(abs);
}

/**
 * Strip unknown fields and coerce types on an incoming PATCH body. Keeps
 * the sidecar schema tight and prevents clients from smuggling arbitrary
 * keys into the JSON.
 */
function sanitizePatch(patch: AssetMetadataPatch): AssetMetadataPatch {
  const out: AssetMetadataPatch = {};
  if (typeof patch.title === "string") out.title = patch.title.slice(0, 200);
  if (typeof patch.category === "string") out.category = patch.category.slice(0, 100);
  if (Array.isArray(patch.tags)) {
    out.tags = patch.tags
      .filter((t): t is string => typeof t === "string")
      .map((t) => t.slice(0, 50))
      .slice(0, 50);
  }
  if (typeof patch.description === "string") out.description = patch.description.slice(0, 2000);
  if (typeof patch.prompt === "string") out.prompt = patch.prompt.slice(0, 4000);
  if (typeof patch.aspectRatio === "string") out.aspectRatio = patch.aspectRatio.slice(0, 20);
  if (patch.source === "generated" || patch.source === "migrated" || patch.source === "imported") {
    out.source = patch.source;
  }
  return out;
}
