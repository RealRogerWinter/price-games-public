/**
 * Full-screen product dashboard modal.
 *
 * Wide multi-column layout showing product info, AI summaries, materials,
 * supply chain map, company info, product history, and related products
 * as a grid of open cards that use the full horizontal space.
 *
 * @param productId - The product to display
 * @param onClose - Called when the dashboard should close
 */

import { useEffect, useRef, useState, lazy, Suspense } from "react";
import {
  puGetProduct,
  puGetCards,
  puGetMaterials,
  puGetSupplyChain,
  puGetRelated,
} from "../../api/universeClient";
import type { PUProductDetail, PUSummaryCard } from "@price-game/shared";
import LoadingSpinner from "./LoadingSpinner";
import ErrorDisplay from "./ErrorDisplay";
import SummaryCards from "./SummaryCards";
import MaterialBreakdown from "./MaterialBreakdown";
import RelatedProducts from "./RelatedProducts";
import { AmazonCTA } from "../AmazonCTA";
import { amazonSearchUrl } from "@price-game/shared";
import EnrichmentStatus from "./EnrichmentStatus";
import SourceList from "./SourceList";

const SupplyChainMap = lazy(() => import("./SupplyChainMap"));

interface ProductDashboardProps {
  productId: number;
  onClose: () => void;
}

interface DashCardProps {
  title: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
  badge?: string;
  /** CSS class for grid placement (e.g. "span-2" for double-width) */
  span?: string;
}

/** A dashboard card that can be collapsed to just its header. */
function DashCard({ title, defaultOpen = true, children, badge, span }: DashCardProps) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={`pu-dash-card ${span ?? ""} ${open ? "open" : "collapsed"}`}>
      <button
        className="pu-dash-card-header"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="pu-dash-card-arrow">{open ? "\u25BC" : "\u25B6"}</span>
        <span className="pu-dash-card-title">{title}</span>
        {badge && <span className="pu-dash-card-badge">{badge}</span>}
      </button>
      {open && <div className="pu-dash-card-body">{children}</div>}
    </div>
  );
}

