import { useState, useEffect, useCallback, useRef } from "react";
import type { GameSession, HigherLowerRoundResult, DailyCompletionPayload } from "@price-game/shared";
import { ROUND_TIME_SECONDS } from "@price-game/shared";
import * as api from "../api/client";
import { useCurrency } from "../context/CurrencyContext";
import { useTimer } from "../hooks/useTimer";
import ProductCard from "../components/ProductCard";
import Timer from "../components/Timer";
import Scoreboard from "../components/Scoreboard";
import ResultReaction from "../components/ResultReaction";
import ImageModal from "../components/ImageModal";
import { soundEngine } from "../audio/SoundEngine";
import ProductTooltip from "../components/ProductTooltip";
import { AmazonCTA } from "../components/AmazonCTA";
import { reportImageFailure } from "../lib/imageDiagnostics";

interface HigherLowerPageProps {
  session: GameSession;
  onRoundComplete: (result: HigherLowerRoundResult, session: GameSession, dailyPayload?: DailyCompletionPayload) => void;
  onGameEnd: () => void;
}

interface HigherLowerData {
  product: { id: number; title: string; imageUrl: string; description: string; category: string; amazonUrl?: string; priceRange?: { min: number; max: number } };
  referencePrice: number;
}

export default function HigherLowerPage({ session, onRoundComplete, onGameEnd }: HigherLowerPageProps) {
  const { formatPrice } = useCurrency();
  const [data, setData] = useState<HigherLowerData | null>(null);
  const [loading, setLoading] = useState(false);
  const [roundResult, setRoundResult] = useState<HigherLowerRoundResult | null>(null);
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
    if (!hasGuessed && !roundResult) {
      soundEngine.play("timer_expire");
      doGuess("lower", true);
    }
  }, [hasGuessed, roundResult]);

  const timer = useTimer(ROUND_TIME_SECONDS, handleTimerExpire);

  const fetchProduct = useCallback(async () => {
    setLoading(true);
    setRoundResult(null);
    setHasGuessed(false);
    try {
      const d = await api.getProduct(session.id);
      setData(d as unknown as HigherLowerData);
      timer.start();
    } catch (err) {
      console.error("Failed to fetch product:", err);
    } finally {
      setLoading(false);
    }
  }, [session.id]);

  useEffect(() => {
    fetchProduct();
  }, [currentRound]);

  async function doGuess(guess: "higher" | "lower", timedOut?: boolean) {
    if (hasGuessed) return;
    setHasGuessed(true);
    timer.stop();
    if (!timedOut) soundEngine.play("guess_submit");
    try {
      const response = await api.submitHigherLowerGuess(session.id, guess, timedOut);
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
      <div className="page game-page" data-testid="game-page-higher-lower" data-mode="higher-lower">
        <Scoreboard currentRound={currentRound} totalRounds={session.totalRounds} score={session.totalScore} />
        <div className="loading">Loading product...</div>
      </div>
    );
  }

  return (
    <div className="page game-page higher-lower-page" data-testid="game-page-higher-lower" data-mode="higher-lower">
      <div className="game-header">
        <Scoreboard currentRound={currentRound} totalRounds={session.totalRounds} score={session.totalScore} />
        <Timer secondsLeft={timer.secondsLeft} isRunning={timer.isRunning} paused={false} />
      </div>

      <ProductCard key={data.product.id} product={data.product} hideAmazonLink />

      <div className="hl-guess-section">
        <div className="hl-reference">
          <span className="hl-reference-label">Is the real price higher or lower than</span>
          <span className="hl-reference-price">{formatPrice(data.referencePrice)}</span>
          <span className="hl-reference-label">?</span>
        </div>
        <div className="hl-buttons">
          <button
            className="btn btn-higher"
            onClick={() => doGuess("higher")}
            disabled={hasGuessed}
            data-testid="higher-lower-higher"
          >
            Higher
          </button>
          <button
            className="btn btn-lower"
            onClick={() => doGuess("lower")}
            disabled={hasGuessed}
            data-testid="higher-lower-lower"
          >
            Lower
          </button>
        </div>
      </div>

      {roundResult && (
        <div className="result-overlay">
          <div className={`round-result ${roundResult.correct ? "tier-nice" : "tier-miss"}`}>
            <ResultReaction score={roundResult.score} goodThreshold={200} badThreshold={0} />
            <div className="result-header">
              <h3 className={`result-title ${roundResult.correct ? "tier-nice" : "tier-miss"}`}>
                {roundResult.correct ? "Correct!" : "Wrong!"}
              </h3>
            </div>

            <div className="result-prices">
              <div className="result-price-row">
                <span className="result-price-label">Reference Price</span>
                <span className="result-price-value">{formatPrice(roundResult.referencePrice)}</span>
              </div>
              <div className="result-price-row">
                <span className="result-price-label">Actual Price</span>
                <span className="result-price-value text-green">{formatPrice(roundResult.product.priceCents)}</span>
              </div>
              <div className="result-price-row">
                <span className="result-price-label">Your Answer</span>
                <span className={`result-price-value ${roundResult.correct ? "text-green" : "text-red"}`}>
                  {roundResult.guess === "higher" ? "Higher" : "Lower"}
                </span>
              </div>
            </div>

            <div className="result-product-card">
              <img
                key={roundResult.product.id}
                src={roundResult.product.imageUrl}
                alt={roundResult.product.title}
                className="result-product-img"
                decoding="sync"
                style={{ cursor: "zoom-in" }}
                onClick={() => setZoomedImage({ src: roundResult.product.imageUrl, alt: roundResult.product.title })}
                onError={(e) => {
                  reportImageFailure({ productId: roundResult.product.id, src: roundResult.product.imageUrl, phase: "error" });
                  (e.target as HTMLImageElement).style.display = "none";
                }}
              />
              <div className="result-product-info">
                <ProductTooltip product={roundResult.product}>
                  <p className="result-product-title product-name-hoverable">{roundResult.product.title}</p>
                </ProductTooltip>
                {roundResult.product.amazonUrl && (
                  <AmazonCTA
                    href={roundResult.product.amazonUrl}
                    size="md"
                    productLabel={roundResult.product.title}
                    showDisclosure
                  />
                )}
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
