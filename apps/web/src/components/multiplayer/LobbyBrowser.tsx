import { useState, useEffect, useRef } from "react";
import type { PublicLobbyEntry, GameMode } from "@price-game/shared";
import { GAME_MODES, getGameModeName } from "@price-game/shared";
import AvatarIcon from "./AvatarIcon";
import { getPlayerSession } from "../../api/socket";

interface LobbyBrowserProps {
  /** Caller-provided join handler. The optional `password` arg is set when
   *  the user just submitted credentials for a password-protected lobby. */
  onJoinRoom: (code: string, password?: string) => void;
  /** Set of admin-disabled mode ids — those modes are hidden from the
   *  filter dropdown so users can't filter by a disabled mode. */
  disabledModes?: Set<string>;
}

/**
 * Server-browser-style lobby list. Polls /api/mp/lobbies every 5s.
 * Displays a sortable table with mode filter and player counts.
 */
export default function LobbyBrowser({ onJoinRoom, disabledModes }: LobbyBrowserProps) {
  const [lobbies, setLobbies] = useState<PublicLobbyEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [modeFilter, setModeFilter] = useState<GameMode | "all">("all");
  const [sortKey, setSortKey] = useState<"players" | "mode" | "host" | "rounds">("players");
  const [sortAsc, setSortAsc] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Password-prompt state: holds the room code the user is trying to join
  // so we can show an inline password input before forwarding the join
  // request. Without this, password-protected lobbies always failed with
  // "incorrect password" because the join fired with no creds.
  const [passwordPromptCode, setPasswordPromptCode] = useState<string | null>(null);
  const [passwordInput, setPasswordInput] = useState("");
  const [passwordError, setPasswordError] = useState<string | null>(null);

  async function fetchLobbies() {
    try {
      const params = modeFilter !== "all" ? `?mode=${modeFilter}` : "";
      const res = await fetch(`/api/mp/lobbies${params}`);
      if (res.ok) {
        const data = await res.json();
        setLobbies(data.lobbies ?? data ?? []);
      }
    } catch {
      // Silently retry on next poll
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    setLoading(true);
    fetchLobbies();
    intervalRef.current = setInterval(fetchLobbies, 5000);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modeFilter]);

  // Capture-phase ESC handler. The outer browser modal (in JoinScreen)
  // has its own document-level keydown listener that calls
  // setShowLobbyBrowser(false) — without intercepting first, pressing
  // ESC inside the password prompt would dismiss the entire lobby
  // browser instead of just closing the prompt. `capture: true` so
  // we run before JoinScreen's bubble-phase listener.
  useEffect(() => {
    if (!passwordPromptCode) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setPasswordPromptCode(null);
      setPasswordInput("");
      setPasswordError(null);
    }
    document.addEventListener("keydown", onKey, { capture: true });
    return () => document.removeEventListener("keydown", onKey, { capture: true });
  }, [passwordPromptCode]);

  function handleSort(key: typeof sortKey) {
    if (sortKey === key) {
      setSortAsc(!sortAsc);
    } else {
      setSortKey(key);
      setSortAsc(false);
    }
  }

  // Hide the user's own current room from the listing — joining your own
  // room would create a duplicate mp_players row (server now also blocks
  // this, but filtering at the UI is the cleaner experience).
  const ownRoomCode = getPlayerSession()?.roomCode ?? null;

  const sorted = [...lobbies]
    .filter((l) => l.code !== ownRoomCode)
    .sort((a, b) => {
      let cmp = 0;
      switch (sortKey) {
        case "players": cmp = a.humanCount - b.humanCount; break;
        case "mode": cmp = a.gameMode.localeCompare(b.gameMode); break;
        case "host": cmp = a.hostName.localeCompare(b.hostName); break;
        case "rounds": cmp = a.totalRounds - b.totalRounds; break;
      }
      return sortAsc ? cmp : -cmp;
    });

  const sortIcon = (key: typeof sortKey) =>
    sortKey === key ? (sortAsc ? " \u25B2" : " \u25BC") : "";

  return (
    <div className="server-browser">
      <div className="server-browser-header">
        <h2 className="server-browser-title">Public Games</h2>
        <div className="server-browser-controls">
          <select
            className="server-browser-filter"
            value={modeFilter}
            onChange={(e) => setModeFilter(e.target.value as GameMode | "all")}
          >
            <option value="all">All Modes</option>
            {GAME_MODES.filter((gm) => !disabledModes?.has(gm.mode)).map((gm) => (
              <option key={gm.mode} value={gm.mode}>{gm.name}</option>
            ))}
          </select>
          <button className="server-browser-refresh" onClick={() => { setLoading(true); fetchLobbies(); }} title="Refresh">
            &#x21BB;
          </button>
        </div>
      </div>

      <div className="server-browser-table-wrap">
        <table className="server-browser-table">
          <thead>
            <tr>
              <th className="sb-th sb-th-mode" onClick={() => handleSort("mode")}>
                Mode{sortIcon("mode")}
              </th>
              <th className="sb-th sb-th-host" onClick={() => handleSort("host")}>
                Host{sortIcon("host")}
              </th>
              <th className="sb-th sb-th-players" onClick={() => handleSort("players")}>
                Players{sortIcon("players")}
              </th>
              <th className="sb-th sb-th-rounds" onClick={() => handleSort("rounds")}>
                Rounds{sortIcon("rounds")}
              </th>
              <th className="sb-th sb-th-action"></th>
            </tr>
          </thead>
          <tbody>
            {loading && lobbies.length === 0 ? (
              <tr><td colSpan={5} className="sb-empty">Loading...</td></tr>
            ) : sorted.length === 0 ? (
              <tr><td colSpan={5} className="sb-empty">No public games found. Create one!</td></tr>
            ) : sorted.map((lobby) => {
              // Password-protected rows must prompt for credentials BEFORE
              // calling onJoinRoom \u2014 otherwise the join fires with no
              // password and the server immediately rejects with
              // "incorrect password" even though the user never had a
              // chance to type one.
              const handleSelect = () => {
                if (lobby.hasPassword) {
                  setPasswordInput("");
                  setPasswordError(null);
                  setPasswordPromptCode(lobby.code);
                  return;
                }
                onJoinRoom(lobby.code);
              };
              return (
                <tr key={lobby.code} className="sb-row" onClick={handleSelect}>
                  <td className="sb-cell sb-cell-mode">
                    <span className="sb-mode-badge">{getGameModeName(lobby.gameMode)}</span>
                  </td>
                  <td className="sb-cell sb-cell-host">
                    <span className="sb-host">
                      {lobby.hostAvatar && <AvatarIcon avatar={lobby.hostAvatar} size={32} />}
                      <span className="sb-host-name">{lobby.hostName}</span>
                      {lobby.hasPassword && (
                        <span className="sb-host-pw" aria-label="Password protected" title="Password protected">
                          {"\uD83D\uDD12"}
                        </span>
                      )}
                    </span>
                  </td>
                  <td className="sb-cell sb-cell-players">
                    <span className="sb-cell-label" aria-hidden="true">{"\uD83D\uDC65"}</span>
                    <span className="sb-player-count">{lobby.humanCount}</span>
                    <span className="sb-player-slash">/</span>
                    <span className="sb-player-max">{lobby.maxPlayers}</span>
                    {lobby.botCount > 0 && (
                      <span className="sb-bot-count"> +{lobby.botCount} {"\uD83E\uDD16"}</span>
                    )}
                  </td>
                  <td className="sb-cell sb-cell-rounds">
                    <span className="sb-cell-label" aria-hidden="true">{"\uD83D\uDD04"}</span>
                    <span className="sb-rounds-num">{lobby.totalRounds}</span>
                    <span className="sb-rounds-suffix"> rounds</span>
                  </td>
                  <td className="sb-cell sb-cell-action">
                    <button
                      className="btn btn-primary sb-join-btn"
                      onClick={(e) => { e.stopPropagation(); handleSelect(); }}
                    >
                      Join
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Password prompt \u2014 shown only when the user has just clicked Join
          on a password-protected lobby. Submitting forwards the password
          to onJoinRoom; cancel returns the user to the browser. */}
      {passwordPromptCode && (
        <div
          className="sb-pw-overlay"
          role="presentation"
          onClick={() => setPasswordPromptCode(null)}
        >
          <form
            className="sb-pw-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Enter room password"
            onClick={(e) => e.stopPropagation()}
            onSubmit={(e) => {
              e.preventDefault();
              const pw = passwordInput.trim();
              if (!pw) {
                setPasswordError("Enter the room password to join.");
                return;
              }
              const code = passwordPromptCode;
              setPasswordPromptCode(null);
              setPasswordInput("");
              setPasswordError(null);
              onJoinRoom(code, pw);
            }}
          >
            <h3 className="sb-pw-title">Password required</h3>
            <p className="sb-pw-subtitle">
              Room <strong>{passwordPromptCode}</strong> is password-protected.
            </p>
            <input
              type="password"
              className="sb-pw-input"
              placeholder="Enter room password..."
              value={passwordInput}
              onChange={(e) => { setPasswordInput(e.target.value); setPasswordError(null); }}
              autoFocus
              maxLength={32}
              // Lobby passwords are short-lived shared secrets, not user
              // account credentials — disable browser/password-manager
              // capture so they don't end up saved as a site credential.
              autoComplete="off"
              data-testid="sb-pw-input"
            />
            {passwordError && <p className="sb-pw-error">{passwordError}</p>}
            <div className="sb-pw-actions">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setPasswordPromptCode(null)}
              >
                Cancel
              </button>
              <button type="submit" className="btn btn-primary">
                Join
              </button>
            </div>
          </form>
        </div>
      )}

      {!loading && (
        <div className="server-browser-footer">
          {sorted.length} game{sorted.length !== 1 ? "s" : ""} found
        </div>
      )}
    </div>
  );
}
