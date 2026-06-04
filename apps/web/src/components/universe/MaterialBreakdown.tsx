/**
 * Material breakdown visualization.
 *
 * Shows materials used in a product as a horizontal bar chart with
 * confidence indicators and optional source links.
 */

interface MaterialSource {
  url: string;
  title: string | null;
}

interface MaterialItem {
  id: number;
  name: string;
  category: string | null;
  description: string | null;
  percentage: number | null;
  confidence: string;
  source?: MaterialSource | null;
  sourceUrl?: string | null;
  sourceTitle?: string | null;
}

interface MaterialBreakdownProps {
  materials: MaterialItem[];
  loading?: boolean;
}

/** Map confidence level to a CSS class suffix. */
function confidenceClass(confidence: string): string {
  if (confidence === "high") return "pu-confidence-high";
  if (confidence === "medium") return "pu-confidence-medium";
  return "pu-confidence-low";
}

export default function MaterialBreakdown({ materials, loading }: MaterialBreakdownProps) {
  if (loading) return <div className="pu-materials pu-loading">Loading materials...</div>;
  if (materials.length === 0) return <p className="pu-muted">No material data available yet.</p>;

  return (
    <div className="pu-materials">
      <h3>Materials</h3>
      <div className="pu-material-list">
        {materials.map((m) => {
          const sourceUrl = m.source?.url ?? m.sourceUrl;
          const sourceTitle = m.source?.title ?? m.sourceTitle;
          const hasRealSource = sourceUrl && !sourceUrl.startsWith("ai:") && /^https?:\/\//i.test(sourceUrl);

          return (
            <div key={m.id} className="pu-material-item">
              <div className="pu-material-header">
                <span className="pu-material-name">{m.name}</span>
                {m.category && <span className="pu-material-category">{m.category}</span>}
                <span className={`pu-material-confidence ${confidenceClass(m.confidence)}`} title={`Confidence: ${m.confidence}`}>
                  {m.confidence}
                </span>
                {m.percentage != null && (
                  <span className="pu-material-pct">{Math.round(m.percentage)}%</span>
                )}
                {hasRealSource && (
                  <a
                    className="pu-material-source-link"
                    href={sourceUrl!}
                    target="_blank"
                    rel="noopener noreferrer"
                    title={sourceTitle || sourceUrl!}
                  >
                    [source]
                  </a>
                )}
              </div>
              {m.percentage != null && (
                <div className="pu-material-bar">
                  <div className="pu-material-bar-fill" style={{ width: `${Math.min(m.percentage, 100)}%` }} />
                </div>
              )}
              {m.description && <p className="pu-material-desc">{m.description}</p>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
