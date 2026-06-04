import { useState } from "react";
import type { RoundResultsPayload, MultiplayerPlayer, ProductWithPrice } from "@price-game/shared";
import AvatarIcon from "./AvatarIcon";
import MPTopBar from "./MPTopBar";
import { useCurrency } from "../../context/CurrencyContext";
import ShareModal from "../share/ShareModal";
import ImageModal from "../ImageModal";
import ProductTooltip from "../ProductTooltip";
import { AmazonCTA } from "../AmazonCTA";
import { useShareData, buildSharedRoundSnapshots } from "../../hooks/useShareData";
import { useModalHistory } from "../../hooks/useModalHistory";
import { useUserAuth } from "../../context/UserAuthContext";
import SignupCtaCard from "../SignupCtaCard";
import LobbyShareModal from "./LobbyShareModal";
import PostMatchInviteCTA from "./PostMatchInviteCTA";
import { buffConsumedKey } from "./RewardToastHost";
import buffIcon from "../../assets/multiplayer/buff-icon.webp";
import type { InviteBuffConsumedEvent } from "@price-game/shared";
import LeaderboardLink from "../results/LeaderboardLink";

interface MPResultsScreenProps {
  finalResults: RoundResultsPayload;
  allRoundResults: RoundResultsPayload[];
  currentPlayerId: string;
  players?: MultiplayerPlayer[];
  roomCode?: string;
  onPlayAgain: () => void;
  onLeave: () => void;
  /** Opens the register modal. Passed from the host page; wires the logged-out CTA. */
  onOpenAuth?: () => void;
  /** MP-specific display-name override forwarded to the IdentityCard in the top bar. */
  displayNameOverride?: string | null;
}

