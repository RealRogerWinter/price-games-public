import { useState, useEffect } from "react";
import type {
  GameSession,
  GameMode,
  RoundResult,
  HigherLowerRoundResult,
  ComparisonRoundResult,
  ClosestRoundResult,
  PriceMatchRoundResult,
  RiserRoundResult,
  OddOneOutRoundResult,
  MarketBasketRoundResult,
  SortItOutRoundResult,
  BudgetBuilderRoundResult,
  ChainReactionRoundResult,
  ProductWithPrice,
  UserRankResponse,
} from "@price-game/shared";
import { getGameModeName, getPerRoundMaxScore } from "@price-game/shared";
import { useCurrency } from "../context/CurrencyContext";
import { useUserAuth } from "../context/UserAuthContext";
import { getUserRank } from "../api/client";
import ShareModal from "../components/share/ShareModal";
import { AmazonCTA } from "../components/AmazonCTA";
import { useShareData, buildSharedRoundSnapshots } from "../hooks/useShareData";
import { useModalHistory } from "../hooks/useModalHistory";
import SignupCtaCard from "../components/SignupCtaCard";
import LeaderboardLink from "../components/results/LeaderboardLink";

interface ResultPageProps {
  session: GameSession;
  roundResults: any[];
  gameMode: GameMode;
  onPlayAgain: () => void;
  onShowLeaderboard: () => void;
  onBackToModes?: () => void;
  onOpenAuth?: () => void;
}

function ProductRow({
  product,
  children,
  rowClass,
}: {
  product: ProductWithPrice;
  children: React.ReactNode;
  rowClass: string;
}) {
  return (
    <div className={`breakdown-row ${rowClass}`}>
      <div className="breakdown-row-product">
        <img
          src={product.imageUrl}
          alt={product.title}
          className="breakdown-row-img"
        />
        <div className="breakdown-row-info">
          <span className="breakdown-row-title">{product.title}</span>
          {product.amazonUrl && (
            <AmazonCTA
              href={product.amazonUrl}
              variant="inline"
              productLabel={product.title}
            />
          )}
        </div>
      </div>
      <div className="breakdown-row-stats">{children}</div>
    </div>
  );
}

function StatPill({ label, value, className }: { label: string; value: string; className?: string }) {
  return (
    <div className={`breakdown-stat ${className || ""}`}>
      <span className="breakdown-stat-label">{label}</span>
      <span className="breakdown-stat-value">{value}</span>
    </div>
  );
}

function ClassicBreakdown({ results }: { results: RoundResult[] }) {
  const { formatPrice } = useCurrency();
  return (
    <div className="breakdown-list">
      {results.map((r, i) => (
        <ProductRow
          key={i}
          product={r.product}
          rowClass={r.score >= 500 ? "row-good" : r.score > 0 ? "row-ok" : "row-miss"}
        >
          <StatPill label="Actual" value={formatPrice(r.product.priceCents)} />
          <StatPill label="Guess" value={formatPrice(r.guessedPriceCents)} />
          <StatPill label="Points" value={String(r.score)} className="stat-score" />
        </ProductRow>
      ))}
    </div>
  );
}

function HigherLowerBreakdown({ results }: { results: HigherLowerRoundResult[] }) {
  const { formatPrice } = useCurrency();
  return (
    <div className="breakdown-list">
      {results.map((r, i) => (
        <ProductRow
          key={i}
          product={r.product}
          rowClass={r.correct ? "row-good" : "row-miss"}
        >
          <StatPill label="Reference" value={formatPrice(r.referencePrice)} />
          <StatPill label="Actual" value={formatPrice(r.product.priceCents)} />
          <StatPill
            label="Answer"
            value={r.guess === "higher" ? "Higher" : "Lower"}
            className={r.correct ? "stat-correct" : "stat-wrong"}
          />
          <StatPill label="Points" value={String(r.score)} className="stat-score" />
        </ProductRow>
      ))}
    </div>
  );
}

