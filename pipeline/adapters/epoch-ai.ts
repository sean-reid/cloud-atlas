import { slugify } from "../../shared/ids";
import type { ProviderSlug } from "../../shared/providers";
import type { Observation } from "../../shared/types";
import { csvRecords } from "../csv";
import { ensureEntity, ensureSource, findSite, makeObservation } from "../entities";
import { resolveAddress } from "../geo";
import { emptyResult, type Adapter, type AdapterContext } from "./types";

const PAGE_URL = "https://epoch.ai/data/ai-data-centers";
const SITES_URL = "https://epoch.ai/data/data_centers/data_centers.csv";
const TIMELINES_URL = "https://epoch.ai/data/data_centers/data_center_timelines.csv";

const OWNERS: Record<string, ProviderSlug> = {
  google: "gcp",
  microsoft: "azure",
  amazon: "aws",
  oracle: "oracle",
  coreweave: "coreweave",
  huawei: "huawei",
  alibaba: "alibaba",
  nebius: "nebius",
  nscale: "nscale",
  crusoe: "crusoe",
};

export function parseOwner(cell: string): {
  owner: string;
  confidence: "confident" | "likely" | "speculative" | null;
} {
  const m = /^(.*?)\s*(?:#(confident|likely|speculative))?\s*$/.exec(cell.trim());
  const owner = (m?.[1] ?? cell).trim();
  const confidence = (m?.[2] as "confident" | "likely" | "speculative" | undefined) ?? null;
  return { owner, confidence };
}

export const epochAi: Adapter = {
  id: "epoch-ai",
  title: "Epoch AI: AI data centers",
  publisher: "Epoch AI",
  url: PAGE_URL,
  tier: 3,
  license: "CC BY 4.0",
  measures:
    "Estimated IT power, total power, and H100-equivalent compute for the largest AI data centers, with dated construction timelines. AI facilities only; not a measure of cloud coverage.",
  mode: "automated",
  schedule: "daily",
  hosts: ["epoch.ai"],
  source: () => ({
    id: "",
    publisher: "Epoch AI",
    title: "AI data centers",
    url: PAGE_URL,
    tier: 3,
    published_date: null,
    license: "CC BY 4.0",
    adapter: "epoch-ai",
  }),
  async run(ctx: AdapterContext) {
    const result = emptyResult();
    const now = ctx.now();
    const { store, dataset } = ctx;
    const source = await ensureSource(store, { ...this.source(), adapter: this.id });
    const sites = csvRecords((await ctx.fetch(SITES_URL, { accept: "text/csv" })).body);
    const timelines = csvRecords((await ctx.fetch(TIMELINES_URL, { accept: "text/csv" })).body);
    if (sites.length < 20) throw new Error(`only ${sites.length} sites parsed`);

    const byName = new Map<string, Record<string, string>[]>();
    for (const t of timelines) {
      const list = byName.get(t["Data center"] ?? "") ?? [];
      list.push(t);
      byName.set(t["Data center"] ?? "", list);
    }

    for (const site of sites) {
      const name = site["Name"]?.trim();
      if (!name) continue;
      const { owner, confidence } = parseOwner(site["Owner"] ?? "");
      const provider = OWNERS[owner.toLowerCase()];
      if (!provider) continue;
      const country = site["Country"] ?? "";
      const address = site["Address"] ?? "";
      const countryCode = COUNTRY_CODES[country] ?? null;
      // The address first; the site name only when the address names no town.
      const place =
        (address ? resolveAddress(ctx.places, address, countryCode) : null) ??
        resolveAddress(ctx.places, `${name} ${address}`, countryCode);
      const match = findSite(store, provider, name);
      const entity = await ensureEntity(store, {
        dataset,
        type: "campus",
        provider,
        name: match?.kind === "same" ? match.entity.name : name,
        slug: match?.kind === "same" ? match.entity.slug : slugify(name),
        country_code: place?.place.country_code ?? countryCode,
        admin_area: place?.place.admin_area ?? null,
        locality: place ? place.key.split(",")[0]! : address || null,
        ...(place
          ? { lat: place.place.lat, lon: place.place.lon, location_precision: "locality" as const }
          : {}),
        ownership: "unknown",
      });
      result.entities++;
      if (
        match?.kind === "similar" &&
        (await store.queueReview({
          id: `rev_dup_${entity.id}_${match.entity.id}`,
          created_at: now.toISOString(),
          adapter: this.id,
          reason: `Epoch AI site "${name}" may be the same site as "${match.entity.name}"; kept separate`,
          payload: JSON.stringify({ entity: entity.id, similar: match.entity.id }),
          resolved_at: null,
          resolution: null,
        }))
      )
        result.review++;
      const reviewId = `rev_epoch_place_${entity.id}`;
      if (place) await store.resolveReview(reviewId, `resolved to ${place.key}`, now.toISOString());
      if (address && !place) {
        if (
          await store.queueReview({
            id: reviewId,
            created_at: now.toISOString(),
            adapter: this.id,
            reason: `address for ${name} did not resolve against data/geo/places.json`,
            payload: JSON.stringify({ name, address, country }),
            resolved_at: null,
            resolution: null,
          })
        )
          result.review++;
      }
      const review: Observation["review_status"] =
        confidence === "speculative" ? "pending" : "accepted";
      const ownerNote = confidence
        ? `Epoch AI tags the owner as #${confidence}.`
        : "Epoch AI gives no owner confidence tag.";
      const users = site["Users"] ? ` Users: ${site["Users"]}.` : "";
      const project = site["Project"] ? ` Project: ${site["Project"]}.` : "";

      const points = (byName.get(name) ?? [])
        .map((t) => ({
          date: t["Date"] ?? "",
          it: Number(t["IT power (MW)"] ?? ""),
          total: Number(t["Power (MW)"] ?? ""),
          h100: Number(t["H100 equivalents"] ?? ""),
          status: (t["Construction status"] ?? "").trim(),
        }))
        .filter((p) => /^\d{4}-\d{2}-\d{2}$/.test(p.date));

      // Timeline rows restate the same figure until it changes; keep one observation per change.
      const today = now.toISOString().slice(0, 10);
      let lastIt: number | null = null;
      let lastTotal: number | null = null;
      let lastH100: number | null = null;
      for (const p of points) {
        // Rows dated after retrieval are Epoch's projected build-out, not observed capacity.
        const future = p.date > today;
        const common = {
          entity_id: entity.id,
          value_low: null,
          value_high: null,
          status: future ? ("announced" as const) : ("operational" as const),
          scope: "campus" as const,
          claim_type: "derived" as const,
          effective_date: p.date,
          effective_precision: "day" as const,
          effective_kind: future ? ("expected_completion" as const) : ("as_of" as const),
          source_id: source.id,
          excerpt: p.status.slice(0, 300) || null,
          locator: `data_center_timelines.csv: ${name} @ ${p.date}`,
          method_id: "epoch-ai-satellite.v1",
          derived_from: null,
          supersedes_id: null,
          review_status: review,
          notes:
            `${ownerNote}${users}${project}${future ? " Projected by Epoch AI for a future date." : ""}`.trim(),
        };
        if (Number.isFinite(p.it) && p.it > 0 && p.it !== lastIt) {
          lastIt = p.it;
          const o = await makeObservation(
            {
              ...common,
              metric: "it_power_mw",
              value: p.it,
              unit: "MW",
              value_original: `${p.it} MW IT`,
            },
            dataset,
            now,
          );
          if (await store.appendObservation(o)) result.observations++;
        }
        if (Number.isFinite(p.total) && p.total > 0 && p.total !== lastTotal) {
          lastTotal = p.total;
          const o = await makeObservation(
            {
              ...common,
              metric: "facility_power_mw",
              value: p.total,
              unit: "MW",
              value_original: `${p.total} MW`,
            },
            dataset,
            now,
          );
          if (await store.appendObservation(o)) result.observations++;
        }
        if (Number.isFinite(p.h100) && p.h100 > 0 && Math.round(p.h100) !== lastH100) {
          lastH100 = Math.round(p.h100);
          const o = await makeObservation(
            {
              ...common,
              metric: "h100_equivalents",
              value: Math.round(p.h100),
              unit: "H100e",
              value_original: String(p.h100),
            },
            dataset,
            now,
          );
          if (await store.appendObservation(o)) result.observations++;
        }
      }

      if (points.length === 0) {
        const it = Number(site["Current power (MW)"] ?? "");
        if (Number.isFinite(it) && it > 0) {
          const o = await makeObservation(
            {
              entity_id: entity.id,
              metric: "it_power_mw",
              value: it,
              value_low: null,
              value_high: null,
              unit: "MW",
              value_original: `${it} MW`,
              status: "operational",
              scope: "campus",
              claim_type: "derived",
              effective_date: now.toISOString().slice(0, 10),
              effective_precision: "day",
              effective_kind: "as_of",
              source_id: source.id,
              excerpt: null,
              locator: `data_centers.csv: ${name}`,
              method_id: "epoch-ai-satellite.v1",
              derived_from: null,
              supersedes_id: null,
              review_status: review,
              notes: `${ownerNote}${users}${project} No timeline rows; current value only.`.trim(),
            },
            dataset,
            now,
          );
          if (await store.appendObservation(o)) result.observations++;
        }
      }
    }
    return result;
  },
};

const COUNTRY_CODES: Record<string, string> = {
  "United States": "US",
  China: "CN",
  Malaysia: "MY",
  Norway: "NO",
  "United Kingdom": "GB",
  Indonesia: "ID",
  Finland: "FI",
  Australia: "AU",
  Portugal: "PT",
  Iceland: "IS",
  Sweden: "SE",
  "United Arab Emirates": "AE",
  Ireland: "IE",
  Netherlands: "NL",
  Germany: "DE",
  France: "FR",
  Spain: "ES",
  Japan: "JP",
  India: "IN",
  Canada: "CA",
  Brazil: "BR",
  Chile: "CL",
  Singapore: "SG",
  Taiwan: "TW",
  Belgium: "BE",
  Denmark: "DK",
  Israel: "IL",
  "Saudi Arabia": "SA",
  Qatar: "QA",
  "South Korea": "KR",
  "New Zealand": "NZ",
  Mexico: "MX",
  "South Africa": "ZA",
  Italy: "IT",
  Switzerland: "CH",
  Poland: "PL",
  Austria: "AT",
};
