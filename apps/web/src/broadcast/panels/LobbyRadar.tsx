import type { LobbyCountdown } from "../state/overlayBus";

interface LobbyRadarProps {
  countdown: LobbyCountdown | null;
}

/**
 * Center-stage overlay shown while the bot is hosting a public room
 * waiting for opponents. Replaces the worst current dead-air gap
 * (90s lobby waits) with intentional content: a slow radar sweep,
 * the room code, opponents-found count, and the remaining countdown.
 *
 * Trigger: `mp.lobby_countdown` events fired by the bot's
 * `executeHostPublic` every ~10 seconds.
 *
 * @param props.countdown Latest countdown event, or null.
 */
export default function LobbyRadar({ countdown }: LobbyRadarProps) {
  if (!countdown) return null;

  const opponents = Math.max(0, countdown.playerCount - 1);
  const opponentLabel = opponents === 0
    ? "Looking for opponents…"
    : opponents === 1
    ? "1 opponent — others welcome"
    : `${opponents} opponents`;

  return (
    <section
      className="broadcast-lobby-radar"
      data-testid="broadcast-lobby-radar"
      aria-label="Lobby status"
    >
      <div className="broadcast-lobby-radar-rings" aria-hidden="true">
        <span className="broadcast-lobby-radar-ring ring-0" />
        <span className="broadcast-lobby-radar-ring ring-1" />
        <span className="broadcast-lobby-radar-ring ring-2" />
        <span className="broadcast-lobby-radar-pulse" />
      </div>
      <div className="broadcast-lobby-radar-info">
        <div className="broadcast-lobby-radar-status">{opponentLabel}</div>
        <div className="broadcast-lobby-radar-meta">
          {countdown.roomCode && (
            <span className="broadcast-lobby-radar-code">
              <span className="broadcast-lobby-radar-code-label">Room</span>
              <span className="broadcast-lobby-radar-code-value">{countdown.roomCode}</span>
            </span>
          )}
          <span className="broadcast-lobby-radar-countdown">
            Starting in <strong>{countdown.remainingSec}s</strong>
          </span>
        </div>
      </div>
    </section>
  );
}
