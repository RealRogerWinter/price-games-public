import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  fetchGalleryAssets,
  updateGalleryAsset,
  deleteGalleryAsset,
  uploadGalleryAssets,
  verifyAdminSessionDebounced,
  galleryAssetImageUrl,
  type GalleryAsset,
} from "../../api/adminClient";

/**
 * Admin asset gallery.
 *
 * Fetches every image from the host-level archive at
 * `/api/admin/gallery/assets` and presents a tabbed, searchable grid with
 * CRUD over metadata (title, category, tags, description, prompt) plus
 * delete. The server re-reads the archive filesystem on every request,
 * so a freshly-generated image + sidecar on disk surfaces as soon as the
 * user clicks Refresh — no rebuild, no redeploy.
 *
 * Categories and the tab list are driven entirely by sidecar JSON
 * metadata, so renaming a category or adding a new one is a PATCH away
 * without any code change.
 */
export default function AdminAssetGalleryPage() {
  const [assets, setAssets] = useState<GalleryAsset[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [activeCategory, setActiveCategory] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [uploadModalOpen, setUploadModalOpen] = useState<boolean>(false);
  const [lightboxAsset, setLightboxAsset] = useState<{ src: string; title: string } | null>(null);
  // Pagination — render a slice of the filtered list so the DOM never
  // holds hundreds of img tags at once. Page size is user-adjustable;
  // both page and pageSize reset to defaults whenever filters change.
  const [page, setPage] = useState<number>(1);
  const [pageSize, setPageSize] = useState<number>(60);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchGalleryAssets();
      setAssets(data.assets);
      setCategories(data.categories);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load assets");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const a of assets) {
      m.set(a.category, (m.get(a.category) ?? 0) + 1);
    }
    return m;
  }, [assets]);

  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return assets.filter((a) => {
      if (activeCategory !== "all" && a.category !== activeCategory) return false;
      if (!q) return true;
      return (
        a.title.toLowerCase().includes(q) ||
        a.id.toLowerCase().includes(q) ||
        a.tags.some((t) => t.toLowerCase().includes(q)) ||
        (a.prompt?.toLowerCase().includes(q) ?? false)
      );
    });
  }, [assets, activeCategory, searchQuery]);

  // Reset to page 1 whenever the filter set changes — otherwise the
  // user would land on an empty slice after narrowing the list.
  useEffect(() => {
    setPage(1);
  }, [activeCategory, searchQuery, pageSize]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, pageCount);
  const pageStart = (safePage - 1) * pageSize;
  const pageItems = filtered.slice(pageStart, pageStart + pageSize);

  const selected = useMemo(
    () => (selectedId ? (assets.find((a) => a.id === selectedId) ?? null) : null),
    [assets, selectedId],
  );

  const handleUpdated = useCallback((updated: GalleryAsset) => {
    setAssets((prev) => prev.map((a) => (a.id === updated.id ? updated : a)));
    // Rebuild category list in case the update added a brand-new category.
    setCategories((prev) => {
      if (prev.includes(updated.category)) return prev;
      return [...prev, updated.category].sort();
    });
  }, []);

  const handleDeleted = useCallback((deletedId: string) => {
    setAssets((prev) => prev.filter((a) => a.id !== deletedId));
    setSelectedId((cur) => (cur === deletedId ? null : cur));
  }, []);

  const handleUploaded = useCallback((newAssets: GalleryAsset[]) => {
    setAssets((prev) => {
      // Replace duplicates (same id) and append the rest; keep the combined
      // list sorted by category then title for a stable grid ordering.
      const map = new Map(prev.map((a) => [a.id, a]));
      for (const a of newAssets) map.set(a.id, a);
      return Array.from(map.values()).sort((a, b) =>
        a.category === b.category
          ? a.title.localeCompare(b.title)
          : a.category.localeCompare(b.category),
      );
    });
    setCategories((prev) => {
      const next = new Set(prev);
      for (const a of newAssets) next.add(a.category);
      return Array.from(next).sort();
    });
  }, []);

  return (
    <div className="admin-dashboard admin-gallery" data-testid="admin-gallery-page">
      <div className="admin-header">
        <h1>Asset Gallery</h1>
        <div className="admin-header-info">
          <span data-testid="admin-gallery-total">
            {loading ? "Loading..." : `${assets.length} assets • ${categories.length} categories`}
          </span>
          <button
            type="button"
            onClick={() => setUploadModalOpen(true)}
            data-testid="admin-gallery-upload-open"
          >
            Upload
          </button>
          <button type="button" onClick={load} disabled={loading} data-testid="admin-gallery-refresh">
            {loading ? "Refreshing..." : "Refresh"}
          </button>
        </div>
      </div>

      {error && (
        <div className="admin-gallery-error" data-testid="admin-gallery-error">
          {error}
        </div>
      )}

      <div className="admin-gallery-controls">
        <input
          type="search"
          className="admin-gallery-search"
          placeholder="Search by name, tag, prompt, or path..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          data-testid="admin-gallery-search"
          aria-label="Search assets"
        />
      </div>

      <div className="admin-gallery-tabs" role="tablist" aria-label="Asset categories">
        <GalleryTab
          label="All"
          count={assets.length}
          active={activeCategory === "all"}
          onClick={() => setActiveCategory("all")}
          testId="admin-gallery-tab-all"
        />
        {categories.map((cat) => (
          <GalleryTab
            key={cat}
            label={toDisplayName(cat)}
            count={counts.get(cat) ?? 0}
            active={activeCategory === cat}
            onClick={() => setActiveCategory(cat)}
            testId={`admin-gallery-tab-${cat}`}
          />
        ))}
      </div>

      <div className="admin-gallery-main">
          {loading && assets.length === 0 ? (
            <div className="admin-empty">Loading assets...</div>
          ) : filtered.length === 0 ? (
            <div className="admin-empty" data-testid="admin-gallery-empty">
              No assets match your filters.
            </div>
          ) : (
            <div className="admin-gallery-grid" data-testid="admin-gallery-grid">
              {pageItems.map((asset) => (
                <figure
                  key={asset.id}
                  className={`admin-gallery-card ${selectedId === asset.id ? "selected" : ""}`}
                  data-testid={`admin-gallery-card-${asset.id}`}
                  onClick={() => setSelectedId(asset.id)}
                >
                  <div
                    className="admin-gallery-thumb"
                    onClick={(e) => {
                      e.stopPropagation();
                      setLightboxAsset({ src: galleryAssetImageUrl(asset.id), title: asset.title });
                    }}
                    style={{ cursor: "zoom-in" }}
                  >
                    <img
                      src={galleryAssetImageUrl(asset.id)}
                      alt={asset.title}
                      loading="lazy"
                      onError={verifyAdminSessionDebounced}
                    />
                    <a
                      className="admin-gallery-download"
                      href={galleryAssetImageUrl(asset.id)}
                      download={asset.filename}
                      onClick={(e) => e.stopPropagation()}
                      title={`Download ${asset.filename}`}
                      aria-label={`Download ${asset.filename}`}
                      data-testid={`admin-gallery-download-${asset.id}`}
                    >
                      ↓
                    </a>
                  </div>
                  <figcaption className="admin-gallery-caption">
                    <div className="admin-gallery-card-name" title={asset.title}>
                      {asset.title}
                    </div>
                    <div className="admin-gallery-card-path" title={asset.id}>
                      {asset.id}
                    </div>
                    {asset.tags.length > 0 && (
                      <div className="admin-gallery-card-tags">
                        {asset.tags.slice(0, 3).map((t) => (
                          <span key={t} className="admin-gallery-tag">
                            {t}
                          </span>
                        ))}
                        {asset.tags.length > 3 && (
                          <span className="admin-gallery-tag-more">+{asset.tags.length - 3}</span>
                        )}
                      </div>
                    )}
                  </figcaption>
                </figure>
              ))}
            </div>
          )}

          {filtered.length > 0 && (
            <div className="admin-gallery-pagination" data-testid="admin-gallery-pagination">
              <div className="admin-gallery-pagination-info">
                Showing <strong>{pageStart + 1}</strong>–<strong>{Math.min(pageStart + pageSize, filtered.length)}</strong> of <strong>{filtered.length}</strong>
              </div>
              <div className="admin-gallery-pagination-controls">
                <button
                  type="button"
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={safePage <= 1}
                  data-testid="admin-gallery-page-prev"
                >
                  ← Prev
                </button>
                <span className="admin-gallery-pagination-indicator">
                  Page {safePage} / {pageCount}
                </span>
                <button
                  type="button"
                  onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
                  disabled={safePage >= pageCount}
                  data-testid="admin-gallery-page-next"
                >
                  Next →
                </button>
                <label className="admin-gallery-pagination-size">
                  Per page:
                  <select
                    value={pageSize}
                    onChange={(e) => setPageSize(Number(e.target.value))}
                    data-testid="admin-gallery-page-size"
                  >
                    <option value={30}>30</option>
                    <option value={60}>60</option>
                    <option value={120}>120</option>
                    <option value={240}>240</option>
                  </select>
                </label>
              </div>
            </div>
          )}
      </div>

      {lightboxAsset && (
        <ImageLightbox
          src={lightboxAsset.src}
          alt={lightboxAsset.title}
          onClose={() => setLightboxAsset(null)}
        />
      )}

      {selected && (
        <AssetDetailModal
          key={selected.id}
          asset={selected}
          onClose={() => setSelectedId(null)}
          onUpdated={handleUpdated}
          onDeleted={handleDeleted}
        />
      )}

      {uploadModalOpen && (
        <UploadModal
          defaultNamespace={activeCategory !== "all" ? activeCategory : ""}
          defaultCategory={activeCategory !== "all" ? activeCategory : ""}
          onClose={() => setUploadModalOpen(false)}
          onUploaded={handleUploaded}
        />
      )}
    </div>
  );
}

