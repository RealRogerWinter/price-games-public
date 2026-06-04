import type { MultiplayerPlayer } from "@price-game/shared";
import AvatarIcon from "./AvatarIcon";

interface PlayerStatusBarProps {
  players: MultiplayerPlayer[];
  lockedPlayerIds: Set<string>;
  currentPlayerId: string;
}

export default function PlayerStatusBar({
  players,
  lockedPlayerIds,
  currentPlayerId,
}: PlayerStatusBarProps) {
  return (
    <div className="player-status-bar">
      {players.map((p) => (
        <div
          key={p.id}
          className={`player-status-item ${
            lockedPlayerIds.has(p.id) ? "locked" : ""
          } ${!p.isConnected ? "offline" : ""} ${
            p.id === currentPlayerId ? "is-you" : ""
          }`}
        >
          <div className="player-status-avatar">
            <AvatarIcon avatar={p.avatar} size={40} dimmed={!p.isConnected} />
            {lockedPlayerIds.has(p.id) && (
              <span className="player-status-check">{"\u2713"}</span>
            )}
          </div>
          <span className="player-status-name">
            {p.isBot && <span className="player-status-bot">{"\uD83E\uDD16"}</span>}
            {p.displayName}
          </span>
          <span className="player-status-score">{p.totalScore.toLocaleString()}</span>
        </div>
      ))}
    </div>
  );
}