export default function ProductDashboard({ productId, onClose }: ProductDashboardProps) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const [product, setProduct] = useState<PUProductDetail | null>(null);
  const [cards, setCards] = useState<PUSummaryCard[]>([]);
  const [materials, setMaterials] = useState<{ id: number; name: string; category: string | null; description: string | null; percentage: number | null; confidence: string; sourceUrl?: string | null; sourceTitle?: string | null }[]>([]);
  const [supplyChain, setSupplyChain] = useState<{ id: number; nodeType: string; description: string | null; orderIndex: number; confidence?: string; company: { id: number; name: string; website?: string | null } | null; location: { id: number; name: string; country: string; latitude: number | null; longitude: number | null } | null; sourceUrl?: string | null; sourceTitle?: string | null }[]>([]);
  const [related, setRelated] = useState<{ id: number; title: string; imageUrl: string | null; category: string | null; manufacturer: string | null; score: number; reason: string | null }[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  useEffect(() => {
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = "";
    };
  }, []);

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;

    puGetProduct(productId)
      .then((prod) => {
        if (cancelled) return;
        setProduct(prod);
        setLoading(false);

        Promise.allSettled([
          puGetCards(productId).then((r) => { if (!cancelled) setCards(r.cards); }),
          puGetMaterials(productId).then((r) => { if (!cancelled) setMaterials(r.materials); }),
          puGetSupplyChain(productId).then((r) => { if (!cancelled) setSupplyChain(r.nodes); }),
          puGetRelated(productId).then((r) => { if (!cancelled) setRelated(r.related); }),
        ]);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err.message);
          setLoading(false);
        }
      });

    return () => { cancelled = true; };
  }, [productId]);

  return (
    <div
      className="pu-dash-overlay"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Product dashboard"
    >
      <div className="pu-dash" onClick={(e) => e.stopPropagation()}>
        {/* Top bar */}
        <div className="pu-dash-topbar">
          <span className="pu-dash-topbar-title">
            {product ? product.title : "Loading..."}
          </span>
          <button
            ref={closeRef}
            className="pu-dash-close"
            onClick={onClose}
            aria-label="Close"
          >
            &times;
          </button>
        </div>

        <div className="pu-dash-scroll">
          {loading && <LoadingSpinner message="Loading product..." />}
          {error && <ErrorDisplay message={error} />}
          {!loading && !error && product && (
            <>
              {/* Hero row: image + info + quick actions */}
              <div className="pu-dash-hero">
                {product.imageUrl && (
                  <img
                    className="pu-dash-hero-img"
                    src={product.imageUrl}
                    alt={product.title}
                  />
                )}
                <div className="pu-dash-hero-info">
                  <h1>{product.title}</h1>
                  <div className="pu-dash-hero-price">
                    ${(product.priceCents / 100).toFixed(2)}
                  </div>
                  <div className="pu-dash-hero-tags">
                    {product.category && <span className="pu-tag">{product.category}</span>}
                    {product.manufacturer && <span className="pu-tag">{product.manufacturer}</span>}
                  </div>
                  {product.description && (
                    <p className="pu-dash-hero-desc">{product.description}</p>
                  )}
                  <EnrichmentStatus enriched={product.puEnriched} enrichedAt={product.puEnrichedAt} />
                </div>
                <div className="pu-dash-hero-actions">
                  <AmazonCTA
                    href={amazonSearchUrl(product.title)}
                    size="md"
                    productLabel={product.title}
                  />
                </div>
              </div>

              {/* Card grid — all sections open by default, side by side */}
              <div className="pu-dash-grid">
                <DashCard
                  title="AI Summary"
                  badge={cards.length > 0 ? `${cards.length} cards` : undefined}
                  span="pu-dash-span-2"
                >
                  <SummaryCards cards={cards} />
                </DashCard>

                <DashCard
                  title="Materials"
                  badge={materials.length > 0 ? `${materials.length}` : undefined}
                >
                  <MaterialBreakdown materials={materials} />
                </DashCard>

                {product.companies.length > 0 && (
                  <DashCard
                    title="Companies"
                    badge={`${product.companies.length}`}
                  >
                    <div className="pu-dash-companies">
                      {product.companies.map((pc) => (
                        <div key={pc.companyId} className="pu-dash-company-item">
                          <div className="pu-dash-company-name">
                            {pc.company.name}
                            <span className="pu-role-badge">{pc.role}</span>
                            {pc.confidence && (
                              <span className={`pu-material-confidence ${pc.confidence === "high" ? "pu-confidence-high" : pc.confidence === "medium" ? "pu-confidence-medium" : "pu-confidence-low"}`}>
                                {pc.confidence}
                              </span>
                            )}
                          </div>
                          {pc.company.description && (
                            <p className="pu-dash-company-desc">{pc.company.description}</p>
                          )}
                          <div className="pu-dash-company-meta">
                            {pc.company.headquarters && <span>HQ: {pc.company.headquarters}</span>}
                            {pc.company.foundedYear && <span>Founded: {pc.company.foundedYear}</span>}
                            {pc.company.website && /^https?:\/\//i.test(pc.company.website) && (
                              <a href={pc.company.website} target="_blank" rel="noopener noreferrer">
                                Website
                              </a>
                            )}
                            {(pc as any).sourceUrl && /^https?:\/\//i.test((pc as any).sourceUrl) && (
                              <a href={(pc as any).sourceUrl} target="_blank" rel="noopener noreferrer" className="pu-source-link">
                                {(pc as any).sourceTitle || "[source]"}
                              </a>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </DashCard>
                )}

                <DashCard title="Supply Chain Map" span="pu-dash-span-2">
                  {supplyChain.length > 0 ? (
                    <Suspense fallback={<LoadingSpinner message="Loading map..." />}>
                      <SupplyChainMap nodes={supplyChain} />
                    </Suspense>
                  ) : (
                    <p className="pu-muted">No supply chain data available yet.</p>
                  )}
                </DashCard>

                {product.puHistory && (() => {
                  let history: {
                    narrative?: string;
                    milestones?: { year: number; event: string; sourceUrl?: string | null; sourceTitle?: string | null }[];
                    sources?: { url: string; title: string | null }[];
                  };
                  try {
                    history = JSON.parse(product.puHistory!);
                  } catch {
                    history = { narrative: "Product history information is available but could not be parsed." };
                  }

                  const historySources = (history.sources ?? []).map((s, i) => ({
                    id: -(i + 1),
                    url: s.url,
                    title: s.title,
                    fetchedAt: "",
                    contentHash: null,
                  }));

                  return (
                    <DashCard title="Product History">
                      <div className="pu-dash-history">
                        {history.narrative && <p>{history.narrative}</p>}
                        {history.milestones && history.milestones.length > 0 && (
                          <div className="pu-history-milestones">
                            <h4>Key Milestones</h4>
                            {history.milestones.map((ms) => (
                              <div key={`${ms.year}-${ms.event}`} className="pu-milestone-item">
                                <span className="pu-milestone-year">{ms.year}</span>
                                <span className="pu-milestone-event">{ms.event}</span>
                                {ms.sourceUrl && /^https?:\/\//i.test(ms.sourceUrl) && (
                                  <a
                                    className="pu-source-link"
                                    href={ms.sourceUrl}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    title={ms.sourceTitle || ms.sourceUrl}
                                  >
                                    [source]
                                  </a>
                                )}
                              </div>
                            ))}
                          </div>
                        )}
                        {historySources.length > 0 && (
                          <SourceList sources={historySources} />
                        )}
                      </div>
                    </DashCard>
                  );
                })()}

                {related.length > 0 && (
                  <DashCard title="Related Products" badge={`${related.length}`}>
                    <RelatedProducts products={related} />
                  </DashCard>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
