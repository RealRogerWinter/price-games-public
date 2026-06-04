#!/usr/bin/env node
/**
 * Backup stray image files from volatile locations (/tmp, ~/layouts)
 * and the in-repo production assets into the durable image archive at
 * $IMAGE_ARCHIVE_ROOT (default ~/image-archive). For each
 * image, copies the binary and writes a sidecar `<name>.json` with
 * inferred category/tags based on the source path.
 *
 * Idempotent: skips files that already exist in the archive with the same
 * byte size. Safe to rerun.
 *
 * Usage:
 *   node scripts/backup-images-to-archive.mjs [--dry-run] [--source <path>]
 *
 * The default sources are the known-generated-image locations on this host.
 * Pass `--source` one or more times to add additional directories.
 */

import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");
const HOME = os.homedir();

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
const ARCHIVE_ROOT = process.env.IMAGE_ARCHIVE_ROOT || path.join(HOME, "image-archive");
const IMAGES_DIR = path.join(ARCHIVE_ROOT, "images");

/**
 * Source directories the backup walks by default. Each entry declares the
 * filesystem root to crawl, the namespace it gets in the archive, and
 * a handful of tags applied to every file copied out of that source.
 */
const DEFAULT_SOURCES = [
  {
    root: "/tmp/icon-sets",
    namespace: "icon-sets",
    category: "mode-icons",
    baseTags: ["exploration", "mode-icon"],
  },
  {
    root: "/tmp/icon-sets-processed",
    namespace: "icon-sets-processed",
    category: "mode-icons",
    baseTags: ["processed", "mode-icon"],
  },
  {
    root: "/tmp/pixel-sets",
    namespace: "pixel-sets",
    category: "pixel-art",
    baseTags: ["exploration", "pixel"],
  },
  {
    root: "/tmp/pixel-sets-processed",
    namespace: "pixel-sets-processed",
    category: "pixel-art",
    baseTags: ["processed", "pixel"],
  },
  {
    root: "/tmp/mockup-crops",
    namespace: "mockup-crops",
    category: "mockups",
    baseTags: ["ui-mockup"],
  },
  {
    root: "/tmp/f20",
    namespace: "f20",
    category: "backgrounds",
    baseTags: ["background", "tile-experiment"],
  },
  {
    root: "/tmp/icons-raw",
    namespace: "icons-raw",
    category: "avatar-audit",
    baseTags: ["audit", "avatar"],
  },
  {
    root: path.join(HOME, "layouts"),
    namespace: "layouts",
    category: "landing-layouts",
    baseTags: ["landing-page", "layout"],
  },
  // In-repo production assets (the images actually shipped in the web
  // bundle). Copies but does NOT move; originals stay in git. Category is
  // inferred from the first subdirectory (avatars/, modes/, etc.) so each
  // shows up in its natural tab in the gallery.
  {
    root: path.join(REPO_ROOT, "apps/web/src/assets"),
    namespace: "production",
    category: "production",
    baseTags: ["production", "in-use"],
    categoryFromSubdir: true,
  },
];

/**
 * Additional loose sources handled specially because they aren't a whole
 * directory tree — or need custom namespacing.
 */
const LOOSE_SOURCES = [
  {
    path: path.join(HOME, "money-zoomed.PNG"),
    namespace: "misc",
    category: "misc",
    baseTags: [],
  },
];

/**
 * Everything directly in /tmp (non-recursive) gets dumped into a
 * single `tmp-misc` namespace with no extra tagging.
 */
const TMP_LOOSE = {
  dir: "/tmp",
  namespace: "tmp-misc",
  category: "misc",
  baseTags: ["tmp-dump"],
};

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const extraSources = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--source" && args[i + 1]) {
    extraSources.push({
      root: args[i + 1],
      namespace: path.basename(args[i + 1]),
      category: "custom",
      baseTags: ["custom"],
    });
    i++;
  }
}

/**
 * Safe slug used to sanitize filenames: lowercase alnum, hyphens, dots.
 */
function slugify(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Generate tags from a path relative to a source root. E.g.
 * `icon-sets/03-sticker/classic.png` → ["icon-sets", "03-sticker", "classic"].
 */
function inferTagsFromPath(relPath) {
  return relPath
    .split(path.sep)
    .flatMap((segment) => segment.replace(/\.[^.]+$/, "").split(/[-_]/))
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 1 && s.length < 30);
}

/**
 * Walk a directory recursively, collecting all image files.
 */
function* walkImages(root) {
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const abs = path.join(root, entry.name);
    if (entry.isDirectory()) {
      yield* walkImages(abs);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (IMAGE_EXTENSIONS.has(ext)) yield abs;
    }
  }
}

/**
 * Build the destination path inside the archive for a given source file
 * and namespace. Preserves subdirectory structure within the namespace
 * so related files stay grouped.
 */
function destFor(srcAbs, sourceRoot, namespace) {
  const relParts = path.relative(sourceRoot, srcAbs).split(path.sep);
  const rel = relParts.map(slugify).join("/");
  return path.join(IMAGES_DIR, namespace, rel);
}

let copied = 0;
let skipped = 0;
let errored = 0;
let sidecarsWritten = 0;

/**
 * Copy a single image into the archive and write its sidecar JSON. Skips
 * when the destination already exists with the same size (idempotent).
 */
