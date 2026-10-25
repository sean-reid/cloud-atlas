import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { feature } from "topojson-client";
import type { GeometryCollection, Topology } from "topojson-specification";

// ISO 3166-1 numeric to alpha-2 for every country in world-atlas countries-50m.
const ISO_A2: Record<string, string> = {
  "336": "VA",
  "583": "FM",
  "584": "MH",
  "580": "MP",
  "850": "VI",
  "316": "GU",
  "016": "AS",
  "239": "GS",
  "086": "IO",
  "654": "SH",
  "612": "PN",
  "660": "AI",
  "136": "KY",
  "060": "BM",
  "092": "VG",
  "796": "TC",
  "500": "MS",
  "832": "JE",
  "831": "GG",
  "833": "IM",
  "776": "TO",
  "702": "SG",
  "690": "SC",
  "678": "ST",
  "674": "SM",
  "882": "WS",
  "670": "VC",
  "662": "LC",
  "659": "KN",
  "585": "PW",
  "570": "NU",
  "184": "CK",
  "533": "AW",
  "531": "CW",
  "520": "NR",
  "492": "MC",
  "480": "MU",
  "470": "MT",
  "462": "MV",
  "438": "LI",
  "296": "KI",
  "308": "GD",
  "666": "PM",
  "876": "WF",
  "663": "MF",
  "652": "BL",
  "258": "PF",
  "248": "AX",
  "212": "DM",
  "234": "FO",
  "174": "KM",
  "446": "MO",
  "344": "HK",
  "132": "CV",
  "052": "BB",
  "048": "BH",
  "334": "HM",
  "574": "NF",
  "028": "AG",
  "020": "AD",
  "534": "SX",
  "004": "AF",
  "008": "AL",
  "010": "AQ",
  "012": "DZ",
  "024": "AO",
  "031": "AZ",
  "032": "AR",
  "036": "AU",
  "040": "AT",
  "044": "BS",
  "050": "BD",
  "051": "AM",
  "056": "BE",
  "064": "BT",
  "068": "BO",
  "070": "BA",
  "072": "BW",
  "076": "BR",
  "084": "BZ",
  "090": "SB",
  "096": "BN",
  "100": "BG",
  "104": "MM",
  "108": "BI",
  "112": "BY",
  "116": "KH",
  "120": "CM",
  "124": "CA",
  "140": "CF",
  "144": "LK",
  "148": "TD",
  "152": "CL",
  "156": "CN",
  "158": "TW",
  "170": "CO",
  "178": "CG",
  "180": "CD",
  "188": "CR",
  "191": "HR",
  "192": "CU",
  "196": "CY",
  "203": "CZ",
  "204": "BJ",
  "208": "DK",
  "214": "DO",
  "218": "EC",
  "222": "SV",
  "226": "GQ",
  "231": "ET",
  "232": "ER",
  "233": "EE",
  "238": "FK",
  "242": "FJ",
  "246": "FI",
  "250": "FR",
  "260": "TF",
  "262": "DJ",
  "266": "GA",
  "268": "GE",
  "270": "GM",
  "275": "PS",
  "276": "DE",
  "288": "GH",
  "300": "GR",
  "304": "GL",
  "320": "GT",
  "324": "GN",
  "328": "GY",
  "332": "HT",
  "340": "HN",
  "348": "HU",
  "352": "IS",
  "356": "IN",
  "360": "ID",
  "364": "IR",
  "368": "IQ",
  "372": "IE",
  "376": "IL",
  "380": "IT",
  "384": "CI",
  "388": "JM",
  "392": "JP",
  "398": "KZ",
  "400": "JO",
  "404": "KE",
  "408": "KP",
  "410": "KR",
  "414": "KW",
  "417": "KG",
  "418": "LA",
  "422": "LB",
  "426": "LS",
  "428": "LV",
  "430": "LR",
  "434": "LY",
  "440": "LT",
  "442": "LU",
  "450": "MG",
  "454": "MW",
  "458": "MY",
  "466": "ML",
  "478": "MR",
  "484": "MX",
  "496": "MN",
  "498": "MD",
  "499": "ME",
  "504": "MA",
  "508": "MZ",
  "512": "OM",
  "516": "NA",
  "524": "NP",
  "528": "NL",
  "540": "NC",
  "548": "VU",
  "554": "NZ",
  "558": "NI",
  "562": "NE",
  "566": "NG",
  "578": "NO",
  "586": "PK",
  "591": "PA",
  "598": "PG",
  "600": "PY",
  "604": "PE",
  "608": "PH",
  "616": "PL",
  "620": "PT",
  "624": "GW",
  "626": "TL",
  "630": "PR",
  "634": "QA",
  "642": "RO",
  "643": "RU",
  "646": "RW",
  "682": "SA",
  "686": "SN",
  "688": "RS",
  "694": "SL",
  "703": "SK",
  "704": "VN",
  "705": "SI",
  "706": "SO",
  "710": "ZA",
  "716": "ZW",
  "724": "ES",
  "728": "SS",
  "729": "SD",
  "732": "EH",
  "740": "SR",
  "748": "SZ",
  "752": "SE",
  "756": "CH",
  "760": "SY",
  "762": "TJ",
  "764": "TH",
  "768": "TG",
  "780": "TT",
  "784": "AE",
  "788": "TN",
  "792": "TR",
  "795": "TM",
  "800": "UG",
  "804": "UA",
  "807": "MK",
  "818": "EG",
  "826": "GB",
  "834": "TZ",
  "840": "US",
  "854": "BF",
  "858": "UY",
  "860": "UZ",
  "862": "VE",
  "887": "YE",
  "894": "ZM",
};

