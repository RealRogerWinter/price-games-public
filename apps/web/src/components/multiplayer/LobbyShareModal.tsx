/**
 * LobbyShareModal — bottom-sheet modal that replaces the lobby's plain
 * "Copy Invite Link" button with a richer share sheet:
 *   - Native share (mobile, when supported)
 *   - Copy Link (always)
 *   - QR code (Jackbox-style for couch co-op)
 *   - Copy room code only (for friends in voice calls)
 *
 * Mints an invite token via POST /api/mp/rooms/:code/invite-token on first
 * open so the URL carries an inviter attribution token. If the mint fails,
 * falls back to a plain /{roomCode} URL — joiners still join, just without
 * the host earning a reward.
 */

import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { ANALYTICS_EVENTS, type GameMode } from "@price-game/shared";
import { mintInviteToken } from "../../api/client";
import { getPlayerSession } from "../../api/socket";
import { useTrackEvent } from "../../analytics/useTrackEvent";
import "../../styles/multiplayer.css";

export interface LobbyShareModalProps {
  open: boolean;
  onClose: () => void;
  roomCode: string;
  /** Optional. If omitted, the modal reads the token from `getPlayerSession()`. */
  playerToken?: string;
  /**
   * Game mode of the room being shared. Forwarded into `share_clicked`
   * event properties so analytics can break down share-link conversion
   * by mode. Optional so the modal stays usable from contexts that
   * don't know the mode (legacy callers); the event still emits with
   * `game_mode: undefined` in that case.
   */
  gameMode?: GameMode;
  /**
   * Whether the local player is the room host (vs a non-host player).
   * Drives the `role` field on the emitted `share_clicked` event so
   * analytics can answer "who's actually sending out invites — hosts
   * or players?". Defaults to false (player) when omitted.
   */
  isHost?: boolean;
}

const SHARE_TEXT = "Join my Price Games room — guess real product prices and beat me!";

export default function LobbyShareModal({
  open,
  onClose,
  roomCode,
  playerToken,
  gameMode,
  isHost = false,
}: LobbyShareModalProps) {
  const [mintedUrl, setMintedUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState<"link" | "code" | null>(null);
  const qrCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);
  const trackEvent = useTrackEvent();

  // Mint the invite token once on open. The fallback URL is the plain code.
  useEffect(() => {
    if (!open) return;
    const effectiveToken = playerToken ?? getPlayerSession()?.playerToken;
    if (!effectiveToken) {
      // No token available — caller will see the plain /<roomCode> fallback.
      setMintedUrl(null);
      return;
    }
    let cancelled = false;
    mintInviteToken(roomCode, effectiveToken)
      .then((res) => {
        if (cancelled) return;
        setMintedUrl(res.url);
      })
      .catch(() => {
        // Silent — caller can still copy the plain code link.
        if (cancelled) return;
        setMintedUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [open, roomCode, playerToken]);

  // Compute the URL we'll actually share. Prefer the minted (attributed)
  // URL; fall back to a plain /{roomCode} link for graceful degradation.
  const shareUrl =
    mintedUrl ??
    (typeof window !== "undefined" ? `${window.location.origin}/${roomCode}` : `/${roomCode}`);

  // Focus management: ESC to close, focus trap is enough as ESC + backdrop.
  useEffect(() => {
    if (!open) return;
    previouslyFocused.current = document.activeElement as HTMLElement | null;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      previouslyFocused.current?.focus?.();
    };
  }, [open, onClose]);

  // Render the QR code into the canvas whenever the share URL changes.
  useEffect(() => {
    if (!open) return;
    const canvas = qrCanvasRef.current;
    if (!canvas) return;
    QRCode.toCanvas(canvas, shareUrl, {
      width: 200,
      margin: 1,
      color: {
        dark: "#1a1a2e",
        light: "#ffffff",
      },
    }).catch(() => {
      // Non-critical — the modal still has Copy Link + native share.
    });
  }, [open, shareUrl]);

  if (!open) return null;

  function emitShareClicked(method: "modal_copy" | "modal_copy_code" | "modal_native_share") {
    trackEvent({
      name: ANALYTICS_EVENTS.SHARE_CLICKED,
      category: "mp",
      properties: {
        room_code: roomCode,
        game_mode: gameMode ?? null,
        role: isHost ? "host" : "player",
        method,
        has_invite_token: !!mintedUrl,
      },
    });
  }

  async function handleCopyLink() {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied("link");
      window.setTimeout(() => setCopied(null), 2000);
      emitShareClicked("modal_copy");
    } catch {
      /* noop */
    }
  }

  async function handleCopyCode() {
    try {
      await navigator.clipboard.writeText(roomCode);
      setCopied("code");
      window.setTimeout(() => setCopied(null), 2000);
      emitShareClicked("modal_copy_code");
    } catch {
      /* noop */
    }
  }

  async function handleNativeShare() {
    if (typeof navigator.share !== "function") return;
    try {
      await navigator.share({
        title: "Price Games — multiplayer",
        text: SHARE_TEXT,
        url: shareUrl,
      });
      // navigator.share resolves on confirmed-share AND on dismissal in some
      // browsers. Best-effort attribution; the over-count is bounded by the
      // dismissal rate and v2 dashboards can dimension on `method` to
      // segregate it from the more reliable copy-button signal.
      emitShareClicked("modal_native_share");
    } catch {
      // User cancelled or browser blocked; nothing to do.
    }
  }

  const canShare = typeof navigator !== "undefined" && typeof navigator.share === "function";

  return (
    <div className="lsm-overlay" onClick={onClose} role="presentation">
      <div
        className="lsm-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="lsm-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="lsm-title" className="lsm-title">Invite friends</h2>

        <div className="lsm-code-block">
          <span className="lsm-code-label">Room code</span>
          <span className="lsm-code">{roomCode}</span>
        </div>

        <div className="lsm-actions">
          {canShare && (
            <button type="button" className="lsm-btn lsm-btn-primary" onClick={handleNativeShare}>
              Share…
            </button>
          )}
          <button type="button" className="lsm-btn lsm-btn-secondary" onClick={handleCopyLink}>
            {copied === "link" ? "Copied!" : "Copy Link"}
          </button>
        </div>

        <div className="lsm-qr-section">
          <p className="lsm-qr-label">Scan with a phone camera</p>
          <div className="lsm-qr-frame" data-testid="lobby-share-qr">
            <canvas ref={qrCanvasRef} />
          </div>
        </div>

        <button type="button" className="lsm-btn-link" onClick={handleCopyCode}>
          {copied === "code" ? "Copied!" : "Copy room code only"}
        </button>

        <button type="button" className="lsm-close" onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>
    </div>
  );
}
