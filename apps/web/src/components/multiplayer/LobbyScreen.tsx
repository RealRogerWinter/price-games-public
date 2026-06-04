import { useState, useEffect } from "react";
import type { MultiplayerRoom, GameMode, BotDifficulty } from "@price-game/shared";
import { GAME_MODES, MAX_PLAYERS, MIN_ROUNDS, MAX_ROUNDS, BOT_DIFFICULTIES, buildMpShareText, buildMpShareTextNoUrl, ANALYTICS_EVENTS } from "@price-game/shared";
import { useTrackEvent } from "../../analytics/useTrackEvent";
import { getCategories, mintInviteToken } from "../../api/client";
import { getPlayerSession } from "../../api/socket";
import { canShareNative, shareNative, copyTextToClipboard } from "../share/clipboard";
import AvatarIcon from "./AvatarIcon";
import MPTopBar from "./MPTopBar";
import LobbyShareModal from "./LobbyShareModal";
import InviteRewardBadge from "./InviteRewardBadge";
import AutoLobbyCountdown from "./AutoLobbyCountdown";
import LobbyEventToasts from "./LobbyEventToasts";

import classicIcon from "../../assets/modes/classic.webp";
import higherLowerIcon from "../../assets/modes/higher-lower.webp";
import comparisonIcon from "../../assets/modes/comparison.webp";
import underbidIcon from "../../assets/modes/underbid.webp";
import priceMatchIcon from "../../assets/modes/price-match.webp";
import riserIcon from "../../assets/modes/riser.webp";
import oddOneOutIcon from "../../assets/modes/odd-one-out.webp";
import marketBasketIcon from "../../assets/modes/market-basket.webp";
import sortItOutIcon from "../../assets/modes/sort-it-out.webp";
import budgetBuilderIcon from "../../assets/modes/budget-builder.webp";
import chainReactionIcon from "../../assets/modes/chain-reaction.webp";
import biddingIcon from "../../assets/modes/bidding.webp";

/** Maps game mode IDs to their kawaii icon assets. */
const MODE_ICONS: Record<string, string> = {
  classic: classicIcon,
  "higher-lower": higherLowerIcon,
  comparison: comparisonIcon,
  "closest-without-going-over": underbidIcon,
  "price-match": priceMatchIcon,
  riser: riserIcon,
  "odd-one-out": oddOneOutIcon,
  "market-basket": marketBasketIcon,
  "sort-it-out": sortItOutIcon,
  "budget-builder": budgetBuilderIcon,
  "chain-reaction": chainReactionIcon,
  bidding: biddingIcon,
};

interface LobbyScreenProps {
  room: MultiplayerRoom;
  playerId: string;
  onStartRound: () => void;
  onKickPlayer: (playerId: string) => void;
  onChangeSettings: (settings: { gameMode?: GameMode; categories?: string[] | null; totalRounds?: number; password?: string | null; isPublic?: boolean }) => void;
  onConfigureBots: (botCount: number, botDifficulty: BotDifficulty) => void;
  onLeave: () => void;
  loading?: boolean;
  /** Opens the register/auth modal when anon players tap the IdentityCard CTA. */
  onOpenAuth?: () => void;
  /** MP-specific display-name override forwarded to the IdentityCard in the top bar. */
  displayNameOverride?: string | null;
}

