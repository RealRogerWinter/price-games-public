/**
 * Supply chain map page.
 *
 * Shows geographic visualization of a product's supply chain
 * using Leaflet with OpenStreetMap tiles.
 */

import { useState, useEffect } from "react";
import { useParams, Link } from "react-router-dom";
import SupplyChainMap from "../../components/universe/SupplyChainMap";
import LoadingSpinner from "../../components/universe/LoadingSpinner";
import ErrorDisplay from "../../components/universe/ErrorDisplay";
import { puGetSupplyChain, puGetProduct } from "../../api/universeClient";

export default function SupplyChainMapPage() {
  const { id } = useParams<{ id: string }>();
  const productId = parseInt(id || "0", 10);

  const [nodes, setNodes] = useState<any[]>([]);
  const [productTitle, setProductTitle] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!productId) return;
    setLoading(true);
    Promise.all([
      puGetSupplyChain(productId),
      puGetProduct(productId),
    ])
      .then(([scData, product]) => {
        setNodes(scData.nodes);
        setProductTitle(product.title);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [productId]);

  if (loading) return <LoadingSpinner message="Loading supply chain..." />;
  if (error) return <ErrorDisplay message={error} />;

  return (
    <div className="pu-supply-chain-page">
      <div className="pu-page-header">
        <Link to={`/universe/product/${productId}`} className="pu-back-link">
          Back to {productTitle || "Product"}
        </Link>
        <h1>Supply Chain Map</h1>
        <p>{productTitle}</p>
      </div>
      {nodes.length > 0 ? (
        <SupplyChainMap nodes={nodes} />
      ) : (
        <p className="pu-muted">No supply chain data available yet. Enrichment may still be in progress.</p>
      )}
    </div>
  );
}
