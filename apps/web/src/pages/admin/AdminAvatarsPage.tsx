import { useState, useEffect, useRef, useMemo } from "react";
import { getAvatarSettings, updateAvatarSettings } from "../../api/adminClient";
import AvatarIcon from "../../components/multiplayer/AvatarIcon";
import type { Avatar } from "@price-game/shared";

type FilterMode = "all" | "enabled" | "disabled";

/**
 * Admin page for managing avatar availability.
 * Displays all avatars in a grid with toggle switches to enable/disable them.
 * Shows user counts per avatar and supports search, filtering, and bulk actions.
 */
export default function AdminAvatarsPage() {
  const [avatars, setAvatars] = useState<readonly string[]>([]);
  const [labels, setLabels] = useState<Record<string, string>>({});
  const [disabledAvatars, setDisabledAvatars] = useState<Set<string>>(new Set());
  const [userCounts, setUserCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [filterMode, setFilterMode] = useState<FilterMode>("all");
  const successTimerRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    getAvatarSettings()
      .then((data) => {
        setAvatars(data.avatars);
        setLabels(data.labels);
        setDisabledAvatars(new Set(data.disabledAvatars));
        setUserCounts(data.userCounts);
      })
      .catch(() => {
        setError("Failed to load avatar settings");
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    return () => {
      if (successTimerRef.current) clearTimeout(successTimerRef.current);
    };
  }, []);

  const filteredAvatars = useMemo(() => {
    const q = searchQuery.toLowerCase().trim();
    return avatars.filter((avatar) => {
      // Search filter
      if (q) {
        const label = (labels[avatar] ?? avatar).toLowerCase();
        if (!avatar.toLowerCase().includes(q) && !label.includes(q)) return false;
      }
      // Status filter
      const isDisabled = disabledAvatars.has(avatar);
      if (filterMode === "enabled" && isDisabled) return false;
      if (filterMode === "disabled" && !isDisabled) return false;
      return true;
    });
  }, [avatars, labels, disabledAvatars, searchQuery, filterMode]);

  const enabledCount = avatars.length - disabledAvatars.size;
  const disabledCount = disabledAvatars.size;

  function toggleAvatar(avatar: string) {
    setDisabledAvatars((prev) => {
      const next = new Set(prev);
      if (next.has(avatar)) {
        next.delete(avatar);
      } else {
        next.add(avatar);
      }
      return next;
    });
  }

  function enableAll() {
    setDisabledAvatars(new Set());
  }

  function disableAll() {
    setDisabledAvatars(new Set(avatars));
  }

  async function handleSave() {
    try {
      setSaving(true);
      setError(null);
      const result = await updateAvatarSettings([...disabledAvatars]);
      setDisabledAvatars(new Set(result.disabledAvatars));
      setUserCounts(result.userCounts);
      setSuccess("Avatar settings saved");
      if (successTimerRef.current) clearTimeout(successTimerRef.current);
      successTimerRef.current = setTimeout(() => setSuccess(null), 4000);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to save avatar settings");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="admin-page">
        <div className="admin-loading" style={{ minHeight: "200px" }}>
          <span className="admin-loading-spinner" />
          Loading avatar settings...
        </div>
      </div>
    );
  }

  return (
    <div className="admin-page admin-avatars-page" data-testid="admin-avatars-page">
      <h2>Avatars</h2>
      <p style={{ fontSize: "0.85rem", color: "#999", marginBottom: 16 }}>
        Manage which avatars are available for users to select. Disabled avatars
        won't appear in the avatar picker or be assigned in multiplayer rooms.
        Users who already have a disabled avatar keep it until they change.
      </p>

      {success && <div className="admin-success" data-testid="avatars-success">{success}</div>}
      {error && <div className="admin-error" style={{ maxWidth: "100%", marginBottom: 16 }} data-testid="avatars-error">{error}</div>}

      <div className="admin-avatars-toolbar" data-testid="avatars-toolbar">
        <input
          type="text"
          className="admin-avatars-search"
          placeholder="Search avatars..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          data-testid="avatars-search"
        />
        <div className="admin-avatars-filter-group">
          {(["all", "enabled", "disabled"] as const).map((mode) => (
            <button
              key={mode}
              className={`admin-avatars-filter-btn ${filterMode === mode ? "active" : ""}`}
              onClick={() => setFilterMode(mode)}
              data-testid={`avatars-filter-${mode}`}
            >
              {mode === "all" ? "All" : mode === "enabled" ? "Enabled" : "Disabled"}
            </button>
          ))}
        </div>
        <div className="admin-avatars-bulk-actions">
          <button
            className="admin-btn-secondary"
            onClick={enableAll}
            data-testid="avatars-enable-all"
          >
            Enable All
          </button>
          <button
            className="admin-btn-secondary"
            onClick={disableAll}
            data-testid="avatars-disable-all"
          >
            Disable All
          </button>
        </div>
      </div>

      <div className="admin-avatars-grid" data-testid="avatars-grid">
        {filteredAvatars.map((avatar) => {
          const enabled = !disabledAvatars.has(avatar);
          const count = userCounts[avatar] ?? 0;
          return (
            <div
              key={avatar}
              className={`admin-avatar-card ${enabled ? "" : "avatar-disabled"}`}
              data-testid={`avatar-card-${avatar}`}
            >
              <AvatarIcon avatar={avatar as Avatar} size={48} dimmed={!enabled} />
              <span className="admin-avatar-label">{labels[avatar] ?? avatar}</span>
              {count > 0 && (
                <span className="admin-avatar-user-count" data-testid={`avatar-users-${avatar}`}>
                  {count} {count === 1 ? "user" : "users"}
                </span>
              )}
              <label className="game-mode-toggle" data-testid={`avatar-toggle-${avatar}`}>
                <input
                  type="checkbox"
                  checked={enabled}
                  onChange={() => toggleAvatar(avatar)}
                />
                <span className="game-mode-toggle-slider" />
              </label>
            </div>
          );
        })}
      </div>

      {filteredAvatars.length === 0 && (
        <div style={{ textAlign: "center", color: "#666", padding: "40px 0" }}>
          No avatars match your search.
        </div>
      )}

      <div className="admin-avatars-footer">
        <span className="admin-avatars-summary">
          {enabledCount} enabled, {disabledCount} disabled
        </span>
        <button
          className="admin-btn-primary"
          onClick={handleSave}
          disabled={saving}
          data-testid="avatars-save"
        >
          {saving ? "Saving..." : "Save Avatar Settings"}
        </button>
      </div>
    </div>
  );
}
