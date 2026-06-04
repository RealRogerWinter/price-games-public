import { useState, useEffect, useCallback, useRef } from "react";
import type {
  RoundStartPayload,
  MultiplayerPlayer,
  GameMode,
  BiddingTurnPayload,
  BidPlacedPayload,
} from "@price-game/shared";
import ProductCard from "../ProductCard";
import ProductTooltip from "../ProductTooltip";
import ComparisonPrompt from "../ComparisonPrompt";
import ImageModal from "../ImageModal";
import PriceInput from "../PriceInput";
import Timer from "../Timer";
import Scoreboard from "../Scoreboard";
import PlayerStatusBar from "./PlayerStatusBar";
import BiddingUI from "./BiddingUI";
import MPTopBar from "./MPTopBar";
import { useCurrency } from "../../context/CurrencyContext";
import { soundEngine } from "../../audio/SoundEngine";
import riserIcon from "../../assets/modes/riser.webp";
// Share RiserPage's extracted stylesheet — MP's Riser mode uses the same
// .riser-* selectors. Vite dedupes the CSS across chunks.
import "../../pages/RiserPage.css";

// Throttle for riser trail particle spawning — matches single-player RiserPage.
const MP_TRAIL_SPAWN_INTERVAL_MS = 22;

interface MPGameScreenProps {
  roundData: RoundStartPayload;
  players: MultiplayerPlayer[];
  currentPlayerId: string;
  lockedPlayerIds: Set<string>;
  currentRound: number;
  totalRounds: number;
  totalScore: number;
  hasGuessed: boolean;
  onSubmitGuess: (guessData: any) => void;
  biddingTurn?: BiddingTurnPayload | null;
  placedBids?: BidPlacedPayload[];
  onSubmitBid?: (bidCents: number) => void;
  onLeave: () => void;
  /** Opens the register/auth modal when anon players tap the IdentityCard CTA. */
  onOpenAuth?: () => void;
  /** MP-specific display-name override forwarded to the IdentityCard in the top bar. */
  displayNameOverride?: string | null;
}

export default function MPGameScreen({
  roundData,
  players,
  currentPlayerId,
  lockedPlayerIds,
  currentRound,
  totalRounds,
  totalScore,
  hasGuessed,
  onSubmitGuess,
  biddingTurn,
  placedBids,
  onSubmitBid,
  onLeave,
  onOpenAuth,
  displayNameOverride,
}: MPGameScreenProps) {
  const mode = roundData.gameMode;

  // Bidding mode has its own timer and flow — render it separately.
  // The extra `mp-bidding-page` class is the CSS hook we use to collapse
  // the outer chrome (PlayerStatusBar is redundant with BiddingUI's own
  // player dock) and tighten vertical spacing on mobile so the essential
  // content — product image, spotlight card, bid input — fits above the
  // fold without scrolling.
  if (mode === "bidding" && onSubmitBid) {
    return (
      <div className="page game-page mp-game-page mp-bidding-page">
        <MPTopBar onLeave={onLeave} onOpenAuth={onOpenAuth} displayNameOverride={displayNameOverride} />
        <div className="game-header">
          <Scoreboard currentRound={currentRound} totalRounds={totalRounds} score={totalScore} />
        </div>

        <PlayerStatusBar
          players={players}
          lockedPlayerIds={lockedPlayerIds}
          currentPlayerId={currentPlayerId}
        />

        <BiddingUI
          roundData={roundData}
          biddingTurn={biddingTurn ?? null}
          placedBids={placedBids ?? []}
          currentPlayerId={currentPlayerId}
          players={players}
          onSubmitBid={onSubmitBid}
          hasGuessed={hasGuessed}
        />
      </div>
    );
  }

  return (
    <div className="page game-page mp-game-page">
      <MPTopBar onLeave={onLeave} onOpenAuth={onOpenAuth} displayNameOverride={displayNameOverride} />
      <div className="game-header">
        <Scoreboard currentRound={currentRound} totalRounds={totalRounds} score={totalScore} />
        {mode !== "riser" && (
          <MPTimer
            seconds={roundData.timerSeconds}
            onExpire={() => handleTimerExpire(mode, roundData, onSubmitGuess, hasGuessed)}
            paused={hasGuessed}
          />
        )}
      </div>

      <PlayerStatusBar
        players={players}
        lockedPlayerIds={lockedPlayerIds}
        currentPlayerId={currentPlayerId}
      />

      {hasGuessed ? (
        <div className="mp-locked-in">
          <p className="mp-locked-text">Locked in!</p>
          <p className="mp-waiting-text">
            Waiting for other players... ({lockedPlayerIds.size}/{players.length})
          </p>
        </div>
      ) : (
        <ModeGameUI
          mode={mode}
          roundData={roundData}
          onSubmitGuess={onSubmitGuess}
          disabled={hasGuessed}
        />
      )}
    </div>
  );
}