export default function MPResultsScreen({
  finalResults,
  allRoundResults,
  currentPlayerId,
  players,
  roomCode,
  onPlayAgain,
  onLeave,
  onOpenAuth,
  displayNameOverride,
}: MPResultsScreenProps) {
  const { user } = useUserAuth();
  const { formatPrice: fmt } = useCurrency();
  const standings = finalResults.standings;
  const [shareOpen, setShareOpen] = useModalHistory("share-mp");
  const [inviteShareOpen, setInviteShareOpen] = useState(false);
  // Read the buff_consumed payload that the global RewardToastHost
  // listener stashed in sessionStorage. Server emits invite:buff_consumed
  // BEFORE GAME_OVER, so by the time this screen mounts the live socket
  // event is past — the cached read is the only reliable surface.
  const buffConsumed = (() => {
    if (!roomCode) return null;
    try {
      const raw = sessionStorage.getItem(buffConsumedKey(roomCode));
      return raw ? (JSON.parse(raw) as InviteBuffConsumedEvent) : null;
    } catch {
      return null;
    }
  })();
  const [zoomedImage, setZoomedImage] = useState<{ src: string; alt: string } | null>(null);
  const currentPlayerTotal =
    standings.find((s) => s.playerId === currentPlayerId)?.totalScore ?? 0;
  const currentPlayerDisplayName =
    standings.find((s) => s.playerId === currentPlayerId)?.displayName ?? null;
  // Finishing position drives the "#N of M" suffix on the share card. Standings
  // are already sorted descending by totalScore; index+1 is the player's rank.
  const currentPlayerRankIdx = standings.findIndex((s) => s.playerId === currentPlayerId);
  const playerRank = currentPlayerRankIdx >= 0 ? currentPlayerRankIdx + 1 : undefined;
  const playerCount = standings.length > 0 ? standings.length : undefined;
  const shareInput = useShareData({
    variant: "mp",
    gameMode: finalResults.gameMode,
    allRoundResults,
    currentPlayerId,
    totalScore: currentPlayerTotal,
    playerRank,
    playerCount,
  });
  // Server-side share snapshot for this player's per-round scores + reveal data.
  const roundSnapshots = buildSharedRoundSnapshots({
    variant: "mp",
    gameMode: finalResults.gameMode,
    allRoundResults,
    currentPlayerId,
    totalScore: currentPlayerTotal,
  });

  const podiumColors = ["#ffd700", "#c0c0c0", "#cd7f32", "#4ecca3"];

  function getProductsForRound(rr: RoundResultsPayload): Array<{ title: string; priceCents: number; amazonUrl?: string; imageUrl?: string }> {
    const reveal = rr.revealData;
    if (!reveal) return [];
    if (reveal.mode === "comparison" || reveal.mode === "price-match"
      || reveal.mode === "odd-one-out" || reveal.mode === "market-basket"
      || reveal.mode === "sort-it-out" || reveal.mode === "budget-builder"
      || reveal.mode === "chain-reaction") {
      return reveal.products.map((p) => ({ title: p.title, priceCents: p.priceCents, amazonUrl: p.amazonUrl, imageUrl: p.imageUrl }));
    }
    // Single-product modes: classic, higher-lower, closest-without-going-over, riser
    return [{ title: reveal.product.title, priceCents: reveal.product.priceCents, amazonUrl: reveal.product.amazonUrl, imageUrl: reveal.product.imageUrl }];
  }

  /** Local player's per-round score (0 if they joined late / no result). */
  function getMyRoundScore(rr: RoundResultsPayload): number {
    return rr.playerResults.find((p) => p.playerId === currentPlayerId)?.score ?? 0;
  }

  /**
   * Mirror SP's BudgetBuilderBreakdown for the LOCAL player only. Each card
   * shows budget, the subset of items they picked, the subtotal, and points.
   * Never surfaces opponents' carts — final-results screens are about the
   * player's own performance.
   */
  function MyBudgetBuilderBreakdown() {
    if (finalResults.gameMode !== "budget-builder") return null;
    return (
      <div className="mp-my-breakdown">
        <h3>Your Rounds</h3>
        <div className="breakdown-list">
          {allRoundResults.map((rr) => {
            const reveal = rr.revealData;
            if (reveal.mode !== "budget-builder") return null;
            const myResult = rr.playerResults.find((p) => p.playerId === currentPlayerId);
            // Harden: guessData is the raw client submission (may be malformed
            // or `{ timedOut: true }`); coerce to a number[] before using.
            const rawSelectedIds = myResult?.guessData
              ? (myResult.guessData as { selectedProductIds?: unknown }).selectedProductIds
              : undefined;
            const selectedIds: number[] = Array.isArray(rawSelectedIds)
              ? rawSelectedIds.filter((id): id is number => typeof id === "number")
              : [];
            const selectedSet = new Set<number>(selectedIds);
            const myItems = reveal.products.filter((p) => selectedSet.has(p.id));
            const subtotal = myItems.reduce((s, p) => s + p.priceCents, 0);
            const isOver = subtotal > reveal.budgetCents;
            const score = getMyRoundScore(rr);
            const rowClass = isOver
              ? "row-miss"
              : score >= 500
                ? "row-good"
                : score > 0
                  ? "row-ok"
                  : "row-miss";
            return (
              <div key={rr.roundNumber} className={`breakdown-row ${rowClass}`}>
                <div className="breakdown-row-header">
                  <span className="breakdown-round-label">Round {rr.roundNumber}</span>
                </div>
                {myItems.length === 0 ? (
                  <p className="bb-reveal-empty">You didn't pick any items.</p>
                ) : (
                  <div className="breakdown-row-pricematch">
                    {myItems.map((p) => (
                      <div key={p.id} className="breakdown-pm-product">
                        {p.imageUrl && <img src={p.imageUrl} alt={p.title} className="breakdown-row-img-sm" />}
                        <div className="breakdown-row-info">
                          <ProductTooltip product={p}>
                            <span className="breakdown-row-title product-name-hoverable">{p.title}</span>
                          </ProductTooltip>
                          <span className="breakdown-comparison-price">{fmt(p.priceCents)}</span>
                          {p.amazonUrl && (
                            <AmazonCTA
                              href={p.amazonUrl}
                              variant="inline"
                              productLabel={p.title}
                            />
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                <div className="breakdown-row-stats">
                  <span className="mp-stat-pill"><span className="mp-stat-label">Budget</span><span className="mp-stat-value">{fmt(reveal.budgetCents)}</span></span>
                  <span className="mp-stat-pill"><span className="mp-stat-label">Cart</span><span className={`mp-stat-value ${isOver ? "text-red" : "text-green"}`}>{fmt(subtotal)}</span></span>
                  <span className="mp-stat-pill"><span className="mp-stat-label">Status</span><span className={`mp-stat-value ${isOver ? "text-red" : "text-green"}`}>{isOver ? "OVER" : "Under"}</span></span>
                  <span className="mp-stat-pill"><span className="mp-stat-label">Points</span><span className="mp-stat-value">{score}</span></span>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  /**
   * Mirror SP's ChainReactionBreakdown for the LOCAL player only. Each card
   * shows products in shown order, the player's correct/total link count, and
   * points. Per-link ✓/✗ details live on the per-round overlay; the final
   * screen stays a high-level recap.
   */
  function MyChainReactionBreakdown() {
    if (finalResults.gameMode !== "chain-reaction") return null;
    return (
      <div className="mp-my-breakdown">
        <h3>Your Rounds</h3>
        <div className="breakdown-list">
          {allRoundResults.map((rr) => {
            const reveal = rr.revealData;
            if (reveal.mode !== "chain-reaction") return null;
            const myResult = rr.playerResults.find((p) => p.playerId === currentPlayerId);
            // Harden against malformed/timed-out guessData (raw client input).
            const rawGuesses = myResult?.guessData
              ? (myResult.guessData as { chainGuesses?: unknown }).chainGuesses
              : undefined;
            const guesses: string[] = Array.isArray(rawGuesses)
              ? rawGuesses.filter((g): g is string => typeof g === "string")
              : [];
            // Recompute correctCount client-side because guessData is the raw
            // submission (no derived correctness count).
            const chainLength = Math.max(0, reveal.products.length - 1);
            let correctCount = 0;
            for (let i = 0; i < chainLength; i++) {
              const a = reveal.products[i].priceCents;
              const b = reveal.products[i + 1].priceCents;
              const actual = a <= b ? "more" : "less";
              if (guesses[i] === actual) correctCount++;
            }
            const score = getMyRoundScore(rr);
            const rowClass =
              correctCount === chainLength && chainLength > 0
                ? "row-good"
                : correctCount > 0
                  ? "row-ok"
                  : "row-miss";
            return (
              <div key={rr.roundNumber} className={`breakdown-row ${rowClass}`}>
                <div className="breakdown-row-header">
                  <span className="breakdown-round-label">Round {rr.roundNumber}</span>
                </div>
                <div className="breakdown-row-pricematch">
                  {reveal.products.map((p) => (
                    <div key={p.id} className="breakdown-pm-product">
                      {p.imageUrl && <img src={p.imageUrl} alt={p.title} className="breakdown-row-img-sm" />}
                      <div className="breakdown-row-info">
                        <span className="breakdown-row-title">{p.title}</span>
                        <span className="breakdown-comparison-price">{fmt(p.priceCents)}</span>
                      </div>
                    </div>
                  ))}
                </div>
                <div className="breakdown-row-stats">
                  <span className="mp-stat-pill"><span className="mp-stat-label">Correct</span><span className="mp-stat-value">{correctCount} / {chainLength}</span></span>
                  <span className="mp-stat-pill"><span className="mp-stat-label">Points</span><span className="mp-stat-value">{score}</span></span>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <div className="mp-results-screen">
      <MPTopBar onLeave={onLeave} onOpenAuth={onOpenAuth} displayNameOverride={displayNameOverride} />

      <h2 className="mp-final-title">Final Results</h2>

      {!user && onOpenAuth && (
        <SignupCtaCard
          variant="multiplayer"
          score={currentPlayerTotal}
          onSignup={onOpenAuth}
        />
      )}

      <div className="mp-podium">
        {standings.map((s, idx) => (
          <div
            key={s.playerId}
            className={`mp-podium-entry ${s.playerId === currentPlayerId ? "is-you" : ""}`}
            style={{ borderColor: podiumColors[idx] || podiumColors[3] }}
          >
            <span className="mp-podium-rank" style={{ color: podiumColors[idx] }}>
              #{idx + 1}
            </span>
            <AvatarIcon avatar={s.avatar} size={64} />
            <span className="mp-podium-name">
              {players?.find((p) => p.id === s.playerId)?.isBot && <span className="mp-podium-bot">{"\uD83E\uDD16"} </span>}
              {s.displayName}
            </span>
            <span className="mp-podium-score">{s.totalScore.toLocaleString()}</span>
          </div>
        ))}
      </div>

      {/* Buff-applied card \u2014 shown only when the score above had an
          invite-reward multiplier consumed. Surfaces the raw \u2192 final
          math so the bonus is felt, not invisible. */}
      {buffConsumed && (
        <div className="mp-buff-card" data-testid="mp-buff-card">
          <img src={buffIcon} alt="" className="mp-buff-card-icon" aria-hidden="true" />
          <div className="mp-buff-card-text">
            <p className="mp-buff-card-title">
              {buffConsumed.source === "invite_host"
                ? "Friendship Boost applied"
                : buffConsumed.source === "public_game"
                  ? "Public-lobby bonus applied"
                  : "Welcome bonus applied"}
            </p>
            <p className="mp-buff-card-math">
              <span className="mp-buff-card-raw">{buffConsumed.rawScore.toLocaleString()}</span>
              <span className="mp-buff-card-mult">
                {" \u00D7 "}+{Math.round((buffConsumed.multiplier - 1) * 100)}%{" = "}
              </span>
              <span className="mp-buff-card-final">
                {buffConsumed.finalScore.toLocaleString()}
              </span>
            </p>
            {buffConsumed.matchesRemaining > 0 && (
              <p className="mp-buff-card-remaining">
                {buffConsumed.matchesRemaining}{" "}
                {buffConsumed.matchesRemaining === 1 ? "match" : "matches"} of bonus left
              </p>
            )}
          </div>
        </div>
      )}

      <div className="mp-round-breakdown">
        <h3>Round-by-Round</h3>
        <div className="mp-breakdown-table">
          <div className="mp-breakdown-header">
            <span>Round</span>
            {standings.map((s) => (
              <span key={s.playerId} className="mp-breakdown-player-col">
                <AvatarIcon avatar={s.avatar} size={32} />
                <span className="mp-breakdown-player-name" title={s.displayName}>
                  {s.displayName}
                </span>
              </span>
            ))}
          </div>
          {allRoundResults.map((rr) => (
            <div key={rr.roundNumber} className="mp-breakdown-row">
              <span>{rr.roundNumber}</span>
              {standings.map((s) => {
                const pr = rr.playerResults.find((p) => p.playerId === s.playerId);
                return <span key={s.playerId}>{pr?.score ?? 0}</span>;
              })}
            </div>
          ))}
          <div className="mp-breakdown-row mp-breakdown-total">
            <span>Total</span>
            {standings.map((s) => (
              <span key={s.playerId}>{s.totalScore.toLocaleString()}</span>
            ))}
          </div>
        </div>
      </div>

      <MyBudgetBuilderBreakdown />
      <MyChainReactionBreakdown />

      {/* The per-round product list below is redundant for budget-builder —
          MyBudgetBuilderBreakdown above already lists the player's cart with
          tooltips + Amazon CTAs. Skip the duplicate section in that mode. */}
      {finalResults.gameMode !== "budget-builder" && (
      <div className="mp-product-breakdown">
        <h3>Products</h3>
        {allRoundResults.map((rr) => {
          const products = getProductsForRound(rr);
          return products.map((p, i) => {
            // Synthesize a ProductWithPrice-shaped object for ProductTooltip.
            // MP reveal payloads don't ship every field a single-player Product
            // carries (id, description, category), so we fill the gaps with
            // safe defaults — the tooltip tolerates missing category/description.
            const tooltipProduct: ProductWithPrice = {
              id: 0,
              title: p.title,
              priceCents: p.priceCents,
              imageUrl: p.imageUrl ?? "",
              amazonUrl: p.amazonUrl,
              description: "",
              category: "",
            };
            return (
              <div key={`${rr.roundNumber}-${i}`} className="mp-product-row">
                <span className="mp-product-round">R{rr.roundNumber}</span>
                {p.imageUrl && (
                  <img
                    src={p.imageUrl}
                    alt={p.title}
                    className="mp-product-img"
                    style={{ cursor: "zoom-in" }}
                    onClick={() => setZoomedImage({ src: p.imageUrl!, alt: p.title })}
                    onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
                  />
                )}
                <div className="mp-product-info">
                  <ProductTooltip product={tooltipProduct}>
                    <span className="mp-product-name product-name-hoverable">{p.title}</span>
                  </ProductTooltip>
                  <span className="mp-product-price">{fmt(p.priceCents)}</span>
                </div>
                {p.amazonUrl && (
                  <AmazonCTA
                    href={p.amazonUrl}
                    variant="inline"
                    productLabel={p.title}
                    className="mp-product-amazon"
                  />
                )}
              </div>
            );
          });
        })}
      </div>
      )}

      <div className="mp-final-actions">
        <button className="btn btn-primary" onClick={onPlayAgain}>
          Play Again
        </button>
        <button
          className="btn btn-primary"
          onClick={() => setShareOpen(true)}
          type="button"
        >
          Share Results
        </button>
        <button className="btn btn-secondary" onClick={onLeave}>
          Leave Room
        </button>
      </div>

      {roomCode && (
        <PostMatchInviteCTA onShare={() => setInviteShareOpen(true)} />
      )}

      <LeaderboardLink />

      {roomCode && (
        <LobbyShareModal
          open={inviteShareOpen}
          onClose={() => setInviteShareOpen(false)}
          roomCode={roomCode}
          gameMode={finalResults.gameMode}
          isHost={!!players?.find((p) => p.id === currentPlayerId)?.isHost}
        />
      )}

      {shareOpen && (
        <ShareModal
          shareInput={shareInput}
          roundSnapshots={roundSnapshots}
          playerName={currentPlayerDisplayName}
          onClose={() => setShareOpen(false)}
        />
      )}

      {zoomedImage && (
        <ImageModal
          src={zoomedImage.src}
          alt={zoomedImage.alt}
          onClose={() => setZoomedImage(null)}
        />
      )}
    </div>
  );
}
