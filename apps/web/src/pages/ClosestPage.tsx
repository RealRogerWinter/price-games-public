import type { GameSession, ClosestRoundResult, DailyCompletionPayload } from "@price-game/shared";
import { ROUND_TIME_SECONDS } from "@price-game/shared";
import { useState, useEffect, useCallback } from "react";
import * as api from "../api/client";
import { useCurrency } from "../context/CurrencyContext";
import { useTimer } from "../hooks/useTimer";
import ProductCard from "../components/ProductCard";
import PriceInput from "../components/PriceInput";
import Timer from "../components/Timer";
import Scoreboard from "../components/Scoreboard";
import type { Product } from "@price-game/shared";
import ResultReaction from "../components/ResultReaction";
import ImageModal from "../components/ImageModal";
import { soundEngine } from "../audio/SoundEngine";
import ProductTooltip from "../components/ProductTooltip";
import { AmazonCTA } from "../components/AmazonCTA";
import { reportImageFailure } from "../lib/imageDiagnostics";

interface ClosestPageProps {
  session: GameSession;
  onRoundComplete: (result: ClosestRoundResult, session: GameSession, dailyPayload?: DailyCompletionPayload) => void;
  onGameEnd: () => void;
}

export default function ClosestPage({ session, onRoundComplete, onGameEnd }: ClosestPageProps) {
  const { formatPrice } = useCurrency();
  const [product, setProduct] = useState<Product | null>(null);
  const [loading, setLoading] = useState(false);
  const [roundResult, setRoundResult] = useState<ClosestRoundResult | null>(null);
  const [currentRound, setCurrentRound] = useState(session.currentRound);
  const [hasGuessed, setHasGuessed] = useState(false);
  const [hintRange, setHintRange] = useState<{ min: number; max: number } | null>(null);
  const [hintUsed, setHintUsed] = useState(false);
  const [hintLoading, setHintLoading] = useState(false);
  const [timerStarted, setTimerStarted] = useState(false);
  const [animatedScore, setAnimatedScore] = useState(0);
  const [zoomedImage, setZoomedImage] = useState<{ src: string; alt: string } | null>(null);

  const handleTimerExpire = useCallback(() => {
    if (!hasGuessed && !roundResult) {
      soundEngine.play("timer_expire");
      doGuess(0, true);
    }
  }, [hasGuessed, roundResult]);

  const timer = useTimer(ROUND_TIME_SECONDS, handleTimerExpire);

  const activateTimer = useCallback(() => {
    if (!timerStarted && !hasGuessed && !roundResult) {
      setTimerStarted(true);
      timer.start();
    }
  }, [timerStarted, hasGuessed, roundResult, timer]);

  const fetchProduct = useCallback(async (round: number) => {
    setLoading(true);
    setRoundResult(null);
    setHasGuessed(false);
    setHintRange(null);
    setHintUsed(false);
    setTimerStarted(false);
    setAnimatedScore(0);
    try {
      const p = await api.getProduct(session.id);
      setProduct(p);
      // Auto-start timer on rounds after the first
      if (round > 1) {
        setTimerStarted(true);
        timer.start();
      }
    } catch (err) {
      console.error("Failed to fetch product:", err);
    } finally {
      setLoading(false);
    }
  }, [session.id, timer]);

  useEffect(() => {
    fetchProduct(currentRound);
  }, [currentRound]);

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

  async function doGuess(guessedPriceCents: number, timedOut?: boolean) {
    if (hasGuessed) return;
    setHasGuessed(true);
    timer.stop();
    if (!timedOut) soundEngine.play("guess_submit");
    try {
      const response = await api.submitClosestGuess(session.id, guessedPriceCents, timedOut);
      setRoundResult(response.result);
      // Result sound: went over = miss, high score = great, otherwise good
      if (response.result.wentOver) soundEngine.play("result_miss");
      else if (response.result.score >= 750) soundEngine.play("result_great");
      else if (response.result.score >= 400) soundEngine.play("result_good");
      else soundEngine.play("result_poor");
      onRoundComplete(response.result, response.session, response.daily);
    } catch (err) {
      console.error("Failed to submit guess:", err);
      setHasGuessed(false);
    }
  }

  async function useHint() {
    if (hintUsed || hintLoading || hasGuessed) return;
    activateTimer();
    setHintLoading(true);
    try {
      const data = await api.getHint(session.id);
      setHintRange(data.hintRange);
      setHintUsed(true);
    } catch (err) {
      console.error("Failed to get hint:", err);
    } finally {
      setHintLoading(false);
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

  if (loading || !product) {
    return (
      <div className="page game-page" data-testid={`game-page-${session.gameMode}`} data-mode={session.gameMode}>
        <Scoreboard currentRound={currentRound} totalRounds={session.totalRounds} score={session.totalScore} />
        <div className="loading">Loading product...</div>
      </div>
    );
  }

  return (
    <div className="page game-page closest-page" data-testid={`game-page-${session.gameMode}`} data-mode={session.gameMode}>
      <div className="game-header">
        <Scoreboard currentRound={currentRound} totalRounds={session.totalRounds} score={session.totalScore} />
        <Timer
          secondsLeft={timer.secondsLeft}
          isRunning={timer.isRunning}
          paused={!timerStarted && !hasGuessed && !roundResult}
        />
      </div>

      <ProductCard key={product.id} product={product} hideAmazonLink />

      <div className="closest-warning">
        {session.gameMode === "bidding"
          ? "Bid the price — but don't go over, or you'll score zero!"
          : "Guess close — but stay under the real price!"}
      </div>

      {!roundResult && (
        <>
          {!timerStarted && !hasGuessed && currentRound === 1 && (
            <div className="timer-hint">Timer starts when you interact</div>
          )}
          <PriceInput
            category={product.category}
            priceRange={hintRange ?? product.priceRange}
            onSubmit={doGuess}
            disabled={hasGuessed}
            onInteract={activateTimer}
          />
          {!hintUsed && !hasGuessed && (
            <button className="btn btn-hint" onClick={useHint} disabled={hintLoading} data-testid="btn-hint">
              {hintLoading ? "Getting hint..." : "Use Hint"}
            </button>
          )}
          {hintRange && (
            <div className="hint-badge">Hint active — price narrowed to a tighter range</div>
          )}
        </>
      )}

      {roundResult && (
        <div className="result-overlay">
          <div className={`round-result ${roundResult.wentOver ? "tier-miss" : roundResult.score >= 500 ? "tier-nice" : "tier-ok"}`}>
            <ResultReaction score={roundResult.score} />
            <div className="result-header">
              {roundResult.wentOver ? (
                <>
                  <h3 className="result-title tier-miss">YOU WENT OVER!</h3>
                  <span className="result-pct-off">Over by {(roundResult.pctOff * 100).toFixed(1)}%</span>
                </>
              ) : session.gameMode === "bidding" ? (
                // Single-player bidding (daily challenge). Scoring is binary —
                // under = 1000, exact = 1500 — so ClosestPage's tiered
                // labels ("So Close!" / "Nice!" / "Way Under") don't apply.
                <>
                  <h3 className={`result-title ${roundResult.score >= 1500 ? "tier-close" : "tier-nice"}`}>
                    {roundResult.score >= 1500 ? "Exact price!" : "Safe bid!"}
                  </h3>
                  <span className="result-pct-off">
                    {roundResult.pctOff === 0 ? "Spot on!" : `${(roundResult.pctOff * 100).toFixed(1)}% under`}
                  </span>
                </>
              ) : (
                <>
                  <h3 className={`result-title ${roundResult.score >= 750 ? "tier-close" : roundResult.score >= 500 ? "tier-nice" : "tier-ok"}`}>
                    {roundResult.score >= 900
                      ? "Incredible!"
                      : roundResult.score >= 750
                      ? "So Close!"
                      : roundResult.score >= 500
                      ? "Nice!"
                      : roundResult.score >= 250
                      ? "Not Bad"
                      : "Way Under"}
                  </h3>
                  <span className="result-pct-off">
                    {roundResult.pctOff === 0 ? "Spot on!" : `${(roundResult.pctOff * 100).toFixed(1)}% under`}
                  </span>
                </>
              )}
            </div>

            <div className="result-prices">
              <div className="result-price-row">
                <span className="result-price-label">Actual Price</span>
                <span className="result-price-value">{formatPrice(roundResult.product.priceCents)}</span>
              </div>
              <div className="result-price-row">
                <span className="result-price-label">Your Guess</span>
                <span className={`result-price-value ${roundResult.wentOver ? "text-red" : "text-green"}`}>
                  {formatPrice(roundResult.guessedPriceCents)}
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

            <div className={`result-score ${roundResult.score >= 500 ? "score-glow" : ""}`}>
              <span className="result-score-label">Points Earned</span>
              <span className={`result-score-value ${roundResult.score === 0 ? "score-zero" : ""}`}>
                +{animatedScore}
              </span>
            </div>

            {hintUsed && <div className="hint-used-badge">Hint was used this round</div>}

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
