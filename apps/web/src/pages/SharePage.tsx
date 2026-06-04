import { useEffect, useState, type ReactNode } from "react";
import { useParams, useNavigate } from "react-router-dom";
import type {
  SharedGameRecord,
  ShareGridInput,
} from "@price-game/shared";
import {
  buildShareText,
  buildShareAccessibleText,
  getGameModeName,
  normalizeRoundScores,
  scoreToTier,
  tierToEmoji,
} from "@price-game/shared";
import { getShare } from "../api/client";
import { useCurrency } from "../context/CurrencyContext";
import SharedRoundCard from "../components/share/SharedRoundCard";
import PageTopBar from "../components/PageTopBar";
import SiteFooter from "../components/SiteFooter";

/** Wrap every branch in the shared site chrome (centered `app` shell + footer)
 *  so the share URL looks like every other top-level route. */
function ShareShell({ children }: { children: ReactNode }) {
  return (
    <div className="app">
      <PageTopBar />
      {children}
      <SiteFooter />
    </div>
  );
}

/**
 * Read-only viewer for a shared game record at `/s/:id`. Fetches the record
 * from the server, shows a loading state while pending, a friendly 404 /
 * error state on failure, and a full branded rendering on success.
 *
 * Deliberately standalone — does not reuse the ResultPage breakdown
 * components because those require the full RoundResult union shape, which
 * the stored snapshot doesn't exactly match.
 */
export default function SharePage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [record, setRecord] = useState<SharedGameRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) {
      setLoading(false);
      setNotFound(true);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setNotFound(false);
    setError(null);
    getShare(id)
      .then((r) => {
        if (cancelled) return;
        setRecord(r);
        setLoading(false);
      })
      .catch((err: Error) => {
        if (cancelled) return;
        // The client throws a generic "API error <status>: <body>" error —
        // parse the status out to distinguish 404 from other failures.
        if (/API error 404/.test(err.message)) {
          setNotFound(true);
        } else {
          setError(err.message);
        }
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (loading) {
    return (
      <ShareShell>
        <div className="page share-page">
          <div className="share-page-loading" role="status" aria-live="polite">
            Loading share…
          </div>
        </div>
      </ShareShell>
    );
  }

  // Check error state BEFORE the null-record branch so a non-404 error
  // (500, network failure, malformed response) doesn't get masked as a 404.
  if (error) {
    return (
      <ShareShell>
        <div className="page share-page">
          <h1 className="share-page-title">Couldn&apos;t load share</h1>
          <p className="share-page-subtitle">{error}</p>
          <button
            className="btn btn-primary"
            onClick={() => navigate("/")}
            type="button"
          >
            Play your own
          </button>
        </div>
      </ShareShell>
    );
  }

  if (notFound || !record) {
    return (
      <ShareShell>
        <div className="page share-page">
          <h1 className="share-page-title">Share not found</h1>
          <p className="share-page-subtitle">
            This share link doesn&apos;t exist, or it may have been removed.
          </p>
          <button
            className="btn btn-primary"
            onClick={() => navigate("/")}
            type="button"
          >
            Play your own
          </button>
        </div>
      </ShareShell>
    );
  }

  return (
    <ShareShell>
      <SharedGameView record={record} onPlay={() => navigate("/")} />
    </ShareShell>
  );
}

interface SharedGameViewProps {
  record: SharedGameRecord;
  onPlay: () => void;
}

/**
 * Presentational layer for a successfully-fetched SharedGameRecord. Split out
 * so tests can render it directly without going through useParams / fetch.
 */
export function SharedGameView({ record, onPlay }: SharedGameViewProps) {
  const { formatPrice } = useCurrency();
  const modeName = getGameModeName(record.gameMode);
  const totalMax = record.perRoundMax * record.roundData.length;

  // Reuse the shared tier grid builder so the /s/:id view uses the exact
  // same emoji / threshold logic as the ShareModal preview and POST path.
  const shareInput: ShareGridInput = {
    gameMode: record.gameMode,
    modeName,
    roundScores: record.roundData.map((r) => r.score),
    totalScore: record.totalScore,
    perRoundMax: record.perRoundMax,
  };
  const shareText = buildShareText(shareInput);
  const a11yText = buildShareAccessibleText(shareInput);

  const normalized = normalizeRoundScores(shareInput.roundScores);
  const tiers = normalized.map((s) => scoreToTier(s, record.perRoundMax));

  const createdDate = new Date(record.createdAt * 1000);
  const createdString = createdDate.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });

  return (
    <div className="page share-page">
      <div className="share-page-header">
        <h1 className="share-page-title">Price Games</h1>
        <span className="share-page-mode">{modeName}</span>
      </div>

      {record.playerName && (
        <p className="share-page-player">
          Shared by <strong>{record.playerName}</strong>
        </p>
      )}

      <div className="share-page-score">
        <span className="share-page-score-value">
          {record.totalScore.toLocaleString("en-US")}
        </span>
        <span className="share-page-score-max">
          / {totalMax.toLocaleString("en-US")}
        </span>
      </div>

      {/* Visual tier grid. aria-hidden because screen readers get the prose
          equivalent from the .sr-only span below. */}
      <div className="share-page-grid" aria-hidden="true">
        {[0, 1].map((rowIdx) => (
          <div key={rowIdx} className="share-page-grid-row">
            {tiers.slice(rowIdx * 5, rowIdx * 5 + 5).map((tier, i) => (
              <span
                key={i}
                className={`share-page-tile share-page-tile-${tier}`}
              >
                {tierToEmoji(tier)}
              </span>
            ))}
          </div>
        ))}
      </div>
      <span className="sr-only">{a11yText}</span>

      <div className="share-page-rounds">
        <h2 className="share-page-rounds-title">Round-by-round</h2>
        {record.roundData.map((snap, i) => (
          <SharedRoundCard
            key={i}
            snap={snap}
            tier={tiers[i] ?? "miss"}
            perRoundMax={record.perRoundMax}
            formatPrice={formatPrice}
          />
        ))}
      </div>

      <button
        className="btn btn-start share-page-play-btn"
        onClick={onPlay}
        type="button"
      >
        Play your own
      </button>

      <p className="share-page-footer">
        <span>price.games</span>
        <span className="share-page-footer-date">{createdString}</span>
      </p>

      {/* Copy the text grid into a hidden <pre> for users who want to paste
          the share summary directly. Inspectable by tests via its text. */}
      <pre className="sr-only">{shareText}</pre>
    </div>
  );
}

