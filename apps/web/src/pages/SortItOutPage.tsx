import { useState, useEffect, useCallback } from "react";
import type { GameSession, SortItOutRoundResult, Product, ProductWithPrice, DailyCompletionPayload } from "@price-game/shared";
import { ROUND_TIME_SECONDS } from "@price-game/shared";
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

interface SortItOutPageProps {
  session: GameSession;
  onRoundComplete: (result: SortItOutRoundResult, session: GameSession, dailyPayload?: DailyCompletionPayload) => void;
  onGameEnd: () => void;
}

interface SortItOutData {
  products: Product[];
}

const FALLBACK_SVG =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300"><rect width="300" height="300" fill="#1a1a2e"/><text x="50%" y="45%" text-anchor="middle" font-size="48" fill="#4ecca3">$?</text></svg>'
  );

/**
 * Game page for the Sort It Out mode. Shows 5 shuffled products; the player
 * reorders them from cheapest to most expensive by tapping pairs to swap.
 * @param session - Current game session state
 * @param onRoundComplete - Callback fired after each round with its result
 * @param onGameEnd - Callback fired when the player finishes the last round
 */
export default function SortItOutPage({ session, onRoundComplete, onGameEnd }: SortItOutPageProps) {
  const { formatPrice } = useCurrency();
  const [data, setData] = useState<SortItOutData | null>(null);
  const [loading, setLoading] = useState(false);
  const [roundResult, setRoundResult] = useState<SortItOutRoundResult | null>(null);
  const [currentRound, setCurrentRound] = useState(session.currentRound);
  const [hasGuessed, setHasGuessed] = useState(false);
  const [animatedScore, setAnimatedScore] = useState(0);
  const [zoomedImage, setZoomedImage] = useState<{ src: string; alt: string } | null>(null);
  const [orderedProducts, setOrderedProducts] = useState<Product[]>([]);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);

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

  const handleTimerExpire = useCallback(() => {
    if (!hasGuessed && !roundResult && orderedProducts.length > 0) {
      soundEngine.play("timer_expire");
      doGuess(orderedProducts.map((p) => p.id), true);
    }
  }, [hasGuessed, roundResult, orderedProducts]);

  const timer = useTimer(ROUND_TIME_SECONDS, handleTimerExpire);

  const fetchProducts = useCallback(async () => {
    setLoading(true);
    setRoundResult(null);
    setHasGuessed(false);
    setSelectedIndex(null);
    try {
      const d = await api.getProduct(session.id);
      const sortData = d as unknown as SortItOutData;
      setData(sortData);
      setOrderedProducts(sortData.products);
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

  /** Handle tapping a product slot to select or swap. */
  function handleSlotClick(index: number) {
    if (hasGuessed) return;
    if (selectedIndex === null) {
      soundEngine.play("item_select");
      setSelectedIndex(index);
    } else if (selectedIndex === index) {
      soundEngine.play("item_deselect");
      setSelectedIndex(null);
    } else {
      // Swap the two products
      soundEngine.play("swap");
      setOrderedProducts((prev) => {
        const next = [...prev];
        const temp = next[selectedIndex];
        next[selectedIndex] = next[index];
        next[index] = temp;
        return next;
      });
      setSelectedIndex(null);
    }
  }

  /** Submit the player's ordering to the server. */
  async function doGuess(submittedOrder: number[], timedOut?: boolean) {
    if (hasGuessed) return;
    setHasGuessed(true);
    timer.stop();
    if (!timedOut) soundEngine.play("guess_submit");
    try {
      const response = await api.submitSortItOutGuess(session.id, submittedOrder, timedOut);
      setRoundResult(response.result);
      const total = orderedProducts.length;
      if (response.result.correctCount === total) soundEngine.play("result_exact");
      else if (response.result.correctCount > 0) soundEngine.play("result_good");
      else soundEngine.play("result_miss");
      onRoundComplete(response.result, response.session, response.daily);
    } catch (err) {
      console.error("Failed to submit guess:", err);
      setHasGuessed(false);
    }
  }

  function handleLockIn() {
    doGuess(orderedProducts.map((p) => p.id));
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
      <div className="page game-page" data-testid="game-page-sort-it-out" data-mode="sort-it-out">
        <Scoreboard currentRound={currentRound} totalRounds={session.totalRounds} score={session.totalScore} />
        <div className="loading">Loading products...</div>
      </div>
    );
  }

  return (
    <div className="page game-page sort-it-out-page" data-testid="game-page-sort-it-out" data-mode="sort-it-out">
      <div className="game-header">
        <Scoreboard currentRound={currentRound} totalRounds={session.totalRounds} score={session.totalScore} />
        <Timer secondsLeft={timer.secondsLeft} isRunning={timer.isRunning} paused={false} />
      </div>

      <div className="comparison-question">
        Sort these products from <strong>CHEAPEST</strong> to <strong>MOST EXPENSIVE</strong>
      </div>

      {!roundResult && (
        <p className="pm-instruction">Tap two products to swap their positions</p>
      )}

      <div className="sort-it-out-list" data-testid="sort-it-out-list">
        {orderedProducts.map((product, index) => (
          <button
            key={product.id}
            className={`sort-it-out-slot ${selectedIndex === index ? "sort-selected" : ""}`}
            onClick={() => handleSlotClick(index)}
            disabled={hasGuessed}
            data-testid="sort-it-out-slot"
            data-product-id={product.id}
            data-position={index}
            data-selected={selectedIndex === index ? "true" : "false"}
          >
            <span className="sort-slot-number">{index + 1}</span>
            <div
              className="comparison-image-wrapper small"
              onClick={(e) => {
                e.stopPropagation();
                setZoomedImage({ src: product.imageUrl, alt: product.title });
              }}
            >
              <img
                src={product.imageUrl}
                alt={product.title}
                onError={(e) => {
                  (e.target as HTMLImageElement).src = FALLBACK_SVG;
                }}
              />
            </div>
            <div className="sort-slot-info">
              <ProductTooltip product={product} showAmazonLink={false} disabled>
                <h4 className="comparison-reveal-title product-name-hoverable">{product.title}</h4>
              </ProductTooltip>
              <span className="category-badge">{product.category}</span>
            </div>
          </button>
        ))}
      </div>

      {!roundResult && !hasGuessed && (
        <button className="btn btn-primary" onClick={handleLockIn} data-testid="sort-it-out-submit">
          Lock In Order
        </button>
      )}

      {roundResult && (
        <div className="result-overlay">
          <div className={`round-result ${roundResult.correctCount === orderedProducts.length ? "tier-nice" : roundResult.correctCount > 0 ? "tier-ok" : "tier-miss"}`}>
            <ResultReaction score={roundResult.score} goodThreshold={600} badThreshold={200} />
            <div className="result-header">
              <h3 className={`result-title ${roundResult.correctCount === orderedProducts.length ? "tier-nice" : roundResult.correctCount > 0 ? "tier-ok" : "tier-miss"}`}>
                {roundResult.correctCount === orderedProducts.length
                  ? "Perfect Order!"
                  : roundResult.correctCount > 0
                  ? `${roundResult.correctCount} of ${orderedProducts.length} Correct`
                  : "None Correct!"}
              </h3>
            </div>

            <div className="sort-it-out-reveal">
              {roundResult.correctOrder.map((productId, index) => {
                const product = roundResult.products.find((p: ProductWithPrice) => p.id === productId);
                if (!product) return null;
                const submittedIndex = roundResult.submittedOrder.indexOf(productId);
                const isCorrectPosition = submittedIndex === index;
                return (
                  <div
                    key={product.id}
                    className={`sort-it-out-reveal-slot ${isCorrectPosition ? "correct-product" : "wrong-product"}`}
                  >
                    <span className="sort-slot-number">{index + 1}</span>
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
                    <div className="sort-reveal-info">
                      <ProductTooltip product={product}>
                        <h4 className="comparison-reveal-title product-name-hoverable">{product.title}</h4>
                      </ProductTooltip>
                      <span className="comparison-price">{formatPrice(product.priceCents)}</span>
                      {isCorrectPosition && <span className="comparison-badge correct-badge">Correct</span>}
                      {!isCorrectPosition && (
                        <span className="comparison-badge wrong-badge">You put #{submittedIndex + 1}</span>
                      )}
                      {product.amazonUrl && (
                        <AmazonCTA
                          href={product.amazonUrl}
                          size="sm"
                          productLabel={product.title}
                        />
                      )}
                    </div>
                  </div>
                );
              })}
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
