/**
 * Anomaly banner for the analytics dashboard shell.
 *
 * Polls `/api/admin/analytics/v2/anomalies` every 60 s and renders a
 * top-of-page banner when any alert is active. An empty array is the
 * all-clear — the component renders nothing.
 *
 * Severities map to banner tone:
 *   critical → red, pulsing dot
 *   warning  → red, static
 *   info     → neutral (spike messages)
 */

import { useQuery } from "@tanstack/react-query";
import { fetchAnomalies } from "./analyticsApi";

export default function AnomalyBanner(): React.ReactElement | null {
  const { data } = useQuery({
    queryKey: ["analytics", "v2", "anomalies"],
    queryFn: fetchAnomalies,
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  if (!data || data.length === 0) return null;

  return (
    <div className="admin-anomaly-banner" role="status" data-testid="anomaly-banner">
      <h3>Analytics alerts</h3>
      <ul className="admin-anomaly-list">
        {data.map((a) => (
          <li key={a.id} data-testid={`anomaly-${a.id}`}>
            <strong>{a.title}:</strong> {a.detail}
          </li>
        ))}
      </ul>
    </div>
  );
}
