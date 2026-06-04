import { useState, useEffect, useCallback, useRef } from "react";
import type {
  Reward,
  RewardListParams,
  RandomRollCriteria,
  QualifyingPlayer,
} from "@price-game/shared";
import {
  getRewards,
  createReward,
  deleteReward,
  awardReward,
  getQualifyingPlayers,
  previewRandomRoll,
  confirmPendingAward,
  discardPendingAward,
  searchUsersForReward,
} from "../../api/adminClient";

type ModalView = "none" | "add" | "award" | "roll" | "roll-review";

interface CandidateAward {
  id: string;
  userId: string;
  username: string;
  email: string;
}

interface UserSearchResult {
  id: string;
  username: string;
  email: string;
  lifetimeScore: number;
}

/**
 * Admin rewards management page. Allows admins to add Amazon gift card
 * rewards to a pool, manually award them to players, or run random rolls
 * based on qualifying criteria.
 */
export default function AdminRewardsPage() {
  // Reward list state
  const [rewards, setRewards] = useState<Reward[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize] = useState(25);
  const [statusFilter, setStatusFilter] = useState<RewardListParams["status"]>("all");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Modal state
  const [modal, setModal] = useState<ModalView>("none");
  const [selectedReward, setSelectedReward] = useState<Reward | null>(null);

  // Add reward form
  const [addCode, setAddCode] = useState("");
  const [addAmount, setAddAmount] = useState("");
  const [addDescription, setAddDescription] = useState("");
  const [addSubmitting, setAddSubmitting] = useState(false);

  // Manual award state
  const [userQuery, setUserQuery] = useState("");
  const [userResults, setUserResults] = useState<UserSearchResult[]>([]);
  const [selectedUser, setSelectedUser] = useState<UserSearchResult | null>(null);
  const [awardSubmitting, setAwardSubmitting] = useState(false);
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout>>();

  // Random roll state
  const [rollCriteria, setRollCriteria] = useState<RandomRollCriteria>({
    mode: "points_only",
    minPoints: 1000,
    period: "last_month",
    useLifetimePoints: false,
    minStreak: 0,
    excludedUserIds: [],
    excludeTestAccounts: true,
  });
  const [qualifyingPlayers, setQualifyingPlayers] = useState<QualifyingPlayer[]>([]);
  const [qualifyingTotal, setQualifyingTotal] = useState(0);
  const [rollLoading, setRollLoading] = useState(false);
  // Phase-2 review state: holds the candidate winner returned from
  // previewRandomRoll while admin decides to confirm or discard.
  const [pendingReview, setPendingReview] = useState<{
    candidateAward: CandidateAward;
    reward: Reward;
    totalQualifying: number;
    nonWinnerNotifyCount: number;
  } | null>(null);
  // Inputs for the calendar_month period
  const today = new Date();
  const [rollMonthYear, setRollMonthYear] = useState<number>(today.getUTCFullYear());
  const [rollMonthIndex, setRollMonthIndex] = useState<number>(today.getUTCMonth());

  const totalPages = Math.ceil(total / pageSize);

  const fetchRewards = useCallback(async () => {
    try {
      setError(null);
      setLoading(true);
      const result = await getRewards({ page, pageSize, status: statusFilter });
      setRewards(result.rewards);
      setTotal(result.total);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load rewards");
    } finally {
      setLoading(false);
    }
  }, [page, pageSize, statusFilter]);

  useEffect(() => {
    fetchRewards();
  }, [fetchRewards]);

  // Clean up debounce
  useEffect(() => {
    return () => {
      if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    };
  }, []);

  const successTimerRef = useRef<ReturnType<typeof setTimeout>>();

  function clearSuccess() {
    if (successTimerRef.current) clearTimeout(successTimerRef.current);
    successTimerRef.current = setTimeout(() => setSuccess(null), 4000);
  }

  // Clean up success timer on unmount
  useEffect(() => {
    return () => {
      if (successTimerRef.current) clearTimeout(successTimerRef.current);
    };
  }, []);

  // === Add Reward ===

  async function handleAddReward(e: React.FormEvent) {
    e.preventDefault();
    const amountDollars = parseFloat(addAmount);
    if (isNaN(amountDollars) || amountDollars <= 0) {
      setError("Amount must be a positive number");
      return;
    }
    try {
      setAddSubmitting(true);
      setError(null);
      await createReward({
        rewardType: "amazon_gift_card",
        amountCents: Math.round(amountDollars * 100),
        code: addCode,
        description: addDescription || undefined,
      });
      setSuccess("Reward added to pool");
      clearSuccess();
      setAddCode("");
      setAddAmount("");
      setAddDescription("");
      setModal("none");
      await fetchRewards();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to add reward");
    } finally {
      setAddSubmitting(false);
    }
  }

  // === Delete Reward ===

  async function handleDelete(reward: Reward) {
    if (reward.status !== "available") return;
    if (!window.confirm(`Delete this ${formatPrice(reward.amountCents)} gift card? This cannot be undone.`)) return;
    try {
      setError(null);
      await deleteReward(reward.id);
      setSuccess("Reward removed from pool");
      clearSuccess();
      await fetchRewards();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to delete reward");
    }
  }

  // === Manual Award ===

  function openAwardModal(reward: Reward) {
    setSelectedReward(reward);
    setSelectedUser(null);
    setUserQuery("");
    setUserResults([]);
    setModal("award");
  }

  function handleUserSearch(query: string) {
    setUserQuery(query);
    setSelectedUser(null);
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    if (!query || query.length < 2) {
      setUserResults([]);
      return;
    }
    searchDebounceRef.current = setTimeout(async () => {
      try {
        const results = await searchUsersForReward(query);
        setUserResults(results);
      } catch {
        setUserResults([]);
      }
    }, 300);
  }

  async function handleAward() {
    if (!selectedReward || !selectedUser) return;
    try {
      setAwardSubmitting(true);
      setError(null);
      await awardReward(selectedReward.id, selectedUser.id);
      setSuccess(`Reward awarded to ${selectedUser.username}`);
      clearSuccess();
      setModal("none");
      setSelectedReward(null);
      setSelectedUser(null);
      await fetchRewards();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to award reward");
    } finally {
      setAwardSubmitting(false);
    }
  }

  // === Random Roll ===

  function openRollModal(reward: Reward) {
    setSelectedReward(reward);
    setQualifyingPlayers([]);
    setQualifyingTotal(0);
    setPendingReview(null);
    setRollCriteria((c) => ({ ...c, excludedUserIds: [] }));
    setModal("roll");
  }

  /**
   * Effective criteria sent to the API. Folds the calendar-month picker
   * + the local exclusion list into the canonical RandomRollCriteria.
   */
  function buildEffectiveCriteria(): RandomRollCriteria {
    const base = { ...rollCriteria };
    if (base.period === "calendar_month") {
      base.month = { year: rollMonthYear, monthIndex: rollMonthIndex };
    } else {
      delete base.month;
    }
    return base;
  }

  async function handlePreviewQualifying() {
    try {
      setRollLoading(true);
      setError(null);
      const result = await getQualifyingPlayers(buildEffectiveCriteria());
      setQualifyingPlayers(result.players);
      setQualifyingTotal(result.total);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load qualifying players");
    } finally {
      setRollLoading(false);
    }
  }

  function toggleExcluded(userId: string) {
    setRollCriteria((c) => {
      const set = new Set(c.excludedUserIds ?? []);
      if (set.has(userId)) set.delete(userId);
      else set.add(userId);
      return { ...c, excludedUserIds: Array.from(set) };
    });
  }

  /**
   * Phase 1 of the two-phase roll: pick a candidate winner without
   * sending any emails. Re-previews qualifying first so the criteria are
   * authoritative, then opens the review modal.
   */
  async function handleStartRoll() {
    if (!selectedReward) return;
    try {
      setRollLoading(true);
      setError(null);
      const result = await previewRandomRoll(selectedReward.id, buildEffectiveCriteria());
      setPendingReview(result);
      setModal("roll-review");
      await fetchRewards();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Random roll failed");
    } finally {
      setRollLoading(false);
    }
  }

  async function handleConfirmReview() {
    if (!pendingReview) return;
    try {
      setRollLoading(true);
      setError(null);
      await confirmPendingAward(pendingReview.candidateAward.id);
      setSuccess(
        `Confirmed — ${pendingReview.candidateAward.username} notified. ` +
        `${pendingReview.nonWinnerNotifyCount} consolation email${pendingReview.nonWinnerNotifyCount === 1 ? "" : "s"} queued.`,
      );
      setPendingReview(null);
      setQualifyingPlayers([]);
      setQualifyingTotal(0);
      setModal("none");
      await fetchRewards();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to confirm award");
    } finally {
      setRollLoading(false);
    }
  }

  async function handleRerollReview() {
    if (!pendingReview || !selectedReward) return;
    try {
      setRollLoading(true);
      setError(null);
      await discardPendingAward(pendingReview.candidateAward.id);
      // Immediately re-roll using the same criteria.
      const result = await previewRandomRoll(selectedReward.id, buildEffectiveCriteria());
      setPendingReview(result);
      await fetchRewards();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Re-roll failed");
    } finally {
      setRollLoading(false);
    }
  }

  /**
   * Discard a pending-review row from a previous session (e.g. admin
   * closed the tab without confirming). Resolves the row from the table
   * — no need to re-open the review modal first.
   */
  async function handleAbandonPending(reward: Reward) {
    if (!reward.award?.id) return;
    if (
      !window.confirm(
        `Discard the pending candidate for this ${formatPrice(reward.amountCents)} reward? The reward returns to the pool. No emails will be sent.`,
      )
    ) {
      return;
    }
    try {
      setError(null);
      await discardPendingAward(reward.award.id);
      setSuccess("Pending candidate discarded; reward returned to the pool.");
      await fetchRewards();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to discard pending");
    }
  }

  async function handleCancelReview() {
    if (!pendingReview) return;
    try {
      setRollLoading(true);
      setError(null);
      await discardPendingAward(pendingReview.candidateAward.id);
      setPendingReview(null);
      setModal("roll");
      await fetchRewards();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Cancel failed");
    } finally {
      setRollLoading(false);
    }
  }

  // === Helpers ===

  function formatPrice(cents: number) {
    return `$${(cents / 100).toFixed(2)}`;
  }

  function formatDate(iso: string) {
    return new Date(iso).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  }

  function statusBadgeClass(status: string) {
    switch (status) {
      case "available":
        return "status-badge status-active";
      case "awarded":
        return "status-badge reward-status-awarded";
      case "claimed":
        return "status-badge reward-status-claimed";
      default:
        return "status-badge";
    }
  }

  function periodLabel(period: string) {
    switch (period) {
      case "last_week": return "Last 7 days";
      case "last_month": return "Last 30 days";
      case "last_3_months": return "Last 3 months";
      case "all_time": return "All time";
      case "calendar_month": return "Calendar month";
      default: return period;
    }
  }

  function monthName(monthIndex: number): string {
    return new Date(Date.UTC(2000, monthIndex, 1)).toLocaleString("en-US", {
      month: "long",
      timeZone: "UTC",
    });
  }

  function describeCriteria(c: RandomRollCriteria) {
    const mode = c.mode ?? "points_only";
    let periodPhrase: string;
    if (c.useLifetimePoints) {
      periodPhrase = "Lifetime";
    } else if (c.period === "calendar_month") {
      const m = c.month ?? { year: rollMonthYear, monthIndex: rollMonthIndex };
      periodPhrase = `${monthName(m.monthIndex)} ${m.year}`;
    } else {
      periodPhrase = periodLabel(c.period);
    }
    const pointsPart = `${periodPhrase} points ≥ ${c.minPoints.toLocaleString()}`;
    const streakPart = `streak ≥ ${(c.minStreak ?? 0).toLocaleString()} day${(c.minStreak ?? 0) === 1 ? "" : "s"}`;
    let core: string;
    switch (mode) {
      case "points_only":
        core = pointsPart;
        break;
      case "streak_only":
        core = streakPart.charAt(0).toUpperCase() + streakPart.slice(1);
        break;
      case "points_and_streak":
        core = `${pointsPart} AND ${streakPart}`;
        break;
      case "points_or_streak":
        core = `${pointsPart} OR ${streakPart}`;
        break;
    }
    const exclusions = (c.excludedUserIds?.length ?? 0) > 0
      ? ` (excluded ${c.excludedUserIds!.length} user${c.excludedUserIds!.length === 1 ? "" : "s"})`
      : "";
    return `${core}${exclusions}`;
  }

  return (
    <div className="admin-rewards-page" data-testid="admin-rewards-page">
      {/* Header */}
      <div className="admin-rewards-header">
        <h2>Rewards</h2>
        <button
          className="admin-btn-primary"
          onClick={() => {
            setAddCode("");
            setAddAmount("");
            setAddDescription("");
            setModal("add");
          }}
          data-testid="add-reward-btn"
        >
          Add Gift Card
        </button>
      </div>

      {success && <div className="admin-success">{success}</div>}
      {error && <div className="admin-error" style={{ maxWidth: "100%", marginBottom: 16 }}>{error}</div>}

      {/* Status filter */}
      <div className="admin-rewards-toolbar">
        <div className="admin-active-toggle" data-testid="rewards-status-filter">
          {(["all", "available", "awarded", "claimed"] as const).map((val) => (
            <button
              key={val}
              className={statusFilter === val ? "active" : ""}
              onClick={() => { setStatusFilter(val); setPage(1); }}
            >
              {val.charAt(0).toUpperCase() + val.slice(1)}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="admin-loading" style={{ minHeight: "200px" }}>
          <span className="admin-loading-spinner" />
          Loading rewards...
        </div>
      ) : (
        <>
          <div className="admin-products-count" data-testid="rewards-count">
            {total} reward{total !== 1 ? "s" : ""}
          </div>

          <div className="admin-table-wrap">
          <table className="admin-table" data-testid="rewards-table">
            <thead>
              <tr>
                <th>Type</th>
                <th>Amount</th>
                <th>Code</th>
                <th>Description</th>
                <th>Status</th>
                <th>Awarded To</th>
                <th>Claim By</th>
                <th>Created</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {rewards.map((reward) => (
                <tr key={reward.id} data-testid={`reward-row-${reward.id}`}>
                  <td className="reward-type-cell">Amazon Gift Card</td>
                  <td className="reward-amount-cell">{formatPrice(reward.amountCents)}</td>
                  <td className="reward-code-cell">
                    <code>{reward.status === "available" ? reward.code : `${reward.code.slice(0, 4)}...`}</code>
                  </td>
                  <td>{reward.description || "—"}</td>
                  <td>
                    <span className={statusBadgeClass(reward.status)}>
                      {reward.status}
                    </span>
                    {reward.award?.pendingReviewAt && (
                      <span
                        className="status-badge"
                        style={{ marginLeft: 4, background: "#fef3c7", color: "#92400e" }}
                        data-testid={`pending-review-${reward.id}`}
                      >
                        pending review
                      </span>
                    )}
                  </td>
                  <td>
                    {reward.award ? (
                      <span title={`Awarded ${formatDate(reward.award.awardedAt)} via ${reward.award.awardMethod}`}>
                        {reward.award.username}
                      </span>
                    ) : "—"}
                  </td>
                  <td>
                    {reward.award && reward.status === "awarded" && !reward.award.pendingReviewAt
                      ? formatDate(reward.award.claimExpiresAt)
                      : "—"}
                  </td>
                  <td>{formatDate(reward.createdAt)}</td>
                  <td className="reward-actions-cell">
                    {reward.status === "available" && (
                      <>
                        <button
                          className="admin-btn-sm"
                          onClick={() => openAwardModal(reward)}
                          title="Manually award to a player"
                          data-testid={`award-btn-${reward.id}`}
                        >
                          Award
                        </button>
                        <button
                          className="admin-btn-sm"
                          onClick={() => openRollModal(reward)}
                          title="Random roll from qualifying players"
                          data-testid={`roll-btn-${reward.id}`}
                        >
                          Roll
                        </button>
                        <button
                          className="admin-btn-sm admin-btn-sm-danger"
                          onClick={() => handleDelete(reward)}
                          title="Remove from pool"
                          data-testid={`delete-btn-${reward.id}`}
                        >
                          Delete
                        </button>
                      </>
                    )}
                    {reward.award?.pendingReviewAt && (
                      <button
                        className="admin-btn-sm admin-btn-sm-danger"
                        onClick={() => handleAbandonPending(reward)}
                        title="Discard the pending candidate and return reward to pool"
                        data-testid={`abandon-pending-btn-${reward.id}`}
                      >
                        Discard pending
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {rewards.length === 0 && (
                <tr>
                  <td colSpan={8} style={{ textAlign: "center", padding: 24, color: "#666" }}>
                    No rewards found
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="admin-pagination">
              <div className="admin-pagination-info">
                Page {page} of {totalPages} ({total} total)
              </div>
              <div className="admin-pagination-pages">
                <button disabled={page <= 1} onClick={() => setPage(page - 1)}>&lsaquo;</button>
                <button disabled={page >= totalPages} onClick={() => setPage(page + 1)}>&rsaquo;</button>
              </div>
            </div>
          )}
        </>
      )}

      {/* === Add Reward Modal === */}
      {modal === "add" && (
        <div className="modal-overlay" onClick={() => setModal("none")}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <button className="modal-close" onClick={() => setModal("none")}>&times;</button>
            <h3 className="modal-title">Add Amazon Gift Card</h3>
            <form onSubmit={handleAddReward} className="reward-form">
              <label>
                Amount ($)
                <input
                  type="number"
                  step="0.01"
                  min="0.01"
                  value={addAmount}
                  onChange={(e) => setAddAmount(e.target.value)}
                  placeholder="25.00"
                  required
                  data-testid="add-reward-amount"
                />
              </label>
              <label>
                Gift Card Code
                <input
                  type="text"
                  value={addCode}
                  onChange={(e) => setAddCode(e.target.value)}
                  placeholder="XXXX-XXXXXX-XXXX"
                  maxLength={200}
                  required
                  data-testid="add-reward-code"
                />
              </label>
              <label>
                Description (optional)
                <input
                  type="text"
                  value={addDescription}
                  onChange={(e) => setAddDescription(e.target.value)}
                  placeholder="e.g. March giveaway prize"
                  maxLength={500}
                  data-testid="add-reward-description"
                />
              </label>
              <div className="reward-form-actions">
                <button type="button" className="admin-btn-cancel" onClick={() => setModal("none")}>
                  Cancel
                </button>
                <button type="submit" className="admin-btn-primary" disabled={addSubmitting}>
                  {addSubmitting ? "Adding..." : "Add Reward"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* === Manual Award Modal === */}
      {modal === "award" && selectedReward && (
        <div className="modal-overlay" onClick={() => setModal("none")}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <button className="modal-close" onClick={() => setModal("none")}>&times;</button>
            <h3 className="modal-title">Award Reward</h3>
            <div className="reward-award-info">
              <p>
                <strong>Reward:</strong> {formatPrice(selectedReward.amountCents)} Amazon Gift Card
              </p>
            </div>
            <div className="reward-user-search">
              <label>
                Search Player
                <input
                  type="text"
                  value={userQuery}
                  onChange={(e) => handleUserSearch(e.target.value)}
                  placeholder="Start typing a username..."
                  data-testid="award-user-search"
                />
              </label>
              {userResults.length > 0 && !selectedUser && (
                <div className="reward-user-results" data-testid="award-user-results">
                  {userResults.map((u) => (
                    <button
                      key={u.id}
                      className="reward-user-result"
                      onClick={() => {
                        setSelectedUser(u);
                        setUserQuery(u.username);
                        setUserResults([]);
                      }}
                    >
                      <span className="reward-user-name">{u.username}</span>
                      <span className="reward-user-email">{u.email}</span>
                      <span className="reward-user-score">{u.lifetimeScore.toLocaleString()} pts</span>
                    </button>
                  ))}
                </div>
              )}
              {selectedUser && (
                <div className="reward-selected-user" data-testid="award-selected-user">
                  <span>{selectedUser.username}</span>
                  <span className="reward-user-email">{selectedUser.email}</span>
                  <span className="reward-user-score">{selectedUser.lifetimeScore.toLocaleString()} pts</span>
                  <button onClick={() => { setSelectedUser(null); setUserQuery(""); }}>Change</button>
                </div>
              )}
            </div>
            <div className="reward-form-actions">
              <button className="admin-btn-cancel" onClick={() => setModal("none")}>Cancel</button>
              <button
                className="admin-btn-primary"
                disabled={!selectedUser || awardSubmitting}
                onClick={handleAward}
                data-testid="confirm-award-btn"
              >
                {awardSubmitting ? "Awarding..." : "Award Reward"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* === Random Roll Modal === */}
      {modal === "roll" && selectedReward && (
        <div className="modal-overlay" onClick={() => setModal("none")}>
          <div className="modal-content reward-roll-modal" onClick={(e) => e.stopPropagation()}>
            <button className="modal-close" onClick={() => setModal("none")}>&times;</button>
            <h3 className="modal-title">Random Roll</h3>
            <div className="reward-award-info">
              <p>
                <strong>Reward:</strong> {formatPrice(selectedReward.amountCents)} Amazon Gift Card
              </p>
            </div>

            <div className="reward-criteria-form">
              <h4>Qualifying Criteria</h4>
              <div className="reward-criteria-grid">
                <label>
                  Qualification Mode
                  <select
                    value={rollCriteria.mode ?? "points_only"}
                    onChange={(e) =>
                      setRollCriteria({
                        ...rollCriteria,
                        mode: e.target.value as NonNullable<RandomRollCriteria["mode"]>,
                      })
                    }
                    data-testid="roll-mode"
                  >
                    <option value="points_only">Points only</option>
                    <option value="streak_only">Streak only</option>
                    <option value="points_and_streak">Points AND streak</option>
                    <option value="points_or_streak">Points OR streak</option>
                  </select>
                </label>
                {rollCriteria.mode !== "streak_only" && (
                  <>
                    <label>
                      Minimum Points
                      <input
                        type="number"
                        min="0"
                        value={rollCriteria.minPoints}
                        onChange={(e) =>
                          setRollCriteria({ ...rollCriteria, minPoints: parseInt(e.target.value, 10) || 0 })
                        }
                        data-testid="roll-min-points"
                      />
                    </label>
                    <label>
                      Time Period
                      <select
                        value={rollCriteria.period}
                        disabled={rollCriteria.useLifetimePoints}
                        onChange={(e) =>
                          setRollCriteria({
                            ...rollCriteria,
                            period: e.target.value as RandomRollCriteria["period"],
                          })
                        }
                        data-testid="roll-period"
                      >
                        <option value="last_week">Last 7 days</option>
                        <option value="last_month">Last 30 days</option>
                        <option value="last_3_months">Last 3 months</option>
                        <option value="all_time">All time</option>
                        <option value="calendar_month">Calendar month…</option>
                      </select>
                    </label>
                    {rollCriteria.period === "calendar_month" && !rollCriteria.useLifetimePoints && (
                      <>
                        <label>
                          Month
                          <select
                            value={rollMonthIndex}
                            onChange={(e) => setRollMonthIndex(parseInt(e.target.value, 10))}
                            data-testid="roll-month-month"
                          >
                            {Array.from({ length: 12 }).map((_, i) => (
                              <option key={i} value={i}>
                                {monthName(i)}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label>
                          Year
                          <input
                            type="number"
                            min="2024"
                            max={today.getUTCFullYear()}
                            value={rollMonthYear}
                            onChange={(e) => setRollMonthYear(parseInt(e.target.value, 10) || today.getUTCFullYear())}
                            data-testid="roll-month-year"
                          />
                          <span className="reward-criteria-hint">
                            Qualifies anyone who scored ≥ minimum points within {monthName(rollMonthIndex)} {rollMonthYear} (UTC).
                          </span>
                        </label>
                      </>
                    )}
                    <label className="reward-criteria-checkbox">
                      <input
                        type="checkbox"
                        checked={rollCriteria.useLifetimePoints}
                        onChange={(e) =>
                          setRollCriteria({ ...rollCriteria, useLifetimePoints: e.target.checked })
                        }
                        data-testid="roll-use-lifetime"
                      />
                      Use lifetime points instead of period points
                    </label>
                  </>
                )}
                <label className="reward-criteria-checkbox">
                  <input
                    type="checkbox"
                    checked={rollCriteria.excludeTestAccounts !== false}
                    onChange={(e) =>
                      setRollCriteria({ ...rollCriteria, excludeTestAccounts: e.target.checked })
                    }
                    data-testid="roll-exclude-test"
                  />
                  Exclude test accounts (recommended)
                </label>
                {rollCriteria.mode !== "points_only" && (
                  <label>
                    Minimum Streak (days)
                    <input
                      type="number"
                      min="1"
                      value={rollCriteria.minStreak ?? 0}
                      onChange={(e) =>
                        setRollCriteria({ ...rollCriteria, minStreak: parseInt(e.target.value, 10) || 0 })
                      }
                      data-testid="roll-min-streak"
                    />
                    <span className="reward-criteria-hint">
                      Current consecutive daily-challenge streak required to qualify.
                    </span>
                  </label>
                )}
              </div>
              <button
                className="admin-btn-primary"
                onClick={handlePreviewQualifying}
                disabled={rollLoading}
                style={{ marginTop: 12 }}
                data-testid="preview-qualifying-btn"
              >
                {rollLoading ? "Loading..." : "Preview Qualifying Players"}
              </button>
            </div>

            {qualifyingTotal > 0 && (
              <div className="reward-qualifying-preview">
                <h4>
                  {qualifyingTotal} Qualifying Player{qualifyingTotal !== 1 ? "s" : ""}
                  {(rollCriteria.excludedUserIds?.length ?? 0) > 0 && (
                    <span className="reward-qualifying-excluded-count">
                      {" "}({rollCriteria.excludedUserIds!.length} excluded)
                    </span>
                  )}
                </h4>
                <p className="reward-criteria-hint">
                  Click the × to remove any player you don't want in the pool (e.g. friends, family,
                  internal accounts). Removed players are dropped before the roll.
                </p>
                <div className="reward-qualifying-list">
                  {qualifyingPlayers.map((p) => {
                    const isExcluded = rollCriteria.excludedUserIds?.includes(p.id) ?? false;
                    return (
                      <div
                        key={p.id}
                        className={`reward-qualifying-player${isExcluded ? " reward-qualifying-excluded" : ""}`}
                      >
                        <span className="reward-user-name">{p.username}</span>
                        <span className="reward-user-score">{p.points.toLocaleString()} pts</span>
                        <span className="reward-user-streak" data-testid="qualifying-player-streak">
                          🔥 {p.streak}
                        </span>
                        <span className="reward-user-games">{p.gamesPlayed} games</span>
                        <button
                          className="reward-qualifying-remove"
                          onClick={() => toggleExcluded(p.id)}
                          data-testid={`exclude-btn-${p.id}`}
                          title={isExcluded ? "Re-include in pool" : "Exclude from pool"}
                        >
                          {isExcluded ? "Restore" : "×"}
                        </button>
                      </div>
                    );
                  })}
                </div>
                <button
                  className="admin-btn-primary reward-roll-btn"
                  onClick={handleStartRoll}
                  disabled={rollLoading}
                  data-testid="execute-roll-btn"
                >
                  {rollLoading
                    ? "Rolling..."
                    : `Roll winner (review before sending emails)`}
                </button>
              </div>
            )}

            {qualifyingTotal === 0 && qualifyingPlayers.length === 0 && !rollLoading && (
              <div className="reward-qualifying-empty">
                Click "Preview" to see qualifying players, or adjust criteria.
              </div>
            )}
          </div>
        </div>
      )}

      {/* === Roll Review Modal (phase 2 — confirm before any emails) === */}
      {modal === "roll-review" && pendingReview && (
        <div className="modal-overlay">
          <div className="modal-content reward-roll-result" onClick={(e) => e.stopPropagation()}>
            <h3 className="modal-title">Review Winner</h3>
            <p className="reward-criteria-hint" style={{ marginTop: 0 }}>
              <strong>No emails have been sent yet.</strong> Confirm to notify the winner and the
              qualifying-but-not-winning players, or re-roll/cancel without sending anything.
            </p>
            <div className="reward-roll-winner">
              <div className="reward-roll-winner-label">Candidate Winner</div>
              <div className="reward-roll-winner-name" data-testid="review-winner-username">
                {pendingReview.candidateAward.username}
              </div>
              <div className="reward-roll-winner-details">
                <span>{pendingReview.candidateAward.email}</span>
              </div>
              <div className="reward-roll-winner-reward">
                Will be awarded {formatPrice(pendingReview.reward.amountCents)} Amazon Gift Card
              </div>
              <div className="reward-roll-odds">
                Selected from {pendingReview.totalQualifying} qualifying player
                {pendingReview.totalQualifying !== 1 ? "s" : ""}.{" "}
                {pendingReview.nonWinnerNotifyCount} consolation email
                {pendingReview.nonWinnerNotifyCount === 1 ? "" : "s"} will be queued on confirm.
              </div>
              <div className="reward-roll-criteria-summary">
                Criteria: {describeCriteria(rollCriteria)}
              </div>
            </div>
            <div className="reward-form-actions" style={{ justifyContent: "space-between", gap: 8 }}>
              <button
                className="admin-btn-secondary"
                onClick={handleCancelReview}
                disabled={rollLoading}
                data-testid="review-cancel-btn"
              >
                Cancel (return to pool)
              </button>
              <button
                className="admin-btn-secondary"
                onClick={handleRerollReview}
                disabled={rollLoading}
                data-testid="review-reroll-btn"
              >
                {rollLoading ? "..." : "Re-roll"}
              </button>
              <button
                className="admin-btn-primary"
                onClick={handleConfirmReview}
                disabled={rollLoading}
                data-testid="review-confirm-btn"
              >
                {rollLoading ? "Sending..." : "Confirm — send emails"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
