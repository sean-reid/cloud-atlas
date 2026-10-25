import { metricById } from "../../shared/metrics";
import type { Entity } from "../../shared/types";
import { extractClaims, type Claim } from "../claims";
import {
  ensureEntity,
  ensureSource,
  findSite,
  makeObservation,
  providerEntity,
  type EntityInput,
} from "../entities";
import { resolveAddress, type Gazetteer, type Place } from "../geo";
import { stripTags } from "../html";
import { sentences } from "../rss";
import { emptyResult, meta, type Adapter, type AdapterContext } from "./types";

export const NSCALE_URL = "https://www.nscale.com/ai-infrastructure";
export const SITE_METHOD = "site-section.v1";

export interface SiteSection {
  id: string;
  slug: string;
  name: string;
  country: string;
  countryCode: string | null;
  text: string;
}

export interface NscaleSiteReview {
  site: string;
  country: string;
  place: string | null;
  locator: string;
  sentences: string[];
  claims: Claim[];
  proposed: Omit<EntityInput, "dataset"> | null;
  why: string;
}

const COUNTRY_CODES: Record<string, string> = {
  norway: "NO",
  sweden: "SE",
  finland: "FI",
  iceland: "IS",
  portugal: "PT",
  spain: "ES",
  france: "FR",
  germany: "DE",
  netherlands: "NL",
  "united kingdom": "GB",
  uk: "GB",
  ireland: "IE",
  "united states": "US",
  usa: "US",
  canada: "CA",
  australia: "AU",
};

const FIGURE_SENTENCE = /\d\s*(?:MW|GW|megawatt|gigawatt|acre)/i;

// The label reads "TEXAS, UNITED STATES" or "NORWAY": the country is the last part.
export function countryCode(label: string): string | null {
  const last = label.split(",").pop()!.trim().toLowerCase();
  return COUNTRY_CODES[last] ?? null;
}

const titleCase = (s: string) =>
  s
    .toLowerCase()
    .replace(/(^|[\s,])([a-z])/g, (m, pre: string, c: string) => pre + c.toUpperCase());

export function parseSections(html: string): SiteSection[] {
  const out: SiteSection[] = [];
  for (const m of html.matchAll(
    /<section[^>]*\sid="(dc-([a-z0-9-]+))"[^>]*>([\s\S]*?)<\/section\s*>/gi,
  )) {
    const body = m[3]!;
    const name = /<h2[^>]*>([\s\S]*?)<\/h2\s*>/i.exec(body)?.[1];
    const country = /<span[^>]*class="text-label-lg-regular"[^>]*>([\s\S]*?)<\/span\s*>/i.exec(
      body,
    )?.[1];
    if (!name) continue;
    const text = [...body.matchAll(/<p[^>]*>([\s\S]*?)<\/p\s*>/gi)]
      .map((p) => stripTags(p[1]!))
      .filter(Boolean)
      .join(" ");
    const label = stripTags(country ?? "");
    out.push({
      id: m[1]!,
      slug: m[2]!,
      name: stripTags(name),
      country: titleCase(label),
      countryCode: label ? countryCode(label) : null,
      text,
    });
  }
  return out;
}

const city = (key: string): string => key.split(",")[0]!.trim();

function proposal(key: string, place: Place): Omit<EntityInput, "dataset"> {
  return {
    type: "campus",
    provider: "nscale",
    name: `Nscale ${city(key)} campus`,
    country_code: place.country_code,
    admin_area: place.admin_area,
    locality: city(key),
    lat: place.lat,
    lon: place.lon,
    location_precision: "locality",
    ownership: "unknown",
  };
}

// The feed rule, with the section heading standing in for a sentence that names no place: one
// figure, a status word, and a place that resolves and agrees with the heading.
function whyHeld(claim: Claim, place: { key: string } | null): string | null {
  if (claim.figures !== 1) return `${claim.figures} figures in one sentence`;
  if (claim.status === "unknown") return "no status word";
  if (!claim.place && !place) return "place unresolved";
  if (claim.place && place && claim.place.key !== place.key)
    return `sentence names ${claim.place.key}, section is ${place.key}`;
  return null;
}