function copyOne(srcAbs, destAbs, source, sourceRoot) {
  try {
    const srcStat = fs.statSync(srcAbs);
    if (fs.existsSync(destAbs)) {
      const destStat = fs.statSync(destAbs);
      if (destStat.size === srcStat.size) {
        skipped++;
        return;
      }
    }
    if (dryRun) {
      console.log(`[dry-run] copy ${srcAbs} -> ${destAbs}`);
      copied++;
      return;
    }
    fs.mkdirSync(path.dirname(destAbs), { recursive: true });
    fs.copyFileSync(srcAbs, destAbs);
    copied++;

    const relFromSource = path.relative(sourceRoot, srcAbs);
    const inferred = inferTagsFromPath(relFromSource);
    const stem = path.basename(destAbs).replace(/\.[^.]+$/, "");
    // When `categoryFromSubdir` is set on the source, use the first path
    // segment as the category instead of the source's default. This makes
    // production assets land in natural buckets (avatars, modes) rather
    // than a single generic "production" tab.
    let category = source.category;
    if (source.categoryFromSubdir) {
      const segments = relFromSource.split(path.sep);
      if (segments.length > 1) {
        category = segments[0];
      } else {
        // Loose root-level file — classify by filename prefix so streak-*
        // and logo* files don't all collapse into one bucket.
        const lower = path.basename(srcAbs).toLowerCase();
        if (lower.startsWith("streak-")) category = "streaks";
        else if (lower.startsWith("logo")) category = "branding";
        else if (lower.startsWith("daily")) category = "daily";
        else category = source.category;
      }
    }
    const sidecar = {
      title: stem.replace(/[-_]/g, " "),
      category,
      tags: Array.from(new Set([...source.baseTags, ...inferred])).slice(0, 50),
      source: "migrated",
      createdAt: srcStat.birthtime.toISOString(),
      updatedAt: new Date().toISOString(),
      notes: `Migrated from ${srcAbs} by scripts/backup-images-to-archive.mjs`,
    };
    const sidecarAbs = destAbs.replace(/\.[^.]+$/, ".json");
    if (!fs.existsSync(sidecarAbs)) {
      fs.writeFileSync(sidecarAbs, JSON.stringify(sidecar, null, 2) + "\n", "utf8");
      sidecarsWritten++;
    }
  } catch (err) {
    errored++;
    console.error(`  error copying ${srcAbs}: ${err.message}`);
  }
}

/**
 * Process all default + extra source roots. Each root walks recursively.
 */
function processTreeSources() {
  const allSources = [...DEFAULT_SOURCES, ...extraSources];
  for (const source of allSources) {
    if (!fs.existsSync(source.root)) {
      console.log(`skip ${source.root} (not present)`);
      continue;
    }
    console.log(`\n=== ${source.root} -> ${source.namespace}/ ===`);
    for (const srcAbs of walkImages(source.root)) {
      const destAbs = destFor(srcAbs, source.root, source.namespace);
      copyOne(srcAbs, destAbs, source, source.root);
    }
  }
}

/**
 * Handle loose files that aren't under one of the tree roots.
 */
function processLooseFiles() {
  console.log(`\n=== loose files ===`);
  for (const loose of LOOSE_SOURCES) {
    if (!fs.existsSync(loose.path)) continue;
    const destAbs = path.join(
      IMAGES_DIR,
      loose.namespace,
      slugify(path.basename(loose.path)),
    );
    copyOne(loose.path, destAbs, loose, path.dirname(loose.path));
  }
}

/**
 * Handle every image file directly in /tmp (non-recursive) — these are the
 * 260+ loose experiments I don't want to lose on reboot.
 */
function processTmpLoose() {
  console.log(`\n=== /tmp loose files ===`);
  if (!fs.existsSync(TMP_LOOSE.dir)) return;
  let entries;
  try {
    entries = fs.readdirSync(TMP_LOOSE.dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isFile() || entry.name.startsWith(".")) continue;
    const ext = path.extname(entry.name).toLowerCase();
    if (!IMAGE_EXTENSIONS.has(ext)) continue;
    const srcAbs = path.join(TMP_LOOSE.dir, entry.name);
    // Hash the parent path into the filename to prevent collisions if two
    // separate runs leave differently-contented files with the same name.
    const hash = crypto.createHash("sha1").update(srcAbs).digest("hex").slice(0, 6);
    const stem = slugify(entry.name.replace(/\.[^.]+$/, ""));
    const destAbs = path.join(IMAGES_DIR, TMP_LOOSE.namespace, `${stem}-${hash}${ext}`);
    copyOne(srcAbs, destAbs, TMP_LOOSE, TMP_LOOSE.dir);
  }
}

console.log(`Image archive backup — target: ${IMAGES_DIR}`);
console.log(dryRun ? "DRY RUN — no files will be written" : "LIVE — files will be copied\n");

if (!dryRun) {
  fs.mkdirSync(IMAGES_DIR, { recursive: true });
}

processTreeSources();
processLooseFiles();
processTmpLoose();

console.log(`\n── summary ──`);
console.log(`  copied:          ${copied}`);
console.log(`  skipped (exist): ${skipped}`);
console.log(`  sidecars written: ${sidecarsWritten}`);
console.log(`  errors:          ${errored}`);
process.exit(errored > 0 ? 1 : 0);