export default function LobbyScreen({
  room,
  playerId,
  onStartRound,
  onKickPlayer,
  onChangeSettings,
  onConfigureBots,
  onLeave,
  loading,
  onOpenAuth,
  displayNameOverride,
}: LobbyScreenProps) {
  const [copied, setCopied] = useState(false);
  const [shareToast, setShareToast] = useState<string | null>(null);
  const trackEvent = useTrackEvent();
  const [showCategories, setShowCategories] = useState(false);
  const [availableCategories, setAvailableCategories] = useState<string[]>([]);
  const [categoryError, setCategoryError] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [passwordInput, setPasswordInput] = useState("");
  const [showShareModal, setShowShareModal] = useState(false);

  const [disabledModes, setDisabledModes] = useState<Set<string>>(new Set());

  useEffect(() => {
    getCategories()
      .then((data) => setAvailableCategories(data.categories.map((c) => c.name)))
      .catch(() => setCategoryError(true));
    fetch("/api/settings/game-modes")
      .then((res) => res.ok ? res.json() : null)
      .then((data) => { if (data?.disabledModes) setDisabledModes(new Set(data.disabledModes)); })
      .catch(() => {});
  }, []);

  const LOBBY_MODE_ORDER = [
    "higher-lower", "bidding", "comparison", "classic", "riser", "price-match",
    "chain-reaction", "market-basket", "sort-it-out", "budget-builder",
    "closest-without-going-over", "odd-one-out",
  ];
  const enabledModes = (disabledModes.size
    ? GAME_MODES.filter(({ mode }) => !disabledModes.has(mode))
    : GAME_MODES
  ).sort((a, b) => {
    const ai = LOBBY_MODE_ORDER.indexOf(a.mode);
    const bi = LOBBY_MODE_ORDER.indexOf(b.mode);
    return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
  });
  const isHost = room.hostPlayerId === playerId;
  const isBetweenRounds = room.status === "between_rounds";
  const humanCount = room.players.filter((p) => !p.isBot).length;
  const botCount = room.players.filter((p) => p.isBot).length;
  const connectedCount = room.players.filter((p) => p.isConnected).length;
  // Allow starting with at least 2 connected players (humans + bots count)
  const canStart = connectedCount >= 2;
  const maxBots = MAX_PLAYERS - humanCount;

  // Plain (unattributed) room URL — used as a fallback if the invite-token
  // mint fails or for non-host viewers.
  const plainRoomUrl =
    typeof window !== "undefined" && window.location?.origin
      ? `${window.location.origin}/${room.code}`
      : `/${room.code}`;

  // Mint an invite token once per lobby for the host. Every share
  // affordance below (Copy / native Share / share modal) uses the
  // resulting `/r/<token>` URL so any link the host hands out earns the
  // +25% buff after the joiner completes a round. Falls back silently
  // to plainRoomUrl on mint failure — joiners still join, the host just
  // doesn't earn a buff for that share.
  const [hostInviteUrl, setHostInviteUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!isHost || !room.code || hostInviteUrl) return;
    const session = getPlayerSession();
    if (!session?.playerToken) return;
    let cancelled = false;
    mintInviteToken(room.code, session.playerToken)
      .then((res) => {
        if (!cancelled) setHostInviteUrl(res.url);
      })
      .catch(() => {
        // Non-fatal: keep plainRoomUrl as the share target. The mint
        // can also fail when the player isn't the room host (race
        // during host transfer); in that case the fallback is correct.
      });
    return () => {
      cancelled = true;
    };
  }, [isHost, room.code, hostInviteUrl]);

  const shareUrl = hostInviteUrl ?? plainRoomUrl;
  const shareText = buildMpShareText(room.code, shareUrl);

  /**
   * Copy the room URL to the clipboard. Shows a "Copied!" pill on the
   * Copy button for 2s. Falls back silently if the Clipboard API is
   * blocked (e.g. cross-origin iframe) — the URL is still visible
   * onscreen so users can long-press / select-and-copy manually.
   */
  function copyLink() {
    copyTextToClipboard(shareUrl)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
        // Fire-and-forget analytics; only on confirmed copy success so the
        // event reflects an actual outbound link, not a click-then-failure.
        trackEvent({
          name: ANALYTICS_EVENTS.SHARE_CLICKED,
          category: "mp",
          properties: {
            room_code: room.code,
            game_mode: room.gameMode,
            role: isHost ? "host" : "player",
            method: "copy",
            has_invite_token: !!hostInviteUrl,
          },
        });
      })
      .catch(() => {
        // Surface failure as a one-shot toast; URL stays selectable below.
        setShareToast("Couldn't copy — long-press the link to copy manually.");
        setTimeout(() => setShareToast(null), 3000);
      });
  }

  /**
   * Trigger the native Web Share sheet (mobile) so users can fan out the
   * invite to SMS / Discord / etc. with one tap. Desktop browsers without
   * Web Share fall back to clipboard copy with a toast confirmation, so
   * the button always does *something* useful regardless of platform.
   */
  function fallbackCopyShare() {
    copyTextToClipboard(shareText)
      .then(() => {
        setShareToast("Link copied!");
        setTimeout(() => setShareToast(null), 2000);
        trackEvent({
          name: ANALYTICS_EVENTS.SHARE_CLICKED,
          category: "mp",
          properties: {
            room_code: room.code,
            game_mode: room.gameMode,
            role: isHost ? "host" : "player",
            method: "fallback_copy",
            has_invite_token: !!hostInviteUrl,
          },
        });
      })
      .catch(() => {
        setShareToast("Couldn't copy — long-press the link to copy manually.");
        setTimeout(() => setShareToast(null), 3000);
      });
  }

  function handleShare() {
    if (canShareNative()) {
      shareNative({
        title: "Price Games multiplayer room",
        // URL travels in `url`, not in `text`, so receivers don't see the
        // link twice (iMessage / Discord concatenate both fields).
        text: buildMpShareTextNoUrl(room.code),
        url: shareUrl,
      })
        .then(() => {
          // The native share sheet resolves on user-confirmed share AND on
          // dismissal in some browsers — best-effort attribution.
          trackEvent({
            name: ANALYTICS_EVENTS.SHARE_CLICKED,
            category: "mp",
            properties: {
              room_code: room.code,
              game_mode: room.gameMode,
              role: isHost ? "host" : "player",
              method: "native_share",
              has_invite_token: !!hostInviteUrl,
            },
          });
        })
        .catch(() => {
          // Native sheet failed (non-abort) — degrade to clipboard copy.
          fallbackCopyShare();
        });
      return;
    }
    fallbackCopyShare();
  }

  function toggleCategory(cat: string) {
    const current = room.categories || [];
    const isSelected = current.includes(cat);
    let next: string[];
    if (isSelected) {
      next = current.filter((c) => c !== cat);
    } else {
      next = [...current, cat];
    }
    onChangeSettings({ categories: next.length > 0 ? next : null });
  }

  function selectAllCategories() {
    onChangeSettings({ categories: null });
  }

  function handleSetPassword() {
    const pw = passwordInput.trim();
    onChangeSettings({ password: pw || null });
    setShowPassword(false);
    setPasswordInput("");
  }

  function handleRemovePassword() {
    onChangeSettings({ password: null });
    setShowPassword(false);
    setPasswordInput("");
  }

  const categoryLabel = room.categories
    ? room.categories.length === 1
      ? room.categories[0]
      : `${room.categories.length} categories`
    : "All";

  return (
    <div className="lobby-screen">
      <MPTopBar onLeave={onLeave} onOpenAuth={onOpenAuth} displayNameOverride={displayNameOverride} />

      <LobbyEventToasts players={room.players} selfPlayerId={playerId} />

      <AutoLobbyCountdown
        targetAt={room.countdownTargetAt}
        humanCount={room.players.filter((p) => !p.isBot).length}
      />

      <div className="lobby-content">
        <div className="lobby-code-section">
          <p className="lobby-label">Room Code</p>
          <div className="lobby-code">{room.code}</div>

          {/* Prominent share block: full URL + Copy + Share buttons. */}
          <div className="lobby-share-block">
            <p className="lobby-share-caption">Send your friends this link:</p>
            <code
              className="lobby-share-url"
              aria-label="Invite URL"
              title="Tap to select the invite URL"
            >
              {shareUrl}
            </code>
            <div className="lobby-share-actions">
              <button
                className="btn btn-secondary lobby-share-btn"
                onClick={copyLink}
                aria-label="Copy invite link"
              >
                {copied ? (
                  <>
                    <svg className="lobby-share-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                      <path d="M3.5 8.5l3 3 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                    Copied!
                  </>
                ) : (
                  <>
                    <svg className="lobby-share-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                      <rect x="4" y="4" width="9" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
                      <path d="M3 12V3.5A1.5 1.5 0 014.5 2H10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                    </svg>
                    Copy
                  </>
                )}
              </button>
              <button
                className="btn btn-primary lobby-share-btn"
                onClick={handleShare}
                aria-label="Share invite link"
              >
                <svg className="lobby-share-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <circle cx="4" cy="8" r="2" stroke="currentColor" strokeWidth="1.5" />
                  <circle cx="12" cy="3.5" r="2" stroke="currentColor" strokeWidth="1.5" />
                  <circle cx="12" cy="12.5" r="2" stroke="currentColor" strokeWidth="1.5" />
                  <path d="M5.7 7l4.6-2.5M5.7 9l4.6 2.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
                Share
              </button>
            </div>
            {shareToast && (
              <p className="lobby-share-toast" role="status" aria-live="polite">
                {shareToast}
              </p>
            )}
          </div>

          {room.hasPassword && (
            <span className="lobby-password-badge">Password Protected</span>
          )}

          {/* Host-only: full share modal w/ QR + token-attributed URL. The
              legacy copy/share row above is kept for V1 because it works
              without a network round-trip and is visible to ALL players —
              every player can copy the plain room link. The QR/modal CTA
              is host-only because mint-token authorizes via host playerToken. */}
          {isHost && (
            <button
              type="button"
              className="btn btn-secondary lobby-share-btn"
              style={{ marginTop: 8 }}
              onClick={() => setShowShareModal(true)}
            >
              <svg className="lobby-share-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <rect x="2" y="2" width="5" height="5" stroke="currentColor" strokeWidth="1.5" />
                <rect x="9" y="2" width="5" height="5" stroke="currentColor" strokeWidth="1.5" />
                <rect x="2" y="9" width="5" height="5" stroke="currentColor" strokeWidth="1.5" />
                <rect x="10" y="10" width="2" height="2" fill="currentColor" />
                <rect x="13" y="10" width="1" height="2" fill="currentColor" />
                <rect x="10" y="13" width="2" height="1" fill="currentColor" />
                <rect x="13" y="13" width="1" height="1" fill="currentColor" />
              </svg>
              Show QR code
            </button>
          )}
          <div style={{ marginTop: 10 }}>
            <InviteRewardBadge />
          </div>
        </div>

        {isBetweenRounds && (
          <div className="lobby-standings">
            <h3>Standings after Round {room.currentRound}</h3>
            <div className="lobby-standings-list">
              {[...room.players]
                .sort((a, b) => b.totalScore - a.totalScore)
                .map((p, idx) => (
                  <div key={p.id} className="lobby-standing-row">
                    <span className="lobby-standing-rank">#{idx + 1}</span>
                    <AvatarIcon avatar={p.avatar} size={40} />
                    <span className="lobby-standing-name">{p.displayName}</span>
                    <span className="lobby-standing-score">{p.totalScore.toLocaleString()}</span>
                  </div>
                ))}
            </div>
          </div>
        )}

        {isHost ? (
          <div className="lobby-settings">
            {/* --- Game Mode Tiles --- */}
            <div className="lobby-setting-card">
              <h3 className="lobby-setting-card-title">Game Mode</h3>
              <div className="lobby-mode-tiles">
                {enabledModes.map((gm) => {
                  const icon = MODE_ICONS[gm.mode];
                  return (
                    <button
                      key={gm.mode}
                      className={`lobby-mode-tile mode-${gm.mode} ${room.gameMode === gm.mode ? "selected" : ""}`}
                      onClick={() => onChangeSettings({ gameMode: gm.mode })}
                      title={gm.description}
                    >
                      <span className="lobby-mode-tile-icon">
                        <img className="lobby-mode-tile-img" src={icon} alt="" draggable={false} />
                      </span>
                      <span className="lobby-mode-tile-name">{gm.name}</span>
                      <span className="lobby-mode-tile-desc">{gm.description}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* --- Rounds pills --- */}
            <div className="lobby-setting-card">
              <h3 className="lobby-setting-card-title">Rounds</h3>
              <div className="lobby-rounds-pills">
                {[3, 5, 10, 15, 20].map((n) => (
                  <button
                    key={n}
                    className={`lobby-round-pill ${room.totalRounds === n ? "selected" : ""}`}
                    onClick={() => onChangeSettings({ totalRounds: n })}
                  >
                    {n}
                  </button>
                ))}
              </div>
            </div>

            {/* --- Categories --- */}
            <div className="lobby-setting-card">
              <h3 className="lobby-setting-card-title">
                Categories
                <span className="lobby-setting-badge">{categoryLabel}</span>
              </h3>
              <button
                className="btn btn-secondary lobby-setting-toggle"
                onClick={() => setShowCategories(!showCategories)}
              >
                {showCategories ? "Hide" : "Change Categories"}
              </button>
              {showCategories && (
                <div className="lobby-categories-grid">
                  {categoryError ? (
                    <p className="lobby-category-error">Failed to load categories.</p>
                  ) : (
                    <>
                      <label className="lobby-category-checkbox">
                        <input
                          type="checkbox"
                          checked={!room.categories}
                          onChange={selectAllCategories}
                        />
                        <span>All Categories</span>
                      </label>
                      {availableCategories.map((cat) => (
                        <label key={cat} className="lobby-category-checkbox">
                          <input
                            type="checkbox"
                            checked={!room.categories || room.categories.includes(cat)}
                            onChange={() => toggleCategory(cat)}
                          />
                          <span>{cat}</span>
                        </label>
                      ))}
                    </>
                  )}
                </div>
              )}
            </div>

            {/* --- Password --- */}
            <div className="lobby-setting-card">
              <h3 className="lobby-setting-card-title">
                Password
                <span className="lobby-setting-badge">{room.hasPassword ? "Set" : "None"}</span>
              </h3>
              {!showPassword ? (
                <button
                  className="btn btn-secondary lobby-setting-toggle"
                  onClick={() => setShowPassword(true)}
                >
                  {room.hasPassword ? "Change Password" : "Set Password"}
                </button>
              ) : (
                <div className="lobby-password-form">
                  <input
                    type="text"
                    className="lobby-password-input"
                    placeholder="Enter room password..."
                    value={passwordInput}
                    onChange={(e) => setPasswordInput(e.target.value)}
                    maxLength={32}
                  />
                  <button className="btn btn-primary lobby-password-set" onClick={handleSetPassword}>
                    Set
                  </button>
                  {room.hasPassword && (
                    <button className="btn btn-secondary lobby-password-remove" onClick={handleRemovePassword}>
                      Remove
                    </button>
                  )}
                  <button className="btn btn-secondary" onClick={() => { setShowPassword(false); setPasswordInput(""); }} style={{ padding: "6px 12px", fontSize: "0.8rem" }}>
                    Cancel
                  </button>
                </div>
              )}
            </div>

            {/* --- Bots (above player list to avoid layout shift) --- */}
            <div className="lobby-setting-card">
              <h3 className="lobby-setting-card-title">
                Bots
                <span className="lobby-setting-badge">{botCount > 0 ? `${botCount} (${room.botDifficulty})` : "None"}</span>
              </h3>
              <div className="lobby-bot-controls">
                <div className="lobby-bot-count">
                  <button
                    className="btn btn-secondary lobby-bot-stepper"
                    onClick={() => onConfigureBots(Math.max(0, botCount - 1), room.botDifficulty)}
                    disabled={botCount <= 0}
                  >
                    -
                  </button>
                  <span className="lobby-bot-count-value">{botCount}</span>
                  <button
                    className="btn btn-secondary lobby-bot-stepper"
                    onClick={() => onConfigureBots(Math.min(maxBots, botCount + 1), room.botDifficulty)}
                    disabled={botCount >= maxBots}
                  >
                    +
                  </button>
                </div>
                <div className="lobby-difficulty-btns">
                  {BOT_DIFFICULTIES.map((diff) => (
                    <button
                      key={diff}
                      className={`lobby-difficulty-btn ${room.botDifficulty === diff ? "selected" : ""}`}
                      onClick={() => onConfigureBots(botCount, diff)}
                    >
                      {diff.charAt(0).toUpperCase() + diff.slice(1)}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* --- Visibility --- */}
            <div className="lobby-setting-card">
              <label className="lobby-public-toggle">
                <input
                  type="checkbox"
                  checked={room.isPublic}
                  onChange={(e) => onChangeSettings({ isPublic: e.target.checked })}
                />
                <span>Public lobby (visible in lobby browser)</span>
              </label>
            </div>
          </div>
        ) : (
          (() => {
            const modeMeta = GAME_MODES.find((m) => m.mode === room.gameMode);
            const modeIcon = MODE_ICONS[room.gameMode];
            return (
              <div className="lobby-player-settings">
                <div className="lobby-mode-card">
                  {modeIcon && (
                    <img
                      className="lobby-mode-card__icon"
                      src={modeIcon}
                      alt=""
                      aria-hidden="true"
                    />
                  )}
                  <div className="lobby-mode-card__body">
                    <p className="lobby-mode-card__eyebrow">Game mode</p>
                    <h3 className="lobby-mode-card__title">{modeMeta?.name ?? room.gameMode}</h3>
                    {modeMeta?.description && (
                      <p className="lobby-mode-card__desc">{modeMeta.description}</p>
                    )}
                  </div>
                </div>
                <div className="lobby-meta-pills">
                  <span className="lobby-meta-pill">
                    <span className="lobby-meta-pill__label">Rounds</span>
                    <span className="lobby-meta-pill__value">{room.totalRounds}</span>
                  </span>
                  <span className="lobby-meta-pill">
                    <span className="lobby-meta-pill__label">Categories</span>
                    <span className="lobby-meta-pill__value">{categoryLabel}</span>
                  </span>
                  {room.hasPassword && (
                    <span className="lobby-meta-pill lobby-meta-pill--locked">
                      <span className="lobby-meta-pill__label">🔒</span>
                      <span className="lobby-meta-pill__value">Password</span>
                    </span>
                  )}
                </div>
              </div>
            );
          })()
        )}

        {/* Player list with fixed height to prevent layout shift from bots */}
        <div className="lobby-players-section">
          <h3>Players ({room.players.length}/{MAX_PLAYERS})</h3>
          <div className="lobby-players-list lobby-players-list-fixed">
            {room.players.map((p) => (
              <div
                key={p.id}
                className={`lobby-player ${!p.isConnected ? "disconnected" : ""}`}
              >
                <AvatarIcon avatar={p.avatar} size={52} />
                <span className="lobby-player-name">
                  {p.displayName}
                  {p.id === playerId && <span className="lobby-you"> (you)</span>}
                </span>
                {p.isBot && <span className="lobby-bot-badge">{"\uD83E\uDD16"}</span>}
                {p.isHost && <span className="lobby-host-badge">HOST</span>}
                {!p.isConnected && !p.isBot && <span className="lobby-disconnected-badge">offline</span>}
                {isHost && p.id !== playerId && (
                  <button
                    className="lobby-kick-btn"
                    onClick={() => onKickPlayer(p.id)}
                    title="Kick player"
                  >
                    &times;
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>

        <div className="lobby-actions">
          {isHost ? (
            <button
              className="btn btn-primary lobby-start-btn"
              onClick={onStartRound}
              disabled={!canStart || loading}
            >
              {loading ? "Starting..." : "Start Game"}
            </button>
          ) : (
            <p className="lobby-waiting">Waiting for host to start...</p>
          )}
          {isHost && !canStart && (
            <p className="lobby-hint">Need at least 2 players to start (add bots or invite friends)</p>
          )}
        </div>
      </div>
      <LobbyShareModal
        open={showShareModal}
        onClose={() => setShowShareModal(false)}
        roomCode={room.code}
        gameMode={room.gameMode}
        isHost={isHost}
      />
    </div>
  );
}
