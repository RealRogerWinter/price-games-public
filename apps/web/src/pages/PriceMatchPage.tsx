import { useState, useEffect, useCallback } from "react";
import type { GameSession, ProductWithPrice, DailyCompletionPayload } from "@price-game/shared";
import * as api from "../api/client";
import { useCurrency } from "../context/CurrencyContext";
import ResultReaction from "../components/ResultReaction";
import ImageModal from "../components/ImageModal";
import { soundEngine } from "../audio/SoundEngine";
import ProductTooltip from "../components/ProductTooltip";
import { AmazonCTA } from "../components/AmazonCTA";
import Scoreboard from "../components/Scoreboard";

interface PriceMatchPageProps {
  session: GameSession;
  onRoundComplete: (result: any, updatedSession: GameSession, dailyPayload?: DailyCompletionPayload) => void;
  onGameEnd: () => void;
}

interface PriceMatchData {
  products: { id: number; title: string; imageUrl: string; description: string; category: string; amazonUrl?: string }[];
  prices: number[];
}

export default function PriceMatchPage({ session, onRoundComplete, onGameEnd }: PriceMatchPageProps) {
  const { formatPrice } = useCurrency();
  const [round, setRound] = useState(session.currentRound);
  const [totalScore, setTotalScore] = useState(session.totalScore);
  const [data, setData] = useState<PriceMatchData | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedProduct, setSelectedProduct] = useState<number | null>(null);
  const [assignments, setAssignments] = useState<Record<number, number>>({});
  const [availablePrices, setAvailablePrices] = useState<number[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [gameEnded, setGameEnded] = useState(false);
  const [animatedScore, setAnimatedScore] = useState(0);
  const [expandedProduct, setExpandedProduct] = useState<number | null>(null);
  const [zoomedImage, setZoomedImage] = useState<{ src: string; alt: string } | null>(null);

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

  const loadProduct = useCallback(async () => {
    setLoading(true);
    setResult(null);
    setAssignments({});
    setSelectedProduct(null);
    try {
      const d = await api.getProduct(session.id) as unknown as PriceMatchData;
      setData(d);
      setAvailablePrices([...d.prices]);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, [session.id]);

  useEffect(() => {
    loadProduct();
  }, [loadProduct, round]);

  function handleProductClick(productId: number) {
    if (result) return;
    // If this product already has a price, unassign it
    if (assignments[productId] !== undefined) {
      const price = assignments[productId];
      setAvailablePrices((prev) => [...prev, price].sort((a, b) => a - b));
      setAssignments((prev) => {
        const next = { ...prev };
        delete next[productId];
        return next;
      });
      soundEngine.play("item_deselect");
      setSelectedProduct(null);
      return;
    }
    soundEngine.play("item_select");
    setSelectedProduct(productId);
  }

  function handlePriceClick(price: number) {
    if (result || selectedProduct === null) return;
    // Assign price to selected product
    setAssignments((prev) => ({ ...prev, [selectedProduct]: price }));
    setAvailablePrices((prev) => {
      const idx = prev.indexOf(price);
      if (idx === -1) return prev;
      const next = [...prev];
      next.splice(idx, 1);
      return next;
    });
    soundEngine.play("guess_submit");
    setSelectedProduct(null);
  }

  async function handleSubmit() {
    if (!data || submitting) return;
    if (Object.keys(assignments).length !== data.products.length) return;

    setSubmitting(true);
    soundEngine.play("guess_submit");
    try {
      const resp = await api.submitPriceMatchGuess(session.id, assignments);
      setResult(resp.result);
      soundEngine.play(resp.result.correctCount === data.products.length ? "result_exact" : resp.result.correctCount > 0 ? "result_good" : "result_miss");
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

  function handleNext() {
    if (gameEnded) {
      onGameEnd();
      return;
    }
    soundEngine.play("next_round");
    setRound((r) => r + 1);
  }

  if (loading) {
    return (
      <div className="page price-match-page" data-testid="game-page-price-match" data-mode="price-match">
        <div className="loading">Loading round...</div>
      </div>
    );
  }

  if (!data) return null;

  const allAssigned = Object.keys(assignments).length === data.products.length;

  return (
    <div className="page price-match-page" data-testid="game-page-price-match" data-mode="price-match">
      <Scoreboard currentRound={round} totalRounds={session.totalRounds} score={totalScore} />

      <h2 className="pm-title">Match each product to its price</h2>

      {!result && selectedProduct !== null && (
        <p className="pm-instruction">Now pick a price for the highlighted product</p>
      )}
      {!result && selectedProduct === null && !allAssigned && (
        <p className="pm-instruction">Tap a product, then tap a price to assign it</p>
      )}

      <div className="pm-products">
        {data.products.map((product) => {
          const assigned = assignments[product.id];
          const isSelected = selectedProduct === product.id;
          const isExpanded = expandedProduct === product.id && !result;
          const isCorrect = result && result.products
            ? result.products.find((p: ProductWithPrice) => p.id === product.id)?.priceCents === assigned
            : null;

          return (
            <div
              key={product.id}
              className={`pm-product-card ${isSelected ? "pm-selected" : ""} ${
                isExpanded ? "pm-expanded" : ""
              } ${result ? (isCorrect ? "pm-correct" : "pm-wrong") : ""}`}
              onClick={() => {
                if (!result && expandedProduct !== product.id) {
                  setExpandedProduct(product.id);
                }
                handleProductClick(product.id);
              }}
              onMouseEnter={() => { if (!result) setExpandedProduct(product.id); }}
              onMouseLeave={() => { if (!result) setExpandedProduct(null); }}
              data-testid="pm-product-card"
              data-product-id={product.id}
              data-selected={isSelected ? "true" : "false"}
              data-assigned-cents={assigned ?? ""}
            >
              <img
                src={product.imageUrl}
                alt={product.title}
                className="pm-product-img"
                style={{ cursor: "zoom-in" }}
                onClick={(e) => { e.stopPropagation(); setZoomedImage({ src: product.imageUrl, alt: product.title }); }}
                onError={(e) => {
                  (e.target as HTMLImageElement).style.display = "none";
                }}
              />
              <ProductTooltip product={product} showAmazonLink={false} disabled>
                <p className="pm-product-title product-name-hoverable">{product.title}</p>
              </ProductTooltip>
              {assigned !== undefined && (
                <span className="pm-assigned-price">{formatPrice(assigned)}</span>
              )}
              {result && (
                <span className="pm-actual-price">
                  Actual: {formatPrice(
                    result.products.find((p: ProductWithPrice) => p.id === product.id)?.priceCents || 0
                  )}
                </span>
              )}
            </div>
          );
        })}
      </div>

      {!result && (
        <div className="pm-prices" data-testid="pm-prices">
          {availablePrices.map((price, idx) => (
            <button
              key={`${price}-${idx}`}
              className={`pm-price-btn ${selectedProduct !== null ? "pm-price-active" : ""}`}
              onClick={() => handlePriceClick(price)}
              disabled={selectedProduct === null}
              data-testid="pm-price-btn"
              data-price-cents={price}
            >
              {formatPrice(price)}
            </button>
          ))}
        </div>
      )}

      {!result && allAssigned && (
        <button className="btn btn-primary pm-submit" onClick={handleSubmit} disabled={submitting} data-testid="pm-submit">
          {submitting ? "Checking..." : "Lock In Answers"}
        </button>
      )}

      {result && (
        <div className="result-overlay">
        <div className={`round-result ${result.correctCount === data.products.length ? "tier-nice" : result.correctCount > 0 ? "tier-ok" : "tier-miss"}`}>
          <ResultReaction score={result.score} goodThreshold={600} badThreshold={200} />
          <div className="result-header">
            <h3 className={`result-title ${result.correctCount === data.products.length ? "tier-nice" : result.correctCount > 0 ? "tier-ok" : "tier-miss"}`}>
              {result.correctCount === data.products.length
                ? "Perfect Match!"
                : result.correctCount > 0
                ? `${result.correctCount} of ${data.products.length} Correct`
                : "No Matches!"}
            </h3>
          </div>

          <div className="pm-reveal-products">
            {result.products.map((p: ProductWithPrice) => {
              const guessedPrice = result.assignments[p.id];
              const isCorrect = guessedPrice === p.priceCents;
              return (
                <div key={p.id} className={`pm-reveal-card ${isCorrect ? "correct-product" : "wrong-product"}`}>
                  <img
                    src={p.imageUrl}
                    alt={p.title}
                    className="pm-reveal-img"
                    style={{ cursor: "zoom-in" }}
                    onClick={() => setZoomedImage({ src: p.imageUrl, alt: p.title })}
                    onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
                  />
                  <div className="pm-reveal-info">
                    <ProductTooltip product={p}>
                      <p className="pm-reveal-title product-name-hoverable">{p.title}</p>
                    </ProductTooltip>
                    <div className="pm-reveal-prices">
                      <span className="result-price-label">Actual:</span>
                      <span className="result-price-value text-green">{formatPrice(p.priceCents)}</span>
                      {guessedPrice !== undefined && guessedPrice !== p.priceCents && (
                        <>
                          <span className="result-price-label">Your guess:</span>
                          <span className="result-price-value text-red">{formatPrice(guessedPrice)}</span>
                        </>
                      )}
                    </div>
                    {p.amazonUrl && (
                      <AmazonCTA
                        href={p.amazonUrl}
                        size="sm"
                        productLabel={p.title}
                      />
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          <div className={`result-score ${result.score > 0 ? "score-glow" : ""}`}>
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
