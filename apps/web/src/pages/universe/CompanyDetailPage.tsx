/**
 * Company detail page for Product Universe.
 *
 * Shows company info, relationship graph, and linked products.
 */

import { useState, useEffect } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import CompanyGraph from "../../components/universe/CompanyGraph";
import LoadingSpinner from "../../components/universe/LoadingSpinner";
import ErrorDisplay from "../../components/universe/ErrorDisplay";
import { puGetCompany, puGetCompanyWeb } from "../../api/universeClient";

export default function CompanyDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const companyId = parseInt(id || "0", 10);

  const [company, setCompany] = useState<any>(null);
  const [graphData, setGraphData] = useState<{ nodes: any[]; edges: any[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!companyId) return;
    setLoading(true);
    Promise.all([
      puGetCompany(companyId),
      puGetCompanyWeb(companyId),
    ])
      .then(([companyData, webData]) => {
        setCompany(companyData);
        setGraphData(webData);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [companyId]);

  if (loading) return <LoadingSpinner message="Loading company..." />;
  if (error) return <ErrorDisplay message={error} />;
  if (!company) return <ErrorDisplay message="Company not found" />;

  return (
    <div className="pu-company-detail">
      <div className="pu-page-header">
        <Link to="/universe/companies" className="pu-back-link">Back to Companies</Link>
        <h1>{company.name}</h1>
        {company.description && <p>{company.description}</p>}
      </div>

      <div className="pu-company-info-grid">
        {company.website && (
          <div className="pu-info-item">
            <span className="pu-info-label">Website</span>
            <span className="pu-info-value">{company.website}</span>
          </div>
        )}
        {company.headquarters && (
          <div className="pu-info-item">
            <span className="pu-info-label">Headquarters</span>
            <span className="pu-info-value">{company.headquarters}</span>
          </div>
        )}
        {company.foundedYear && (
          <div className="pu-info-item">
            <span className="pu-info-label">Founded</span>
            <span className="pu-info-value">{company.foundedYear}</span>
          </div>
        )}
        {company.employeeCount && (
          <div className="pu-info-item">
            <span className="pu-info-label">Employees</span>
            <span className="pu-info-value">{company.employeeCount.toLocaleString()}</span>
          </div>
        )}
        {company.revenue && (
          <div className="pu-info-item">
            <span className="pu-info-label">Revenue</span>
            <span className="pu-info-value">{company.revenue}</span>
          </div>
        )}
      </div>

      {graphData && graphData.nodes.length > 0 && (
        <div className="pu-section">
          <h2>Relationship Network</h2>
          <CompanyGraph
            nodes={graphData.nodes}
            edges={graphData.edges}
            onNodeClick={(id) => navigate(`/universe/company/${id}`)}
          />
        </div>
      )}

      {company.products && company.products.length > 0 && (
        <div className="pu-section">
          <h2>Products</h2>
          <div className="pu-product-list-simple">
            {company.products.map((p: any) => (
              <Link key={p.id} to={`/universe/product/${p.id}`} className="pu-product-link">
                {p.title}
                <span className="pu-role-badge">{p.role}</span>
              </Link>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