function ComparisonBreakdown({ results }: { results: ComparisonRoundResult[] }) {
  const { formatPrice } = useCurrency();
  return (
    <div className="breakdown-list">
      {results.map((r, i) => (
        <div key={i} className={`breakdown-row ${r.correct ? "row-good" : "row-miss"}`}>
          <div className="breakdown-row-comparison">
            {r.products.map((p) => (
              <div key={p.id} className="breakdown-comparison-product">
                <img src={p.imageUrl} alt={p.title} className="breakdown-row-img" />
                <div className="breakdown-row-info">
                  <span className="breakdown-row-title">{p.title}</span>
                  <span className="breakdown-comparison-price">{formatPrice(p.priceCents)}</span>
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
          <div className="breakdown-row-stats">
            <StatPill
              label={r.question === "most-expensive" ? "More $" : "Less $"}
              value={r.correct ? "Correct" : "Wrong"}
              className={r.correct ? "stat-correct" : "stat-wrong"}
            />
            <StatPill label="Points" value={String(r.score)} className="stat-score" />
          </div>
        </div>
      ))}
    </div>
  );
}

function ClosestBreakdown({ results }: { results: ClosestRoundResult[] }) {
  const { formatPrice } = useCurrency();
  return (
    <div className="breakdown-list">
      {results.map((r, i) => (
        <ProductRow
          key={i}
          product={r.product}
          rowClass={r.wentOver ? "row-miss" : r.score >= 500 ? "row-good" : r.score > 0 ? "row-ok" : "row-miss"}
        >
          <StatPill label="Actual" value={formatPrice(r.product.priceCents)} />
          <StatPill label="Guess" value={formatPrice(r.guessedPriceCents)} />
          <StatPill
            label="Over?"
            value={r.wentOver ? "OVER" : "OK"}
            className={r.wentOver ? "stat-wrong" : "stat-correct"}
          />
          <StatPill label="Points" value={String(r.score)} className="stat-score" />
        </ProductRow>
      ))}
    </div>
  );
}

function PriceMatchBreakdown({ results }: { results: PriceMatchRoundResult[] }) {
  const { formatPrice } = useCurrency();
  return (
    <div className="breakdown-list">
      {results.map((r, i) => (
        <div key={i} className={`breakdown-row ${r.correctCount === (r.products?.length || 4) ? "row-good" : r.correctCount > 0 ? "row-ok" : "row-miss"}`}>
          <div className="breakdown-row-pricematch">
            {r.products?.map((p) => (
              <div key={p.id} className="breakdown-pm-product">
                <img src={p.imageUrl} alt={p.title} className="breakdown-row-img-sm" />
                <div className="breakdown-row-info">
                  <span className="breakdown-row-title">{p.title}</span>
                  <span className="breakdown-comparison-price">{formatPrice(p.priceCents)}</span>
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
          <div className="breakdown-row-stats">
            <StatPill label="Correct" value={`${r.correctCount} / ${r.products?.length || 4}`} />
            <StatPill label="Points" value={String(r.score)} className="stat-score" />
          </div>
        </div>
      ))}
    </div>
  );
}

function RiserBreakdown({ results }: { results: RiserRoundResult[] }) {
  const { formatPrice } = useCurrency();
  return (
    <div className="breakdown-list">
      {results.map((r, i) => (
        <ProductRow
          key={i}
          product={r.product}
          rowClass={r.wentOver ? "row-miss" : r.score >= 500 ? "row-good" : r.score > 0 ? "row-ok" : "row-miss"}
        >
          <StatPill label="Actual" value={formatPrice(r.product.priceCents)} />
          <StatPill label="Stopped" value={formatPrice(r.stoppedPriceCents)} />
          <StatPill
            label="Over?"
            value={r.wentOver ? "OVER" : "OK"}
            className={r.wentOver ? "stat-wrong" : "stat-correct"}
          />
          <StatPill label="Points" value={String(r.score)} className="stat-score" />
        </ProductRow>
      ))}
    </div>
  );
}

function OddOneOutBreakdown({ results }: { results: OddOneOutRoundResult[] }) {
  const { formatPrice } = useCurrency();
  return (
    <div className="breakdown-list">
      {results.map((r, i) => (
        <div key={i} className={`breakdown-row ${r.correct ? "row-good" : "row-miss"}`}>
          <div className="breakdown-row-comparison">
            {r.products.map((p) => (
              <div key={p.id} className={`breakdown-comparison-product ${p.id === r.outlierProductId ? "outlier-product" : ""}`}>
                <img src={p.imageUrl} alt={p.title} className="breakdown-row-img" />
                <div className="breakdown-row-info">
                  <span className="breakdown-row-title">{p.title}</span>
                  <span className="breakdown-comparison-price">{formatPrice(p.priceCents)}</span>
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
          <div className="breakdown-row-stats">
            <StatPill label="Outlier" value={r.correct ? "Correct" : "Wrong"} className={r.correct ? "stat-correct" : "stat-wrong"} />
            <StatPill label="Points" value={String(r.score)} className="stat-score" />
          </div>
        </div>
      ))}
    </div>
  );
}

function MarketBasketBreakdown({ results }: { results: MarketBasketRoundResult[] }) {
  const { formatPrice } = useCurrency();
  return (
    <div className="breakdown-list">
      {results.map((r, i) => (
        <div key={i} className={`breakdown-row ${r.score >= 500 ? "row-good" : r.score > 0 ? "row-ok" : "row-miss"}`}>
          <div className="breakdown-row-pricematch">
            {r.products.map((p) => (
              <div key={p.id} className="breakdown-pm-product">
                <img src={p.imageUrl} alt={p.title} className="breakdown-row-img-sm" />
                <div className="breakdown-row-info">
                  <span className="breakdown-row-title">{p.title}</span>
                  <span className="breakdown-comparison-price">{formatPrice(p.priceCents)}</span>
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
          <div className="breakdown-row-stats">
            <StatPill label="Total" value={formatPrice(r.actualTotalCents)} />
            <StatPill label="Guess" value={formatPrice(r.guessedTotalCents)} />
            <StatPill label="Points" value={String(r.score)} className="stat-score" />
          </div>
        </div>
      ))}
    </div>
  );
}

function SortItOutBreakdown({ results }: { results: SortItOutRoundResult[] }) {
  const { formatPrice } = useCurrency();
  return (
    <div className="breakdown-list">
      {results.map((r, i) => (
        <div key={i} className={`breakdown-row ${r.correctCount === r.correctOrder.length ? "row-good" : r.correctCount > 0 ? "row-ok" : "row-miss"}`}>
          <div className="breakdown-row-pricematch">
            {r.products.slice().sort((a, b) => a.priceCents - b.priceCents).map((p) => (
              <div key={p.id} className="breakdown-pm-product">
                <img src={p.imageUrl} alt={p.title} className="breakdown-row-img-sm" />
                <div className="breakdown-row-info">
                  <span className="breakdown-row-title">{p.title}</span>
                  <span className="breakdown-comparison-price">{formatPrice(p.priceCents)}</span>
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
          <div className="breakdown-row-stats">
            <StatPill label="Correct" value={`${r.correctCount} / ${r.correctOrder.length}`} />
            <StatPill label="Points" value={String(r.score)} className="stat-score" />
          </div>
        </div>
      ))}
    </div>
  );
}

function BudgetBuilderBreakdown({ results }: { results: BudgetBuilderRoundResult[] }) {
  const { formatPrice } = useCurrency();
  return (
    <div className="breakdown-list">
      {results.map((r, i) => {
        const overBudget = r.cartTotalCents > r.budgetCents;
        const rowClass = overBudget
          ? "row-miss"
          : r.score >= 500
            ? "row-good"
            : r.score > 0
              ? "row-ok"
              : "row-miss";
        // Server returns the full product set for the round; surface only
        // the items the player actually put in their cart so the recap
        // mirrors the in-game reveal overlay.
        const selectedProducts = (r.products || []).filter((p) =>
          r.selectedProductIds.includes(p.id),
        );
        return (
          <div key={i} className={`breakdown-row breakdown-row-budget ${rowClass}`}>
            <div className="breakdown-row-stats budget-builder-recap-stats">
              <StatPill label={`Round ${i + 1} Budget`} value={formatPrice(r.budgetCents)} />
              <StatPill label="Cart Total" value={formatPrice(r.cartTotalCents)} />
              <StatPill
                label="Status"
                value={overBudget ? "OVER" : "Under"}
                className={overBudget ? "stat-wrong" : "stat-correct"}
              />
              <StatPill label="Points" value={String(r.score)} className="stat-score" />
            </div>
            {selectedProducts.length > 0 && (
              <div className="breakdown-row-pricematch budget-builder-recap-products">
                {selectedProducts.map((p) => (
                  <div key={p.id} className="breakdown-pm-product">
                    <img
                      src={p.imageUrl}
                      alt={p.title}
                      className="breakdown-row-img-sm"
                    />
                    <div className="breakdown-row-info">
                      <span className="breakdown-row-title">{p.title}</span>
                      <span className="breakdown-comparison-price">
                        {formatPrice(p.priceCents)}
                      </span>
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
          </div>
        );
      })}
    </div>
  );
}

function ChainReactionBreakdown({ results }: { results: ChainReactionRoundResult[] }) {
  const { formatPrice } = useCurrency();
  return (
    <div className="breakdown-list">
      {results.map((r, i) => (
        <div key={i} className={`breakdown-row ${r.correctCount === r.chainLength ? "row-good" : r.correctCount > 0 ? "row-ok" : "row-miss"}`}>
          <div className="breakdown-row-pricematch">
            {r.products.map((p) => (
              <div key={p.id} className="breakdown-pm-product">
                <img src={p.imageUrl} alt={p.title} className="breakdown-row-img-sm" />
                <div className="breakdown-row-info">
                  <span className="breakdown-row-title">{p.title}</span>
                  <span className="breakdown-comparison-price">{formatPrice(p.priceCents)}</span>
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
          <div className="breakdown-row-stats">
            <StatPill label="Correct" value={`${r.correctCount} / ${r.chainLength}`} />
            <StatPill label="Points" value={String(r.score)} className="stat-score" />
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Choose a result-screen headline based on how close the player got to the max
 * possible score. "Game Over!" stays reserved for a zero-score run so the phrase
 * reads as a commiseration; higher scores get progressively more encouraging
 * copy.
 *
 * @param totalScore - The player's final score
 * @param maxScore - The maximum achievable score for this session (per-round max × totalRounds)
 * @returns A headline string for display at the top of the results page
 */
export function getResultHeadline(totalScore: number, maxScore: number): string {
  if (maxScore <= 0 || totalScore <= 0) return "Game Over!";
  const ratio = totalScore / maxScore;
  if (ratio >= 0.9) return "Masterful!";
  if (ratio >= 0.7) return "Great game!";
  if (ratio >= 0.5) return "Nice work!";
  if (ratio >= 0.25) return "Not bad!";
  return "Tough round!";
}

export default function ResultPage({
  session,
  roundResults,
  gameMode,
  onPlayAgain,
  onShowLeaderboard,
  onBackToModes,
  onOpenAuth,
}: ResultPageProps) {
  const { formatPrice } = useCurrency();
  const { user } = useUserAuth();
  const [shareOpen, setShareOpen] = useModalHistory("share-sp");
  const [rankData, setRankData] = useState<UserRankResponse | null>(null);
  const [rankLoading, setRankLoading] = useState(false);
  const shareInput = useShareData({
    variant: "sp",
    gameMode,
    roundResults,
    totalScore: session.totalScore,
  });
  // Snapshot used to mint a shareable URL server-side when the modal opens.
  // Computed once per render from the same source data as shareInput.
  const roundSnapshots = buildSharedRoundSnapshots({
    variant: "sp",
    gameMode,
    roundResults,
    totalScore: session.totalScore,
  });

  // Auto-fetch rank for authenticated users
  useEffect(() => {
    if (!user) return;
    setRankLoading(true);
    getUserRank()
      .then((data) => setRankData(data))
      .catch(() => setRankData(null))
      .finally(() => setRankLoading(false));
  }, [user]);

  const baseHeadline = getResultHeadline(
    session.totalScore,
    getPerRoundMaxScore(gameMode) * session.totalRounds,
  );
  // Personalize the headline with the player's name when they're signed
  // in — the run already belongs to them, so landing the name next to the
  // achievement makes the result feel "theirs" rather than generic.
  // Anonymous users keep the neutral copy (no invented placeholder names).
  const headline = user
    ? `${baseHeadline.replace(/[!.?]+$/, "")}, ${user.username}!`
    : baseHeadline;

  const signupCta =
    !user && onOpenAuth ? (
      <SignupCtaCard variant="score" score={session.totalScore} onSignup={onOpenAuth} />
    ) : null;

  return (
    <div className="page result-page" data-testid="result-page">
      <h1 className="result-page-title">{headline}</h1>
      <span className="mode-label">{getGameModeName(gameMode)}</span>
      <div className="final-score">
        <span className="final-score-label">Final Score</span>
        <span className="final-score-value">{session.totalScore}</span>
      </div>

      {signupCta}

      <button className="btn btn-start" onClick={onPlayAgain}>
        Play Again
      </button>

      <button
        className="btn btn-primary"
        onClick={() => setShareOpen(true)}
        type="button"
      >
        Share Results
      </button>

      <div className="breakdown">
        <h3 className="breakdown-title">Round-by-Round Breakdown</h3>
        {gameMode === "classic" && <ClassicBreakdown results={roundResults} />}
        {gameMode === "higher-lower" && <HigherLowerBreakdown results={roundResults} />}
        {gameMode === "comparison" && <ComparisonBreakdown results={roundResults} />}
        {gameMode === "closest-without-going-over" && <ClosestBreakdown results={roundResults} />}
        {gameMode === "price-match" && <PriceMatchBreakdown results={roundResults} />}
        {gameMode === "riser" && <RiserBreakdown results={roundResults} />}
        {gameMode === "odd-one-out" && <OddOneOutBreakdown results={roundResults} />}
        {gameMode === "market-basket" && <MarketBasketBreakdown results={roundResults} />}
        {gameMode === "sort-it-out" && <SortItOutBreakdown results={roundResults} />}
        {gameMode === "budget-builder" && <BudgetBuilderBreakdown results={roundResults} />}
        {gameMode === "chain-reaction" && <ChainReactionBreakdown results={roundResults} />}
      </div>

      {user && (
        <div className="leaderboard-rank">
          {rankLoading ? (
            <p className="rank-loading">Checking your rank...</p>
          ) : rankData ? (
            <p className="rank-display">
              You are ranked <strong>#{rankData.rank}</strong> of{" "}
              {rankData.totalPlayers.toLocaleString()} players.{" "}
              <button className="btn btn-link" onClick={onShowLeaderboard}>
                View Leaderboard
              </button>
            </p>
          ) : (
            <button className="btn btn-link" onClick={onShowLeaderboard}>
              View Leaderboard
            </button>
          )}
        </div>
      )}

      <button className="btn btn-start" onClick={onPlayAgain}>
        Play Again
      </button>
      {onBackToModes && (
        <button className="btn btn-secondary" onClick={onBackToModes}>
          Change Game Mode
        </button>
      )}

      {/* Logged-in users already see the rank-display block above with
          its own "View Leaderboard" CTA — only render the footer link
          for anon users so the page doesn't double-CTA. */}
      {!user && <LeaderboardLink onShowLeaderboard={onShowLeaderboard} />}

      {shareOpen && (
        <ShareModal
          shareInput={shareInput}
          roundSnapshots={roundSnapshots}
          playerName={user ? user.username : null}
          onClose={() => setShareOpen(false)}
        />
      )}
    </div>
  );
}
