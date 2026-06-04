/**
 * Compact source citation list.
 *
 * Shows where enrichment data came from — clickable links for web sources,
 * "AI-generated" badge for AI-only sources. Collapses when more than 3 sources.
 *
 * @param sources - Array of PUSource objects to display.
 */

import { useState } from "react";
import type { PUSource } from "@price-game/shared";

interface SourceListProps {
  sources: PUSource[];
}

export default function SourceList({ sources }: SourceListProps) {
  const [expanded, setExpanded] = useState(false);

  if (sources.length === 0) return null;

  const isAiSource = (url: string) => url.startsWith("ai:");
  const isSafeUrl = (url: string) => /^https?:\/\//i.test(url);
  const visibleSources = expanded ? sources : sources.slice(0, 3);
  const hasMore = sources.length > 3;

  return (
    <div className="pu-source-list">
      <span className="pu-source-list-label">Sources:</span>
      {visibleSources.map((s) => (
        <div key={s.id} className="pu-source-item">
          {isAiSource(s.url) ? (
            <span className="pu-source-ai-badge">AI-generated</span>
          ) : isSafeUrl(s.url) ? (
            <a
              className="pu-source-link"
              href={s.url}
              target="_blank"
              rel="noopener noreferrer"
              title={s.url}
            >
              {s.title || s.url}
            </a>
          ) : (
            <span className="pu-source-link">{s.title || s.url}</span>
          )}
        </div>
      ))}
      {hasMore && !expanded && (
        <button
          className="pu-source-toggle"
          onClick={() => setExpanded(true)}
        >
          +{sources.length - 3} more
        </button>
      )}
      {hasMore && expanded && (
        <button
          className="pu-source-toggle"
          onClick={() => setExpanded(false)}
        >
          Show less
        </button>
      )}
    </div>
  );
}
