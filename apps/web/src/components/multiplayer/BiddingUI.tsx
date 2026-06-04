import { useState, useEffect, useRef } from "react";
import type {
  RoundStartPayload,
  MultiplayerPlayer,
  BiddingTurnPayload,
  BidPlacedPayload,
} from "@price-game/shared";
import PriceInput from "../PriceInput";
import ProductTooltip from "../ProductTooltip";
import AvatarIcon from "./AvatarIcon";
import ImageModal from "../ImageModal";
import { useCurrency } from "../../context/CurrencyContext";
import { useSound } from "../../audio/SoundContext";

interface BiddingUIProps {
  roundData: RoundStartPayload;
  biddingTurn: BiddingTurnPayload | null;
  placedBids: BidPlacedPayload[];
  currentPlayerId: string;
  players: MultiplayerPlayer[];
  onSubmitBid: (bidCents: number) => void;
  hasGuessed: boolean;
}

type BiddingPhase = "shuffle" | "active" | "done";

/**
 * Bidding UI with a central spotlight card for the active bidder.
 * When a player's turn comes up, their card enlarges to center stage.
 * After they bid, the amount animates in, then the card docks back to
 * the chip row, and the next bidder takes center stage.
 */
export default function BiddingUI({
  roundData,
  biddingTurn,
  placedBids,
  currentPlayerId,
  players,
  onSubmitBid,
  hasGuessed,
}: BiddingUIProps) {
  const { formatPrice } = useCurrency();
  const { play } = useSound();
  const [phase, setPhase] = useState<BiddingPhase>("shuffle");
  const [spotlightState, setSpotlightState] = useState<"active" | "revealing" | "docking">("active");
  const [spotlightBid, setSpotlightBid] = useState<BidPlacedPayload | null>(null);
  const [zoomedImage, setZoomedImage] = useState(false);
  const prevBidCountRef = useRef(0);

  const biddingOrder = roundData.biddingOrder ?? [];
  const product = roundData.product;

  // Shuffle → active after 3s
  useEffect(() => {
    setPhase("shuffle");
    setSpotlightState("active");
    setSpotlightBid(null);
    prevBidCountRef.current = 0;
    play("bidding_shuffle");
    const timer = setTimeout(() => setPhase("active"), 3000);
    return () => clearTimeout(timer);
  }, [roundData.roundNumber, play]);

  // When a new bid arrives, trigger the spotlight reveal → dock animation
  useEffect(() => {
    if (placedBids.length > prevBidCountRef.current) {
      const latest = placedBids[placedBids.length - 1];
      setSpotlightBid(latest);
      setSpotlightState("revealing");

      const dockTimer = setTimeout(() => {
        setSpotlightState("docking");
        play("bid_dock");
      }, 1500);

      const resetTimer = setTimeout(() => {
        setSpotlightBid(null);
        setSpotlightState("active");
      }, 2300);

      prevBidCountRef.current = placedBids.length;
      return () => {
        clearTimeout(dockTimer);
        clearTimeout(resetTimer);
      };
    }
  }, [placedBids, play]);

  // Determine if all bids are in
  useEffect(() => {
    if (phase === "shuffle") return;
    if (!biddingTurn && placedBids.length > 0 && spotlightState === "active") {
      setPhase("done");
    }
  }, [biddingTurn, placedBids, phase, spotlightState]);

  if (!product) return null;

  const isMyTurn = biddingTurn?.currentPlayerId === currentPlayerId && !hasGuessed;

  // Determine who's in the spotlight: either the bidder we're revealing, or the current turn player
  const spotlightPlayerId = spotlightBid?.playerId ?? biddingTurn?.currentPlayerId ?? null;
  const spotlightPlayer = spotlightPlayerId
    ? (biddingOrder.find((p) => p.playerId === spotlightPlayerId) ??
       players.find((p) => p.id === spotlightPlayerId))
    : null;

  // Shuffle screen
  if (phase === "shuffle") {
    return (
      <div className="bid-compact" data-testid="game-page-bidding" data-mode="bidding" data-phase="shuffle">
        <div className="bid-shuffle-screen">
          <h2 className="bid-shuffle-heading">Bidding Order</h2>
          <div className="bid-shuffle-list" data-testid="bid-shuffle-list">
            {biddingOrder.map((entry, idx) => (
              <div
                key={entry.playerId}
                className={`bid-shuffle-item ${entry.playerId === currentPlayerId ? "is-you" : ""}`}
                style={{ animationDelay: `${idx * 0.15}s` }}
                data-testid="bid-shuffle-item"
                data-player-id={entry.playerId}
                data-rank={idx + 1}
              >
                <span className="bid-shuffle-rank">#{idx + 1}</span>
                <AvatarIcon avatar={entry.avatar as any} size={40} />
                <span className="bid-shuffle-name">{entry.displayName}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className="bid-compact"
      data-testid="game-page-bidding"
      data-mode="bidding"
      data-phase={phase}
      data-my-turn={isMyTurn ? "true" : "false"}
    >
      {/* Product — compact inline with zoomable image */}
      <div className="bid-product-row">
        {product.imageUrl && (
          <img
            className="bid-product-img"
            src={product.imageUrl}
            alt={product.title}
            draggable={false}
            style={{ cursor: "zoom-in" }}
            onClick={() => setZoomedImage(true)}
          />
        )}
        <div className="bid-product-info">
          <ProductTooltip product={product} showAmazonLink={false}><span className="bid-product-title product-name-hoverable">{product.title}</span></ProductTooltip>
          <span className="bid-product-cat">{product.category}</span>
        </div>
      </div>

      {zoomedImage && product.imageUrl && (
        <ImageModal src={product.imageUrl} alt={product.title} onClose={() => setZoomedImage(false)} />
      )}

      {/* Spotlight card — the current or just-revealed bidder */}
      {phase === "active" && spotlightPlayer && (
        <div className={`bid-spotlight bid-spotlight--${spotlightState} ${isMyTurn && spotlightState === "active" ? "bid-spotlight--you" : ""}`}>
          <div className="bid-spotlight-card">
            <div className="bid-spotlight-avatar">
              <AvatarIcon
                avatar={("avatar" in spotlightPlayer ? (spotlightPlayer as any).avatar : "wizard") as any}
                size={96}
              />
            </div>
            <div className="bid-spotlight-name">
              {"displayName" in spotlightPlayer
                ? (spotlightPlayer as any).displayName
                : (spotlightPlayer as MultiplayerPlayer).displayName}
            </div>

            {/* When revealing the bid, show it prominently */}
            {spotlightState === "revealing" && spotlightBid && (
              <div className="bid-spotlight-amount">
                {formatPrice(spotlightBid.bidCents)}
              </div>
            )}

            {/* Status / instruction when active */}
            {spotlightState === "active" && biddingTurn && !spotlightBid && (
              <>
                {isMyTurn ? (
                  <div className="bid-spotlight-status bid-spotlight-status--you">
                    YOUR TURN
                  </div>
                ) : (
                  <div className="bid-spotlight-status">bidding...</div>
                )}
                <BiddingCountdown
                  seconds={biddingTurn.timerSeconds}
                  playSounds={isMyTurn}
                  key={`turn-${biddingTurn.turnIndex}`}
                />
              </>
            )}

            {/* Docking state: fade out */}
            {spotlightState === "docking" && spotlightBid && (
              <div className="bid-spotlight-amount bid-spotlight-amount--docking">
                {formatPrice(spotlightBid.bidCents)}
              </div>
            )}

            {/* Bid input — only when it's your turn and we're active */}
            {isMyTurn && spotlightState === "active" && (
              <div className="bid-spotlight-input">
                <PriceInput
                  category={product.category}
                  priceRange={product.priceRange}
                  onSubmit={(cents) => onSubmitBid(cents)}
                  disabled={hasGuessed}
                  onInteract={() => {}}
                />
              </div>
            )}
          </div>
        </div>
      )}

      {/* Dock — all players' status chips in a row */}
      <div className="bid-dock" data-testid="bid-dock">
        {biddingOrder.map((entry) => {
          const bid = placedBids.find((b) => b.playerId === entry.playerId);
          const isCurrent = biddingTurn?.currentPlayerId === entry.playerId;
          const isSpotlighted = spotlightPlayerId === entry.playerId && phase === "active";
          return (
            <div
              key={entry.playerId}
              className={`bid-dock-item
                ${bid ? "bid-dock-item--done" : ""}
                ${isCurrent ? "bid-dock-item--active" : ""}
                ${isSpotlighted ? "bid-dock-item--spotlighted" : ""}
                ${entry.playerId === currentPlayerId ? "bid-dock-item--you" : ""}
              `}
              data-testid="bid-dock-item"
              data-player-id={entry.playerId}
              data-bid-cents={bid?.bidCents ?? ""}
              data-is-current={isCurrent ? "true" : "false"}
            >
              <AvatarIcon avatar={entry.avatar as any} size={40} />
              <span className="bid-dock-name">{entry.displayName.split(" ")[0]}</span>
              {bid ? (
                <span className="bid-dock-amount">{formatPrice(bid.bidCents)}</span>
              ) : isCurrent ? (
                <span className="bid-dock-thinking">...</span>
              ) : (
                <span className="bid-dock-waiting">-</span>
              )}
            </div>
          );
        })}
      </div>

      {phase === "done" && (
        <div className="bid-done-zone">
          <span className="bid-done-text">All bids locked in!</span>
        </div>
      )}
    </div>
  );
}

/**
 * Dramatic countdown timer with pulse animation and urgency sound cues.
 *
 * Sound thresholds mirror the main {@link Timer} component: a single
 * `timer_urgent` cue when crossing into ≤10s, a `timer_critical` cue at
 * ≤5s, and a per-second `timer_tick` during both phases so the feel
 * matches the per-round timer elsewhere in the app.
 *
 * @param seconds    Initial countdown length (the per-turn bid clock).
 * @param playSounds When true, fire urgency/tick sounds as the clock ticks down.
 *                   Gated so only the active bidder hears them — everyone else
 *                   watching the turn stays silent.
 */
function BiddingCountdown({ seconds, playSounds = false }: { seconds: number; playSounds?: boolean }) {
  const { play } = useSound();
  const [remaining, setRemaining] = useState(seconds);
  const prevUrgentRef = useRef(false);
  const prevCriticalRef = useRef(false);

  useEffect(() => {
    setRemaining(seconds);
    prevUrgentRef.current = false;
    prevCriticalRef.current = false;
    const interval = setInterval(() => {
      setRemaining((prev) => {
        if (prev <= 1) { clearInterval(interval); return 0; }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [seconds]);

  // Fire urgency cues on transition + per-second ticks while the clock is low.
  useEffect(() => {
    if (!playSounds || remaining <= 0) return;
    const isUrgent = remaining <= 10;
    const isCritical = remaining <= 5;
    if (isCritical && !prevCriticalRef.current) play("timer_critical");
    else if (isUrgent && !prevUrgentRef.current) play("timer_urgent");
    if (isCritical) play("timer_tick", { volume: 0.6 });
    else if (isUrgent) play("timer_tick", { volume: 0.3 });
    prevUrgentRef.current = isUrgent;
    prevCriticalRef.current = isCritical;
  }, [remaining, play, playSounds]);

  const urgent = remaining <= 5;
  const fraction = remaining / seconds;

  return (
    <div
      className={`bid-timer ${urgent ? "bid-timer-urgent" : ""}`}
      role="timer"
      aria-live="polite"
      aria-label={`${remaining} seconds remaining to place your bid`}
    >
      <div className="bid-timer-bar" style={{ width: `${fraction * 100}%` }} />
      <span className="bid-timer-text">
        <span className="bid-timer-text-label">Time left</span>
        <span>{remaining}s</span>
      </span>
    </div>
  );
}
