import treasureChestImg from "../../assets/banner/giveaway-treasure-chest.webp";

/**
 * Top-right glass banner promoting the $50 Amazon gift-card giveaway.
 * Mirrors `HeaderBar`'s glass treatment so the broadcast stage reads
 * as a balanced two-block top edge: brand on the left, viewer
 * incentive on the right.
 *
 * Strictly presentational — the giveaway logic itself lives in
 * `GiveawayModal` on the regular site. Broadcast viewers see this as
 * a static call-to-action; the bot doesn't run any modal interaction.
 */
export default function GiveawayBanner() {
  return (
    <aside
      className="broadcast-giveaway"
      data-testid="broadcast-giveaway"
      aria-label="Win a $50 Amazon gift card by playing price.games"
    >
      <img
        src={treasureChestImg}
        alt=""
        className="broadcast-giveaway-icon"
        draggable={false}
      />
      <div className="broadcast-giveaway-text">
        <div className="broadcast-giveaway-tag">WIN A $50 GIFT CARD</div>
        <div className="broadcast-giveaway-cta">
          Play at <span className="broadcast-giveaway-cta-url">price.games</span>
        </div>
      </div>
    </aside>
  );
}