// Three shapes in the atlas carry no numeric id.
const BY_NAME: Record<string, string> = { Kosovo: "XK", "N. Cyprus": "CY", Somaliland: "SO" };

// A point just off a 50m coastline still belongs to that coast.
export const COAST_KM = 20;

type Ring = [number, number][];

interface Shape {
  code: string;
  outer: Ring;
  holes: Ring[];
  bbox: [number, number, number, number];
}

let shapes: Shape[] | null = null;

export function countryCodeFor(id: string | number | undefined, name: string): string | null {
  const byId = id === undefined ? undefined : ISO_A2[String(id).padStart(3, "0")];
  return byId ?? BY_NAME[name] ?? null;
}

function load(): Shape[] {
  if (shapes) return shapes;
  const require = createRequire(import.meta.url);
  const topo = JSON.parse(
    readFileSync(require.resolve("world-atlas/countries-50m.json"), "utf8"),
  ) as Topology<{ countries: GeometryCollection<{ name: string }> }>;
  const fc = feature(topo, topo.objects.countries);
  shapes = [];
  for (const f of fc.features) {
    const code = countryCodeFor(f.id, f.properties?.name ?? "");
    if (!code) continue;
    const polys =
      f.geometry.type === "Polygon"
        ? [f.geometry.coordinates]
        : f.geometry.type === "MultiPolygon"
          ? f.geometry.coordinates
          : [];
    for (const poly of polys) {
      const outer = poly[0] as Ring;
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const [x, y] of outer) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
      shapes.push({ code, outer, holes: poly.slice(1) as Ring[], bbox: [minX, minY, maxX, maxY] });
    }
  }
  return shapes;
}

function inRing(lon: number, lat: number, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

const KM_PER_DEG = 111.32;

// Distance from a point to a segment on a local flat projection, in km.
function segmentKm(lon: number, lat: number, a: [number, number], b: [number, number]): number {
  const k = Math.cos((lat * Math.PI) / 180);
  const ax = (a[0] - lon) * k;
  const ay = a[1] - lat;
  const bx = (b[0] - lon) * k;
  const by = b[1] - lat;
  const dx = bx - ax;
  const dy = by - ay;
  const len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len)) : 0;
  const px = ax + t * dx;
  const py = ay + t * dy;
  return Math.sqrt(px * px + py * py) * KM_PER_DEG;
}

function edgeKm(lon: number, lat: number, s: Shape): number {
  const [minX, minY, maxX, maxY] = s.bbox;
  const pad = COAST_KM / KM_PER_DEG / Math.max(0.2, Math.cos((lat * Math.PI) / 180));
  if (lon < minX - pad || lon > maxX + pad || lat < minY - pad || lat > maxY + pad) return Infinity;
  let best = Infinity;
  for (let i = 1; i < s.outer.length; i++) {
    const d = segmentKm(lon, lat, s.outer[i - 1]!, s.outer[i]!);
    if (d < best) best = d;
  }
  return best;
}

// The country whose polygon holds the point, else the one whose coast lies within COAST_KM,
// else null. Natural Earth 50m carries every state down to Singapore and Bahrain.
export function countryAt(lat: number, lon: number): string | null {
  const all = load();
  for (const s of all) {
    const [minX, minY, maxX, maxY] = s.bbox;
    if (lon < minX || lon > maxX || lat < minY || lat > maxY) continue;
    if (inRing(lon, lat, s.outer) && !s.holes.some((h) => inRing(lon, lat, h))) return s.code;
  }
  let best: { code: string; km: number } | null = null;
  for (const s of all) {
    const km = edgeKm(lon, lat, s);
    if (km <= COAST_KM && (!best || km < best.km)) best = { code: s.code, km };
  }
  return best?.code ?? null;
}