export function sectionClaims(section: SiteSection, places: Gazetteer): Claim[] {
  const seen = new Set<string>();
  return sentences(section.text)
    .flatMap((s) => extractClaims(s, places))
    .filter((c) => {
      const key = `${c.metric}|${c.value}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

export const nscaleSites: Adapter = {
  ...meta("nscale-sites"),
  url: NSCALE_URL,
  tier: 1,
  license: "Nscale website; one sentence quoted per figure with attribution",
  hosts: ["nscale.com"],
  source: () => ({
    id: "",
    publisher: "Nscale",
    title: "Nscale AI infrastructure",
    url: NSCALE_URL,
    tier: 1,
    published_date: null,
    license: null,
    adapter: "nscale-sites",
  }),
  async run(ctx: AdapterContext) {
    const result = emptyResult();
    const now = ctx.now();
    const today = now.toISOString().slice(0, 10);
    const { store, dataset } = ctx;
    const source = await ensureSource(store, { ...this.source(), adapter: this.id });
    const sections = parseSections((await ctx.fetch(NSCALE_URL)).body);
    if (!sections.length) throw new Error("no site sections parsed; page layout changed");

    for (const s of sections) {
      const locator = `${NSCALE_URL}#${s.id}`;
      const place = resolveAddress(ctx.places, s.name, s.countryCode);
      const claims = sectionClaims(s, ctx.places);
      const held: { claim: Claim; why: string }[] = [];
      const accepted: Claim[] = [];
      for (const claim of claims) {
        const why = whyHeld(claim, place);
        if (why) held.push({ claim, why });
        else accepted.push(claim);
      }
      const reviewId = `rev_nscale-sites_${s.slug}`;
      let entity: Entity | null = null;
      if (accepted.length) {
        const key = accepted[0]!.place?.key ?? place!.key;
        const where = accepted[0]!.place ?? { key, ...place!.place };
        const name = `Nscale ${city(key)} campus`;
        const match = findSite(store, "nscale", name);
        if (match?.kind === "similar") {
          for (const claim of accepted.splice(0))
            held.push({ claim, why: `"${name}" may be the same site as "${match.entity.name}"` });
        } else if (match) entity = match.entity;
        else {
          const parent = await providerEntity(store, "nscale", "Nscale", dataset);
          entity = await ensureEntity(store, {
            ...proposal(key, where),
            dataset,
            parent_id: parent.id,
          });
          result.entities++;
        }
      }
      for (const claim of accepted) {
        const metric = metricById(claim.metric)!;
        const obs = await makeObservation(
          {
            entity_id: entity!.id,
            metric: metric.id,
            value: claim.value,
            value_low: null,
            value_high: null,
            unit: metric.unit,
            value_original: claim.value_original,
            status: claim.status,
            scope: "campus",
            claim_type: "reported",
            effective_date: today,
            effective_precision: "day",
            effective_kind: claim.effective_kind,
            source_id: source.id,
            excerpt: claim.sentence.slice(0, 500),
            locator,
            method_id: SITE_METHOD,
            derived_from: null,
            supersedes_id: null,
            review_status: "accepted",
            notes: null,
          },
          dataset,
          now,
        );
        if (await store.appendObservation(obs)) result.observations++;
      }
      if (accepted.length && !held.length) {
        await store.resolveReview(reviewId, "recorded on the campus", now.toISOString());
        continue;
      }
      const figureSentences = sentences(s.text).filter((t) => FIGURE_SENTENCE.test(t));
      const why = held.length
        ? held.map((h) => `"${h.claim.value_original}": ${h.why}`).join("; ")
        : figureSentences.length
          ? "figure sentence without a site word or a parsable figure"
          : "no power or investment figure in the section";
      const payload: NscaleSiteReview = {
        site: s.name,
        country: s.country,
        place: place?.key ?? null,
        locator,
        sentences: figureSentences.length ? figureSentences : sentences(s.text).slice(0, 2),
        claims: held.map((h) => h.claim),
        proposed: place ? proposal(place.key, place.place) : null,
        why,
      };
      if (
        await store.queueReview({
          id: reviewId,
          created_at: now.toISOString(),
          adapter: this.id,
          reason: `Nscale ${s.name} (${s.country}): ${why}`,
          payload: JSON.stringify(payload),
          resolved_at: null,
          resolution: null,
        })
      )
        result.review++;
    }
    return result;
  },
};
