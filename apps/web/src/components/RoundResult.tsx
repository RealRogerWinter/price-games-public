import { useEffect, useState, useRef } from "react";
import type { RoundResult as RoundResultType } from "@price-game/shared";
import { useCurrency } from "../context/CurrencyContext";
import { useSound } from "../audio/SoundContext";
import ResultReaction from "./ResultReaction";
import ImageModal from "./ImageModal";
import { AmazonCTA } from "./AmazonCTA";
import { reportImageFailure } from "../lib/imageDiagnostics";
import { getAccuracyLabel } from "../lib/accuracyLabel";

interface RoundResultProps {
  result: RoundResultType;
  isLastRound: boolean;
  onNextRound: () => void;
  usedHint?: boolean;
}

function createConfettiParticles(count: number): Array<{
  id: number;
  x: number;
  delay: number;
  duration: number;
  color: string;
  size: number;
}> {
  const colors = ["#f6c90e", "#4ecca3", "#e23e57", "#ff6b6b", "#48dbfb", "#ff9ff3", "#feca57"];
  return Array.from({ length: count }, (_, i) => ({
    id: i,
    x: Math.random() * 100,
    delay: Math.random() * 0.5,
    duration: 1.5 + Math.random() * 1.5,
    color: colors[Math.floor(Math.random() * colors.length)],
    size: 6 + Math.random() * 8,
  }));
}

export default function RoundResult({
  result,
  isLastRound,
  onNextRound,
  usedHint,
}: RoundResultProps) {
  const { formatPrice } = useCurrency();
  const { play } = useSound();
  const { text: accuracyText, className: tierClass } = getAccuracyLabel(result.pctOff);
  const pctOffDisplay = `${(result.pctOff * 100).toFixed(1)}%`;
  const diff = result.guessedPriceCents - result.product.priceCents;
  const isOver = diff > 0;
  const isUnder = diff < 0;
  const showConfetti = result.score >= 400;
  const showBigConfetti = result.score >= 850;

  const [animatedScore, setAnimatedScore] = useState(0);
  const [showParticles, setShowParticles] = useState(false);
  const [zoomedImage, setZoomedImage] = useState(false);
  const confettiRef = useRef(createConfettiParticles(showBigConfetti ? 40 : 20));

  // Play result tier sound on mount. Thresholds track the tier label buckets
  // so the audio tone always matches the on-screen snark.
  useEffect(() => {
    if (result.pctOff === 0) play("result_exact");
    else if (result.pctOff <= 0.07) play("result_great");
    else if (result.pctOff <= 0.30) play("result_good");
    else if (result.pctOff <= 0.60) play("result_poor");
    else play("result_miss");
  }, [result.pctOff, play]);

  // Animate score counting up with sound
  useEffect(() => {
    if (result.score === 0) {
      setAnimatedScore(0);
      return;
    }
    const duration = 800;
    const steps = 30;
    const increment = result.score / steps;
    let current = 0;
    let tickCount = 0;
    const interval = setInterval(() => {
      current += increment;
      // Play tick sound every 5th step to avoid overwhelming audio
      if (tickCount % 5 === 0) play("score_counting");
      tickCount++;
      if (current >= result.score) {
        setAnimatedScore(result.score);
        clearInterval(interval);
      } else {
        setAnimatedScore(Math.round(current));
      }
    }, duration / steps);
    return () => clearInterval(interval);
  }, [result.score, play]);

  // Trigger confetti with sound
  useEffect(() => {
    if (showConfetti) {
      play("confetti");
      setShowParticles(true);
      const timer = setTimeout(() => setShowParticles(false), 3000);
      return () => clearTimeout(timer);
    }
  }, [showConfetti, play]);

  return (
    <div className={`round-result ${tierClass}`}>
      <ResultReaction score={result.score} />
      {/* Confetti overlay */}
      {showParticles && (
        <div className="confetti-container">
          {confettiRef.current.map((p) => (
            <div
              key={p.id}
              className="confetti-particle"
              style={{
                left: `${p.x}%`,
                animationDelay: `${p.delay}s`,
                animationDuration: `${p.duration}s`,
                backgroundColor: p.color,
                width: `${p.size}px`,
                height: `${p.size}px`,
              }}
            />
          ))}
        </div>
      )}

      <div className="result-header">
        <h3 className={`result-title ${tierClass}`}>{accuracyText}</h3>
        <span className="result-pct-off">
          {result.pctOff === 0 ? "Spot on!" : `${pctOffDisplay} off`}
        </span>
      </div>

      <div className="result-prices">
        <div className="result-price-row">
          <span className="result-price-label">Actual Price</span>
          <span className="result-price-value">
            {formatPrice(result.product.priceCents)}
          </span>
        </div>
        <div className="result-price-row">
          <span className="result-price-label">Your Guess</span>
          <span className="result-price-value">
            {formatPrice(result.guessedPriceCents)}
          </span>
        </div>
        <div className="result-price-row">
          <span className="result-price-label">Difference</span>
          <span className={`result-price-value ${result.score >= 400 ? "text-green" : result.score > 0 ? "text-yellow" : "text-red"}`}>
            {formatPrice(Math.abs(diff))}
            {isOver ? " over" : isUnder ? " under" : ""}
          </span>
        </div>
      </div>

      {/* Product card */}
      <div className="result-product-card">
        <img
          key={result.product.id}
          src={result.product.imageUrl}
          alt={result.product.title}
          className="result-product-img"
          decoding="sync"
          style={{ cursor: "zoom-in" }}
          onClick={() => setZoomedImage(true)}
          onError={(e) => {
            reportImageFailure({ productId: result.product.id, src: result.product.imageUrl, phase: "error" });
            (e.target as HTMLImageElement).style.display = "none";
          }}
        />
        <div className="result-product-info">
          <p className="result-product-title">{result.product.title}</p>
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

      {/* Score with animated count-up */}
      <div className={`result-score ${result.score >= 400 ? "score-glow" : ""}`}>
        <span className="result-score-label">Points Earned</span>
        <span className={`result-score-value ${result.score === 0 ? "score-zero" : ""}`}>
          +{animatedScore}
        </span>
      </div>

      {usedHint && (
        <div className="hint-used-badge">Hint was used this round</div>
      )}

      <button className="btn btn-primary" onClick={onNextRound} data-testid="round-result-next">
        {isLastRound ? "See Final Results" : "Next Round"}
      </button>

      {zoomedImage && (
        <ImageModal src={result.product.imageUrl} alt={result.product.title} onClose={() => setZoomedImage(false)} />
      )}
    </div>
  );
}
