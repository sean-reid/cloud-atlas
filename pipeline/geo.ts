import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { GeoIndex, GeoRegion } from "./adapters/types";

export interface Place {
  lat: number;
  lon: number;
  country_code: string;
  admin_area: string | null;
}

export type Gazetteer = Record<string, Place>;

export function loadGeo(root: string): { regions: GeoIndex; places: Gazetteer } {
  const regions = JSON.parse(readFileSync(join(root, "geo", "regions.json"), "utf8")) as GeoIndex;
  const places = JSON.parse(readFileSync(join(root, "geo", "places.json"), "utf8")) as Gazetteer;
  return { regions, places };
}

export function regionGeo(index: GeoIndex, provider: string, code: string): GeoRegion | null {
  return index[provider]?.[code] ?? null;
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

// Looks a free-text place up by its "City, Region, Country" key with progressively
// looser matching. Returns null rather than guessing.
export function lookupPlace(
  places: Gazetteer,
  ...candidates: (string | null | undefined)[]
): { key: string; place: Place } | null {
  const keys = Object.keys(places);
  const normKeys = new Map(keys.map((k) => [norm(k), k]));
  for (const c of candidates) {
    if (!c) continue;
    const exact = normKeys.get(norm(c));
    if (exact) return { key: exact, place: places[exact]! };
  }
  for (const c of candidates) {
    if (!c) continue;
    const n = norm(c);
    for (const [nk, k] of normKeys) {
      const city = nk.split(" ")[0];
      if (
        city &&
        city.length > 3 &&
        n.split(" ").includes(city) &&
        nk.split(" ").every((w) => n.includes(w))
      ) {
        return { key: k, place: places[k]! };
      }
    }
  }
  return null;
}

const STATES: Record<string, string> = {
  alabama: "AL",
  alaska: "AK",
  arizona: "AZ",
  arkansas: "AR",
  california: "CA",
  colorado: "CO",
  connecticut: "CT",
  delaware: "DE",
  florida: "FL",
  georgia: "GA",
  hawaii: "HI",
  idaho: "ID",
  illinois: "IL",
  indiana: "IN",
  iowa: "IA",
  kansas: "KS",
  kentucky: "KY",
  louisiana: "LA",
  maine: "ME",
  maryland: "MD",
  massachusetts: "MA",
  michigan: "MI",
  minnesota: "MN",
  mississippi: "MS",
  missouri: "MO",
  montana: "MT",
  nebraska: "NE",
  nevada: "NV",
  "new hampshire": "NH",
  "new jersey": "NJ",
  "new mexico": "NM",
  "new york": "NY",
  "north carolina": "NC",
  "north dakota": "ND",
  ohio: "OH",
  oklahoma: "OK",
  oregon: "OR",
  pennsylvania: "PA",
  "rhode island": "RI",
  "south carolina": "SC",
  "south dakota": "SD",
  tennessee: "TN",
  texas: "TX",
  utah: "UT",
  vermont: "VT",
  virginia: "VA",
  washington: "WA",
  "west virginia": "WV",
  wisconsin: "WI",
  wyoming: "WY",
};

const FOLD: Record<string, string> = { ø: "o", æ: "ae", å: "a", ß: "ss", ð: "d", þ: "th", ł: "l" };

export function foldText(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[øæåßðþł]/g, (c) => FOLD[c] ?? c)
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Resolves a free-text address to a gazetteer place: the place's city must appear as whole
// words in the address and the country must match. Several matching cities in different
// places need a state to pick one; otherwise the address stays unresolved for review.
export function resolveAddress(
  places: Gazetteer,
  address: string,
  countryCode: string | null,
): { key: string; place: Place } | null {
  const text = ` ${foldText(address)} `;
  const hits: { key: string; place: Place; len: number; at: number }[] = [];
  for (const [key, place] of Object.entries(places)) {
    if (countryCode && place.country_code !== countryCode) continue;
    const city = foldText(key.split(",")[0] ?? "");
    const at = city ? text.lastIndexOf(` ${city} `) : -1;
    if (at < 0) continue;
    hits.push({ key, place, len: city.length, at });
  }
  if (!hits.length) return null;
  const distinct = new Map(hits.map((h) => [`${h.place.lat},${h.place.lon}`, h]));
  if (distinct.size === 1) {
    const h = hits.sort((a, b) => b.len - a.len)[0]!;
    return { key: h.key, place: h.place };
  }
  // "street, city, state": the city is the match nearest the end of the address.
  const last = hits.sort((a, b) => b.at - a.at || b.len - a.len)[0]!;
  if (hits.filter((h) => h.at === last.at).length === 1)
    return { key: last.key, place: last.place };
  const byState = hits.filter((h) => {
    const abbr = h.place.admin_area?.toLowerCase();
    if (!abbr) return false;
    const full = Object.entries(STATES).find(([, v]) => v.toLowerCase() === abbr)?.[0];
    return text.includes(` ${abbr} `) || (full ? text.includes(` ${full} `) : false);
  });
  const stateDistinct = new Map(byState.map((h) => [`${h.place.lat},${h.place.lon}`, h]));
  if (stateDistinct.size === 1) {
    const h = byState.sort((a, b) => b.len - a.len)[0]!;
    return { key: h.key, place: h.place };
  }
  return null;
}