// Timer that auto-starts and counts down
function MPTimer({
  seconds,
  onExpire,
  paused,
}: {
  seconds: number;
  onExpire: () => void;
  paused: boolean;
}) {
  const [secondsLeft, setSecondsLeft] = useState(seconds);
  const expiredRef = useRef(false);

  useEffect(() => {
    setSecondsLeft(seconds);
    expiredRef.current = false;
  }, [seconds]);

  useEffect(() => {
    if (paused || expiredRef.current) return;

    const interval = setInterval(() => {
      setSecondsLeft((prev) => {
        if (prev <= 1) {
          clearInterval(interval);
          if (!expiredRef.current) {
            expiredRef.current = true;
            setTimeout(() => onExpire(), 0);
          }
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(interval);
  }, [paused, onExpire]);

  return <Timer secondsLeft={secondsLeft} isRunning={!paused && !expiredRef.current} paused={paused} />;
}

function handleTimerExpire(
  mode: GameMode,
  roundData: RoundStartPayload,
  onSubmitGuess: (data: any) => void,
  hasGuessed: boolean
) {
  if (hasGuessed) return;
  soundEngine.play("timer_expire");
  // Auto-submit a default guess when timer expires
  switch (mode) {
    case "classic":
    case "closest-without-going-over":
      onSubmitGuess({ guessedPriceCents: 0 });
      break;
    case "higher-lower":
      onSubmitGuess({ guess: "lower" });
      break;
    case "comparison":
      if (roundData.products?.[0]) {
        onSubmitGuess({ guessedProductId: roundData.products[0].id });
      }
      break;
    case "price-match":
      onSubmitGuess({ assignments: {} });
      break;
    case "riser":
      onSubmitGuess({ stoppedPriceCents: 0 });
      break;
    case "odd-one-out":
      if (roundData.products?.[0]) {
        onSubmitGuess({ guessedProductId: roundData.products[0].id });
      }
      break;
    case "market-basket":
      onSubmitGuess({ guessedTotalCents: 0 });
      break;
    case "sort-it-out":
      if (roundData.products) {
        onSubmitGuess({ submittedOrder: roundData.products.map((p) => p.id) });
      }
      break;
    case "budget-builder":
      onSubmitGuess({ selectedProductIds: [] });
      break;
    case "chain-reaction":
      if (roundData.products) {
        onSubmitGuess({ chainGuesses: Array(roundData.products.length - 1).fill("more") });
      }
      break;
    case "bidding":
      // Bidding mode handles its own timer per-turn on the server
      break;
  }
}

// Renders the correct game UI based on mode
function ModeGameUI({
  mode,
  roundData,
  onSubmitGuess,
  disabled,
}: {
  mode: GameMode;
  roundData: RoundStartPayload;
  onSubmitGuess: (data: any) => void;
  disabled: boolean;
}) {
  switch (mode) {
    case "classic":
      return <ClassicUI roundData={roundData} onSubmitGuess={onSubmitGuess} disabled={disabled} />;
    case "closest-without-going-over":
      return <ClosestUI roundData={roundData} onSubmitGuess={onSubmitGuess} disabled={disabled} />;
    case "higher-lower":
      return <HigherLowerUI roundData={roundData} onSubmitGuess={onSubmitGuess} disabled={disabled} />;
    case "comparison":
      return <ComparisonUI roundData={roundData} onSubmitGuess={onSubmitGuess} disabled={disabled} />;
    case "price-match":
      return <PriceMatchUI roundData={roundData} onSubmitGuess={onSubmitGuess} disabled={disabled} />;
    case "riser":
      return <RiserUI roundData={roundData} onSubmitGuess={onSubmitGuess} disabled={disabled} />;
    case "odd-one-out":
      return <OddOneOutUI roundData={roundData} onSubmitGuess={onSubmitGuess} disabled={disabled} />;
    case "market-basket":
      return <MarketBasketUI roundData={roundData} onSubmitGuess={onSubmitGuess} disabled={disabled} />;
    case "sort-it-out":
      return <SortItOutUI roundData={roundData} onSubmitGuess={onSubmitGuess} disabled={disabled} />;
    case "budget-builder":
      return <BudgetBuilderUI roundData={roundData} onSubmitGuess={onSubmitGuess} disabled={disabled} />;
    case "chain-reaction":
      return <ChainReactionUI roundData={roundData} onSubmitGuess={onSubmitGuess} disabled={disabled} />;
    default:
      return <div>Unknown mode</div>;
  }
}

// --- Classic Mode UI ---
function ClassicUI({
  roundData,
  onSubmitGuess,
  disabled,
}: {
  roundData: RoundStartPayload;
  onSubmitGuess: (data: any) => void;
  disabled: boolean;
}) {
  if (!roundData.product) return null;
  return (
    <>
      <ProductCard key={roundData.product.id} product={roundData.product} hideAmazonLink />
      <PriceInput
        category={roundData.product.category}
        priceRange={roundData.product.priceRange}
        onSubmit={(cents) => onSubmitGuess({ guessedPriceCents: cents })}
        disabled={disabled}
        onInteract={() => {}}
      />
    </>
  );
}

// --- Closest Without Going Over UI ---
function ClosestUI({
  roundData,
  onSubmitGuess,
  disabled,
}: {
  roundData: RoundStartPayload;
  onSubmitGuess: (data: any) => void;
  disabled: boolean;
}) {
  if (!roundData.product) return null;
  return (
    <>
      <ProductCard key={roundData.product.id} product={roundData.product} hideAmazonLink />
      <div className="mode-label">Underbid!</div>
      <PriceInput
        category={roundData.product.category}
        priceRange={roundData.product.priceRange}
        onSubmit={(cents) => onSubmitGuess({ guessedPriceCents: cents })}
        disabled={disabled}
        onInteract={() => {}}
      />
    </>
  );
}

// --- Higher/Lower UI ---
function HigherLowerUI({
  roundData,
  onSubmitGuess,
  disabled,
}: {
  roundData: RoundStartPayload;
  onSubmitGuess: (data: any) => void;
  disabled: boolean;
}) {
  const { formatPrice } = useCurrency();
  if (!roundData.product || roundData.referencePrice === undefined) return null;

  return (
    <>
      <ProductCard key={roundData.product.id} product={roundData.product} hideAmazonLink />
      <div className="hl-guess-section">
        <div className="hl-reference">
          <span className="hl-reference-label">Is the real price higher or lower than</span>
          <span className="hl-reference-price">{formatPrice(roundData.referencePrice)}</span>
          <span className="hl-reference-label">?</span>
        </div>
        <div className="hl-buttons">
          <button
            className="btn btn-higher"
            onClick={() => onSubmitGuess({ guess: "higher" })}
            disabled={disabled}
          >
            Higher
          </button>
          <button
            className="btn btn-lower"
            onClick={() => onSubmitGuess({ guess: "lower" })}
            disabled={disabled}
          >
            Lower
          </button>
        </div>
      </div>
    </>
  );
}

// --- Comparison UI ---
//
// Click-to-zoom is intentionally NOT wired on the in-round image: the entire
// card region (including the image) is the selection target so taps land
// reliably even when the user's finger drifts onto the image. The image still
// gets zoom in the reveal/result overlay (different component).
function ComparisonUI({
  roundData,
  onSubmitGuess,
  disabled,
}: {
  roundData: RoundStartPayload;
  onSubmitGuess: (data: any) => void;
  disabled: boolean;
}) {
  if (!roundData.products) return null;
  const question = roundData.question || "most-expensive";

  return (
    <>
      <ComparisonPrompt question={question} roundKey={roundData.roundNumber} />
      <div className="comparison-products">
        {roundData.products.map((p) => (
          <button
            key={p.id}
            className="comparison-card"
            onClick={() => onSubmitGuess({ guessedProductId: p.id })}
            disabled={disabled}
          >
            <div className="comparison-image-wrapper comparison-image-wrapper--no-zoom">
              <img
                src={p.imageUrl}
                alt={p.title}
                onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
              />
            </div>
            <span className="category-badge">{p.category}</span>
            <ProductTooltip product={p} showAmazonLink={false}><h3 className="comparison-title product-name-hoverable">{p.title}</h3></ProductTooltip>
          </button>
        ))}
      </div>
    </>
  );
}

// --- Price Match UI ---
function PriceMatchUI({
  roundData,
  onSubmitGuess,
  disabled,
}: {
  roundData: RoundStartPayload;
  onSubmitGuess: (data: any) => void;
  disabled: boolean;
}) {
  const [assignments, setAssignments] = useState<Record<number, number>>({});
  const [selectedProduct, setSelectedProduct] = useState<number | null>(null);
  const [zoomedImage, setZoomedImage] = useState<{ src: string; alt: string } | null>(null);

  if (!roundData.products || !roundData.prices) return null;

  const products = roundData.products;
  const prices = roundData.prices;
  const assignedPrices = new Set(Object.values(assignments));
  const allAssigned = Object.keys(assignments).length === products.length;

  function handleProductClick(productId: number) {
    if (disabled) return;
    // If already assigned, unassign it
    if (assignments[productId] !== undefined) {
      soundEngine.play("item_deselect");
      setAssignments((prev) => {
        const next = { ...prev };
        delete next[productId];
        return next;
      });
      return;
    }
    soundEngine.play("item_select");
    setSelectedProduct(productId);
  }

  function handlePriceClick(price: number) {
    if (disabled || selectedProduct === null) return;
    if (assignedPrices.has(price)) return;
    soundEngine.play("guess_submit");
    setAssignments((prev) => ({ ...prev, [selectedProduct]: price }));
    setSelectedProduct(null);
  }

  const { formatPrice: fmt } = useCurrency();

  return (
    <>
      <h2 className="pm-title">Match each product to its price</h2>

      {!disabled && selectedProduct !== null && (
        <p className="pm-instruction">Now pick a price for the highlighted product</p>
      )}
      {!disabled && selectedProduct === null && !allAssigned && (
        <p className="pm-instruction">Tap a product, then tap a price to assign it</p>
      )}

      <div className="pm-products">
        {products.map((p) => (
          <div
            key={p.id}
            className={`pm-product-card ${selectedProduct === p.id ? "pm-selected" : ""} ${
              assignments[p.id] !== undefined ? "pm-assigned" : ""
            }`}
            onClick={() => handleProductClick(p.id)}
          >
            <img
              src={p.imageUrl}
              alt={p.title}
              className="pm-product-img"
              onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
              onClick={(e) => { e.stopPropagation(); setZoomedImage({ src: p.imageUrl, alt: p.title }); }}
            />
            <ProductTooltip product={p} showAmazonLink={false}><p className="pm-product-title product-name-hoverable">{p.title}</p></ProductTooltip>
            {assignments[p.id] !== undefined && (
              <span className="pm-assigned-price">{fmt(assignments[p.id])}</span>
            )}
          </div>
        ))}
      </div>

      <div className="pm-prices">
        {/*
          Filter out assigned prices entirely (mirrors single-player
          PriceMatchPage behavior): once a price is placed inside a product
          card it disappears from the lower menu, so the remaining options
          stay focused. Tapping the assigned product unassigns it, returning
          the price to the menu via setAssignments.
        */}
        {prices
          .filter((price) => !assignedPrices.has(price))
          .map((price, idx) => (
            <button
              key={`${price}-${idx}`}
              className={`pm-price-btn ${selectedProduct !== null ? "pm-price-active" : ""}`}
              onClick={() => handlePriceClick(price)}
              disabled={disabled || selectedProduct === null}
            >
              {fmt(price)}
            </button>
          ))}
      </div>

      {allAssigned && (
        <button
          className="btn btn-primary pm-submit"
          onClick={() => onSubmitGuess({ assignments })}
          disabled={disabled}
        >
          Lock In Answers
        </button>
      )}
      {zoomedImage && (
        <ImageModal src={zoomedImage.src} alt={zoomedImage.alt} onClose={() => setZoomedImage(null)} />
      )}
    </>
  );
}

// --- Riser UI ---
function RiserUI({
  roundData,
  onSubmitGuess,
  disabled,
}: {
  roundData: RoundStartPayload;
  onSubmitGuess: (data: any) => void;
  disabled: boolean;
}) {
  const [started, setStarted] = useState(false);
  const [stopped, setStopped] = useState(false);
  const [zoomedImage, setZoomedImage] = useState<{ src: string; alt: string } | null>(null);
  const animRef = useRef<number | null>(null);
  const startTimeRef = useRef<number>(0);
  const currentPriceRef = useRef(0);
  const stoppedRef = useRef(false);
  const priceDisplayRef = useRef<HTMLSpanElement>(null);
  const rocketRef = useRef<HTMLDivElement>(null);
  const trailRef = useRef<HTMLDivElement>(null);
  const flyingSoundTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSpawnRef = useRef(0);
  const { formatPrice } = useCurrency();

  /** Reduced-motion check — users who opt in skip the particle trail entirely. */
  const prefersReducedMotion = (): boolean =>
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  if (!roundData.product) return null;

  const maxPrice = roundData.maxPriceCents || 10000;
  const minPrice = Math.round(maxPrice * 0.1);
  const duration = roundData.durationMs || 8000;
  const pattern = roundData.speedPattern || "linear";

  function getProgress(elapsed: number): number {
    const t = Math.min(elapsed / duration, 1);
    switch (pattern) {
      case "accelerating":
        return t * t;
      case "decelerating":
        return 1 - (1 - t) * (1 - t);
      case "wave":
        return t + 0.05 * Math.sin(t * Math.PI * 6);
      default:
        return t;
    }
  }

  /** Spawn a single fire/smoke particle at the rocket's tail. */
  function spawnTrailParticle(xPct: number, yPct: number) {
    const trail = trailRef.current;
    if (!trail) return;
    if (prefersReducedMotion()) return;
    const el = document.createElement("div");
    const isSmoke = Math.random() < 0.45;
    el.className = `riser-particle${isSmoke ? " is-smoke" : ""}`;
    const jitterX = (Math.random() - 0.5) * 2.5;
    const jitterY = (Math.random() - 0.5) * 2.0;
    el.style.left = `${xPct - 1.6 + jitterX}%`;
    el.style.bottom = `${yPct - 1.6 + jitterY}%`;
    const dx = -14 - Math.random() * 24;
    const dy = 22 + Math.random() * 30;
    const life = 520 + Math.floor(Math.random() * 320);
    const scale = 1.4 + Math.random() * 1.1;
    el.style.setProperty("--rp-dx", `${dx}px`);
    el.style.setProperty("--rp-dy", `${dy}px`);
    el.style.setProperty("--rp-life", `${life}ms`);
    el.style.setProperty("--rp-scale", `${scale}`);
    el.addEventListener("animationend", () => el.remove(), { once: true });
    trail.appendChild(el);
  }

  function startRiser() {
    setStarted(true);
    stoppedRef.current = false;
    startTimeRef.current = performance.now();
    lastSpawnRef.current = -MP_TRAIL_SPAWN_INTERVAL_MS;
    soundEngine.play("riser_launch");
    flyingSoundTimerRef.current = setTimeout(() => {
      flyingSoundTimerRef.current = null;
      if (!stoppedRef.current) soundEngine.play("riser_flying");
    }, 400);

    function animate(now: number) {
      if (stoppedRef.current) return;
      const elapsed = now - startTimeRef.current;
      const progress = Math.min(getProgress(elapsed), 1);
      const price = Math.round(minPrice + (maxPrice - minPrice) * progress);
      currentPriceRef.current = price;
      if (priceDisplayRef.current) {
        priceDisplayRef.current.textContent = formatPrice(price);
      }

      // Match the single-player mapping: diagonal (40,180)→(390,20) in SVG
      // units, converted to container percentages for the rocket overlay.
      const priceRange = maxPrice - minPrice;
      const pct = priceRange > 0 ? Math.min(((price - minPrice) / priceRange) * 100, 100) : 0;
      const svgX = 40 + (350 * pct) / 100;
      const svgY = 180 - (160 * pct) / 100;
      const xPct = (svgX / 400) * 100;
      const yPct = ((200 - svgY) / 200) * 100;
      if (rocketRef.current) {
        rocketRef.current.style.left = `${xPct}%`;
        rocketRef.current.style.bottom = `${yPct}%`;
      }

      if (elapsed - lastSpawnRef.current >= MP_TRAIL_SPAWN_INTERVAL_MS) {
        lastSpawnRef.current = elapsed;
        spawnTrailParticle(xPct, yPct);
      }

      if (elapsed >= duration) {
        stoppedRef.current = true;
        setStopped(true);
        soundEngine.stop("riser_flying");
        soundEngine.play("riser_stop");
        onSubmitGuess({ stoppedPriceCents: maxPrice });
        return;
      }
      animRef.current = requestAnimationFrame(animate);
    }

    animRef.current = requestAnimationFrame(animate);
  }

  function stopRiser() {
    if (stoppedRef.current || disabled) return;
    stoppedRef.current = true;
    setStopped(true);
    if (animRef.current) {
      cancelAnimationFrame(animRef.current);
    }
    if (flyingSoundTimerRef.current) {
      clearTimeout(flyingSoundTimerRef.current);
      flyingSoundTimerRef.current = null;
    }
    soundEngine.stop("riser_flying");
    soundEngine.play("riser_stop");
    onSubmitGuess({ stoppedPriceCents: currentPriceRef.current });
  }

  // Cleanup on unmount. Flush any in-flight particles so their animationend
  // handlers don't fire against a detached subtree.
  useEffect(() => {
    return () => {
      if (animRef.current) cancelAnimationFrame(animRef.current);
      if (flyingSoundTimerRef.current) clearTimeout(flyingSoundTimerRef.current);
      trailRef.current?.replaceChildren();
      soundEngine.stop("riser_flying");
    };
  }, []);

  return (
    <>
      <div className="riser-product">
        <img
          src={roundData.product.imageUrl}
          alt={roundData.product.title}
          className="riser-product-img"
          onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
          onClick={() => setZoomedImage({ src: roundData.product!.imageUrl, alt: roundData.product!.title })}
        />
        <ProductTooltip product={roundData.product} showAmazonLink={false}><p className="riser-product-title product-name-hoverable">{roundData.product.title}</p></ProductTooltip>
      </div>

      <div className="riser-display">
        <div className="riser-price-label"><span ref={priceDisplayRef}>{formatPrice(0)}</span></div>
        <div className="riser-scene">
          <svg className="riser-scene-bg" viewBox="0 0 400 200" preserveAspectRatio="none" aria-hidden="true">
            {/* Background grid lines */}
            <line x1="40" y1="180" x2="390" y2="180" stroke="#333" strokeWidth="1" />
            <line x1="40" y1="135" x2="390" y2="135" stroke="#222" strokeWidth="0.5" strokeDasharray="4" />
            <line x1="40" y1="90" x2="390" y2="90" stroke="#222" strokeWidth="0.5" strokeDasharray="4" />
            <line x1="40" y1="45" x2="390" y2="45" stroke="#222" strokeWidth="0.5" strokeDasharray="4" />
            <line x1="40" y1="180" x2="40" y2="10" stroke="#333" strokeWidth="1" />

            {/* Diagonal trajectory */}
            <line x1="40" y1="180" x2="390" y2="20" stroke="url(#mpRiserPath)" strokeWidth="2" strokeDasharray="6 4" />

            {/* Danger zone */}
            <rect x="340" y="10" width="55" height="40" rx="4" fill="rgba(244,67,54,0.18)" />
            <text x="367" y="34" textAnchor="middle" fill="#f44336" fontSize="11" fontWeight="700">OVER</text>

            <defs>
              <linearGradient id="mpRiserPath" x1="0" y1="1" x2="1" y2="0">
                <stop offset="0%" stopColor="#4ecca3" stopOpacity="0.6" />
                <stop offset="60%" stopColor="#f6c90e" stopOpacity="0.75" />
                <stop offset="100%" stopColor="#f44336" stopOpacity="0.9" />
              </linearGradient>
            </defs>
          </svg>

          <div className="riser-trail" ref={trailRef} aria-hidden="true" />

          <div
            className={`riser-rocket-wrapper${started && !stopped ? " is-flying" : ""}`}
            ref={rocketRef}
            aria-hidden="true"
          >
            <img src={riserIcon} alt="" className="riser-rocket-img" />
          </div>
        </div>
        <div className="riser-range">
          <span>{formatPrice(minPrice)}</span>
          <span className="riser-danger">{formatPrice(maxPrice)}</span>
        </div>
      </div>

      {!started && !stopped && (
        <button className="btn btn-primary riser-start-btn" onClick={startRiser} disabled={disabled}>
          Start
        </button>
      )}

      {started && !stopped && (
        <button className="btn btn-stop riser-stop-btn" onClick={stopRiser} disabled={disabled}>
          STOP!
        </button>
      )}
      {zoomedImage && (
        <ImageModal src={zoomedImage.src} alt={zoomedImage.alt} onClose={() => setZoomedImage(null)} />
      )}
    </>
  );
}

// --- Odd One Out UI ---
//
// Click-to-zoom intentionally omitted on the in-round image: the entire card
// region (image included) is the selection target so taps land reliably. See
// `ComparisonUI` above for the same rationale.
function OddOneOutUI({
  roundData,
  onSubmitGuess,
  disabled,
}: {
  roundData: RoundStartPayload;
  onSubmitGuess: (data: any) => void;
  disabled: boolean;
}) {
  if (!roundData.products) return null;

  return (
    <>
      <div className="comparison-question">
        Which product is the <strong>ODD ONE OUT</strong>?
      </div>
      <div className="comparison-products">
        {roundData.products.map((p) => (
          <button
            key={p.id}
            className="comparison-card"
            onClick={() => onSubmitGuess({ guessedProductId: p.id })}
            disabled={disabled}
          >
            <div className="comparison-image-wrapper comparison-image-wrapper--no-zoom">
              <img
                src={p.imageUrl}
                alt={p.title}
                onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
              />
            </div>
            <span className="category-badge">{p.category}</span>
            <ProductTooltip product={p} showAmazonLink={false}><h3 className="comparison-title product-name-hoverable">{p.title}</h3></ProductTooltip>
          </button>
        ))}
      </div>
    </>
  );
}

// --- Market Basket UI ---
function MarketBasketUI({
  roundData,
  onSubmitGuess,
  disabled,
}: {
  roundData: RoundStartPayload;
  onSubmitGuess: (data: any) => void;
  disabled: boolean;
}) {
  const [zoomedImage, setZoomedImage] = useState<{ src: string; alt: string } | null>(null);
  if (!roundData.products) return null;

  return (
    <>
      <h2 className="pm-title">Guess the total price of all items</h2>
      <div className="pm-products">
        {roundData.products.map((p) => (
          <div key={p.id} className="pm-product-card">
            <img
              src={p.imageUrl}
              alt={p.title}
              className="pm-product-img"
              onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
              onClick={() => setZoomedImage({ src: p.imageUrl, alt: p.title })}
            />
            <ProductTooltip product={p} showAmazonLink={false}><p className="pm-product-title product-name-hoverable">{p.title}</p></ProductTooltip>
          </div>
        ))}
      </div>
      <PriceInput
        category=""
        onSubmit={(cents) => onSubmitGuess({ guessedTotalCents: cents })}
        disabled={disabled}
        onInteract={() => {}}
      />
      {zoomedImage && (
        <ImageModal src={zoomedImage.src} alt={zoomedImage.alt} onClose={() => setZoomedImage(null)} />
      )}
    </>
  );
}

// --- Sort It Out UI ---
function SortItOutUI({
  roundData,
  onSubmitGuess,
  disabled,
}: {
  roundData: RoundStartPayload;
  onSubmitGuess: (data: any) => void;
  disabled: boolean;
}) {
  const [order, setOrder] = useState<number[]>(() =>
    roundData.products ? roundData.products.map((p) => p.id) : []
  );
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);
  const [zoomedImage, setZoomedImage] = useState<{ src: string; alt: string } | null>(null);

  if (!roundData.products) return null;
  const productMap = new Map(roundData.products.map((p) => [p.id, p]));

  function handleTap(idx: number) {
    if (disabled) return;
    if (selectedIdx === null) {
      soundEngine.play("item_select");
      setSelectedIdx(idx);
    } else {
      soundEngine.play("swap");
      const newOrder = [...order];
      [newOrder[selectedIdx], newOrder[idx]] = [newOrder[idx], newOrder[selectedIdx]];
      setOrder(newOrder);
      setSelectedIdx(null);
    }
  }

  return (
    <>
      <h2 className="pm-title">Sort cheapest to most expensive</h2>
      <p className="pm-instruction">Tap two items to swap them</p>
      <div className="sio-products">
        {order.map((id, idx) => {
          const p = productMap.get(id);
          if (!p) return null;
          return (
            <button
              key={id}
              className={`sio-product-card ${selectedIdx === idx ? "sio-selected" : ""}`}
              onClick={() => handleTap(idx)}
              type="button"
            >
              <span className="sio-rank">{idx + 1}</span>
              <img
                src={p.imageUrl}
                alt={p.title}
                className="sio-product-img"
                onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
                onClick={(e) => { e.stopPropagation(); setZoomedImage({ src: p.imageUrl, alt: p.title }); }}
              />
              <ProductTooltip product={p} showAmazonLink={false}><p className="sio-product-title product-name-hoverable">{p.title}</p></ProductTooltip>
            </button>
          );
        })}
      </div>
      <button
        className="btn btn-primary pm-submit"
        onClick={() => onSubmitGuess({ submittedOrder: order })}
        disabled={disabled}
      >
        Lock In Order
      </button>
      {zoomedImage && (
        <ImageModal src={zoomedImage.src} alt={zoomedImage.alt} onClose={() => setZoomedImage(null)} />
      )}
    </>
  );
}

// --- Budget Builder UI ---
//
// Click-to-zoom intentionally omitted on the in-round image: the entire card
// region is the selection toggle target. See `ComparisonUI` above for the same
// rationale (consistent UX across multiplayer card-pick modes).
function BudgetBuilderUI({
  roundData,
  onSubmitGuess,
  disabled,
}: {
  roundData: RoundStartPayload;
  onSubmitGuess: (data: any) => void;
  disabled: boolean;
}) {
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const { formatPrice } = useCurrency();

  if (!roundData.products || !roundData.budgetCents) return null;
  const budgetCents = roundData.budgetCents;

  function toggleProduct(id: number) {
    if (disabled) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
        soundEngine.play("item_deselect");
      } else {
        next.add(id);
        soundEngine.play("item_select");
      }
      return next;
    });
  }

  return (
    <>
      <h2 className="pm-title">Build a cart closest to the budget</h2>
      <div className="bb-budget-display">
        <span className="bb-budget-label">Budget:</span>
        <span className="bb-budget-value">{formatPrice(budgetCents)}</span>
      </div>
      <div className="bb-products">
        {roundData.products.map((p) => (
          <button
            key={p.id}
            className={`bb-product-card ${selected.has(p.id) ? "bb-selected" : ""}`}
            onClick={() => toggleProduct(p.id)}
            type="button"
          >
            <img
              src={p.imageUrl}
              alt={p.title}
              className="bb-product-img"
              onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
            />
            <ProductTooltip product={p} showAmazonLink={false}><p className="bb-product-title product-name-hoverable">{p.title}</p></ProductTooltip>
          </button>
        ))}
      </div>
      <button
        className="btn btn-primary pm-submit"
        onClick={() => onSubmitGuess({ selectedProductIds: Array.from(selected) })}
        disabled={disabled || selected.size === 0}
      >
        Lock In Cart ({selected.size} items)
      </button>
    </>
  );
}

// --- Chain Reaction UI ---
//
// Mirrors the single-player layout (apps/web/src/pages/ChainReactionPage.tsx):
// one product is shown at a time, with the previous product rendered as a
// small reference above it. Progress dots show how far the chain has been
// traversed. The "Start Chain" button gives the player a moment to see the
// first product before locking in their first "More/Less" guess. Once the
// chain is complete, all guesses are submitted together.
function ChainReactionUI({
  roundData,
  onSubmitGuess,
  disabled,
}: {
  roundData: RoundStartPayload;
  onSubmitGuess: (data: any) => void;
  disabled: boolean;
}) {
  const [guesses, setGuesses] = useState<("more" | "less")[]>([]);
  const [chainIndex, setChainIndex] = useState(0);
  const [started, setStarted] = useState(false);
  const [zoomedImage, setZoomedImage] = useState<{ src: string; alt: string } | null>(null);

  // Reset local step state when a new round arrives (keyed on round number)
  useEffect(() => {
    setGuesses([]);
    setChainIndex(0);
    setStarted(false);
  }, [roundData.roundNumber]);

  // Preload every chain product's image on round start so each
  // setChainIndex transition swaps to a cached image immediately. Without
  // this the new <img> can flash the previous bitmap while the network
  // fetch runs (the unmounted product's image briefly persists). Browsers
  // cache by URL so a one-shot Image() with src= warms HTTP cache for the
  // upcoming <img> elements.
  useEffect(() => {
    if (typeof window === "undefined" || !roundData.products) return;
    const images: HTMLImageElement[] = [];
    for (const p of roundData.products) {
      if (!p.imageUrl) continue;
      const img = new window.Image();
      img.src = p.imageUrl;
      images.push(img);
    }
    return () => {
      // Drop refs so the GC can reclaim. We don't cancel in-flight fetches —
      // the browser cache entry is the desired side effect either way.
      images.length = 0;
    };
  }, [roundData.products]);

  if (!roundData.products || roundData.products.length < 2) return null;
  const products = roundData.products;
  const chainLength = products.length - 1;
  const allDone = guesses.length >= chainLength;

  // At chainIndex 0 we're showing the "starting product" preview before
  // any guesses. Once started, chainIndex is the index of the product the
  // player is currently guessing about (relative to products[chainIndex-1]).
  const isFirstProduct = !started;
  const currentProduct = products[chainIndex];
  const previousProduct = chainIndex > 0 ? products[chainIndex - 1] : null;

  function handleGuess(guess: "more" | "less") {
    if (disabled || allDone) return;
    soundEngine.play("chain_link");
    const newGuesses = [...guesses, guess];
    setGuesses(newGuesses);
    const nextIndex = chainIndex + 1;
    if (newGuesses.length >= chainLength) {
      onSubmitGuess({ chainGuesses: newGuesses });
    } else {
      setChainIndex(nextIndex);
    }
  }

  return (
    <div className="chain-reaction-area">
      <div className="comparison-question">
        <strong>Chain Reaction</strong> &mdash; Link {Math.min(chainIndex + 1, products.length)} of {products.length}
      </div>

      {/* Chain progress dots */}
      <div className="chain-progress" data-testid="chain-progress">
        {products.map((_, i) => (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <div
              className={`chain-progress-dot ${i < chainIndex ? "dot-done" : i === chainIndex ? "dot-current" : ""}`}
              data-testid="chain-progress-dot"
            />
            {i < products.length - 1 && (
              <div className={`chain-progress-connector ${i < chainIndex ? "connector-done" : ""}`} />
            )}
          </div>
        ))}
      </div>

      {/* Previous product reference */}
      {previousProduct && (
        <div className="chain-previous">
          <span className="chain-label">Previous</span>
          <div className="chain-card chain-card-small">
            <div
              className="comparison-image-wrapper small"
              onClick={() => setZoomedImage({ src: previousProduct.imageUrl, alt: previousProduct.title })}
            >
              <img
                src={previousProduct.imageUrl}
                alt={previousProduct.title}
                onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
              />
            </div>
            <ProductTooltip product={previousProduct} showAmazonLink={false}><h4 className="comparison-reveal-title product-name-hoverable">{previousProduct.title}</h4></ProductTooltip>
          </div>
        </div>
      )}

      {/* Arrow connector */}
      {previousProduct && <div className="chain-arrow-connector">&#x2193;</div>}

      {/* Current product */}
      <div className="chain-current">
        {isFirstProduct && <span className="chain-label">Starting product</span>}
        {!isFirstProduct && !allDone && <span className="chain-label">Is this MORE or LESS expensive?</span>}
        <div className="chain-card chain-card-main">
          <div
            className="comparison-image-wrapper"
            onClick={() => setZoomedImage({ src: currentProduct.imageUrl, alt: currentProduct.title })}
          >
            <img
              src={currentProduct.imageUrl}
              alt={currentProduct.title}
              onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
            />
          </div>
          <ProductTooltip product={currentProduct} showAmazonLink={false}><h3 className="comparison-title product-name-hoverable">{currentProduct.title}</h3></ProductTooltip>
          <span className="category-badge">{currentProduct.category}</span>
        </div>
      </div>

      {/* Start Chain button — mirrors the single-player "Ready?" gate */}
      {isFirstProduct && !allDone && !disabled && (
        <div className="chain-start-hint">
          <p className="pm-instruction">This is your starting product. Ready?</p>
          <button
            className="btn btn-primary"
            onClick={() => {
              setStarted(true);
              setChainIndex(1);
            }}
          >
            Start Chain
          </button>
        </div>
      )}

      {/* More/Less buttons from the second product onward */}
      {!isFirstProduct && !allDone && !disabled && (
        <div className="chain-buttons">
          <button
            className="btn btn-primary chain-btn-more"
            onClick={() => handleGuess("more")}
            disabled={disabled}
          >
            More Expensive
          </button>
          <button
            className="btn btn-primary chain-btn-less"
            onClick={() => handleGuess("less")}
            disabled={disabled}
          >
            Less Expensive
          </button>
        </div>
      )}

      {allDone && (
        <p className="mp-locked-text">Chain complete!</p>
      )}

      {zoomedImage && (
        <ImageModal src={zoomedImage.src} alt={zoomedImage.alt} onClose={() => setZoomedImage(null)} />
      )}
    </div>
  );
}
