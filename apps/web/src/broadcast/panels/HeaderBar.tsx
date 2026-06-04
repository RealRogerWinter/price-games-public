// Transparent-bg variant rather than logo.webp — that one has the
// navy starfield baked in, which clashes with the broadcast panel's
// dark glass and reads as a flat rectangle on stream.
import logoImg from "../../assets/logo-transparent.png";

/**
 * Top-left brand block for the broadcast stage. Renders only the
 * site logo, the "24/7 BOT STREAM" tag, and the "Play at https://
 * price.games" call-to-action. No horizontal bar across the screen
 * and no lifecycle-phase chip — viewers don't need either, and a
 * bar steals vertical space from the centred game canvas.
 */
export default function HeaderBar() {
  return (
    <header
      className="broadcast-header"
      data-testid="broadcast-header"
      role="banner"
    >
      <img
        src={logoImg}
        alt="price.games"
        className="broadcast-header-logo-img"
        draggable={false}
      />
      <div className="broadcast-header-tag">24/7 BOT STREAM</div>
      <div className="broadcast-header-cta">
        Play at <span className="broadcast-header-cta-url">https://price.games</span>
      </div>
    </header>
  );
}
