/**
 * World choropleth backed by `react-simple-maps`.
 *
 * Lives in its own module so `React.lazy` can code-split it out of the
 * main admin bundle — the ~110 KB TopoJSON + map library only lands when
 * the admin actually opens the Geo tab.
 */

import { memo, useMemo } from "react";
import { ComposableMap, Geographies, Geography } from "react-simple-maps";
import type { GeoCountryRow } from "./GeoTab";

// A CDN-hosted TopoJSON world-atlas file. Using `import.meta.env.BASE_URL`
// makes this play nicely if the app is ever served from a non-root path.
// `react-simple-maps` accepts a URL for `Geographies.geography`.
const WORLD_TOPO_URL =
  "https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json";

interface Props {
  countries: GeoCountryRow[];
}

function WorldMapImpl({ countries }: Props): React.ReactElement {
  const byIso = useMemo(() => {
    const m = new Map<string, GeoCountryRow>();
    for (const row of countries) {
      if (row.country && row.country !== "unknown") m.set(row.country, row);
    }
    return m;
  }, [countries]);

  const max = useMemo(
    () => countries.reduce((m, r) => (r.sessions > m ? r.sessions : m), 0),
    [countries],
  );

  return (
    <div className="world-map" data-testid="world-map">
      <ComposableMap
        projectionConfig={{ scale: 150 }}
        width={900}
        height={450}
        style={{ width: "100%", height: "auto" }}
      >
        <Geographies geography={WORLD_TOPO_URL}>
          {({ geographies }: { geographies: Array<{ rsmKey: string; id: string; properties: { name: string } }> }) =>
            geographies.map((geo) => {
              // world-atlas `id` is an ISO-3166 numeric code; map to ISO-2
              // via a lookup table below. Missing/unmatched countries
              // render as transparent fill.
              const iso2 = NUMERIC_TO_ISO2[geo.id];
              const row = iso2 ? byIso.get(iso2) : undefined;
              const fill = row && max > 0
                ? `rgba(76, 120, 168, ${(0.15 + (row.sessions / max) * 0.75).toFixed(3)})`
                : "rgba(76, 120, 168, 0.08)";
              return (
                <Geography
                  key={geo.rsmKey}
                  geography={geo}
                  fill={fill}
                  stroke="#2a2a4a"
                  strokeWidth={0.5}
                  style={{
                    default: { outline: "none" },
                    hover: { outline: "none", fill: "rgba(255,255,255,0.2)" },
                    pressed: { outline: "none" },
                  }}
                >
                  <title>
                    {geo.properties.name}
                    {row ? ` — ${row.sessions.toLocaleString()} sessions` : ""}
                  </title>
                </Geography>
              );
            })
          }
        </Geographies>
      </ComposableMap>
    </div>
  );
}

export default memo(WorldMapImpl);

/**
 * Minimal ISO-3166 numeric → alpha-2 lookup for the countries in
 * world-atlas's 110m dataset. Only the common set is covered; the long
 * tail (uninhabited territories, minor islands) is intentionally omitted
 * — those would never have meaningful session counts anyway.
 */
const NUMERIC_TO_ISO2: Record<string, string> = {
  "004": "AF", "008": "AL", "012": "DZ", "020": "AD", "024": "AO",
  "028": "AG", "031": "AZ", "032": "AR", "036": "AU", "040": "AT",
  "044": "BS", "048": "BH", "050": "BD", "051": "AM", "052": "BB",
  "056": "BE", "064": "BT", "068": "BO", "070": "BA", "072": "BW",
  "076": "BR", "084": "BZ", "090": "SB", "096": "BN", "100": "BG",
  "104": "MM", "108": "BI", "112": "BY", "116": "KH", "120": "CM",
  "124": "CA", "140": "CF", "144": "LK", "148": "TD", "152": "CL",
  "156": "CN", "158": "TW", "170": "CO", "174": "KM", "178": "CG",
  "180": "CD", "188": "CR", "191": "HR", "192": "CU", "196": "CY",
  "203": "CZ", "204": "BJ", "208": "DK", "214": "DO", "218": "EC",
  "222": "SV", "226": "GQ", "231": "ET", "232": "ER", "233": "EE",
  "242": "FJ", "246": "FI", "250": "FR", "260": "TF", "262": "DJ",
  "266": "GA", "268": "GE", "270": "GM", "275": "PS", "276": "DE",
  "288": "GH", "300": "GR", "304": "GL", "308": "GD", "320": "GT",
  "324": "GN", "328": "GY", "332": "HT", "340": "HN", "344": "HK",
  "348": "HU", "352": "IS", "356": "IN", "360": "ID", "364": "IR",
  "368": "IQ", "372": "IE", "376": "IL", "380": "IT", "384": "CI",
  "388": "JM", "392": "JP", "398": "KZ", "400": "JO", "404": "KE",
  "408": "KP", "410": "KR", "414": "KW", "417": "KG", "418": "LA",
  "422": "LB", "426": "LS", "428": "LV", "430": "LR", "434": "LY",
  "438": "LI", "440": "LT", "442": "LU", "450": "MG", "454": "MW",
  "458": "MY", "462": "MV", "466": "ML", "470": "MT", "478": "MR",
  "484": "MX", "492": "MC", "496": "MN", "498": "MD", "499": "ME",
  "504": "MA", "508": "MZ", "512": "OM", "516": "NA", "520": "NR",
  "524": "NP", "528": "NL", "540": "NC", "548": "VU", "554": "NZ",
  "558": "NI", "562": "NE", "566": "NG", "578": "NO", "584": "MH",
  "586": "PK", "591": "PA", "598": "PG", "600": "PY", "604": "PE",
  "608": "PH", "616": "PL", "620": "PT", "624": "GW", "626": "TL",
  "630": "PR", "634": "QA", "642": "RO", "643": "RU", "646": "RW",
  "682": "SA", "686": "SN", "688": "RS", "690": "SC", "694": "SL",
  "702": "SG", "703": "SK", "704": "VN", "705": "SI", "706": "SO",
  "710": "ZA", "716": "ZW", "724": "ES", "728": "SS", "729": "SD",
  "740": "SR", "748": "SZ", "752": "SE", "756": "CH", "760": "SY",
  "762": "TJ", "764": "TH", "768": "TG", "776": "TO", "780": "TT",
  "784": "AE", "788": "TN", "792": "TR", "795": "TM", "800": "UG",
  "804": "UA", "807": "MK", "818": "EG", "826": "GB", "834": "TZ",
  "840": "US", "854": "BF", "858": "UY", "860": "UZ", "862": "VE",
  "882": "WS", "887": "YE", "894": "ZM",
};
