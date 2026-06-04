import { useState, useEffect, useCallback, useRef } from "react";
import type { GameSession, DailyCompletionPayload } from "@price-game/shared";
import * as api from "../api/client";
import { useCurrency } from "../context/CurrencyContext";
import { soundEngine } from "../audio/SoundEngine";
import ResultReaction from "../components/ResultReaction";
import ImageModal from "../components/ImageModal";
import ProductTooltip from "../components/ProductTooltip";
import { AmazonCTA } from "../components/AmazonCTA";
import Scoreboard from "../components/Scoreboard";
import riserIcon from "../assets/modes/riser.webp";
import { reportImageFailure } from "../lib/imageDiagnostics";
import "./RiserPage.css";

// Tail particles are spawned behind the rocket while it's flying. Positions
// match the SVG viewBox (0..400 x 0..200) expressed as container percentages,
// so the trail aligns visually with the dashed trajectory line.
const TRAIL_SPAWN_INTERVAL_MS = 22;

// Cap on concurrent in-flight particles. At a ~22 ms spawn interval and
// ~700 ms lifespan we expect ~32 at steady state, so 100 is comfortably
// above the natural ceiling while still bounding pathological cases
// (main-thread jank batching spawns, long flights, etc.).
const MAX_PARTICLES = 100;

interface RiserPageProps {
  session: GameSession;
  onRoundComplete: (result: any, updatedSession: GameSession, dailyPayload?: DailyCompletionPayload) => void;
  onGameEnd: () => void;
}

interface RiserData {
  product: { id: number; title: string; imageUrl: string; description: string; category: string; amazonUrl?: string };
  maxPriceCents: number;
  speedPattern: string;
  durationMs: number;
}

function getProgress(elapsed: number, duration: number, pattern: string): number {
  const t = Math.min(elapsed / duration, 1);
  switch (pattern) {
    case "accelerating":
      return t * t;
    case "decelerating":
      return 1 - (1 - t) * (1 - t);
    case "wave":
      return t + 0.05 * Math.sin(t * Math.PI * 4);
    default: // linear
      return t;
  }
}

