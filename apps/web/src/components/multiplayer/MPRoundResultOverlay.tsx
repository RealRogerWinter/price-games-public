import { useEffect, useRef, useState } from "react";
import type { RoundResultsPayload, GuessData, RevealData } from "@price-game/shared";
import AvatarIcon from "./AvatarIcon";
import ImageModal from "../ImageModal";
import { useCurrency } from "../../context/CurrencyContext";
import { useSound } from "../../audio/SoundContext";
import ResultReaction from "../ResultReaction";
import ProductTooltip from "../ProductTooltip";
import { reportImageFailure } from "../../lib/imageDiagnostics";
import { getAccuracyLabel } from "../../lib/accuracyLabel";
import { AmazonCTA } from "../AmazonCTA";

interface MPRoundResultOverlayProps {
  results: RoundResultsPayload;
  currentPlayerId: string;
  onContinue: () => void;
  isGameOver: boolean;
  hasContinued?: boolean;
  continuedPlayerIds?: Set<string>;
  players?: Array<{ id: string; displayName: string; isConnected: boolean }>;
}

export default function MPRoundResultOverlay({
  results,
  currentPlayerId,
  onContinue,
  isGameOver,
  hasContinued,
  continuedPlayerIds,
  players,
}: MPRoundResultOverlayProps) {
  const { formatPrice } = useCurrency();
  const [zoomedImage, setZoomedImage] = useState<{ src: string; alt: string } | null>(null);
  const revealData = results.revealData;
  const mode = results.gameMode;

  const myResult = results.playerResults.find((pr) => pr.playerId === currentPlayerId);
  const myScore = myResult?.score ?? 0;

  // Compute pctOff for price-based modes.
  // guessData comes from the server as parsed JSON without a `mode` discriminant,
  // so we use the round-level `mode` and cast to access mode-specific fields.
  function computePctOff(guessData: GuessData | null): { pctOff: number; wentOver: boolean } | null {
    if (!guessData) return null;
    // Only single-product modes have a product to compare against
    if (revealData.mode === "comparison" || revealData.mode === "price-match"
      || revealData.mode === "odd-one-out" || revealData.mode === "sort-it-out"
      || revealData.mode === "budget-builder" || revealData.mode === "chain-reaction") return null;
    if (revealData.mode === "bidding") {
      const bidCents = (guessData as { bidCents?: number }).bidCents;
      if (bidCents == null) return null;
      const actual = revealData.product.priceCents;
      if (!actual || actual === 0) return null;
      if (bidCents > actual) return { pctOff: (bidCents - actual) / actual, wentOver: true };
      return { pctOff: (actual - bidCents) / actual, wentOver: false };
    }
    if (revealData.mode === "market-basket") {
      const guessed = (guessData as { guessedTotalCents?: number }).guessedTotalCents;
      if (guessed == null) return null;
      const actual = revealData.actualTotalCents;
      if (!actual || actual === 0) return null;
      return { pctOff: Math.abs(guessed - actual) / actual, wentOver: false };
    }
    const actual = revealData.product.priceCents;
    if (!actual || actual === 0) return null;

    if (mode === "classic") {
      const guessed = (guessData as { guessedPriceCents?: number }).guessedPriceCents;
      if (guessed == null) return null;
      return { pctOff: Math.abs(guessed - actual) / actual, wentOver: false };
    }
    if (mode === "closest-without-going-over") {
      const guessed = (guessData as { guessedPriceCents?: number }).guessedPriceCents;
      if (guessed == null) return null;
      if (guessed > actual) return { pctOff: (guessed - actual) / actual, wentOver: true };
      return { pctOff: (actual - guessed) / actual, wentOver: false };
    }
    if (mode === "riser") {
      const stopped = (guessData as { stoppedPriceCents?: number }).stoppedPriceCents;
      if (stopped == null) return null;
      if (stopped > actual) return { pctOff: (stopped - actual) / actual, wentOver: true };
      return { pctOff: (actual - stopped) / actual, wentOver: false };
    }
    return null;
  }

  function formatGuess(guessData: GuessData | null): string | null {
    if (!guessData) return null;
    if (mode === "classic" || mode === "closest-without-going-over") {
      const guessed = (guessData as { guessedPriceCents?: number }).guessedPriceCents;
      return guessed != null ? formatPrice(guessed) : null;
    }
    if (mode === "higher-lower") {
      const g = (guessData as { guess?: string }).guess;
      return g === "higher" ? "Higher" : g === "lower" ? "Lower" : null;
    }
    if (mode === "comparison") {
      const guessedProductId = (guessData as { guessedProductId?: number }).guessedProductId;
      if (guessedProductId == null) return null;
      if (revealData.mode !== "comparison") return null;
      const picked = revealData.products.find((p) => p.id === guessedProductId);
      return picked ? picked.title : null;
    }
    if (mode === "riser") {
      const stopped = (guessData as { stoppedPriceCents?: number }).stoppedPriceCents;
      return stopped != null ? formatPrice(stopped) : null;
    }
    if (mode === "price-match") {
      const assignments = (guessData as { assignments?: Record<string, number> }).assignments;
      if (!assignments) return null;
      if (revealData.mode !== "price-match") return null;
      const total = revealData.products.length;
      let correct = 0;
      for (const p of revealData.products) {
        if (assignments[p.id] === p.priceCents) correct++;
      }
      return `${correct}/${total} correct`;
    }
    if (mode === "odd-one-out") {
      const guessedProductId = (guessData as { guessedProductId?: number }).guessedProductId;
      if (guessedProductId == null) return null;
      if (revealData.mode !== "odd-one-out") return null;
      const picked = revealData.products.find((p) => p.id === guessedProductId);
      return picked ? picked.title : null;
    }
    if (mode === "market-basket") {
      const guessed = (guessData as { guessedTotalCents?: number }).guessedTotalCents;
      return guessed != null ? formatPrice(guessed) : null;
    }
    if (mode === "sort-it-out") {
      const order = (guessData as { submittedOrder?: number[] }).submittedOrder;
      if (!order || !Array.isArray(order)) return null;
      if (revealData.mode !== "sort-it-out") return null;
      let correct = 0;
      for (let i = 0; i < order.length; i++) {
        if (order[i] === revealData.correctOrder[i]) correct++;
      }
      return `${correct}/${revealData.correctOrder.length} correct`;
    }
    if (mode === "budget-builder") {
      const ids = (guessData as { selectedProductIds?: number[] }).selectedProductIds;
      return ids ? `${ids.length} items` : null;
    }
    if (mode === "chain-reaction") {
      const cg = (guessData as { chainGuesses?: string[] }).chainGuesses;
      if (!cg) return null;
      return `${cg.length} guesses`;
    }
    if (mode === "bidding") {
      const bid = (guessData as { bidCents?: number }).bidCents;
      return bid != null ? formatPrice(bid) : null;
    }
    return null;
  }

  function formatPctOff(info: { pctOff: number; wentOver: boolean }): string {
    if (info.pctOff === 0) return "Spot on!";
    const pct = (info.pctOff * 100).toFixed(1);
    if (info.wentOver) return `${pct}% over`;
    return `${pct}% off`;
  }

  // Personalized message for the current player
  function getPersonalMessage(): { text: string; tier: string } {
    if (mode === "classic") {
      if (myScore >= 900) return { text: "Spot on!", tier: "tier-close" };
      if (myScore >= 750) return { text: "So close!", tier: "tier-close" };
      if (myScore >= 500) return { text: "Nice guess!", tier: "tier-nice" };
      if (myScore >= 250) return { text: "Not bad!", tier: "tier-ok" };
      if (myScore > 0) return { text: "Way off!", tier: "tier-far" };
      return { text: "Missed it!", tier: "tier-miss" };
    }
    if (mode === "closest-without-going-over" || mode === "riser") {
      const info = myResult ? computePctOff(myResult.guessData) : null;
      if (info?.wentOver) return { text: "Went over!", tier: "tier-miss" };
      if (myScore >= 900) return { text: "Incredible!", tier: "tier-close" };
      if (myScore >= 750) return { text: "So close!", tier: "tier-close" };
      if (myScore >= 500) return { text: "Nice!", tier: "tier-nice" };
      if (myScore >= 250) return { text: "Not bad", tier: "tier-ok" };
      if (myScore > 0) return { text: "Too cautious!", tier: "tier-far" };
      return { text: "Missed it!", tier: "tier-miss" };
    }
    if (mode === "higher-lower" || mode === "comparison") {
      if (myScore > 0) return { text: "Correct!", tier: "tier-nice" };
      return { text: "Wrong!", tier: "tier-miss" };
    }
    if (mode === "price-match" && revealData.mode === "price-match") {
      const guessData = myResult?.guessData;
      const total = revealData.products.length;
      let correct = 0;
      const assignments = guessData ? (guessData as { assignments?: Record<string, number> }).assignments : undefined;
      if (assignments) {
        for (const p of revealData.products) {
          if (assignments[p.id] === p.priceCents) correct++;
        }
      }
      if (correct === total) return { text: "Perfect match!", tier: "tier-nice" };
      if (correct > 0) return { text: `${correct} of ${total} correct`, tier: "tier-ok" };
      return { text: "No matches!", tier: "tier-miss" };
    }
    if (mode === "odd-one-out") {
      if (myScore > 0) return { text: "Correct!", tier: "tier-nice" };
      return { text: "Wrong!", tier: "tier-miss" };
    }
    if (mode === "market-basket") {
      if (myScore >= 900) return { text: "Spot on!", tier: "tier-close" };
      if (myScore >= 500) return { text: "Good estimate!", tier: "tier-nice" };
      if (myScore > 0) return { text: "Not bad!", tier: "tier-ok" };
      return { text: "Way off!", tier: "tier-miss" };
    }
    if (mode === "sort-it-out" && revealData.mode === "sort-it-out") {
      if (myScore >= 1000) return { text: "Perfect order!", tier: "tier-close" };
      if (myScore >= 600) return { text: "Almost right!", tier: "tier-nice" };
      if (myScore > 0) return { text: "Partially right", tier: "tier-ok" };
      return { text: "All wrong!", tier: "tier-miss" };
    }
    if (mode === "budget-builder") {
      if (myScore === 0) return { text: "Over budget!", tier: "tier-miss" };
      if (myScore >= 900) return { text: "Budget master!", tier: "tier-close" };
      if (myScore >= 500) return { text: "Good shopping!", tier: "tier-nice" };
      return { text: "Under budget", tier: "tier-ok" };
    }
    if (mode === "chain-reaction") {
      if (myScore >= 3000) return { text: "Perfect chain!", tier: "tier-close" };
      if (myScore >= 1500) return { text: "Strong chain!", tier: "tier-nice" };
      if (myScore > 0) return { text: "Broken chain", tier: "tier-ok" };
      return { text: "No links!", tier: "tier-miss" };
    }
    if (mode === "bidding") {
      // Label tracks how close the bid was, not whether it outranked others.
      // A $0.01 bid that happens to win (because everyone else overbid) should
      // still read as "Technically a Number", not "Won the bid!".
      const info = myResult ? computePctOff(myResult.guessData) : null;
      if (info?.wentOver) return { text: "Overbid!", tier: "tier-miss" };
      if (info) {
        const { text, className } = getAccuracyLabel(info.pctOff);
        return { text, tier: className };
      }
      return { text: "Missed it!", tier: "tier-miss" };
    }
    if (myScore > 0) return { text: "Nice!", tier: "tier-nice" };
    return { text: "Better luck next time", tier: "tier-miss" };
  }

  const personalMsg = getPersonalMessage();
  const myPctOff = myResult ? computePctOff(myResult.guessData) : null;

  // Determine tier for the round-result border
  const tierClass = myScore >= 500 ? "tier-nice" : myScore > 0 ? "tier-ok" : "tier-miss";

  // Play result sound when overlay mounts
  const { play } = useSound();
  const soundPlayedRef = useRef(false);
  useEffect(() => {
    if (soundPlayedRef.current) return;
    soundPlayedRef.current = true;
    const tier = personalMsg.tier;
    if (tier === "tier-close") play("result_great");
    else if (tier === "tier-nice") play("result_good");
    else if (tier === "tier-ok") play("result_poor");
    else play("result_miss");
  }, []);

  function renderReveal() {
    if (revealData.mode === "comparison") {
      return (
        <div className="comparison-reveal">
          {revealData.products.map((p) => (
            <div
              key={p.id}
              className={`comparison-reveal-card ${p.id === revealData.correctProductId ? "correct-product" : ""}`}
            >
              <div className="comparison-image-wrapper small">
                <img
                  src={p.imageUrl}
                  alt={p.title}
                  onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
                />
              </div>
              <div className="comparison-reveal-info">
                <ProductTooltip product={p}><h4 className="comparison-reveal-title product-name-hoverable">{p.title}</h4></ProductTooltip>
                <span className="comparison-price">{formatPrice(p.priceCents)}</span>
                {p.id === revealData.correctProductId && (
                  <span className="comparison-badge correct-badge">
                    {revealData.question === "most-expensive" ? "More Expensive" : "Less Expensive"}
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
      );
    }

    if (revealData.mode === "price-match") {
      const myAssignments = myResult?.guessData
        ? (myResult.guessData as { assignments?: Record<string, number> }).assignments
        : undefined;
      return (
        <div className="pm-reveal-products">
          {revealData.products.map((p) => {
            const playerGuess = myAssignments?.[p.id];
            const isCorrect = playerGuess === p.priceCents;
            return (
              <div key={p.id} className={`pm-reveal-card ${playerGuess !== undefined ? (isCorrect ? "correct-product" : "wrong-product") : ""}`}>
                <img
                  src={p.imageUrl}
                  alt={p.title}
                  className="pm-reveal-img"
                  onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
                />
                <div className="pm-reveal-info">
                  <ProductTooltip product={p}><p className="pm-reveal-title product-name-hoverable">{p.title}</p></ProductTooltip>
                  <div className="pm-reveal-prices">
                    <span className="result-price-label">Actual:</span>
                    <span className="result-price-value text-green">{formatPrice(p.priceCents)}</span>
                    {playerGuess !== undefined && !isCorrect && (
                      <>
                        <span className="result-price-label">Your guess:</span>
                        <span className="result-price-value text-red">{formatPrice(playerGuess)}</span>
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
      );
    }

    if (revealData.mode === "odd-one-out") {
      return (
        <div className="comparison-reveal">
          {revealData.products.map((p) => (
            <div key={p.id} className={`comparison-reveal-card ${p.id === revealData.outlierProductId ? "correct-product" : ""}`}>
              <div className="comparison-image-wrapper small">
                <img src={p.imageUrl} alt={p.title} onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
              </div>
              <div className="comparison-reveal-info">
                <ProductTooltip product={p}><h4 className="comparison-reveal-title product-name-hoverable">{p.title}</h4></ProductTooltip>
                <span className="comparison-price">{formatPrice(p.priceCents)}</span>
                {p.id === revealData.outlierProductId && (
                  <span className="comparison-badge correct-badge">Odd One Out</span>
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
      );
    }

    if (revealData.mode === "market-basket") {
      return (
        <div className="pm-reveal-products">
          {revealData.products.map((p) => (
            <div key={p.id} className="pm-reveal-card">
              <img src={p.imageUrl} alt={p.title} className="pm-reveal-img" onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
              <div className="pm-reveal-info">
                <ProductTooltip product={p}><p className="pm-reveal-title product-name-hoverable">{p.title}</p></ProductTooltip>
                <span className="result-price-value text-green">{formatPrice(p.priceCents)}</span>
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
          <div className="result-price-row">
            <span className="result-price-label">Actual Total</span>
            <span className="result-price-value">{formatPrice(revealData.actualTotalCents)}</span>
          </div>
        </div>
      );
    }

    if (revealData.mode === "sort-it-out") {
      const mySubmittedOrder: number[] | undefined = myResult?.guessData
        ? (myResult.guessData as { submittedOrder?: number[] }).submittedOrder
        : undefined;
      const sortedProducts = revealData.correctOrder.map((id) => revealData.products.find((p) => p.id === id)).filter((p): p is NonNullable<typeof p> => p !== null);
      return (
        <div className="pm-reveal-products">
          {sortedProducts.map((p, idx) => {
            const submittedIdx = mySubmittedOrder ? mySubmittedOrder.indexOf(p.id) : -1;
            const isCorrect = submittedIdx === idx;
            return (
              <div key={p.id} className={`pm-reveal-card ${mySubmittedOrder ? (isCorrect ? "correct-product" : "wrong-product") : ""}`}>
                <span className="sio-rank">{idx + 1}</span>
                <img src={p.imageUrl} alt={p.title} className="pm-reveal-img" onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
                <div className="pm-reveal-info">
                  <ProductTooltip product={p}><p className="pm-reveal-title product-name-hoverable">{p.title}</p></ProductTooltip>
                  <span className="result-price-value text-green">{formatPrice(p.priceCents)}</span>
                  {isCorrect && <span className="comparison-badge correct-badge">Correct</span>}
                  {mySubmittedOrder && !isCorrect && submittedIdx >= 0 && (
                    <span className="comparison-badge wrong-badge">You put #{submittedIdx + 1}</span>
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
      );
    }

    if (revealData.mode === "budget-builder") {
      // Surface the player's actual cart (selected items) before listing the
      // full product set. Without this split, a player who bought 3 of 6 items
      // had to mentally cross-reference the table to figure out what they got.
      // guessData is the raw client submission stored on the server without
      // type validation, so harden against non-array shapes (e.g. a malformed
      // payload or a `{ timedOut: true }` placeholder).
      const rawSelectedIds = myResult?.guessData
        ? (myResult.guessData as { selectedProductIds?: unknown }).selectedProductIds
        : undefined;
      const mySelectedIds: number[] = Array.isArray(rawSelectedIds)
        ? rawSelectedIds.filter((id): id is number => typeof id === "number")
        : [];
      const mySelectedSet = new Set<number>(mySelectedIds);
      const myCartProducts = revealData.products.filter((p) => mySelectedSet.has(p.id));
      const myCartTotalCents = myCartProducts.reduce((sum, p) => sum + p.priceCents, 0);
      const isOver = myCartTotalCents > revealData.budgetCents;
      return (
        <div className="pm-reveal-products">
          {myResult && (
            <>
              <h4 className="bb-reveal-section-title">Your cart</h4>
              {myCartProducts.length === 0 ? (
                <p className="bb-reveal-empty">You didn't pick any items.</p>
              ) : (
                myCartProducts.map((p) => (
                  <div key={`my-${p.id}`} className="pm-reveal-card bb-reveal-cart-item">
                    <img src={p.imageUrl} alt={p.title} className="pm-reveal-img" onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
                    <div className="pm-reveal-info">
                      <ProductTooltip product={p}><p className="pm-reveal-title product-name-hoverable">{p.title}</p></ProductTooltip>
                      <span className="result-price-value text-green">{formatPrice(p.priceCents)}</span>
                      {p.amazonUrl && (
                        <AmazonCTA
                          href={p.amazonUrl}
                          size="sm"
                          productLabel={p.title}
                        />
                      )}
                    </div>
                  </div>
                ))
              )}
              <div className="result-price-row">
                <span className="result-price-label">Subtotal</span>
                <span className={`result-price-value ${isOver ? "text-red" : "text-green"}`}>
                  {formatPrice(myCartTotalCents)}
                </span>
              </div>
              <div className="result-price-row">
                <span className="result-price-label">Budget</span>
                <span className="result-price-value">{formatPrice(revealData.budgetCents)}</span>
              </div>
              {isOver && (
                <p className="bb-reveal-status text-red">Over budget by {formatPrice(myCartTotalCents - revealData.budgetCents)}</p>
              )}
            </>
          )}

          <h4 className="bb-reveal-section-title">All products this round</h4>
          {revealData.products.map((p) => (
            <div key={p.id} className="pm-reveal-card">
              <img src={p.imageUrl} alt={p.title} className="pm-reveal-img" onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
              <div className="pm-reveal-info">
                <ProductTooltip product={p}><p className="pm-reveal-title product-name-hoverable">{p.title}</p></ProductTooltip>
                <span className="result-price-value text-green">{formatPrice(p.priceCents)}</span>
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
          {!myResult && (
            <div className="result-price-row">
              <span className="result-price-label">Budget</span>
              <span className="result-price-value">{formatPrice(revealData.budgetCents)}</span>
            </div>
          )}
        </div>
      );
    }

    if (revealData.mode === "chain-reaction") {
      // Pull the player's chain guesses from guessData; the link between
      // products[i] and products[i+1] is correct iff the guess at index i
      // matches the actual price relationship. Surface ✓/✗ per link and the
      // first wrong link as a "Chain broke" indicator. Defensive: guess_data
      // is the raw client submission, so guard against non-array shapes.
      const rawChainGuesses = myResult?.guessData
        ? (myResult.guessData as { chainGuesses?: unknown }).chainGuesses
        : undefined;
      const myChainGuesses: string[] = Array.isArray(rawChainGuesses)
        ? rawChainGuesses.filter((g): g is string => typeof g === "string")
        : [];
      const links: { actual: "more" | "less"; guess: string | undefined; correct: boolean | null }[] = [];
      for (let i = 0; i < revealData.products.length - 1; i++) {
        const a = revealData.products[i].priceCents;
        const b = revealData.products[i + 1].priceCents;
        // Treat ties as "more" to match the server's `<=` arrow rendering.
        const actual: "more" | "less" = a <= b ? "more" : "less";
        const guess = myChainGuesses[i];
        const correct = guess === undefined ? null : guess === actual;
        links.push({ actual, guess, correct });
      }
      // First wrong link (1-based) — this is where the chain broke.
      const firstWrongIdx = links.findIndex((l) => l.correct === false);
      const brokeAt = firstWrongIdx >= 0 ? firstWrongIdx + 1 : null;
      return (
        <div className="pm-reveal-products">
          {revealData.products.map((p, idx) => {
            const link = idx < links.length ? links[idx] : null;
            return (
              <div key={p.id} className="pm-reveal-card">
                <img src={p.imageUrl} alt={p.title} className="pm-reveal-img" onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
                <div className="pm-reveal-info">
                  <ProductTooltip product={p}><p className="pm-reveal-title product-name-hoverable">{p.title}</p></ProductTooltip>
                  <span className="result-price-value text-green">{formatPrice(p.priceCents)}</span>
                  {p.amazonUrl && (
                    <AmazonCTA
                      href={p.amazonUrl}
                      size="sm"
                      productLabel={p.title}
                    />
                  )}
                </div>
                {link && (
                  <span
                    className={`cr-reveal-arrow ${
                      link.correct === true ? "cr-link-correct" : link.correct === false ? "cr-link-wrong" : ""
                    }`}
                    aria-label={
                      link.correct === true
                        ? `Link ${idx + 1}: correct`
                        : link.correct === false
                          ? `Link ${idx + 1}: wrong`
                          : `Link ${idx + 1}: ${link.actual}`
                    }
                  >
                    {link.actual === "more" ? "+" : "-"}
                    {link.correct === true && (
                      <span className="cr-link-badge cr-link-badge-correct" aria-hidden="true">✓</span>
                    )}
                    {link.correct === false && (
                      <span className="cr-link-badge cr-link-badge-wrong" aria-hidden="true">✗</span>
                    )}
                  </span>
                )}
              </div>
            );
          })}
          {brokeAt !== null && (
            <p className="cr-reveal-broke">Chain broke at link {brokeAt}</p>
          )}
        </div>
      );
    }

    if (revealData.mode === "bidding") {
      const actualCents = revealData.product.priceCents;
      const rawBids = revealData.bids ?? [];
      // Show bids in order of who did best this round instead of bid order —
      // highest score first, with overbids (score 0) tie-broken by bid amount
      // so the closest-to-actual overbid shows above the most blown ones.
      const bids = [...rawBids].sort((a, b) => {
        const aScore = results.playerResults.find((r) => r.playerId === a.playerId)?.score ?? 0;
        const bScore = results.playerResults.find((r) => r.playerId === b.playerId)?.score ?? 0;
        if (aScore !== bScore) return bScore - aScore;
        const aDiff = Math.abs(a.bidCents - actualCents);
        const bDiff = Math.abs(b.bidCents - actualCents);
        return aDiff - bDiff;
      });
      const myBid = bids.find((b) => b.playerId === currentPlayerId);
      const myDiffCents = myBid ? myBid.bidCents - actualCents : null;

      return (
        <>
          {/* Actual price — large and prominent */}
          <div className="bidding-reveal-price-hero">
            <span className="bidding-reveal-price-label">Actual Price</span>
            <span className="bidding-reveal-price-value">{formatPrice(actualCents)}</span>
          </div>

          <div className="result-product-card">
            <img
              key={revealData.product.id}
              src={revealData.product.imageUrl}
              alt={revealData.product.title}
              className="result-product-img"
              decoding="sync"
              style={{ cursor: "zoom-in" }}
              onClick={() => setZoomedImage({ src: revealData.product.imageUrl, alt: revealData.product.title })}
              onError={(e) => {
                reportImageFailure({ productId: revealData.product.id, src: revealData.product.imageUrl, phase: "error" });
                (e.target as HTMLImageElement).style.display = "none";
              }}
            />
            <div className="result-product-info">
              <ProductTooltip product={revealData.product}><p className="result-product-title product-name-hoverable">{revealData.product.title}</p></ProductTooltip>
              {revealData.product.amazonUrl && (
                <AmazonCTA
                  href={revealData.product.amazonUrl}
                  size="md"
                  productLabel={revealData.product.title}
                  showDisclosure
                />
              )}
            </div>
          </div>

          {/* Current player's bid summary */}
          {myBid && myDiffCents !== null && (
            <div className="bidding-reveal-my-bid">
              <span className="bidding-reveal-my-bid-label">Your bid</span>
              <span className="bidding-reveal-my-bid-amount">{formatPrice(myBid.bidCents)}</span>
              <span className={`bidding-reveal-my-bid-diff ${myDiffCents > 0 ? "text-red" : "text-green"}`}>
                {myDiffCents === 0
                  ? "Spot on!"
                  : myDiffCents > 0
                    ? `${formatPrice(myDiffCents)} over`
                    : `${formatPrice(Math.abs(myDiffCents))} under`}
              </span>
            </div>
          )}

          {/* Merged bid results: rank, name, bid, diff, score, total */}
          {bids.length > 0 && (
            <div className="bidding-reveal-bids">
              <h4>All Bids</h4>
              {bids.map((bid, idx) => {
                const diffCents = bid.bidCents - actualCents;
                const isOver = diffCents > 0;
                const isMe = bid.playerId === currentPlayerId;
                const pr = results.playerResults.find((r) => r.playerId === bid.playerId);
                const standing = results.standings.find((s) => s.playerId === bid.playerId);
                return (
                  <div key={bid.playerId} className={`bidding-reveal-bid-row ${isOver ? "overbid" : ""} ${isMe ? "is-you" : ""}`}>
                    <span className="bidding-reveal-rank">#{idx + 1}</span>
                    <span className="bidding-reveal-avatar">
                      {pr && <AvatarIcon avatar={pr.avatar} size={36} />}
                    </span>
                    <span className="bidding-reveal-name">{bid.displayName}{isMe ? " (you)" : ""}</span>
                    <span className={`bidding-reveal-amount ${isOver ? "text-red" : "text-green"}`}>
                      {formatPrice(bid.bidCents)}
                    </span>
                    <span className={`bidding-reveal-diff ${isOver ? "text-red" : "text-green"}`}>
                      {diffCents === 0
                        ? "Spot on!"
                        : isOver
                          ? `${formatPrice(diffCents)} over`
                          : `${formatPrice(Math.abs(diffCents))} under`}
                    </span>
                    <span className="bidding-reveal-score">
                      {pr && pr.score > 0 ? `+${pr.score}` : "0"}
                    </span>
                    <span className="bidding-reveal-total">
                      {standing?.totalScore.toLocaleString() || "0"}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </>
      );
    }

    // Single product modes (classic, higher-lower, closest-without-going-over, riser)
    const product = revealData.product;
    const myGuessData = myResult?.guessData;
    const myGuessedPrice = myGuessData ? (myGuessData as { guessedPriceCents?: number }).guessedPriceCents : undefined;
    const myStoppedPrice = myGuessData ? (myGuessData as { stoppedPriceCents?: number }).stoppedPriceCents : undefined;
    const myHLGuess = myGuessData ? (myGuessData as { guess?: string }).guess : undefined;

    return (
      <>
        <div className="result-prices">
          <div className="result-price-row">
            <span className="result-price-label">Actual Price</span>
            <span className="result-price-value">{formatPrice(product.priceCents)}</span>
          </div>
          {revealData.mode === "higher-lower" && revealData.referencePrice && (
            <div className="result-price-row">
              <span className="result-price-label">Reference Price</span>
              <span className="result-price-value">{formatPrice(revealData.referencePrice)}</span>
            </div>
          )}
          {(mode === "classic" || mode === "closest-without-going-over") && myGuessedPrice != null && (
            <div className="result-price-row">
              <span className="result-price-label">Your Guess</span>
              <span className={`result-price-value ${myPctOff?.wentOver ? "text-red" : "text-green"}`}>
                {formatPrice(myGuessedPrice)}
              </span>
            </div>
          )}
          {mode === "riser" && myStoppedPrice != null && (
            <div className="result-price-row">
              <span className="result-price-label">You Stopped At</span>
              <span className={`result-price-value ${myPctOff?.wentOver ? "text-red" : "text-green"}`}>
                {formatPrice(myStoppedPrice)}
              </span>
            </div>
          )}
          {mode === "higher-lower" && myHLGuess && (
            <div className="result-price-row">
              <span className="result-price-label">Your Answer</span>
              <span className={`result-price-value ${myScore > 0 ? "text-green" : "text-red"}`}>
                {myHLGuess === "higher" ? "Higher" : "Lower"}
              </span>
            </div>
          )}
          {myPctOff && (
            <div className="result-price-row">
              <span className="result-price-label">Difference</span>
              <span className={`result-price-value ${myPctOff.wentOver ? "text-red" : myPctOff.pctOff <= 0.1 ? "text-green" : "text-yellow"}`}>
                {formatPctOff(myPctOff)}
              </span>
            </div>
          )}
        </div>
        <div className="result-product-card">
          <img
            key={product.id}
            src={product.imageUrl}
            alt={product.title}
            className="result-product-img"
            decoding="sync"
            style={{ cursor: "zoom-in" }}
            onClick={() => setZoomedImage({ src: product.imageUrl, alt: product.title })}
            onError={(e) => {
              reportImageFailure({ productId: product.id, src: product.imageUrl, phase: "error" });
              (e.target as HTMLImageElement).style.display = "none";
            }}
          />
          <div className="result-product-info">
            <ProductTooltip product={product}><p className="result-product-title product-name-hoverable">{product.title}</p></ProductTooltip>
            {product.amazonUrl && (
              <AmazonCTA
                href={product.amazonUrl}
                size="md"
                productLabel={product.title}
                showDisclosure
              />
            )}
          </div>
        </div>
      </>
    );
  }

  // Show pct off in the player table for price-based modes
  const showPctCol = mode === "classic" || mode === "closest-without-going-over" || mode === "riser" || mode === "market-basket";

  return (
    <div className="result-overlay">
      <div className={`round-result ${tierClass}`}>
        <ResultReaction score={myScore} />

        <div className="result-header">
          <h3 className={`result-title ${personalMsg.tier}`}>
            {personalMsg.text}
          </h3>
          {myPctOff && myPctOff.pctOff > 0 && (
            <span className="result-pct-off">{formatPctOff(myPctOff)}</span>
          )}
        </div>

        {renderReveal()}

        {/* Bidding mode merges scores into the bid table above; skip the default table */}
        {results.gameMode !== "bidding" && (
          <div className="mp-result-table">
            <div className={`mp-result-header ${showPctCol ? "mp-result-header-with-pct" : "mp-result-header-with-guess"}`}>
              <span></span>
              <span>Player</span>
              <span>Guess</span>
              {showPctCol && <span>Off</span>}
              <span>Pts</span>
              <span>Total</span>
            </div>
            {results.playerResults.map((pr, idx) => {
              const standing = results.standings.find((s) => s.playerId === pr.playerId);
              const guess = formatGuess(pr.guessData);
              const pctInfo = computePctOff(pr.guessData);
              return (
                <div
                  key={pr.playerId}
                  className={`mp-result-row ${showPctCol ? "mp-result-row-with-pct" : "mp-result-row-with-guess"} ${pr.playerId === currentPlayerId ? "is-you" : ""} ${
                    idx === 0 ? "round-winner" : ""
                  }`}
                >
                  <AvatarIcon avatar={pr.avatar} size={36} />
                  <span className="mp-result-name">{pr.displayName}</span>
                  <span className="mp-result-guess" title={guess || ""}>
                    {guess || "—"}
                  </span>
                  {showPctCol && (
                    <span className={`mp-result-pct ${pctInfo?.wentOver ? "text-red" : ""}`}>
                      {pctInfo ? (pctInfo.pctOff === 0 ? "0%" : `${(pctInfo.pctOff * 100).toFixed(1)}%`) : "—"}
                    </span>
                  )}
                  <span className="mp-result-round-score">
                    {pr.score > 0 ? `+${pr.score}` : "0"}
                  </span>
                  <span className="mp-result-total-score">
                    {standing?.totalScore.toLocaleString() || "0"}
                  </span>
                </div>
              );
            })}
          </div>
        )}

        {hasContinued && !isGameOver ? (
          <p className="mp-result-waiting">
            Waiting for others... ({continuedPlayerIds?.size || 0}/{players?.filter(p => p.isConnected).length || 0})
          </p>
        ) : (
          <button className="btn btn-primary mp-result-continue" onClick={onContinue}>
            {isGameOver ? "See Final Results" : "Continue"}
          </button>
        )}
      </div>

      {zoomedImage && (
        <ImageModal src={zoomedImage.src} alt={zoomedImage.alt} onClose={() => setZoomedImage(null)} />
      )}
    </div>
  );
}
