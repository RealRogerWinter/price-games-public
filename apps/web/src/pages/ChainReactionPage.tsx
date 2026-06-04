import { useState, useEffect, useCallback, useRef } from "react";
import type { GameSession, ChainReactionRoundResult, Product, ProductWithPrice, DailyCompletionPayload } from "@price-game/shared";
import { SP_CHAIN_REACTION_SUB_TIME_SECONDS } from "@price-game/shared";
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

interface ChainReactionPageProps {
  session: GameSession;
  onRoundComplete: (result: ChainReactionRoundResult, session: GameSession, dailyPayload?: DailyCompletionPayload) => void;
  onGameEnd: () => void;
}

interface ChainReactionData {
  products: Product[];
}

/** Price that has been revealed after a sub-guess. */
interface RevealedLink {
  product: Product;
  guess: "more" | "less";
  revealedPriceCents: number;
}

const FALLBACK_SVG =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300"><rect width="300" height="300" fill="#1a1a2e"/><text x="50%" y="45%" text-anchor="middle" font-size="48" fill="#4ecca3">$?</text></svg>'
  );

/**
 * Game page for the Chain Reaction mode. Products are shown one at a time;
 * for each successive product the player guesses "More" or "Less" relative
 * to the previous product's revealed price. A local 15-second timer resets
 * after each sub-guess. All guesses are submitted together when the chain
 * is complete.
 * @param session - Current game session state
 * @param onRoundComplete - Callback fired after each round with its result
 * @param onGameEnd - Callback fired when the player finishes the last round
 */
