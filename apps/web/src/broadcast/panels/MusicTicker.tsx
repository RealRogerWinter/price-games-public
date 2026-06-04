import type { MusicNowPlaying } from "../state/overlayBus";

interface MusicTickerProps {
  music: MusicNowPlaying | null;
}

/**
 * Bottom strip showing the currently-playing royalty-free background
 * track. Renders an idle placeholder when no track info has arrived yet
 * (early bot-streamer container start, or music daemon not running).
 */
export default function MusicTicker({ music }: MusicTickerProps) {
  return (
    <div className="broadcast-music-ticker" data-testid="broadcast-music-ticker">
      <span className="broadcast-music-icon" aria-hidden="true">♪</span>
      {music ? (
        <span className="broadcast-music-now" data-testid="music-now">
          <strong>{music.title}</strong>
          {music.artist && <span className="broadcast-music-artist"> — {music.artist}</span>}
          {music.album && <span className="broadcast-music-album"> · {music.album}</span>}
        </span>
      ) : (
        <span className="broadcast-music-idle">Music will start when the streamer is up.</span>
      )}
    </div>
  );
}
