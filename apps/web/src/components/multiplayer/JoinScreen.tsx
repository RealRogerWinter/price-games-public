import { useState, useRef, useEffect } from "react";
import type { GameMode, MultiplayerRoom, BotDifficulty, RoundCountOption, JoinSource } from "@price-game/shared";
import { GAME_MODES, BOT_DIFFICULTIES, ROUND_COUNT_OPTIONS } from "@price-game/shared";
import { useUserAuth } from "../../context/UserAuthContext";
import { useLivePlayerCount } from "../../hooks/useLivePlayerCount";
import { quickplayMatch } from "../../api/client";
import {
  getOrCreateGuestIdentity,
  getMultiplayerDisplayNameOverride,
  MP_DISPLAY_NAME_KEY,
} from "../../utils/guestIdentity";
import LobbyBrowser from "./LobbyBrowser";
import "../../styles/multiplayer.css";
import HomeTopBar from "../HomeTopBar";
import IdentityCard from "../IdentityCard";
import logoImg from "../../assets/logo.webp";
import quickplayIcon from "../../assets/mp-icons/quickplay.svg";
import createRoomIcon from "../../assets/mp-icons/create-room.svg";
import browseGamesIcon from "../../assets/mp-icons/browse-games.svg";

interface JoinScreenProps {
  roomCode?: string;          // set when joining via link
  existingRoom?: MultiplayerRoom | null; // room info fetched via HTTP
  onCreateRoom: (displayName: string, gameMode: GameMode, options?: { categories?: string[]; password?: string; totalRounds?: number; isPublic?: boolean; autoStart?: { botCount: number; botDifficulty: BotDifficulty } }) => void;
  onJoinRoom: (
    roomCode: string,
    displayName: string,
    password?: string,
    source?: JoinSource,
  ) => void;
  error?: string | null;
  loading?: boolean;
  /** Callback to leave the join screen and return home. */
  onLeave?: () => void;
  /** Opens the register/auth modal when anon players tap the IdentityCard CTA. */
  onOpenAuth?: () => void;
}

/**
 * Multiplayer lobby hub screen. Shows a hero section, three action cards
 * (Quick Play, Create Room, Browse Games), and a stats footer.
 * When joining via room code, displays a focused join card instead.
 */