export default function ChainReactionPage({ session, onRoundComplete, onGameEnd }: ChainReactionPageProps) {
  const { formatPrice } = useCurrency();
  const [data, setData] = useState<ChainReactionData | null>(null);
  const [loading, setLoading] = useState(false);
  const [roundResult, setRoundResult] = useState<ChainReactionRoundResult | null>(null);
  const [currentRound, setCurrentRound] = useState(session.currentRound);
  const [hasGuessed, setHasGuessed] = useState(false);
  const [animatedScore, setAnimatedScore] = useState(0);
  const [zoomedImage, setZoomedImage] = useState<{ src: string; alt: string } | null>(null);

  // Chain-specific state
  const [chainIndex, setChainIndex] = useState(0); // which product we're currently guessing about
  const [chainGuesses, setChainGuesses] = useState<("more" | "less")[]>([]);
  const [revealedLinks, setRevealedLinks] = useState<RevealedLink[]>([]);
  const [submitting, setSubmitting] = useState(false);

  // We use a ref for chainGuesses so the timer expiry callback sees the latest value
  const chainGuessesRef = useRef(chainGuesses);
  chainGuessesRef.current = chainGuesses;

  const chainIndexRef = useRef(chainIndex);
  chainIndexRef.current = chainIndex;

  const dataRef = useRef(data);
  dataRef.current = data;

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
    if (hasGuessed || roundResult || !dataRef.current) return;
    soundEngine.play("timer_expire");
    handleSubGuess("more", true);
  }, [hasGuessed, roundResult]);

  const timer = useTimer(SP_CHAIN_REACTION_SUB_TIME_SECONDS, handleTimerExpire);

  const fetchProducts = useCallback(async () => {
    setLoading(true);
    setRoundResult(null);
    setHasGuessed(false);
    setChainIndex(0);
    setChainGuesses([]);
    setRevealedLinks([]);
    setSubmitting(false);
    try {
      const d = await api.getProduct(session.id);
      setData(d as unknown as ChainReactionData);
      // Timer starts when user clicks "Start Chain", not on data load
    } catch (err) {
      console.error("Failed to fetch products:", err);
    } finally {
      setLoading(false);
    }
  }, [session.id]);

  useEffect(() => {
    fetchProducts();
  }, [currentRound]);

  // Preload every chain product's image as soon as the round's data arrives
  // so each setChainIndex transition swaps to a cached image immediately.
  // Without this, the new <img> can briefly flash the previous bitmap while
  // the network fetch runs — the bug surfaces as a "duplicate product image"
  // for ~50–200ms per chain step. Browsers cache by URL so a single
  // Image() with src= warms HTTP cache for the subsequent <img> renders.
  useEffect(() => {
    if (typeof window === "undefined" || !data?.products) return;
    const images: HTMLImageElement[] = [];
    for (const p of data.products) {
      if (!p.imageUrl) continue;
      const img = new window.Image();
      img.src = p.imageUrl;
      images.push(img);
    }
    return () => {
      // Drop refs so GC can reclaim. We don't cancel in-flight fetches —
      // the browser cache entry is the desired side effect either way.
      images.length = 0;
    };
  }, [data?.products]);

  /**
   * Handle a sub-guess for the current chain link. Reveals the previous
   * product's price locally and advances to the next product. When the chain
   * is complete, all guesses are submitted to the server at once.
   */
  async function handleSubGuess(guess: "more" | "less", _timedOut?: boolean) {
    if (hasGuessed || !data) return;
    soundEngine.play("chain_link");

    const currentIdx = chainIndexRef.current;
    const currentProduct = data.products[currentIdx];

    const newGuesses = [...chainGuessesRef.current, guess];
    setChainGuesses(newGuesses);

    // Reveal the current product in the chain (we don't actually know the price
    // client-side, so we store the product for display; actual prices come from the result)
    setRevealedLinks((prev) => [
      ...prev,
      { product: currentProduct, guess, revealedPriceCents: 0 },
    ]);

    const nextIndex = currentIdx + 1;

    // The chain has products.length items; the first is just shown, so we make
    // (products.length - 1) guesses total
    if (nextIndex >= data.products.length) {
      // Chain complete: submit all guesses
      setHasGuessed(true);
      timer.stop();
      soundEngine.play("guess_submit");
      setSubmitting(true);
      try {
        const response = await api.submitChainReactionGuess(session.id, newGuesses);
        setRoundResult(response.result);
        soundEngine.play(response.result.correctCount === response.result.chainLength ? "result_exact" : response.result.correctCount > 0 ? "result_good" : "result_miss");
        onRoundComplete(response.result, response.session, response.daily);
      } catch (err) {
        console.error("Failed to submit chain guesses:", err);
        setHasGuessed(false);
      } finally {
        setSubmitting(false);
      }
    } else {
      setChainIndex(nextIndex);
      // Reset the sub-timer for the next guess
      timer.start();
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
      <div className="page game-page" data-testid="game-page-chain-reaction" data-mode="chain-reaction">
        <Scoreboard currentRound={currentRound} totalRounds={session.totalRounds} score={session.totalScore} />
        <div className="loading">Loading products...</div>
      </div>
    );
  }

  const currentProduct = data.products[chainIndex];
  // The first product in the chain is just displayed; guesses start from index 1
  const isFirstProduct = chainIndex === 0 && chainGuesses.length === 0;
  const previousProduct = chainIndex > 0 ? data.products[chainIndex - 1] : null;

  return (
    <div
      className="page game-page chain-reaction-page"
      data-testid="game-page-chain-reaction"
      data-mode="chain-reaction"
      data-chain-index={chainIndex}
      data-chain-length={data.products.length}
    >
      <div className="game-header">
        <Scoreboard currentRound={currentRound} totalRounds={session.totalRounds} score={session.totalScore} />
        <Timer secondsLeft={timer.secondsLeft} isRunning={timer.isRunning} paused={false} />
      </div>

      <div className="comparison-question">
        <strong>Chain Reaction</strong> &mdash; Link {Math.min(chainIndex + 1, data.products.length)} of {data.products.length}
      </div>

      {!roundResult && (
        <div className="chain-reaction-area">
          {/* Chain progress dots */}
          <div className="chain-progress" data-testid="chain-progress">
            {data.products.map((_, i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <div
                  className={`chain-progress-dot ${i < chainIndex ? "dot-done" : i === chainIndex ? "dot-current" : ""}`}
                  data-testid="chain-progress-dot"
                />
                {i < data.products.length - 1 && (
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
                    onError={(e) => {
                      (e.target as HTMLImageElement).src = FALLBACK_SVG;
                    }}
                  />
                </div>
                <ProductTooltip product={previousProduct} showAmazonLink={false} disabled>
                  <h4 className="comparison-reveal-title product-name-hoverable">{previousProduct.title}</h4>
                </ProductTooltip>
              </div>
            </div>
          )}

          {/* Arrow connector */}
          {previousProduct && <div className="chain-arrow-connector">&#x2193;</div>}

          {/* Current product */}
          <div className="chain-current">
            {isFirstProduct && <span className="chain-label">Starting product</span>}
            {!isFirstProduct && !hasGuessed && <span className="chain-label">Is this MORE or LESS expensive?</span>}
            <div className="chain-card chain-card-main">
              <div
                className="comparison-image-wrapper"
                onClick={() => setZoomedImage({ src: currentProduct.imageUrl, alt: currentProduct.title })}
              >
                <img
                  src={currentProduct.imageUrl}
                  alt={currentProduct.title}
                  onError={(e) => {
                    (e.target as HTMLImageElement).src = FALLBACK_SVG;
                  }}
                />
              </div>
              <ProductTooltip product={currentProduct} showAmazonLink={false} disabled>
                <h3 className="comparison-title product-name-hoverable">{currentProduct.title}</h3>
              </ProductTooltip>
              <span className="category-badge">{currentProduct.category}</span>
            </div>
          </div>

          {/* Guess buttons: only shown from the second product onward */}
          {isFirstProduct && !hasGuessed && (
            <div className="chain-start-hint">
              <p className="pm-instruction">This is your starting product. Ready?</p>
              <button
                className="btn btn-primary"
                onClick={() => {
                  setChainIndex(1);
                  timer.start();
                }}
                data-testid="chain-start"
              >
                Start Chain
              </button>
            </div>
          )}

          {!isFirstProduct && !hasGuessed && !submitting && (
            <div className="chain-buttons" data-testid="chain-buttons">
              <button
                className="btn btn-primary chain-btn-more"
                onClick={() => handleSubGuess("more")}
                data-testid="chain-more"
              >
                More Expensive
              </button>
              <button
                className="btn btn-primary chain-btn-less"
                onClick={() => handleSubGuess("less")}
                data-testid="chain-less"
              >
                Less Expensive
              </button>
            </div>
          )}

          {submitting && (
            <div className="loading">Submitting chain...</div>
          )}
        </div>
      )}

      {roundResult && (
        <div className="result-overlay">
          <div className={`round-result ${roundResult.correctCount === roundResult.chainLength ? "tier-nice" : roundResult.correctCount > roundResult.chainLength / 2 ? "tier-ok" : "tier-miss"}`}>
            <ResultReaction score={roundResult.score} goodThreshold={600} badThreshold={200} />
            <div className="result-header">
              <h3 className={`result-title ${roundResult.correctCount === roundResult.chainLength ? "tier-nice" : roundResult.correctCount > roundResult.chainLength / 2 ? "tier-ok" : "tier-miss"}`}>
                {roundResult.correctCount === roundResult.chainLength
                  ? "Perfect Chain!"
                  : roundResult.correctCount > 0
                  ? `${roundResult.correctCount} of ${roundResult.chainLength} Correct`
                  : "No Correct Links!"}
              </h3>
            </div>

            <div className="chain-reaction-reveal">
              {roundResult.products.map((p: ProductWithPrice, index: number) => {
                const guess = roundResult.chainGuesses[index - 1]; // no guess for the first product
                const prevProduct = index > 0 ? roundResult.products[index - 1] : null;
                const isCorrectLink =
                  guess && prevProduct
                    ? (guess === "more" && p.priceCents >= prevProduct.priceCents) ||
                      (guess === "less" && p.priceCents <= prevProduct.priceCents)
                    : null;

                return (
                  <div
                    key={p.id}
                    className={`chain-reveal-link ${
                      isCorrectLink === null ? "" : isCorrectLink ? "correct-product" : "wrong-product"
                    }`}
                  >
                    <span className="chain-link-number">{index + 1}</span>
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
                    <div className="chain-reveal-info">
                      <ProductTooltip product={p}>
                        <h4 className="comparison-reveal-title product-name-hoverable">{p.title}</h4>
                      </ProductTooltip>
                      <span className="comparison-price">{formatPrice(p.priceCents)}</span>
                      {guess && (
                        <span className={`comparison-badge ${isCorrectLink ? "correct-badge" : "wrong-badge"}`}>
                          You said: {guess === "more" ? "More" : "Less"}
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
