import { useState, useEffect, useRef } from "react";
import { getGameModeSettings, updateGameModeSettings } from "../../api/adminClient";

/**
 * Admin page for enabling/disabling game modes.
 * Fetches current settings on mount, lets admin toggle modes, and saves on button click.
 */
export default function AdminGameModesPage() {
  const [modes, setModes] = useState<{ mode: string; name: string; description: string }[]>([]);
  const [disabledModes, setDisabledModes] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const successTimerRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    getGameModeSettings()
      .then((data) => {
        setModes(data.modes);
        setDisabledModes(new Set(data.disabledModes));
      })
      .catch(() => {
        setError("Failed to load game mode settings");
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    return () => {
      if (successTimerRef.current) clearTimeout(successTimerRef.current);
    };
  }, []);

  function toggleMode(mode: string) {
    setDisabledModes((prev) => {
      const next = new Set(prev);
      if (next.has(mode)) {
        next.delete(mode);
      } else {
        next.add(mode);
      }
      return next;
    });
  }

  async function handleSave() {
    try {
      setSaving(true);
      setError(null);
      const result = await updateGameModeSettings([...disabledModes]);
      setDisabledModes(new Set(result.disabledModes));
      setSuccess("Game mode settings saved");
      if (successTimerRef.current) clearTimeout(successTimerRef.current);
      successTimerRef.current = setTimeout(() => setSuccess(null), 4000);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to save game mode settings");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="admin-page">
        <div className="admin-loading" style={{ minHeight: "200px" }}>
          <span className="admin-loading-spinner" />
          Loading game mode settings...
        </div>
      </div>
    );
  }

  return (
    <div className="admin-page admin-game-modes-page" data-testid="admin-game-modes-page">
      <h2>Game Modes</h2>
      <p style={{ fontSize: "0.85rem", color: "#999", marginBottom: 16 }}>
        Toggle game modes on or off. Disabled modes will not appear on the home page
        and cannot be used for single-player or multiplayer games.
      </p>

      {success && <div className="admin-success">{success}</div>}
      {error && <div className="admin-error" style={{ maxWidth: "100%", marginBottom: 16 }}>{error}</div>}

      <div className="admin-section" data-testid="game-modes-grid">
        <div className="game-modes-grid">
          {modes.map(({ mode, name, description }) => {
            const enabled = !disabledModes.has(mode);
            return (
              <div
                key={mode}
                className={`game-mode-card ${enabled ? "game-mode-enabled" : "game-mode-disabled"}`}
                data-testid={`game-mode-card-${mode}`}
              >
                <div className="game-mode-card-header">
                  <span className="game-mode-card-name">{name}</span>
                  <label className="game-mode-toggle" data-testid={`game-mode-toggle-${mode}`}>
                    <input
                      type="checkbox"
                      checked={enabled}
                      onChange={() => toggleMode(mode)}
                    />
                    <span className="game-mode-toggle-slider" />
                  </label>
                </div>
                <p className="game-mode-card-desc">{description}</p>
                <span className={`game-mode-card-status ${enabled ? "status-enabled" : "status-disabled"}`}>
                  {enabled ? "Enabled" : "Disabled"}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      <div style={{ marginTop: 20 }}>
        <button
          className="admin-btn-primary"
          onClick={handleSave}
          disabled={saving}
          data-testid="game-modes-save"
        >
          {saving ? "Saving..." : "Save Game Mode Settings"}
        </button>
      </div>
    </div>
  );
}
