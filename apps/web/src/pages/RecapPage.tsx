import { useEffect, useState, type ReactNode } from "react";
import { useParams, useNavigate } from "react-router-dom";
import type { SharedGameRecord } from "@price-game/shared";
import { userGetHistoryRecap } from "../api/userClient";
import PageTopBar from "../components/PageTopBar";
import SiteFooter from "../components/SiteFooter";
import { SharedGameView } from "./SharePage";
import LeaderboardLink from "../components/results/LeaderboardLink";

/** Wrap every branch in the shared site chrome (centered `app` shell + footer)
 *  so the recap URL looks like every other top-level route. */
function RecapShell({ children }: { children: ReactNode }) {
  return (
    <div className="app">
      <PageTopBar />
      {children}
      <SiteFooter />
    </div>
  );
}

/**
 * Read-only recap of any game in `user_game_history`. Mounted at
 * `/recap/:historyId`. Fetches via `GET /api/user/history/:historyId/recap`,
 * which returns a `SharedGameRecord` (either a cache hit against the
 * canonical `shared_games` row or a freshly-synthesized snapshot). The
 * underlying renderer is the same `SharedGameView` used by `/s/:id` so the
 * two URL namespaces produce identical round-by-round breakdowns.
 */
export default function RecapPage() {
  const { historyId } = useParams<{ historyId: string }>();
  const navigate = useNavigate();
  const [record, setRecord] = useState<SharedGameRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const parsed = historyId ? parseInt(historyId, 10) : NaN;
    if (!Number.isFinite(parsed) || parsed <= 0) {
      setLoading(false);
      setNotFound(true);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setNotFound(false);
    setError(null);
    userGetHistoryRecap(parsed)
      .then((r) => {
        if (cancelled) return;
        setRecord(r);
        setLoading(false);
      })
      .catch((err: Error) => {
        if (cancelled) return;
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
  }, [historyId]);

  if (loading) {
    return (
      <RecapShell>
        <div className="page share-page">
          <div className="share-page-loading" role="status" aria-live="polite">
            Loading recap…
          </div>
        </div>
      </RecapShell>
    );
  }

  if (error) {
    return (
      <RecapShell>
        <div className="page share-page">
          <h1 className="share-page-title">Couldn&apos;t load recap</h1>
          <p className="share-page-subtitle">{error}</p>
          <button
            className="btn btn-primary"
            onClick={() => navigate("/")}
            type="button"
          >
            Play your own
          </button>
        </div>
      </RecapShell>
    );
  }

  if (notFound || !record) {
    return (
      <RecapShell>
        <div className="page share-page">
          <h1 className="share-page-title">Recap not found</h1>
          <p className="share-page-subtitle">
            This game couldn&apos;t be loaded. It may have been removed.
          </p>
          <button
            className="btn btn-primary"
            onClick={() => navigate("/")}
            type="button"
          >
            Play your own
          </button>
        </div>
      </RecapShell>
    );
  }

  // No breakdown available (underlying session trimmed). Show a friendlier
  // empty state than SharedGameView's default, which expects rounds.
  if (record.roundData.length === 0) {
    return (
      <RecapShell>
        <div className="page share-page">
          <h1 className="share-page-title">No breakdown available</h1>
          <p className="share-page-subtitle">
            This game&apos;s round data is no longer on file, but your score
            of <strong>{record.totalScore.toLocaleString()}</strong> is still
            credited to your account.
          </p>
          <button
            className="btn btn-primary"
            onClick={() => navigate("/")}
            type="button"
          >
            Play a new game
          </button>
        </div>
      </RecapShell>
    );
  }

  return (
    <RecapShell>
      <SharedGameView record={record} onPlay={() => navigate("/")} />
      <LeaderboardLink />
    </RecapShell>
  );
}
