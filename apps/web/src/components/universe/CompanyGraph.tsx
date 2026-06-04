/**
 * Company relationship graph using D3 force-directed layout.
 *
 * Renders company nodes and relationship edges as an SVG graph.
 * Nodes are sized by product count, colored by type (center vs related).
 */

import { useEffect, useRef } from "react";
import { forceSimulation, forceLink, forceManyBody, forceCenter, forceCollide } from "d3-force";

interface GraphNode {
  id: number;
  name: string;
  type: "center" | "related";
  productCount: number;
  x?: number;
  y?: number;
}

interface GraphEdge {
  source: number;
  target: number;
  type: string;
}

interface CompanyGraphProps {
  nodes: GraphNode[];
  edges: GraphEdge[];
  width?: number;
  height?: number;
  onNodeClick?: (companyId: number) => void;
}

export default function CompanyGraph({
  nodes,
  edges,
  width = 800,
  height = 600,
  onNodeClick,
}: CompanyGraphProps) {
  const svgRef = useRef<SVGSVGElement>(null);

  useEffect(() => {
    if (!svgRef.current || nodes.length === 0) return;

    const svg = svgRef.current;
    // Clear previous content
    while (svg.firstChild) svg.removeChild(svg.firstChild);

    // Create deep copies for D3 mutation
    const simNodes = nodes.map((n) => ({ ...n, x: width / 2, y: height / 2 }));
    const simEdges = edges.map((e) => ({ ...e }));

    const simulation = forceSimulation(simNodes as any)
      .force("link", forceLink(simEdges as any).id((d: any) => d.id).distance(100))
      .force("charge", forceManyBody().strength(-300))
      .force("center", forceCenter(width / 2, height / 2))
      .force("collide", forceCollide().radius(30));

    // Create SVG groups
    const ns = "http://www.w3.org/2000/svg";

    // Edge lines
    const edgeGroup = document.createElementNS(ns, "g");
    svg.appendChild(edgeGroup);

    const edgeElements = simEdges.map((edge) => {
      const line = document.createElementNS(ns, "line");
      line.setAttribute("stroke", "#999");
      line.setAttribute("stroke-opacity", "0.6");
      line.setAttribute("stroke-width", "1.5");
      edgeGroup.appendChild(line);

      // Edge label
      const text = document.createElementNS(ns, "text");
      text.textContent = edge.type.replace("_", " ");
      text.setAttribute("font-size", "10");
      text.setAttribute("fill", "#666");
      text.setAttribute("text-anchor", "middle");
      edgeGroup.appendChild(text);

      return { line, text };
    });

    // Node circles
    const nodeGroup = document.createElementNS(ns, "g");
    svg.appendChild(nodeGroup);

    const nodeElements = simNodes.map((node) => {
      const g = document.createElementNS(ns, "g");
      g.style.cursor = "pointer";

      const circle = document.createElementNS(ns, "circle");
      const radius = node.type === "center" ? 20 : 12 + Math.min(node.productCount, 10);
      circle.setAttribute("r", String(radius));
      circle.setAttribute("fill", node.type === "center" ? "#3498db" : "#95a5a6");
      circle.setAttribute("stroke", "#fff");
      circle.setAttribute("stroke-width", "2");
      g.appendChild(circle);

      const text = document.createElementNS(ns, "text");
      text.textContent = node.name.length > 15 ? node.name.slice(0, 15) + "..." : node.name;
      text.setAttribute("font-size", "11");
      text.setAttribute("fill", "#333");
      text.setAttribute("text-anchor", "middle");
      text.setAttribute("dy", String(radius + 14));
      g.appendChild(text);

      if (onNodeClick) {
        g.addEventListener("click", () => onNodeClick(node.id));
      }

      nodeGroup.appendChild(g);
      return g;
    });

    simulation.on("tick", () => {
      edgeElements.forEach((el, i) => {
        const source = (simEdges[i] as any).source;
        const target = (simEdges[i] as any).target;
        el.line.setAttribute("x1", source.x);
        el.line.setAttribute("y1", source.y);
        el.line.setAttribute("x2", target.x);
        el.line.setAttribute("y2", target.y);
        el.text.setAttribute("x", String((source.x + target.x) / 2));
        el.text.setAttribute("y", String((source.y + target.y) / 2 - 5));
      });

      nodeElements.forEach((g, i) => {
        g.setAttribute("transform", `translate(${simNodes[i].x},${simNodes[i].y})`);
      });
    });

    return () => {
      simulation.stop();
    };
  }, [nodes, edges, width, height, onNodeClick]);

  if (nodes.length === 0) {
    return <p className="pu-muted">No company relationship data available.</p>;
  }

  return (
    <div className="pu-company-graph">
      <svg ref={svgRef} width={width} height={height} viewBox={`0 0 ${width} ${height}`} />
    </div>
  );
}
