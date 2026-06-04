import { useState, useEffect, useCallback } from "react";
import type { GameSession, BudgetBuilderRoundResult, Product, ProductWithPrice, DailyCompletionPayload } from "@price-game/shared";
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

interface BudgetBuilderPageProps {
  session: GameSession;
  onRoundComplete: (result: BudgetBuilderRoundResult, session: GameSession, dailyPayload?: DailyCompletionPayload) => void;
  onGameEnd: () => void;
}

interface BudgetBuilderData {
  products: Product[];
  budgetCents: number;
}

const BUDGET_BUILDER_TIME = 60;

const FALLBACK_SVG =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300"><rect width="300" height="300" fill="#1a1a2e"/><text x="50%" y="45%" text-anchor="middle" font-size="48" fill="#4ecca3">$?</text></svg>'
  );

/**
 * Game page for the Budget Builder mode. Shows 6 products and a target budget;
 * the player toggles products on/off to get as close to the budget as possible.
 * @param session - Current game session state
 * @param onRoundComplete - Callback fired after each round with its result
 * @param onGameEnd - Callback fired when the player finishes the last round
 */
export default function BudgetBuilderPage({ session, onRoundComplete, onGameEnd }: BudgetBuilderPageProps) {
  const { formatPrice } = useCurrency();
  const [data, setData] = useState<BudgetBuilderData | null>(null);
  const [loading, setLoading] = useState(false);
  const [roundResult, setRoundResult] = useState<BudgetBuilderRoundResult | null>(null);
  const [currentRound, setCurrentRound] = useState(session.currentRound);
  const [hasGuessed, setHasGuessed] = useState(false);
  const [animatedScore, setAnimatedScore] = useState(0);
  const [zoomedImage, setZoomedImage] = useState<{ src: string; alt: string } | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());

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
    if (!hasGuessed && !roundResult) {
      soundEngine.play("timer_expire");
      doGuess([...selectedIds], true);
    }
  }, [hasGuessed, roundResult, selectedIds]);

  const timer = useTimer(BUDGET_BUILDER_TIME, handleTimerExpire);

  const fetchProducts = useCallback(async () => {
    setLoading(true);
    setRoundResult(null);
    setHasGuessed(false);
    setSelectedIds(new Set());
    try {
      const d = await api.getProduct(session.id);
      setData(d as unknown as BudgetBuilderData);
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

  // Defensive reset: clear any selected-card highlights the moment the round
  // advances. `fetchProducts` already empties `selectedIds`, but it's also
  // responsible for kicking off the network call — keeping a separate
  // round-keyed effect guarantees the green-highlight state cannot bleed into
  // a new round even if `fetchProducts` is reordered or short-circuits later.
  useEffect(() => {
    setSelectedIds(new Set());
  }, [currentRound]);

  /** Toggle a product's selection on or off. */
  function toggleProduct(productId: number) {
    if (hasGuessed) return;
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(productId)) {
        next.delete(productId);
        soundEngine.play("item_deselect");
      } else {
        next.add(productId);
        soundEngine.play("item_select");
      }
      return next;
    });
  }

  /** Submit the player's selected products to the server. */
  async function doGuess(productIds: number[], timedOut?: boolean) {
    if (hasGuessed) return;
    setHasGuessed(true);
    timer.stop();
    if (!timedOut) soundEngine.play("guess_submit");
    try {
      const response = await api.submitBudgetBuilderGuess(session.id, productIds, timedOut);
      setRoundResult(response.result);
      if (response.result.cartTotalCents <= response.result.budgetCents) soundEngine.play("correct");
      else soundEngine.play("incorrect");
      onRoundComplete(response.result, response.session, response.daily);
    } catch (err) {
      console.error("Failed to submit guess:", err);
      setHasGuessed(false);
    }
  }

  function handleLockIn() {
    doGuess([...selectedIds]);
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

  // Estimate cart total for the live bar (we don't know actual prices, so count items)
  const selectedCount = selectedIds.size;

  if (loading || !data) {
    return (
      <div className="page game-page" data-testid="game-page-budget-builder" data-mode="budget-builder">
        <Scoreboard currentRound={currentRound} totalRounds={session.totalRounds} score={session.totalScore} />
        <div className="loading">Loading products...</div>
      </div>
    );
  }

  return (
    <div
      className="page game-page budget-builder-page"
      data-testid="game-page-budget-builder"
      data-mode="budget-builder"
      data-budget-cents={data.budgetCents}
    >
      <div className="game-header">
        <Scoreboard currentRound={currentRound} totalRounds={session.totalRounds} score={session.totalScore} />
        <Timer secondsLeft={timer.secondsLeft} isRunning={timer.isRunning} paused={false} />
      </div>

      <div className="comparison-question">
        Build a cart that hits the <strong>BUDGET</strong> of {formatPrice(data.budgetCents)}
      </div>

      <div className="budget-builder-status">
        <div>
          <span className="budget-builder-selected">{selectedCount} item{selectedCount !== 1 ? "s" : ""} selected</span>
          <span className="budget-builder-target">Budget: {formatPrice(data.budgetCents)}</span>
        </div>
        <div className="budget-builder-bar">
          <div
            className="budget-builder-bar-fill"
            style={{ width: `${Math.min((selectedCount / data.products.length) * 100, 100)}%` }}
          />
        </div>
      </div>

      <div className="budget-builder-products" data-testid="budget-builder-products">
        {data.products.map((product) => {
          const isSelected = selectedIds.has(product.id);
          return (
            <button
              key={product.id}
              className={`budget-builder-card ${isSelected ? "budget-selected" : ""}`}
              onClick={() => toggleProduct(product.id)}
              disabled={hasGuessed}
              data-testid="budget-builder-card"
              data-product-id={product.id}
              data-selected={isSelected ? "true" : "false"}
            >
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
              <div className="budget-builder-card-info">
                <ProductTooltip product={product} showAmazonLink={false} disabled>
                  <h4 className="comparison-reveal-title product-name-hoverable">{product.title}</h4>
                </ProductTooltip>
                <span className="category-badge">{product.category}</span>
              </div>
              {isSelected && <span className="budget-builder-check">In Cart</span>}
            </button>
          );
        })}
      </div>

      {!roundResult && !hasGuessed && (
        <button className="btn btn-primary" onClick={handleLockIn} disabled={selectedCount === 0} data-testid="budget-builder-submit">
          Lock In Cart
        </button>
      )}

      {roundResult && (
        <div className="result-overlay">
          <div className={`round-result ${roundResult.cartTotalCents <= roundResult.budgetCents ? "tier-nice" : "tier-ok"}`}>
            <ResultReaction score={roundResult.score} goodThreshold={600} badThreshold={200} />
            <div className="result-header">
              <h3 className={`result-title ${roundResult.cartTotalCents <= roundResult.budgetCents ? "tier-nice" : "tier-ok"}`}>
                {roundResult.cartTotalCents <= roundResult.budgetCents
                  ? "Under Budget!"
                  : "Over Budget!"}
              </h3>
            </div>

            <div className="budget-builder-reveal">
              {roundResult.products
                .filter((p: ProductWithPrice) => roundResult.selectedProductIds.includes(p.id))
                .map((p: ProductWithPrice) => (
                  <div key={p.id} className="budget-builder-reveal-card">
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
                    <div className="budget-builder-reveal-info">
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

            <div className="budget-builder-totals">
              <div className="market-basket-total-row">
                <span className="result-price-label">Cart Total:</span>
                <span className={`result-price-value ${roundResult.cartTotalCents <= roundResult.budgetCents ? "text-green" : "text-red"}`}>
                  {formatPrice(roundResult.cartTotalCents)}
                </span>
              </div>
              <div className="market-basket-total-row">
                <span className="result-price-label">Budget:</span>
                <span className="result-price-value">{formatPrice(roundResult.budgetCents)}</span>
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