interface GalleryTabProps {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
  testId: string;
}

/** A single tab button in the gallery's category tablist. */
function GalleryTab({ label, count, active, onClick, testId }: GalleryTabProps) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      className={`admin-gallery-tab ${active ? "active" : ""}`}
      onClick={onClick}
      data-testid={testId}
    >
      {label}
      <span className="admin-gallery-tab-count">{count}</span>
    </button>
  );
}

interface AssetDetailModalProps {
  asset: GalleryAsset;
  onClose: () => void;
  onUpdated: (asset: GalleryAsset) => void;
  onDeleted: (id: string) => void;
}

/**
 * Centered modal shown when a gallery card is clicked. Left side holds a
 * large image preview (click-through to the raw binary in a new tab for
 * native browser zoom/pan); right side holds the editable metadata form
 * and delete action. Closes on ESC, backdrop click, or the × button —
 * fixed position means it opens centered on the current viewport, not at
 * the top of the document, so clicking a card deep in the grid no longer
 * forces a scroll-to-top.
 */
function AssetDetailModal({ asset, onClose, onUpdated, onDeleted }: AssetDetailModalProps) {
  const [title, setTitle] = useState<string>(asset.title);
  const [category, setCategory] = useState<string>(asset.category);
  const [tagsText, setTagsText] = useState<string>(asset.tags.join(", "));
  const [description, setDescription] = useState<string>(asset.description ?? "");
  const [prompt, setPrompt] = useState<string>(asset.prompt ?? "");
  const [saving, setSaving] = useState<boolean>(false);
  const [deleting, setDeleting] = useState<boolean>(false);
  const [panelError, setPanelError] = useState<string | null>(null);

  // ESC to close. Attached at mount, detached on unmount.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function handleSave() {
    setSaving(true);
    setPanelError(null);
    try {
      const tags = tagsText
        .split(",")
        .map((t) => t.trim())
        .filter((t) => t.length > 0);
      const updated = await updateGalleryAsset(asset.id, {
        title,
        category,
        tags,
        description: description || undefined,
        prompt: prompt || undefined,
      });
      onUpdated(updated);
    } catch (err) {
      setPanelError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    // eslint-disable-next-line no-alert
    const confirmed = window.confirm(`Delete ${asset.filename}? This cannot be undone.`);
    if (!confirmed) return;
    setDeleting(true);
    setPanelError(null);
    try {
      await deleteGalleryAsset(asset.id);
      onDeleted(asset.id);
    } catch (err) {
      setPanelError(err instanceof Error ? err.message : "Delete failed");
      setDeleting(false);
    }
  }

  const imageUrl = galleryAssetImageUrl(asset.id);

  return createPortal(
    <div
      className="admin-gallery-modal-backdrop"
      onClick={onClose}
      data-testid="admin-gallery-detail-modal"
    >
      <div
        className="admin-gallery-detail-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={`Asset details for ${asset.title}`}
      >
        <button
          type="button"
          className="admin-gallery-detail-close"
          onClick={onClose}
          aria-label="Close"
          data-testid="admin-gallery-panel-close"
        >
          ×
        </button>

        <div className="admin-gallery-detail-image">
          <a
            href={imageUrl}
            target="_blank"
            rel="noreferrer noopener"
            title="Open full size in a new tab"
          >
            <img
              src={imageUrl}
              alt={asset.title}
              onError={verifyAdminSessionDebounced}
            />
          </a>
          <a
            className="admin-gallery-detail-fullsize"
            href={imageUrl}
            target="_blank"
            rel="noreferrer noopener"
          >
            Open full size in new tab ↗
          </a>
        </div>

        <div className="admin-gallery-detail-side">
          <h2>{asset.title}</h2>

          <dl className="admin-gallery-panel-meta">
            <dt>Path</dt>
            <dd><code>{asset.id}</code></dd>
            <dt>Size</dt>
            <dd>{formatSize(asset.sizeBytes)}</dd>
            <dt>Created</dt>
            <dd>{new Date(asset.createdAt).toLocaleString()}</dd>
            {asset.source && (<><dt>Source</dt><dd>{asset.source}</dd></>)}
            {asset.model && (<><dt>Model</dt><dd>{asset.model}</dd></>)}
            {asset.aspectRatio && (<><dt>Aspect</dt><dd>{asset.aspectRatio}</dd></>)}
          </dl>

          <div className="admin-gallery-panel-form">
            <label>
              Title
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                data-testid="admin-gallery-panel-title"
              />
            </label>
            <label>
              Category
              <input
                type="text"
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                data-testid="admin-gallery-panel-category"
              />
            </label>
            <label>
              Tags (comma-separated)
              <input
                type="text"
                value={tagsText}
                onChange={(e) => setTagsText(e.target.value)}
                data-testid="admin-gallery-panel-tags"
              />
            </label>
            <label>
              Description
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={3}
                data-testid="admin-gallery-panel-description"
              />
            </label>
            <label>
              Prompt
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                rows={4}
                data-testid="admin-gallery-panel-prompt"
              />
            </label>
          </div>

          {panelError && <div className="admin-gallery-panel-error">{panelError}</div>}

          <div className="admin-gallery-panel-actions">
            <button
              type="button"
              onClick={handleSave}
              disabled={saving || deleting}
              className="admin-gallery-panel-save"
              data-testid="admin-gallery-panel-save"
            >
              {saving ? "Saving..." : "Save"}
            </button>
            <a
              href={imageUrl}
              download={asset.filename}
              className="admin-gallery-panel-download"
              onClick={(e) => e.stopPropagation()}
            >
              Download
            </a>
            <button
              type="button"
              onClick={handleDelete}
              disabled={saving || deleting}
              className="admin-gallery-panel-delete"
              data-testid="admin-gallery-panel-delete"
            >
              {deleting ? "Deleting..." : "Delete"}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** Simple fullscreen lightbox for previewing an image. */
function ImageLightbox({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return createPortal(
    <div className="admin-gallery-lightbox" onClick={onClose}>
      <img src={src} alt={alt} onClick={(e) => e.stopPropagation()} />
      <button type="button" className="admin-gallery-lightbox-close" onClick={onClose} aria-label="Close">×</button>
    </div>,
    document.body,
  );
}

/** Render a category slug as a human-friendly label. */
function toDisplayName(category: string): string {
  if (!category) return "Other";
  const spaced = category.replace(/[-_]/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Format a byte count as a short human-readable string. */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

interface UploadModalProps {
  defaultNamespace: string;
  defaultCategory: string;
  onClose: () => void;
  onUploaded: (assets: GalleryAsset[]) => void;
}

/**
 * Modal dialog for uploading one or more images into the archive.
 * Handles both single-file and bulk uploads — the picker is `multiple`
 * and the drop zone accepts any number of files at once. Metadata
 * (namespace, category, tags, description) applies to every file in
 * the batch; title applies only when a single file is selected so
 * bulk uploads fall back to per-file stem-based titles.
 */
function UploadModal({ defaultNamespace, defaultCategory, onClose, onUploaded }: UploadModalProps) {
  const [files, setFiles] = useState<File[]>([]);
  const [namespace, setNamespace] = useState<string>(defaultNamespace);
  const [category, setCategory] = useState<string>(defaultCategory);
  const [title, setTitle] = useState<string>("");
  const [tagsText, setTagsText] = useState<string>("");
  const [description, setDescription] = useState<string>("");
  const [uploading, setUploading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [failures, setFailures] = useState<{ filename: string; error: string }[]>([]);
  const [isDragging, setIsDragging] = useState<boolean>(false);
  const [successCount, setSuccessCount] = useState<number>(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Guard against double-submit via rapid click. State-based disabling
  // isn't enough because React batches state updates and a determined
  // double-click can race past the `uploading` flag.
  const inFlightRef = useRef<boolean>(false);

  // ESC closes the modal (unless an upload is in progress — don't
  // interrupt the POST).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !uploading) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, uploading]);

  const addFiles = useCallback((incoming: FileList | File[] | null) => {
    if (!incoming) return;
    const list = Array.from(incoming).filter((f) => f.type.startsWith("image/") || /\.(png|jpe?g|webp|gif)$/i.test(f.name));
    if (list.length === 0) return;
    setFiles((prev) => [...prev, ...list]);
    setError(null);
    setSuccessCount(0);
  }, []);

  const removeFile = useCallback((index: number) => {
    setFiles((prev) => prev.filter((_, i) => i !== index));
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (inFlightRef.current) return;
    if (files.length === 0) {
      setError("Pick at least one file to upload");
      return;
    }
    if (!namespace.trim()) {
      setError("Namespace is required");
      return;
    }
    inFlightRef.current = true;
    setUploading(true);
    setError(null);
    setFailures([]);
    setSuccessCount(0);
    try {
      const tags = tagsText
        .split(",")
        .map((t) => t.trim())
        .filter((t) => t.length > 0);
      const result = await uploadGalleryAssets(files, {
        namespace: namespace.trim(),
        category: category.trim() || undefined,
        title: files.length === 1 ? title.trim() || undefined : undefined,
        tags,
        description: description.trim() || undefined,
      });
      if (result.failures.length > 0) {
        setFailures(result.failures);
      }
      if (result.assets.length > 0) {
        // Parent merges the new assets into the grid. We DO NOT close
        // the modal — the user may want to upload more batches. Clear
        // the file list and show a success banner; keep namespace /
        // category / tags / description so rapid re-uploads don't
        // re-type the same fields.
        onUploaded(result.assets);
        setFiles([]);
        setSuccessCount(result.assets.length);
        setTitle("");
        if (fileInputRef.current) fileInputRef.current.value = "";
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
      inFlightRef.current = false;
    }
  }

  const totalBytes = files.reduce((n, f) => n + f.size, 0);

  return createPortal(
    <div
      className="admin-gallery-modal-backdrop"
      onClick={uploading ? undefined : onClose}
      data-testid="admin-gallery-upload-modal"
    >
      <div
        className="admin-gallery-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Upload images"
      >
        <div className="admin-gallery-modal-header">
          <h2>Upload images</h2>
          <button
            type="button"
            onClick={onClose}
            disabled={uploading}
            aria-label="Close"
            data-testid="admin-gallery-upload-close"
          >
            ×
          </button>
        </div>

        {successCount > 0 && (
          <div className="admin-gallery-upload-success" data-testid="admin-gallery-upload-success">
            Uploaded {successCount} file{successCount === 1 ? "" : "s"}. Pick more files or close.
          </div>
        )}

        <form onSubmit={handleSubmit} className="admin-gallery-upload-form">
          <div
            className={`admin-gallery-dropzone ${isDragging ? "dragging" : ""}`}
            onClick={() => fileInputRef.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setIsDragging(true);
            }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setIsDragging(false);
              addFiles(e.dataTransfer.files);
            }}
            data-testid="admin-gallery-dropzone"
          >
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept="image/png,image/jpeg,image/webp,image/gif"
              onChange={(e) => {
                addFiles(e.target.files);
                if (e.target) e.target.value = "";
              }}
              style={{ display: "none" }}
              data-testid="admin-gallery-file-input"
            />
            {files.length === 0 ? (
              <p>Drop images here or click to pick (PNG, JPEG, WebP, GIF). Max 50 files, 20 MB each.</p>
            ) : (
              <p>
                {files.length} file{files.length === 1 ? "" : "s"} selected • {formatSize(totalBytes)} total
              </p>
            )}
          </div>

          {files.length > 0 && (
            <ul className="admin-gallery-upload-list">
              {files.map((f, i) => (
                <li key={`${f.name}-${i}`}>
                  <span className="admin-gallery-upload-filename">{f.name}</span>
                  <span className="admin-gallery-upload-filesize">{formatSize(f.size)}</span>
                  <button
                    type="button"
                    onClick={() => removeFile(i)}
                    aria-label={`Remove ${f.name}`}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div className="admin-gallery-upload-fields">
            <label>
              Namespace <span className="admin-gallery-required">*</span>
              <input
                type="text"
                value={namespace}
                onChange={(e) => setNamespace(e.target.value)}
                placeholder="e.g. avatars, backgrounds, experiments-v2"
                required
                data-testid="admin-gallery-upload-namespace"
              />
            </label>
            <label>
              Category
              <input
                type="text"
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                placeholder="Defaults to namespace"
                data-testid="admin-gallery-upload-category"
              />
            </label>
            {files.length === 1 && (
              <label>
                Title
                <input
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="Defaults to filename stem"
                  data-testid="admin-gallery-upload-title"
                />
              </label>
            )}
            <label>
              Tags (comma-separated)
              <input
                type="text"
                value={tagsText}
                onChange={(e) => setTagsText(e.target.value)}
                data-testid="admin-gallery-upload-tags"
              />
            </label>
            <label>
              Description
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={3}
                data-testid="admin-gallery-upload-description"
              />
            </label>
          </div>

          {error && <div className="admin-gallery-panel-error">{error}</div>}
          {failures.length > 0 && (
            <div className="admin-gallery-panel-error">
              {failures.length} file{failures.length === 1 ? "" : "s"} failed:
              <ul>
                {failures.map((f) => (
                  <li key={f.filename}>
                    <code>{f.filename}</code>: {f.error}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="admin-gallery-modal-actions">
            <button type="button" onClick={onClose} disabled={uploading}>
              Cancel
            </button>
            <button
              type="submit"
              disabled={uploading || files.length === 0}
              className="admin-gallery-panel-save"
              data-testid="admin-gallery-upload-submit"
            >
              {uploading ? "Uploading..." : `Upload ${files.length || ""}`.trim()}
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  );
}
