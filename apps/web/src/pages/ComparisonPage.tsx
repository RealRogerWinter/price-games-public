import { useState, useEffect, useCallback } from "react";
import type { GameSession, ComparisonRoundResult, Product, ProductWithPrice, DailyCompletionPayload } from "@price-game/shared";
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
import ComparisonPrompt from "../components/ComparisonPrompt";
import { AmazonCTA } from "../components/AmazonCTA";

interface ComparisonPageProps {
  session: GameSession;
  onRoundComplete: (result: ComparisonRoundResult, session: GameSession, dailyPayload?: DailyCompletionPayload) => void;
  onGameEnd: () => void;
}

interface ComparisonData {
  products: Product[];
  question: "most-expensive" | "least-expensive";
}

const FALLBACK_SVG =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300"><rect width="300" height="300" fill="#1a1a2e"/><text x="50%" y="45%" text-anchor="middle" font-size="48" fill="#4ecca3">$?</text></svg>'
  );

export default function ComparisonPage({ session, onRoundComplete, onGameEnd }: ComparisonPageProps) {
  const { formatPrice } = useCurrency();
  const [data, setData] = useState<ComparisonData | null>(null);
  const [loading, setLoading] = useState(false);
  const [roundResult, setRoundResult] = useState<ComparisonRoundResult | null>(null);
  const [currentRound, setCurrentRound] = useState(session.currentRound);
  const [hasGuessed, setHasGuessed] = useState(false);
  const [animatedScore, setAnimatedScore] = useState(0);
  const [zoomedImage, setZoomedImage] = useState<{ src: string; alt: string } | null>(null);

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
    if (!hasGuessed && !roundResult && data?.products.length) {
      soundEngine.play("timer_expire");
      doGuess(data.products[0].id, true);
    }
  }, [hasGuessed, roundResult, data]);

  const timer = useTimer(ROUND_TIME_SECONDS, handleTimerExpire);

  const fetchProducts = useCallback(async () => {
    setLoading(true);
    setRoundResult(null);
    setHasGuessed(false);
    try {
      const d = await api.getProduct(session.id);
      setData(d as unknown as ComparisonData);
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

  async function doGuess(productId: number, timedOut?: boolean) {
    if (hasGuessed) return;
    setHasGuessed(true);
    timer.stop();
    if (!timedOut) soundEngine.play("guess_submit");
    try {
      const response = await api.submitComparisonGuess(session.id, productId, timedOut);
      setRoundResult(response.result);
      soundEngine.play(response.result.correct ? "correct" : "incorrect");
      onRoundComplete(response.result, response.session, response.daily);
    } catch (err) {
      console.error("Failed to submit guess:", err);
      setHasGuessed(false);
    }
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
      <div className="page game-page" data-testid="game-page-comparison" data-mode="comparison">
        <Scoreboard currentRound={currentRound} totalRounds={session.totalRounds} score={session.totalScore} />
        <div className="loading">Loading products...</div>
      </div>
    );
  }

  return (
    <div className="page game-page comparison-page" data-testid="game-page-comparison" data-mode="comparison" data-question={data.question}>
      <div className="game-header">
        <Scoreboard currentRound={currentRound} totalRounds={session.totalRounds} score={session.totalScore} />
        <Timer secondsLeft={timer.secondsLeft} isRunning={timer.isRunning} paused={false} />
      </div>

      <ComparisonPrompt question={data.question} roundKey={currentRound} />

      <div className="comparison-products" data-testid="comparison-products">
        {data.products.map((product) => (
          <button
            key={product.id}
            className="comparison-card"
            onClick={() => doGuess(product.id)}
            disabled={hasGuessed}
            data-testid="comparison-card"
            data-product-id={product.id}
          >
            <div className="comparison-image-wrapper" onClick={(e) => { e.stopPropagation(); setZoomedImage({ src: product.imageUrl, alt: product.title }); }}>
              <img
                src={product.imageUrl}
                alt={product.title}
                onError={(e) => {
                  (e.target as HTMLImageElement).src = FALLBACK_SVG;
                }}
              />
            </div>
            <span className="category-badge">{product.category}</span>
            <ProductTooltip product={product} showAmazonLink={false} disabled>
              <h3 className="comparison-title product-name-hoverable">{product.title}</h3>
            </ProductTooltip>
          </button>
        ))}
      </div>

      {roundResult && (
        <div className="result-overlay">
          <div className={`round-result ${roundResult.correct ? "tier-nice" : "tier-miss"}`}>
            <ResultReaction score={roundResult.score} goodThreshold={400} badThreshold={0} />
            <div className="result-header">
              <h3 className={`result-title ${roundResult.correct ? "tier-nice" : "tier-miss"}`}>
                {roundResult.correct ? "Correct!" : "Wrong!"}
              </h3>
            </div>

            <div className="comparison-reveal">
              {roundResult.products.map((p: ProductWithPrice) => (
                <div
                  key={p.id}
                  className={`comparison-reveal-card ${
                    p.id === roundResult.correctProductId ? "correct-product" : ""
                  } ${p.id === roundResult.guessedProductId && !roundResult.correct ? "wrong-product" : ""}`}
                >
                  <div className="comparison-image-wrapper small" onClick={() => setZoomedImage({ src: p.imageUrl, alt: p.title })}>
                    <img
                      src={p.imageUrl}
                      alt={p.title}
                      onError={(e) => {
                        (e.target as HTMLImageElement).src = FALLBACK_SVG;
                      }}
                    />
                  </div>
                  <div className="comparison-reveal-info">
                    <ProductTooltip product={p}>
                      <h4 className="comparison-reveal-title product-name-hoverable">{p.title}</h4>
                    </ProductTooltip>
                    <span className="comparison-price">{formatPrice(p.priceCents)}</span>
                    {p.id === roundResult.correctProductId && (
                      <span className="comparison-badge correct-badge">
                        {roundResult.question === "most-expensive" ? "More Expensive" : "Less Expensive"}
                      </span>
                    )}
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
