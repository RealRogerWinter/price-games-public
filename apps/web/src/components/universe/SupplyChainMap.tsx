/**
 * Supply chain map visualization using Leaflet.
 *
 * Renders supply chain nodes as markers on an OpenStreetMap base layer,
 * connected by polylines in order of the supply chain flow.
 */

import { useEffect, useRef } from "react";
import type { Map as LeafletMap } from "leaflet";
import "leaflet/dist/leaflet.css";

interface SupplyChainNode {
  id: number;
  nodeType: string;
  description: string | null;
  orderIndex: number;
  confidence?: string;
  company: { id: number; name: string; website?: string | null } | null;
  location: {
    id: number;
    name: string;
    country: string;
    latitude: number | null;
    longitude: number | null;
  } | null;
  sourceUrl?: string | null;
  sourceTitle?: string | null;
}

interface SupplyChainMapProps {
  nodes: SupplyChainNode[];
}

const NODE_COLORS: Record<string, string> = {
  raw_material: "#e67e22",
  processing: "#3498db",
  manufacturing: "#2ecc71",
  assembly: "#9b59b6",
  distribution: "#1abc9c",
  retail: "#e74c3c",
};

export default function SupplyChainMap({ nodes }: SupplyChainMapProps) {
  const mapRef = useRef<HTMLDivElement>(null);
  const leafletMap = useRef<LeafletMap | null>(null);

  useEffect(() => {
    if (!mapRef.current) return;

    // Dynamic import to avoid SSR issues
    import("leaflet").then((L) => {
      if (leafletMap.current) {
        leafletMap.current.remove();
      }

      const map = L.map(mapRef.current!, { scrollWheelZoom: true });
      leafletMap.current = map;

      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
        maxZoom: 18,
      }).addTo(map);

      const geoNodes = nodes.filter(
        (n) => n.location?.latitude != null && n.location?.longitude != null
      );

      if (geoNodes.length === 0) {
        map.setView([20, 0], 2);
        return;
      }

      const bounds: [number, number][] = [];
      const lineCoords: [number, number][] = [];

      geoNodes.forEach((node) => {
        const lat = node.location!.latitude!;
        const lng = node.location!.longitude!;
        const pos: [number, number] = [lat, lng];
        bounds.push(pos);
        lineCoords.push(pos);

        const color = NODE_COLORS[node.nodeType] || "#95a5a6";
        const icon = L.divIcon({
          className: "pu-map-marker",
          html: `<div style="background:${color};width:14px;height:14px;border-radius:50%;border:2px solid #fff;"></div>`,
          iconSize: [14, 14],
          iconAnchor: [7, 7],
        });

        const isSafe = (url: string) => /^https?:\/\//i.test(url);
        const parts = [
          `<strong>${node.nodeType.replace("_", " ")}</strong>`,
          node.company ? (
            node.company.website && isSafe(node.company.website)
              ? `<a href="${node.company.website}" target="_blank" rel="noopener noreferrer">${node.company.name}</a>`
              : node.company.name
          ) : null,
          node.location ? `${node.location.name}, ${node.location.country}` : null,
          node.description,
          node.confidence ? `<span style="font-size:11px;color:#888;">Confidence: ${node.confidence}</span>` : null,
          node.sourceUrl && isSafe(node.sourceUrl)
            ? `<a href="${node.sourceUrl}" target="_blank" rel="noopener noreferrer" style="font-size:11px;">${node.sourceTitle || "[source]"}</a>`
            : null,
        ].filter(Boolean).join("<br>");

        L.marker(pos, { icon }).addTo(map).bindPopup(parts);
      });

      // Draw supply chain flow
      if (lineCoords.length > 1) {
        L.polyline(lineCoords, {
          color: "#3498db",
          weight: 2,
          opacity: 0.7,
          dashArray: "5, 10",
        }).addTo(map);
      }

      map.fitBounds(bounds, { padding: [30, 30] });
    });

    return () => {
      if (leafletMap.current) {
        leafletMap.current.remove();
        leafletMap.current = null;
      }
    };
  }, [nodes]);

  return (
    <div className="pu-map-container">
      <div ref={mapRef} className="pu-map" style={{ height: "500px", width: "100%" }} />
      <div className="pu-map-legend">
        {Object.entries(NODE_COLORS).map(([type, color]) => (
          <span key={type} className="pu-map-legend-item">
            <span className="pu-map-legend-dot" style={{ background: color }} />
            {type.replace("_", " ")}
          </span>
        ))}
      </div>
    </div>
  );
}