export default function JoinScreen({
  roomCode,
  existingRoom,
  onCreateRoom,
  onJoinRoom,
  error,
  loading,
  onLeave,
  onOpenAuth,
}: JoinScreenProps) {
  const { user } = useUserAuth();
  // Lazy-init the guest identity so the handle + avatar read happens once
  // per mount and stays stable across renders. Anon players fall back to
  // this handle whenever they haven't explicitly customized their name.
  const [guest] = useState(getOrCreateGuestIdentity);
  const [displayName, setDisplayName] = useState(() => {
    if (typeof window === "undefined") return "";
    return getMultiplayerDisplayNameOverride() ?? "";
  });
  const [password, setPassword] = useState("");
  const [isPublic, setIsPublic] = useState(false);
  const [showLobbyBrowser, setShowLobbyBrowser] = useState(false);
  const [quickPlayMode, setQuickPlayMode] = useState<GameMode | "random">("random");
  // Mirrors the LobbyScreen pattern: respect admin-disabled modes from
  // /api/settings/game-modes so the Game Type dropdown can't surface a
  // mode the admin has turned off (and the random-mode pick can't pick one).
  const [disabledModes, setDisabledModes] = useState<Set<string>>(new Set());
  const [quickPlayRounds, setQuickPlayRounds] = useState<RoundCountOption | "random">("random");
  // Live count of public lobbies — auto-refreshes every 15s while the
  // tab is visible (see useLivePlayerCount). Replaces the original
  // mount-only fetch.
  const live = useLivePlayerCount();
  const lobbyCount = live.status === "live" ? live.count : null;

  const nameInputRef = useRef<HTMLInputElement>(null);

  const isJoining = !!roomCode;
  const needsPassword = isJoining && existingRoom?.hasPassword;
  // Anon players always have a usable name (custom override → guest handle)
  // so Quick Play / Create Room / Join can proceed without a blocking field.
  const trimmedCustom = displayName.trim();
  const effectiveName = user
    ? user.username
    : trimmedCustom.length > 0
      ? trimmedCustom
      : guest.handle;
  const identityOverride = user ? null : trimmedCustom.length > 0 ? trimmedCustom : null;

  // Fetch lobby count on mount for the Browse card badge
  // ESC closes the lobby-browser modal when it's open.
  useEffect(() => {
    if (!showLobbyBrowser) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setShowLobbyBrowser(false);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [showLobbyBrowser]);

  useEffect(() => {
    if (isJoining) return;
    // Lobby count is sourced from useLivePlayerCount above; this effect
    // only handles the admin-disabled-modes fetch (one-shot on mount).
    // Mirror LobbyScreen: pull the admin-disabled mode list so the Game
    // Type dropdown can't offer modes the admin turned off (and the
    // random-mode pool below skips them too).
    fetch("/api/settings/game-modes")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data?.disabledModes) setDisabledModes(new Set(data.disabledModes));
      })
      .catch(() => {});
  }, [isJoining]);

  /**
   * Persist the player's custom multiplayer display name to localStorage, or
   * clear it when the field is empty. An empty field means "fall back to the
   * guest handle" — we actively remove the key instead of storing `""` so
   * other surfaces (`getMultiplayerDisplayNameOverride`) can reliably tell
   * "no override" from "explicit empty string".
   */
  function updateDisplayName(name: string) {
    setDisplayName(name);
    const trimmed = name.trim();
    try {
      if (trimmed) {
        localStorage.setItem(MP_DISPLAY_NAME_KEY, trimmed);
      } else {
        localStorage.removeItem(MP_DISPLAY_NAME_KEY);
      }
    } catch {
      // Storage unavailable — in-memory state still reflects the edit.
    }
  }

  /** Handle the join-room form submit (when joining via link). */
  function handleJoinSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (roomCode) {
      // The roomCode prop is populated by MultiplayerPage from the URL path
      // (`/<roomCode>`), which means this user landed on a shared link —
      // tag the join accordingly so analytics distinguish share-link
      // arrivals from lobby-browser / quickplay flows.
      onJoinRoom(roomCode, effectiveName, password || undefined, "share_link");
    }
  }

  /** Handle Create Room card button. */
  function handleCreateRoom() {
    onCreateRoom(effectiveName, "classic", { isPublic: isPublic || undefined });
  }

  /**
   * Quick Play: try to match the player into an existing public room with
   * real humans first — filtering by game mode and total round count when
   * those are specified — and fall back to creating a new public room with
   * bots if nothing matches.
   *
   * The rounds filter accepts the canonical options (3, 5, 10) or "random",
   * which omits the filter entirely so the matchmaker picks any available
   * room. When falling back to bot creation, a "random" rounds choice is
   * resolved to one of the canonical options at random.
   */
  function handleQuickPlay() {
    // Resolve mode — if "random", pick from all available modes that aren't
    // admin-disabled. If every mode is disabled, fall back to "classic"
    // (kept-on by definition since it's the default).
    let mode: GameMode;
    if (quickPlayMode === "random") {
      const pool = GAME_MODES.filter(({ mode: m }) => !disabledModes.has(m));
      const picked = pool.length > 0
        ? pool[Math.floor(Math.random() * pool.length)]
        : { mode: "classic" as GameMode };
      mode = picked.mode;
    } else {
      mode = quickPlayMode;
    }

    // Resolve rounds — keep null for "random" so the matchmaker doesn't
    // filter by round count; resolve to a concrete value when falling
    // back to bot creation so the room has a deterministic size.
    const preferredRounds: RoundCountOption | null =
      quickPlayRounds === "random" ? null : quickPlayRounds;

    const botCount = 2 + Math.floor(Math.random() * 3); // 2-4 bots
    const botDifficulty = BOT_DIFFICULTIES[Math.floor(Math.random() * BOT_DIFFICULTIES.length)];

    const resolvedRounds: RoundCountOption =
      preferredRounds ??
      (ROUND_COUNT_OPTIONS[
        Math.floor(Math.random() * ROUND_COUNT_OPTIONS.length)
      ] as RoundCountOption);

    // Note: when the UI is set to "random" game mode, we deliberately ask
    // the matchmaker for ANY mode (gameMode omitted) so the player can slot
    // into any waiting lobby. If no lobby is available we fall back to
    // creating a new room using the locally-picked `mode` above — the two
    // resolutions intentionally diverge so the experience stays snappy.
    quickplayMatch(
      quickPlayMode === "random" ? undefined : mode,
      preferredRounds ?? undefined,
    )
      .then((data) => {
        if (data.action === "join" && typeof data.roomCode === "string") {
          onJoinRoom(data.roomCode, effectiveName, undefined, "quickplay");
          return;
        }
        onCreateRoom(effectiveName, mode, {
          isPublic: true,
          totalRounds: resolvedRounds,
          autoStart: { botCount, botDifficulty },
        });
      })
      .catch(() => {
        // Network / server failure — still give the player a game by
        // creating a fresh bot room.
        onCreateRoom(effectiveName, mode, {
          isPublic: true,
          totalRounds: resolvedRounds,
          autoStart: { botCount, botDifficulty },
        });
      });
  }

  /** Handle lobby browser join click. The optional `password` arg is
   *  forwarded when the browser's inline password prompt collected
   *  credentials for a protected lobby. */
  function handleLobbyJoin(code: string, password?: string) {
    setShowLobbyBrowser(false);
    onJoinRoom(code, effectiveName, password, "browser");
  }

  // ── Joining flow (via room code link) ─────────────────────
  // Top header reuses `HomeTopBar` so the MP hub matches the home page:
  // the auth dropdown floats absolutely in the top-right beside the
  // centered logo. The Home button on the left was removed — clicking
  // the price.games logo already routes home, and a separate Home
  // button felt redundant. Gated on `onLeave` so render trees that
  // omit it (component tests) skip the embedded UserDropdown's
  // `useNavigate()` requirement.
  const navRow = onLeave ? <HomeTopBar /> : null;

  const identityCard = (
    <IdentityCard
      onOpenRegister={onOpenAuth ?? (() => {})}
      displayNameOverride={identityOverride}
    />
  );

  if (isJoining) {
    return (
      <div className="mp-hub-join">
        {navRow}
        {identityCard}
        <div className="mp-hub-join-card">
          <div className="mp-hub-join-title">Join Game</div>

          {existingRoom && (
            <div className="mp-hub-join-room-info">
              <p>
                Room <strong>{roomCode}</strong> &middot;{" "}
                {existingRoom.players.length} player
                {existingRoom.players.length !== 1 ? "s" : ""} waiting
              </p>
              <p className="mp-hub-join-room-mode">
                Mode:{" "}
                {GAME_MODES.find((m) => m.mode === existingRoom.gameMode)?.name ||
                  existingRoom.gameMode}
              </p>
              {existingRoom.hasPassword && (
                <p className="mp-hub-join-room-pw">
                  This room requires a password
                </p>
              )}
            </div>
          )}

          <form onSubmit={handleJoinSubmit} style={{ display: "contents" }}>
            {!user && (
              <>
                <label className="mp-hub-join-label" htmlFor="mp-join-display-name">
                  Display Name (optional)
                </label>
                <input
                  id="mp-join-display-name"
                  ref={nameInputRef}
                  type="text"
                  className="mp-hub-join-input"
                  placeholder={guest.handle}
                  value={displayName}
                  onChange={(e) => updateDisplayName(e.target.value)}
                  maxLength={20}
                  disabled={loading}
                />
              </>
            )}

            {needsPassword && (
              <>
                <label className="mp-hub-join-label">Room Password</label>
                <input
                  type="password"
                  className="mp-hub-join-input"
                  placeholder="Enter room password..."
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  maxLength={32}
                  disabled={loading}
                />
              </>
            )}

            {error && <p className="mp-hub-error">{error}</p>}

            <button
              type="submit"
              className="mp-hub-join-btn"
              disabled={loading}
            >
              {loading ? "Connecting..." : "Join Game"}
            </button>
          </form>
        </div>
      </div>
    );
  }

  // ── Main lobby hub ────────────────────────────────────────
  return (
    <div className="page mp-hub">
      {navRow}

      {/* Logo — same wrapper element + sizing as HomePage so navigating
          between / and /mp doesn't shift the logo position by even a
          pixel. Click routes home (parity with HomePage's UserDropdown
          behaviour). */}
      <div className="home-title">
        <img
          className="home-logo-img"
          src={logoImg}
          width={512}
          height={158}
          alt="price.games"
          draggable={false}
          onClick={onLeave}
          style={{ cursor: "pointer" }}
        />
      </div>

      {/* Identity card sits beneath the logo so the "playing as guest"
          CTA is the first thing users see after the brand mark, not
          crowded into the top nav strip. */}
      {identityCard}

      {/* Hero Section */}
      <div className="mp-hub-hero">
        <h2 className="mp-hub-hero-title">Multiplayer</h2>

        {!user && (
          <div className="mp-hub-name-field">
            <label className="mp-hub-name-label" htmlFor="mp-hub-display-name">
              Display Name (optional)
            </label>
            <input
              id="mp-hub-display-name"
              ref={nameInputRef}
              type="text"
              className="mp-hub-name-input"
              placeholder={guest.handle}
              value={displayName}
              onChange={(e) => updateDisplayName(e.target.value)}
              maxLength={20}
              disabled={loading}
            />
          </div>
        )}
        {error && <p className="mp-hub-error">{error}</p>}
      </div>

      {/* Three Action Cards — 2-on-top + 1-centered-below layout. The
          inner row wrappers let us put Quick Play + Create Room side-by-side
          and centre Browse Games beneath them at half-width on every
          breakpoint, instead of letting auto-fit grids collapse it to
          full-width below ~640px. */}
      <div className="mp-hub-cards">
        <div className="mp-hub-cards-row mp-hub-cards-row--top">
          {/* Card A (top-left): Browse Games — promoted to the top row so
              the +10% bonus path sits next to the +25% Create Room path
              and Quick Play moves to the centered slot below. */}
          <div
            className={`mp-hub-card mp-hub-card--browse ${showLobbyBrowser ? "mp-hub-card--active" : ""}`}
          >
            <span className="mp-hub-card-bonus-flag mp-hub-card-bonus-flag--browse">+10% bonus</span>
            <div className="mp-hub-card-icon">
              <img
                src={browseGamesIcon}
                alt=""
                width={64}
                height={64}
                draggable={false}
              />
            </div>
            <div className="mp-hub-card-title">Browse Games</div>
            <div className="mp-hub-card-subtitle">
              Find and join public games with other players
            </div>
            <p className="mp-hub-card-bonus-copy">
              Finish a public match to earn <strong>+10% score</strong> on
              your next match.
            </p>
            {lobbyCount !== null && (
              <div className="mp-hub-card-badge">
                <span className="mp-hub-card-badge-dot" />
                {lobbyCount} active game{lobbyCount !== 1 ? "s" : ""}
              </div>
            )}
            <button
              className="mp-hub-card-btn mp-hub-card-btn--browse"
              onClick={() => setShowLobbyBrowser(!showLobbyBrowser)}
              disabled={loading}
            >
              Browse
            </button>
          </div>

          {/* Card B (top-right): Create Room */}
          <div className="mp-hub-card mp-hub-card--create mp-hub-card--featured">
            <span className="mp-hub-card-bonus-flag">+25% bonus</span>
            <div className="mp-hub-card-icon">
              <img
                src={createRoomIcon}
                alt=""
                width={64}
                height={64}
                draggable={false}
              />
            </div>
            <div className="mp-hub-card-title">Create Room</div>
            <div className="mp-hub-card-subtitle">
              Host a private or public game
            </div>
            <p className="mp-hub-card-bonus-copy">
              Share your room link. When a friend joins and plays, you earn{" "}
              <strong>+25% score</strong> on your next 3 matches.
            </p>
            <div className="mp-hub-card-control">
              <fieldset className="mp-visibility-picker">
                <legend className="visually-hidden">Room visibility</legend>
                <label className={`mp-visibility-option${!isPublic ? " mp-visibility-option--active" : ""}`}>
                  <input
                    type="radio"
                    name="mp-visibility"
                    value="private"
                    checked={!isPublic}
                    onChange={() => setIsPublic(false)}
                  />
                  <span className="mp-visibility-option__icon" aria-hidden="true">🔒</span>
                  <span className="mp-visibility-option__label">Private</span>
                  <span className="mp-visibility-option__hint">Link only</span>
                </label>
                <label className={`mp-visibility-option${isPublic ? " mp-visibility-option--active" : ""}`}>
                  <input
                    type="radio"
                    name="mp-visibility"
                    value="public"
                    checked={isPublic}
                    onChange={() => setIsPublic(true)}
                  />
                  <span className="mp-visibility-option__icon" aria-hidden="true">🌐</span>
                  <span className="mp-visibility-option__label">Public</span>
                  <span className="mp-visibility-option__hint">Listed in lobby browser</span>
                </label>
              </fieldset>
            </div>
            <button
              className="mp-hub-card-btn mp-hub-card-btn--create"
              onClick={handleCreateRoom}
              disabled={loading}
            >
              {loading ? "Creating..." : "Create Room"}
            </button>
          </div>
        </div>

        <div className="mp-hub-cards-row mp-hub-cards-row--bottom">
          {/* Card C (centered below): Quick Play — moved here from the top
              row so the bonus-bearing Browse + Create cards sit together
              above it. */}
          <div className="mp-hub-card mp-hub-card--quickplay">
            <div className="mp-hub-card-icon">
              <img
                src={quickplayIcon}
                alt=""
                width={64}
                height={64}
                draggable={false}
              />
            </div>
            <div className="mp-hub-card-title">Quick Play</div>
            <div className="mp-hub-card-subtitle">
              Drop into a game instantly
            </div>
            <div className="mp-hub-card-control">
              <label htmlFor="mp-quickplay-mode">Game Type</label>
              <select
                id="mp-quickplay-mode"
                className="mp-hub-card-select"
                value={quickPlayMode}
                onChange={(e) =>
                  setQuickPlayMode(e.target.value as GameMode | "random")
                }
                disabled={loading}
                aria-label="Quick play game type"
              >
                <option value="random">Random</option>
                {GAME_MODES.filter(({ mode }) => !disabledModes.has(mode)).map(({ mode, name }) => (
                  <option key={mode} value={mode}>
                    {name}
                  </option>
                ))}
              </select>
            </div>
            <div className="mp-hub-card-control">
              <label htmlFor="mp-quickplay-rounds">Rounds</label>
              <select
                id="mp-quickplay-rounds"
                className="mp-hub-card-select"
                value={quickPlayRounds}
                onChange={(e) => {
                  const v = e.target.value;
                  if (v === "random") {
                    setQuickPlayRounds("random");
                  } else {
                    setQuickPlayRounds(Number(v) as RoundCountOption);
                  }
                }}
                disabled={loading}
                aria-label="Quick play number of rounds"
              >
                <option value="random">Random</option>
                {ROUND_COUNT_OPTIONS.map((n) => (
                  <option key={n} value={n}>
                    {n} rounds
                  </option>
                ))}
              </select>
            </div>
            <button
              className="mp-hub-card-btn mp-hub-card-btn--quickplay"
              onClick={handleQuickPlay}
              disabled={loading}
            >
              {loading ? "Starting..." : "Play Now"}
            </button>
          </div>
        </div>
      </div>

      {/* Server Browser — rendered as a modal overlay. Backdrop click +
          ESC close, focus stays within the modal. */}
      {showLobbyBrowser && (
        <div
          className="mp-hub-browser-overlay"
          role="presentation"
          onClick={() => setShowLobbyBrowser(false)}
        >
          <div
            className="mp-hub-browser-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Browse public games"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              className="mp-hub-browser-close"
              onClick={() => setShowLobbyBrowser(false)}
              aria-label="Close browser"
            >
              ×
            </button>
            <LobbyBrowser
              onJoinRoom={(code, password) => handleLobbyJoin(code, password)}
              disabledModes={disabledModes}
            />
          </div>
        </div>
      )}

      {/* Stats Footer */}
      <div className="mp-hub-footer">
        <span className="mp-hub-footer-item">
          <span className="mp-hub-footer-dot" />
          {lobbyCount ?? "..."} public game{lobbyCount !== 1 ? "s" : ""} active
        </span>
        <span className="mp-hub-footer-sep" />
        <span className="mp-hub-footer-tip">
          Tip: Quick Play drops you straight into a game with bots!
        </span>
      </div>
    </div>
  );
}
