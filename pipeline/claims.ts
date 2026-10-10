import { parsePowerMw, parseMoneyUsd } from "../shared/metrics";
import type { Status } from "../shared/types";
import { resolveAddress, statesNamed, type Gazetteer } from "./geo";

export interface ClaimPlace {
  key: string;
  lat: number;
  lon: number;
  country_code: string;
  admin_area: string | null;
}

export interface Claim {
  metric: "it_power_mw" | "facility_power_mw" | "investment_usd";
  value: number;
  value_original: string;
  status: Status;
  effective_kind: "announced" | "as_of" | "opened" | "expected_completion";
  place: ClaimPlace | null;
  sentence: string;
  figures: number;
}

const POWER =
  /(\d[\d,]*(?:\.\d+)?)\s*(?:-|to)?\s*(?:\d[\d,]*(?:\.\d+)?)?\s*(gigawatts?|megawatts?|GW|MW)(?![a-z])/gi;
const MONEY = /\$\s?(\d[\d,]*(?:\.\d+)?)\s*(billion|million|bn|b|m)\b/gi;
const SITE_WORD =
  /data\s?cent(?:er|re)s?|datacenters?|campus|facility|facilities|cloud region|server farm/i;
const IT_WORD = /\bIT\s+(?:load|power|capacity)|critical\s+(?:IT\s+)?(?:load|power)/i;

const STATUS_WORDS: [RegExp, Status, Claim["effective_kind"]][] = [
  [/cancel+ed|scrapped|withdrawn|abandon/i, "cancelled", "as_of"],
  [
    /\b(now|is|are|became|went)\s+(open|live|operational|online)\b|opened|inaugurat|begins? operations|began operations|came online/i,
    "operational",
    "opened",
  ],
  [
    /under construction|breaking ground|broke ground|being built|construction (?:is|has) (?:under\s?way|begun|started)/i,
    "under_construction",
    "as_of",
  ],
  [
    /plans? to|will (?:build|invest|develop|add|bring)|announc|propos|intends? to|to build|expected to|slated|scheduled to open|set to open/i,
    "announced",
    "announced",
  ],
];

// A US town that shares its name with a town in another state only counts when the sentence
// names no state or names that town's state.
function placeFor(places: Gazetteer, sentence: string): ClaimPlace | null {
  const hit = resolveAddress(places, sentence, null);
  if (!hit) return null;
  const states = statesNamed(sentence);
  if (hit.place.country_code === "US" && hit.place.admin_area && states.length) {
    if (!states.includes(hit.place.admin_area)) return null;
  }
  return { key: hit.key, ...hit.place };
}

// Pulls capacity and investment claims out of one sentence. Deterministic on purpose: every
// figure comes with the exact sentence that held it, and anything the rules cannot place
// goes to review rather than onto the site.
export function extractClaims(sentence: string, places: Gazetteer): Claim[] {
  if (!SITE_WORD.test(sentence)) return [];
  const out: Claim[] = [];
  const statusHit = STATUS_WORDS.find(([re]) => re.test(sentence));
  const status: Status = statusHit?.[1] ?? "unknown";
  const kind = statusHit?.[2] ?? "as_of";
  const place = placeFor(places, sentence);
  const powerHits = [...sentence.matchAll(POWER)];
  const moneyHits = [...sentence.matchAll(MONEY)];
  const figures = powerHits.length + moneyHits.length;
  for (const m of powerHits) {
    const parsed = parsePowerMw(m[0]);
    if (!parsed) continue;
    out.push({
      metric: IT_WORD.test(sentence) ? "it_power_mw" : "facility_power_mw",
      value: parsed.value,
      value_original: m[0].trim(),
      status,
      effective_kind: kind,
      place,
      sentence,
      figures,
    });
  }
  for (const m of moneyHits) {
    const parsed = parseMoneyUsd(m[0]);
    if (!parsed || parsed.value < 1e8) continue;
    out.push({
      metric: "investment_usd",
      value: parsed.value,
      value_original: m[0].trim(),
      status: status === "unknown" ? "announced" : status,
      effective_kind: kind === "as_of" ? "announced" : kind,
      place,
      sentence,
      figures,
    });
  }
  return out;
}

// A claim from a provider's own newsroom whose sentence holds one figure of any kind, a status
// word, and a resolved place is accepted as reported. Anything less waits for a maintainer.
export function autoAccept(claim: Claim, tier: number): boolean {
  return tier === 1 && claim.figures === 1 && claim.place !== null && claim.status !== "unknown";
}
