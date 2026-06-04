import { useState, useEffect, useCallback, useRef } from "react";
import type { GameSession, MarketBasketRoundResult, Product, ProductWithPrice, DailyCompletionPayload } from "@price-game/shared";
import * as api from "../api/client";
import { useCurrency } from "../context/CurrencyContext";
import { useTimer } from "../hooks/useTimer";
import Timer from "../components/Timer";
import Scoreboard from "../components/Scoreboard";
import ResultReaction from "../components/ResultReaction";
import ImageModal from "../components/ImageModal";
import { soundEngine } from "../audio/SoundEngine";
import ProductTooltip from "../components/ProductTooltip";
import { AmazonCTA } from "../components/AmazonCTA";

interface MarketBasketPageProps {
  session: GameSession;
  onRoundComplete: (result: MarketBasketRoundResult, session: GameSession, dailyPayload?: DailyCompletionPayload) => void;
  onGameEnd: () => void;
}

interface MarketBasketData {
  products: Product[];
  itemCount: number;
}

const MARKET_BASKET_TIME = 45;

const FALLBACK_SVG =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300"><rect width="300" height="300" fill="#1a1a2e"/><text x="50%" y="45%" text-anchor="middle" font-size="48" fill="#4ecca3">$?</text></svg>'
  );

/**
 * Game page for the Market Basket mode. Shows 3-6 products; the player
 * guesses the combined total price of all displayed items.
 * @param session - Current game session state
 * @param onRoundComplete - Callback fired after each round with its result
 * @param onGameEnd - Callback fired when the player finishes the last round
 */