export default function RiserPage({ session, onRoundComplete, onGameEnd }: RiserPageProps) {
  const { formatPrice } = useCurrency();
  const [round, setRound] = useState(session.currentRound);
  const [totalScore, setTotalScore] = useState(session.totalScore);
  const [data, setData] = useState<RiserData | null>(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const currentPriceRef = useRef(0);
  const priceDisplayRef = useRef<HTMLSpanElement>(null);
  const rocketRef = useRef<HTMLDivElement>(null);
  const trailRef = useRef<HTMLDivElement>(null);
  const lastSpawnRef = useRef(0);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [gameEnded, setGameEnded] = useState(false);
  const [animatedScore, setAnimatedScore] = useState(0);
  const [zoomedImage, setZoomedImage] = useState<{ src: string; alt: string } | null>(null);
  const flyingSoundTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Animate score on result
  useEffect(() => {
    if (!result || result.score === 0) {
      setAnimatedScore(0);
      return;
    }
    const duration = 800;
    const steps = 30;
    const increment = result.score / steps;
    let current = 0;
    const interval = setInterval(() => {
      current += increment;
      if (current >= result.score) {
        setAnimatedScore(result.score);
        clearInterval(interval);
      } else {
        setAnimatedScore(Math.round(current));
      }
    }, duration / steps);
    return () => clearInterval(interval);
  }, [result?.score]);
  const animRef = useRef<number | null>(null);
  const startTimeRef = useRef<number>(0);
  const stoppedRef = useRef(false);

  // Cache reduced-motion preference once at mount. Evaluating matchMedia on
  // every particle spawn (~45×/sec during flight) was wasteful, and the
  // preference can't change mid-round anyway.
  const reducedMotionRef = useRef(
    typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );

  // Scene dimensions are sampled once per flight so the RAF loop can
  // translate the rocket by pixel-accurate transforms without re-measuring
  // each frame. A resize mid-flight will skew the rocket's final position
  // by at most a few pixels — acceptable for a 3–6 s animation.
  const sceneRectRef = useRef<{ width: number; height: number } | null>(null);

  const loadProduct = useCallback(async () => {
    setLoading(true);
    setResult(null);
    currentPriceRef.current = 0;
    setRunning(false);
    stoppedRef.current = false;
    lastSpawnRef.current = 0;
    // Reset the rocket back to its CSS-default position (10% left / 10% bottom,
    // matching the SVG origin at x=40,y=180). Clearing style.transform drops
    // any in-flight translate3d set by the RAF loop so the stylesheet's
    // `transform: translate(-50%, 50%)` centering takes over again.
    if (rocketRef.current) {
      rocketRef.current.style.transform = "";
    }
    // Clear any in-flight particles from the previous round
    if (trailRef.current) {
      trailRef.current.replaceChildren();
    }
    try {
      const d = await api.getProduct(session.id) as unknown as RiserData;
      setData(d);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, [session.id]);

  useEffect(() => {
    loadProduct();
  }, [loadProduct, round]);

  // Clean up animation on unmount. Also flush any in-flight particles so
  // their animationend handlers don't fire against a detached subtree.
  useEffect(() => {
    return () => {
      if (animRef.current) cancelAnimationFrame(animRef.current);
      if (flyingSoundTimerRef.current) clearTimeout(flyingSoundTimerRef.current);
      trailRef.current?.replaceChildren();
      soundEngine.stop("riser_flying");
    };
  }, []);

  /**
   * Spawn a single fire/smoke particle at the rocket's tail and append it
   * to the trail container. The particle self-removes when its CSS animation
   * finishes, so there is no pool to maintain.
   */
  function spawnTrailParticle(xPct: number, yPct: number) {
    const trail = trailRef.current;
    if (!trail) return;
    // Users who prefer reduced motion see the rocket travel without any
    // particle effects at all.
    if (reducedMotionRef.current) return;
    // Hard cap the DOM particle count so a long flight or frame-batched spawn
    // burst can't balloon the trail container. At steady state the natural
    // ceiling is ~32; the FIFO evict keeps us safe from edge cases.
    while (trail.children.length >= MAX_PARTICLES) {
      trail.firstElementChild?.remove();
    }
    const el = document.createElement("div");
    // Alternate fire/smoke particles so the trail has warm + cool tones
    const isSmoke = Math.random() < 0.45;
    el.className = `riser-particle${isSmoke ? " is-smoke" : ""}`;
    // Offset the particle slightly toward the rocket's tail (down-left of center)
    const jitterX = (Math.random() - 0.5) * 2.5;
    const jitterY = (Math.random() - 0.5) * 2.0;
    el.style.left = `${xPct - 1.6 + jitterX}%`;
    el.style.bottom = `${yPct - 1.6 + jitterY}%`;
    // CSS variables drive per-particle drift direction, size, and lifespan
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

  function startAnimation() {
    if (!data) return;
    setRunning(true);
    stoppedRef.current = false;
    startTimeRef.current = performance.now();
    lastSpawnRef.current = -TRAIL_SPAWN_INTERVAL_MS; // force spawn on first frame
    // Measure the scene's current pixel dimensions once so the RAF loop can
    // express the rocket's position as a composited transform rather than
    // mutating left/bottom (which triggers layout + paint every frame).
    const scene = rocketRef.current?.parentElement;
    if (scene) {
      const rect = scene.getBoundingClientRect();
      sceneRectRef.current = { width: rect.width, height: rect.height };
    }
    soundEngine.play("riser_launch");
    // Start loopable flying sound after launch
    flyingSoundTimerRef.current = setTimeout(() => {
      flyingSoundTimerRef.current = null;
      if (!stoppedRef.current) soundEngine.play("riser_flying");
    }, 400);

    const minPrice = Math.round(data.maxPriceCents * 0.1); // Start at ~10% of max

    function animate(now: number) {
      if (stoppedRef.current) return;
      const elapsed = now - startTimeRef.current;
      const progress = getProgress(elapsed, data!.durationMs, data!.speedPattern);
      const price = Math.round(minPrice + (data!.maxPriceCents - minPrice) * Math.min(progress, 1));
      currentPriceRef.current = price;
      if (priceDisplayRef.current) {
        priceDisplayRef.current.textContent = formatPrice(price);
        // Surface the live cents value as a stable data-cents attribute
        // so the bot streamer can read it without parsing currency-
        // formatted text (which depends on user locale + currency).
        priceDisplayRef.current.setAttribute("data-cents", String(price));
      }

      // Map price progress to the SVG diagonal (40,180) → (390,20), then
      // convert to container percentages for the HTML rocket overlay.
      const priceRange = data!.maxPriceCents - minPrice;
      const pct = priceRange > 0 ? Math.min(((price - minPrice) / priceRange) * 100, 100) : 0;
      const svgX = 40 + (350 * pct) / 100;
      const svgY = 180 - (160 * pct) / 100;
      const xPct = (svgX / 400) * 100;       // 10% → 97.5%
      const yPct = ((200 - svgY) / 200) * 100; // 10% → 90% (from bottom)
      const rect = sceneRectRef.current;
      if (rocketRef.current && rect) {
        // Position via compositor-friendly transform. The CSS default keeps
        // the rocket at left:10% bottom:10% with a translate(-50%, 50%)
        // centering rule; here we compute the delta from that anchor so the
        // new transform replaces the centering cleanly.
        const xDeltaPx = ((xPct - 10) / 100) * rect.width;
        const yDeltaPx = ((yPct - 10) / 100) * rect.height;
        rocketRef.current.style.transform =
          `translate3d(${xDeltaPx}px, ${-yDeltaPx}px, 0) translate(-50%, 50%)`;
      }

      // Spawn trail particles at a throttled rate so the trail fills out
      // smoothly without flooding the DOM with nodes.
      if (elapsed - lastSpawnRef.current >= TRAIL_SPAWN_INTERVAL_MS) {
        lastSpawnRef.current = elapsed;
        spawnTrailParticle(xPct, yPct);
      }

      if (progress >= 1) {
        // Time's up — auto-stop at max
        stoppedRef.current = true;
        setRunning(false);
        soundEngine.stop("riser_flying");
        soundEngine.play("riser_stop");
        submitStop(data!.maxPriceCents);
        return;
      }
      animRef.current = requestAnimationFrame(animate);
    }
    animRef.current = requestAnimationFrame(animate);
  }

  async function submitStop(priceCents: number) {
    if (submitting) return;
    setSubmitting(true);
    try {
      const resp = await api.submitRiserGuess(session.id, priceCents);
      setResult(resp.result);
      if (resp.result.wentOver) soundEngine.play("result_miss");
      else if (resp.result.score >= 650) soundEngine.play("result_great");
      else if (resp.result.score >= 350) soundEngine.play("result_good");
      else soundEngine.play("result_poor");
      setTotalScore(resp.session.totalScore);
      onRoundComplete(resp.result, resp.session, resp.daily);
      if (resp.session.completed) {
        setGameEnded(true);
      }
    } catch (err) {
      console.error(err);
    } finally {
      setSubmitting(false);
    }
  }

  function handleStop() {
    if (!running || stoppedRef.current) return;
    stoppedRef.current = true;
    if (animRef.current) cancelAnimationFrame(animRef.current);
    if (flyingSoundTimerRef.current) {
      clearTimeout(flyingSoundTimerRef.current);
      flyingSoundTimerRef.current = null;
    }
    setRunning(false);
    soundEngine.stop("riser_flying");
    soundEngine.play("riser_stop");
    submitStop(currentPriceRef.current);
  }

  function handleNext() {
    if (gameEnded) {
      onGameEnd();
      return;
    }
    setRound((r) => r + 1);
  }

  if (loading || !data) {
    return (
      <div className="page riser-page" data-testid="game-page-riser" data-mode="riser">
        <div className="loading">Loading round...</div>
      </div>
    );
  }

  const minPrice = Math.round(data.maxPriceCents * 0.1);
  const priceRange = data.maxPriceCents - minPrice;
  const actualPricePct = result && priceRange > 0
    ? Math.min(((result.product.priceCents - minPrice) / priceRange) * 100, 100)
    : 0;

  return (
    <div
      className="page riser-page"
      data-testid="game-page-riser"
      data-mode="riser"
      data-running={running ? "true" : "false"}
      data-max-price-cents={data.maxPriceCents}
    >
      <Scoreboard currentRound={round} totalRounds={session.totalRounds} score={totalScore} />

      {!result && (
        <div className="riser-product">
          <img
            src={data.product.imageUrl}
            alt={data.product.title}
            className="riser-product-img"
            style={{ cursor: "zoom-in" }}
            onClick={() => setZoomedImage({ src: data.product.imageUrl, alt: data.product.title })}
            onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
          />
          <ProductTooltip product={data.product} showAmazonLink={false} disabled>
            <p className="riser-product-title product-name-hoverable">{data.product.title}</p>
          </ProductTooltip>
        </div>
      )}

      <div className="riser-display">
        <div className="riser-price-label"><span ref={priceDisplayRef}>{formatPrice(currentPriceRef.current)}</span></div>
        {/* Over-price indicator sits above the frame so the scene isn't
            bracketed by range labels. The min price stays below as the
            floor of the range. */}
        <div className="riser-range-top">
          <span className="riser-range-top-label">Over at</span>
          <span className="riser-danger">{formatPrice(data.maxPriceCents)}</span>
        </div>
        <div className="riser-scene">
          <svg className="riser-scene-bg" viewBox="0 0 400 200" preserveAspectRatio="none" aria-hidden="true">
            {/* Background grid lines */}
            <line x1="40" y1="180" x2="390" y2="180" stroke="#333" strokeWidth="1" />
            <line x1="40" y1="135" x2="390" y2="135" stroke="#222" strokeWidth="0.5" strokeDasharray="4" />
            <line x1="40" y1="90" x2="390" y2="90" stroke="#222" strokeWidth="0.5" strokeDasharray="4" />
            <line x1="40" y1="45" x2="390" y2="45" stroke="#222" strokeWidth="0.5" strokeDasharray="4" />
            <line x1="40" y1="180" x2="40" y2="10" stroke="#333" strokeWidth="1" />

            {/* Diagonal trajectory — the rocket flies up this line */}
            <line x1="40" y1="180" x2="390" y2="20" stroke="url(#riserPath)" strokeWidth="2" strokeDasharray="6 4" />

            {/* Danger zone at the top-right */}
            <rect x="340" y="10" width="55" height="40" rx="4" fill="rgba(244,67,54,0.18)" />
            <text x="367" y="34" textAnchor="middle" fill="#f44336" fontSize="11" fontWeight="700">OVER</text>

            {/* Actual price marker — shown after result */}
            {result && actualPricePct > 0 && (
              <>
                {/* Horizontal dashed line at actual price height */}
                <line
                  x1={40 + (350 * actualPricePct) / 100 - 20}
                  y1={180 - (160 * actualPricePct) / 100}
                  x2={40 + (350 * actualPricePct) / 100 + 20}
                  y2={180 - (160 * actualPricePct) / 100}
                  stroke="#4ecca3"
                  strokeWidth="2"
                  strokeDasharray="4"
                />
                {/* Vertical tick down to axis */}
                <line
                  x1={40 + (350 * actualPricePct) / 100}
                  y1={180 - (160 * actualPricePct) / 100}
                  x2={40 + (350 * actualPricePct) / 100}
                  y2={180}
                  stroke="#4ecca3"
                  strokeWidth="1"
                  strokeDasharray="3"
                  opacity="0.5"
                />
                {/* Diamond marker at actual price position */}
                <polygon
                  points={`
                    ${40 + (350 * actualPricePct) / 100},${180 - (160 * actualPricePct) / 100 - 8}
                    ${40 + (350 * actualPricePct) / 100 + 6},${180 - (160 * actualPricePct) / 100}
                    ${40 + (350 * actualPricePct) / 100},${180 - (160 * actualPricePct) / 100 + 8}
                    ${40 + (350 * actualPricePct) / 100 - 6},${180 - (160 * actualPricePct) / 100}
                  `}
                  fill="#4ecca3"
                  stroke="#fff"
                  strokeWidth="1.5"
                />
                {/* Label */}
                <text
                  x={40 + (350 * actualPricePct) / 100}
                  y={180 - (160 * actualPricePct) / 100 - 14}
                  textAnchor="middle"
                  fill="#4ecca3"
                  fontSize="10"
                  fontWeight="700"
                >
                  Actual
                </text>
              </>
            )}

            <defs>
              <linearGradient id="riserPath" x1="0" y1="1" x2="1" y2="0">
                <stop offset="0%" stopColor="#4ecca3" stopOpacity="0.6" />
                <stop offset="60%" stopColor="#f6c90e" stopOpacity="0.75" />
                <stop offset="100%" stopColor="#f44336" stopOpacity="0.9" />
              </linearGradient>
            </defs>
          </svg>

          {/* Smoke/fire trail layer — particles spawned imperatively during flight */}
          <div className="riser-trail" ref={trailRef} aria-hidden="true" />

          {/* Rocket — position updated via ref, wobble + thrust glow via CSS */}
          <div
            className={`riser-rocket-wrapper${running ? " is-flying" : ""}`}
            ref={rocketRef}
            aria-hidden="true"
          >
            <img src={riserIcon} alt="" className="riser-rocket-img" />
          </div>
        </div>
        <div className="riser-range">
          <span className="riser-range-floor-label">Floor</span>
          <span>{formatPrice(minPrice)}</span>
        </div>
      </div>

      {!running && !result && (
        <button className="btn btn-primary riser-start-btn" onClick={startAnimation} data-testid="riser-start">
          Start
        </button>
      )}

      {running && (
        <button className="btn btn-stop riser-stop-btn" onClick={handleStop} data-testid="riser-stop">
          STOP!
        </button>
      )}

      {result && (
        <div className="riser-result-inline" role="status" aria-live="polite">
          <div className={`round-result riser-round-result ${result.wentOver ? "tier-miss" : result.score >= 500 ? "tier-nice" : "tier-ok"}`}>
            <ResultReaction score={result.score} />
            <div className="result-header">
              <h3 className={`result-title ${result.wentOver ? "tier-miss" : result.score >= 650 ? "tier-close" : result.score >= 350 ? "tier-nice" : result.score >= 100 ? "tier-ok" : "tier-far"}`}>
                {result.wentOver
                  ? "WENT OVER!"
                  : result.score >= 900
                  ? "Nailed it!"
                  : result.score >= 650
                  ? "So close!"
                  : result.score >= 500
                  ? "Nice stop!"
                  : result.score >= 350
                  ? "Good read!"
                  : result.score >= 200
                  ? "In the ballpark"
                  : result.score >= 100
                  ? "Keep going next time"
                  : "Too cautious!"}
              </h3>
              {!result.wentOver && result.pctOff > 0 && (
                <span className="result-pct-off">{(result.pctOff * 100).toFixed(1)}% under</span>
              )}
              {result.wentOver && (
                <span className="result-pct-off">Over by {(result.pctOff * 100).toFixed(1)}%</span>
              )}
            </div>

            <div className="result-prices">
              <div className="result-price-row">
                <span className="result-price-label">Actual Price</span>
                <span className="result-price-value">{formatPrice(result.product.priceCents)}</span>
              </div>
              <div className="result-price-row">
                <span className="result-price-label">You Stopped At</span>
                <span className={`result-price-value ${result.wentOver ? "text-red" : "text-green"}`}>
                  {formatPrice(result.stoppedPriceCents)}
                </span>
              </div>
              <div className="result-price-row">
                <span className="result-price-label">Difference</span>
                <span className={`result-price-value ${result.wentOver ? "text-red" : result.score >= 500 ? "text-green" : "text-yellow"}`}>
                  {formatPrice(Math.abs(result.stoppedPriceCents - result.product.priceCents))}
                  {result.wentOver ? " over" : " under"}
                </span>
              </div>
            </div>

            <div className="result-product-card">
              <img
                key={result.product.id}
                src={result.product.imageUrl}
                alt={result.product.title}
                className="result-product-img"
                decoding="sync"
                style={{ cursor: "zoom-in" }}
                onClick={() => setZoomedImage({ src: result.product.imageUrl, alt: result.product.title })}
                onError={(e) => {
                  reportImageFailure({ productId: result.product.id, src: result.product.imageUrl, phase: "error" });
                  (e.target as HTMLImageElement).style.display = "none";
                }}
              />
              <div className="result-product-info">
                <ProductTooltip product={result.product}>
                  <p className="result-product-title product-name-hoverable">{result.product.title}</p>
                </ProductTooltip>
                {result.product.amazonUrl && (
                  <AmazonCTA
                    href={result.product.amazonUrl}
                    size="md"
                    productLabel={result.product.title}
                    showDisclosure
                  />
                )}
              </div>
            </div>

            <div className={`result-score ${result.score >= 500 ? "score-glow" : ""}`}>
              <span className="result-score-label">Points Earned</span>
              <span className={`result-score-value ${result.score === 0 ? "score-zero" : ""}`}>
                +{animatedScore}
              </span>
            </div>

            <button className="btn btn-primary" onClick={handleNext} data-testid="round-result-next">
              {gameEnded ? "See Final Results" : "Next Round"}
            </button>
          </div>
        </div>
      )}

      {zoomedImage && (
        <ImageModal src={zoomedImage.src} alt={zoomedImage.alt} onClose={() => setZoomedImage(null)} />
      )}
    </div>
  );
}