export default function MarketBasketPage({ session, onRoundComplete, onGameEnd }: MarketBasketPageProps) {
  const { formatPrice, parseInput, currency } = useCurrency();
  const [data, setData] = useState<MarketBasketData | null>(null);
  const [loading, setLoading] = useState(false);
  const [roundResult, setRoundResult] = useState<MarketBasketRoundResult | null>(null);
  const [currentRound, setCurrentRound] = useState(session.currentRound);
  const [hasGuessed, setHasGuessed] = useState(false);
  const [animatedScore, setAnimatedScore] = useState(0);
  const [zoomedImage, setZoomedImage] = useState<{ src: string; alt: string } | null>(null);
  const [cents, setCents] = useState(0);
  const [textValue, setTextValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  // Animate score on result
  useEffect(() => {
    if (!roundResult || roundResult.score === 0) {
      setAnimatedScore(0);
      return;
    }
    const duration = 800;
    const steps = 30;
    const increment = roundResult.score / steps;
    let current = 0;
    const interval = setInterval(() => {
      current += increment;
      if (current >= roundResult.score) {
        setAnimatedScore(roundResult.score);
        clearInterval(interval);
      } else {
        setAnimatedScore(Math.round(current));
      }
    }, duration / steps);
    return () => clearInterval(interval);
  }, [roundResult?.score]);

  // Compute slider range from product price ranges
  const sliderRange = (() => {
    if (!data) return { min: 100, max: 200000, step: 100 };
    const products = data.products;
    const minTotal = products.reduce((s, p) => s + (p.priceRange?.min || 100), 0);
    const maxTotal = products.reduce((s, p) => s + (p.priceRange?.max || 50000), 0);
    // Add some buffer so the answer is reachable
    const min = Math.max(100, Math.round(minTotal * 0.5));
    const max = Math.round(maxTotal * 1.2);
    const step = max <= 10000 ? 50 : max <= 100000 ? 100 : 500;
    return { min, max, step };
  })();

  // Initialize slider to random position when products load
  useEffect(() => {
    if (data && !roundResult && !hasGuessed) {
      const spread = sliderRange.max - sliderRange.min;
      const randomStart = Math.round(sliderRange.min + Math.random() * spread);
      const rounded = Math.round(randomStart / sliderRange.step) * sliderRange.step;
      const clamped = Math.max(sliderRange.min, Math.min(sliderRange.max, rounded));
      setCents(clamped);
      setTextValue(formatPrice(clamped));
    }
  }, [data, currentRound]);

  // Re-format display when currency changes
  useEffect(() => {
    if (cents > 0) setTextValue(formatPrice(cents));
  }, [currency]);

  const handleTimerExpire = useCallback(() => {
    if (!hasGuessed && !roundResult) {
      soundEngine.play("timer_expire");
      doGuess(cents, true);
    }
  }, [hasGuessed, roundResult, cents]);

  const timer = useTimer(MARKET_BASKET_TIME, handleTimerExpire);

  const fetchProducts = useCallback(async () => {
    setLoading(true);
    setRoundResult(null);
    setHasGuessed(false);
    setCents(0);
    setTextValue("");
    try {
      const d = await api.getProduct(session.id);
      setData(d as unknown as MarketBasketData);
      timer.start();
    } catch (err) {
      console.error("Failed to fetch products:", err);
    } finally {
      setLoading(false);
    }
  }, [session.id]);

  useEffect(() => {
    fetchProducts();
  }, [currentRound]);

  /** Submit the player's total price guess in cents. */
  async function doGuess(totalCents: number, timedOut?: boolean) {
    if (hasGuessed) return;
    setHasGuessed(true);
    timer.stop();
    if (!timedOut) soundEngine.play("guess_submit");
    try {
      const response = await api.submitMarketBasketGuess(session.id, totalCents, timedOut);
      setRoundResult(response.result);
      if (response.result.pctOff <= 10) soundEngine.play("result_great");
      else if (response.result.pctOff <= 30) soundEngine.play("result_good");
      else soundEngine.play("result_miss");
      onRoundComplete(response.result, response.session, response.daily);
    } catch (err) {
      console.error("Failed to submit guess:", err);
      setHasGuessed(false);
    }
  }

  // Throttle slider tick sound
  const lastTickRef = useRef(0);
  function handleSliderChange(e: React.ChangeEvent<HTMLInputElement>) {
    const val = parseInt(e.target.value, 10);
    setCents(val);
    setTextValue(formatPrice(val));
    const now = performance.now();
    if (now - lastTickRef.current > 60) {
      lastTickRef.current = now;
      soundEngine.play("slider_tick");
    }
  }

  function handleTextChange(e: React.ChangeEvent<HTMLInputElement>) {
    setTextValue(e.target.value);
    const parsed = parseInput(e.target.value);
    if (parsed >= 0) {
      setCents(Math.max(sliderRange.min, Math.min(sliderRange.max, parsed)));
    }
  }

  function handleTextBlur() {
    const parsed = parseInput(textValue);
    const clamped = Math.max(sliderRange.min, Math.min(sliderRange.max, parsed));
    setCents(clamped);
    setTextValue(formatPrice(clamped));
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!hasGuessed) doGuess(cents);
  }

  function handleNextRound() {
    if (currentRound >= session.totalRounds) {
      onGameEnd();
    } else {
      soundEngine.play("next_round");
      setCurrentRound((r) => r + 1);
    }
  }

  const isLastRound = currentRound >= session.totalRounds;

  if (loading || !data) {
    return (
      <div className="page game-page" data-testid="game-page-market-basket" data-mode="market-basket">
        <Scoreboard currentRound={currentRound} totalRounds={session.totalRounds} score={session.totalScore} />
        <div className="loading">Loading products...</div>
      </div>
    );
  }

  return (
    <div className="page game-page market-basket-page" data-testid="game-page-market-basket" data-mode="market-basket" data-basket-size={data.products.length}>
      <div className="game-header">
        <Scoreboard currentRound={currentRound} totalRounds={session.totalRounds} score={session.totalScore} />
        <Timer secondsLeft={timer.secondsLeft} isRunning={timer.isRunning} paused={false} />
      </div>

      <div className="comparison-question">
        What is the <strong>TOTAL PRICE</strong> of these {data.products.length} items?
      </div>

      <div className="market-basket-products" data-testid="market-basket-products">
        {data.products.map((product) => (
          <div key={product.id} className="market-basket-card" data-testid="market-basket-card" data-product-id={product.id}>
            <div
              className="comparison-image-wrapper small"
              onClick={() => setZoomedImage({ src: product.imageUrl, alt: product.title })}
            >
              <img
                src={product.imageUrl}
                alt={product.title}
                onError={(e) => {
                  (e.target as HTMLImageElement).src = FALLBACK_SVG;
                }}
              />
            </div>
            <div className="market-basket-info">
              <ProductTooltip product={product} showAmazonLink={false} disabled>
                <h4 className="comparison-reveal-title product-name-hoverable">{product.title}</h4>
              </ProductTooltip>
              <span className="category-badge">{product.category}</span>
            </div>
          </div>
        ))}
      </div>

      {!roundResult && (
        <form className="price-input market-basket-price-input" onSubmit={handleSubmit} data-testid="market-basket-form">
          <label className="price-label" htmlFor="market-basket-price-input">Your Total Estimate</label>
          <input
            ref={inputRef}
            id="market-basket-price-input"
            type="text"
            className="price-text-input"
            value={textValue}
            onChange={handleTextChange}
            onBlur={handleTextBlur}
            disabled={hasGuessed}
            inputMode="decimal"
            autoFocus
            aria-label="Total basket price estimate in dollars"
            data-testid="market-basket-input-text"
          />
          <div className="slider-container">
            <span className="slider-label">{formatPrice(sliderRange.min)}</span>
            <input
              type="range"
              className="price-slider"
              min={sliderRange.min}
              max={sliderRange.max}
              step={sliderRange.step}
              value={cents}
              onChange={handleSliderChange}
              disabled={hasGuessed}
              aria-label="Adjust your basket-total estimate with the slider"
              data-testid="market-basket-input-slider"
            />
            <span className="slider-label">{formatPrice(sliderRange.max)}</span>
          </div>
          <button
            className="btn btn-primary"
            type="submit"
            disabled={hasGuessed || cents <= 0}
            data-testid="market-basket-submit"
          >
            {hasGuessed ? "Submitting..." : "Lock In Total"}
          </button>
        </form>
      )}

      {roundResult && (
        <div className="result-overlay">
          <div className={`round-result ${roundResult.pctOff <= 0.10 ? "tier-nice" : roundResult.pctOff <= 0.30 ? "tier-ok" : "tier-miss"}`}>
            <ResultReaction score={roundResult.score} goodThreshold={600} badThreshold={200} />
            <div className="result-header">
              <h3 className={`result-title ${roundResult.pctOff <= 0.10 ? "tier-nice" : roundResult.pctOff <= 0.30 ? "tier-ok" : "tier-miss"}`}>
                {roundResult.pctOff <= 0.10 ? "Great Estimate!" : roundResult.pctOff <= 0.30 ? "Not Bad!" : "Way Off!"}
              </h3>
            </div>

            <div className="market-basket-reveal">
              {roundResult.products.map((p: ProductWithPrice) => (
                <div key={p.id} className="market-basket-reveal-card">
                  <div
                    className="comparison-image-wrapper small"
                    onClick={() => setZoomedImage({ src: p.imageUrl, alt: p.title })}
                  >
                    <img
                      src={p.imageUrl}
                      alt={p.title}
                      onError={(e) => {
                        (e.target as HTMLImageElement).src = FALLBACK_SVG;
                      }}
                    />
                  </div>
                  <div className="market-basket-reveal-info">
                    <ProductTooltip product={p}>
                      <h4 className="comparison-reveal-title product-name-hoverable">{p.title}</h4>
                    </ProductTooltip>
                    <span className="comparison-price">{formatPrice(p.priceCents)}</span>
                    {p.amazonUrl && (
                      <AmazonCTA
                        href={p.amazonUrl}
                        size="sm"
                        productLabel={p.title}
                      />
                    )}
                  </div>
                </div>
              ))}
            </div>

            <div className="market-basket-totals">
              <div className="market-basket-total-row">
                <span className="result-price-label">Actual Total:</span>
                <span className="result-price-value text-green">{formatPrice(roundResult.actualTotalCents)}</span>
              </div>
              <div className="market-basket-total-row">
                <span className="result-price-label">Your Guess:</span>
                <span className={`result-price-value ${roundResult.pctOff <= 0.10 ? "text-green" : "text-red"}`}>
                  {formatPrice(roundResult.guessedTotalCents)}
                </span>
              </div>
              <div className="market-basket-total-row">
                <span className="result-price-label">Off by:</span>
                <span className="result-price-value">{(roundResult.pctOff * 100).toFixed(1)}%</span>
              </div>
            </div>

            <div className={`result-score ${roundResult.score > 0 ? "score-glow" : ""}`}>
              <span className="result-score-label">Points Earned</span>
              <span className={`result-score-value ${roundResult.score === 0 ? "score-zero" : ""}`}>
                +{animatedScore}
              </span>
            </div>

            <button className="btn btn-primary" onClick={handleNextRound} data-testid="round-result-next">
              {isLastRound ? "See Final Results" : "Next Round"}
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
