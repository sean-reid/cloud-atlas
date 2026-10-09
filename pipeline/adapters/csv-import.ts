import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { datePrecision } from "../../shared/dates";
import { slugify } from "../../shared/ids";
import { metricById } from "../../shared/metrics";
import { PROVIDERS, type ProviderSlug } from "../../shared/providers";
import type {
  ClaimType,
  EffectiveKind,
  Entity,
  EntityType,
  Ownership,
  Scope,
  SourceTier,
  Status,
} from "../../shared/types";
import type { EntityInput } from "../entities";
import { csvRecords } from "../csv";
import { ensureEntity, ensureSource, findSite, makeObservation, providerEntity } from "../entities";
import { resolveAddress } from "../geo";
import { emptyResult, meta, type Adapter, type AdapterContext, type AdapterResult } from "./types";

const STATUSES = new Set<Status>([
  "operational",
  "under_construction",
  "announced",
  "cancelled",
  "decommissioned",
  "unknown",
]);
const SCOPES = new Set<Scope>([
  "provider_wide",
  "public_cloud",
  "campus",
  "facility",
  "phase",
  "region",
]);
const KINDS = new Set<EffectiveKind>(["as_of", "opened", "announced", "expected_completion"]);
const OWNERSHIP = new Set<Ownership>(["owned", "leased", "joint_venture", "unknown"]);
const TYPES = new Set<EntityType>(["provider", "region", "campus", "facility", "phase"]);
const PROVIDER_SLUGS = new Set(PROVIDERS.map((p) => p.slug));

const num = (s: string | undefined): number | null => {
  if (s === undefined || s.trim() === "") return null;
  const n = Number(s.replace(/,/g, ""));
  return Number.isFinite(n) ? n : NaN;
};

export function validateRow(row: Record<string, string>): string[] {
  const errors: string[] = [];
  if (!PROVIDER_SLUGS.has(row.provider_slug as ProviderSlug))
    errors.push(`unknown provider ${row.provider_slug}`);
  if (!TYPES.has(row.entity_type as EntityType)) errors.push(`bad entity_type ${row.entity_type}`);
  if (!row.entity_name?.trim()) errors.push("entity_name empty");
  if (!metricById(row.metric ?? "")) errors.push(`unknown metric ${row.metric}`);
  const v = num(row.value);
  const lo = num(row.value_low);
  const hi = num(row.value_high);
  if (v === null && (lo === null || hi === null)) errors.push("value or both bounds required");
  if ([v, lo, hi].some((x) => x !== null && Number.isNaN(x))) errors.push("non-numeric value");
  if (v !== null && v < 0) errors.push("negative value");
  if (lo !== null && hi !== null && lo > hi) errors.push("value_low above value_high");
  if (!STATUSES.has(row.status as Status)) errors.push(`bad status ${row.status}`);
  if (!SCOPES.has(row.scope as Scope)) errors.push(`bad scope ${row.scope}`);
  if (row.ownership && !OWNERSHIP.has(row.ownership as Ownership))
    errors.push(`bad ownership ${row.ownership}`);
  if (!row.effective_date || !datePrecision(row.effective_date))
    errors.push(`bad effective_date ${row.effective_date}`);
  if (!KINDS.has(row.effective_date_kind as EffectiveKind))
    errors.push(`bad effective_date_kind ${row.effective_date_kind}`);
  if (!["reported", "derived"].includes(row.claim_type ?? ""))
    errors.push(`bad claim_type ${row.claim_type}`);
  if (!/^[1-4]$/.test(row.source_tier ?? "")) errors.push(`bad source_tier ${row.source_tier}`);
  if (!/^https:\/\//.test(row.source_url ?? "")) errors.push("source_url must be https");
  if (!row.source_publisher?.trim()) errors.push("source_publisher empty");
  if (row.claim_type === "derived" && !row.notes?.trim())
    errors.push("derived rows need notes stating the method");
  if ((row.lat && !row.lon) || (!row.lat && row.lon)) errors.push("lat and lon must come together");
  if (row.source_published_date && !datePrecision(row.source_published_date))
    errors.push("bad source_published_date");
  if (
    row.metric?.endsWith("_mw") &&
    !/mw|gw|kw|megawatt|gigawatt/i.test(row.value_original ?? "") &&
    !row.notes
  ) {
    errors.push("power row without a unit in value_original");
  }
  return errors;
}

export async function importCsv(
  ctx: AdapterContext,
  path: string,
  adapterId: string,
): Promise<AdapterResult> {
  const result = emptyResult();
  const now = ctx.now();
  const { store, dataset } = ctx;
  const rows = csvRecords(readFileSync(path, "utf8"));
  const file = basename(path);
  for (const [i, row] of rows.entries()) {
    const line = i + 2;
    const errors = validateRow(row);
    const reviewId = `rev_csv_${slugify(file)}_${line}`;
    if (!errors.length) await store.resolveReview(reviewId, "row now validates", now.toISOString());
    if (errors.length) {
      if (
        await store.queueReview({
          id: reviewId,
          created_at: now.toISOString(),
          adapter: adapterId,
          reason: `${file}:${line}: ${errors.join("; ")}`,
          payload: JSON.stringify(row),
          resolved_at: null,
          resolution: null,
        })
      )
        result.review++;
      continue;
    }
    const provider = row.provider_slug as ProviderSlug;
    const entityName = (row.entity_name ?? "").trim();
    const sourceUrl = (row.source_url ?? "").trim();
    const sourcePublisher = (row.source_publisher ?? "").trim();
    const metricId = row.metric ?? "";
    const effectiveDate = row.effective_date ?? "";
    const providerName = PROVIDERS.find((p) => p.slug === provider)!.name;
    const providerEnt = await providerEntity(store, provider, providerName, dataset);
    const type = row.entity_type as EntityType;

    const placeText = [row.locality, row.admin_area, row.country_code].filter(Boolean).join(", ");
    const countryCode = row.country_code || null;
    let parentId: string | null = providerEnt.id;
    if (row.parent_entity?.trim()) {
      const parentName = row.parent_entity.trim();
      const parentMatch = findSite(store, provider, parentName);
      const parentPlace =
        (placeText ? resolveAddress(ctx.places, placeText, countryCode) : null) ??
        resolveAddress(ctx.places, `${parentName} ${placeText}`, countryCode);
      const parent = await ensureEntity(store, {
        dataset,
        type: "campus",
        provider,
        name: parentMatch?.kind === "same" ? parentMatch.entity.name : parentName,
        ...(parentMatch?.kind === "same" ? { slug: parentMatch.entity.slug } : {}),
        parent_id: providerEnt.id,
        country_code: countryCode ?? parentPlace?.place.country_code ?? null,
        admin_area: row.admin_area || parentPlace?.place.admin_area || null,
        locality: row.locality || null,
        ...(parentPlace
          ? {
              lat: parentPlace.place.lat,
              lon: parentPlace.place.lon,
              location_precision: "locality" as const,
            }
          : {}),
      });
      parentId = parent.id;
    }

    let entityId = providerEnt.id;
    if (type !== "provider") {
      const lat = num(row.lat);
      const lon = num(row.lon);
      // The stated place first; the site name only when the row names no town.
      const place =
        lat !== null
          ? null
          : ((placeText ? resolveAddress(ctx.places, placeText, countryCode) : null) ??
            resolveAddress(ctx.places, `${entityName} ${placeText}`, countryCode));
      const match = type === "region" ? null : findSite(store, provider, entityName, [type]);
      const geo: Partial<EntityInput> = {};
      if (lat !== null && lon !== null) {
        geo.lat = lat;
        geo.lon = lon;
        geo.location_precision =
          (row.location_precision as Entity["location_precision"]) || "exact";
      } else if (place) {
        geo.lat = place.place.lat;
        geo.lon = place.place.lon;
        geo.location_precision = "locality";
      }
      const entity = await ensureEntity(store, {
        dataset,
        type,
        provider,
        name: match?.kind === "same" ? match.entity.name : entityName,
        ...(match?.kind === "same" ? { slug: match.entity.slug } : {}),
        code: type === "region" ? entityName : null,
        parent_id: parentId,
        country_code: row.country_code || place?.place.country_code || null,
        admin_area: row.admin_area || place?.place.admin_area || null,
        locality: row.locality || null,
        ownership: (row.ownership as Ownership) || "unknown",
        landlord: row.landlord || null,
        ...geo,
      });
      if (match?.kind === "similar") {
        if (
          await store.queueReview({
            id: `rev_dup_${entity.id}_${match.entity.id}`,
            created_at: now.toISOString(),
            adapter: adapterId,
            reason: `${file}:${line}: "${entityName}" may be the same site as "${match.entity.name}"; kept separate`,
            payload: JSON.stringify({ entity: entity.id, similar: match.entity.id }),
            resolved_at: null,
            resolution: null,
          })
        )
          result.review++;
      }
      result.entities++;
      entityId = entity.id;
    }

    const source = await ensureSource(store, {
      publisher: sourcePublisher,
      title: row.source_title?.trim() || sourceUrl,
      url: sourceUrl,
      tier: Number(row.source_tier) as SourceTier,
      published_date: row.source_published_date || null,
      license: null,
      adapter: adapterId,
    });
    const metric = metricById(metricId)!;
    const obs = await makeObservation(
      {
        entity_id: entityId,
        metric: metric.id,
        value: num(row.value),
        value_low: num(row.value_low),
        value_high: num(row.value_high),
        unit: metric.unit,
        value_original: row.value_original || null,
        status: row.status as Status,
        scope: row.scope as Scope,
        claim_type: row.claim_type as ClaimType,
        effective_date: effectiveDate,
        effective_precision: datePrecision(effectiveDate)!,
        effective_kind: row.effective_date_kind as EffectiveKind,
        source_id: source.id,
        excerpt: row.excerpt || null,
        locator: `${file}:${line}`,
        method_id: row.claim_type === "derived" ? row.method_id || "fx-conversion.v1" : null,
        derived_from: null,
        supersedes_id: null,
        review_status: "accepted",
        notes: row.notes || null,
      },
      dataset,
      now,
    );
    if (await store.appendObservation(obs)) result.observations++;
  }
  return result;
}

export const csvImport: Adapter = {
  ...meta("csv-import"),
  url: "https://github.com/sean-reid/cloud-atlas/tree/main/data/imports",
  tier: 4,
  license: "Each row cites its own source; the compilation is CC BY 4.0",
  hosts: [],
  source: () => ({
    id: "",
    publisher: "Cloud Atlas maintainers",
    title: "Reviewed observations",
    url: "https://github.com/sean-reid/cloud-atlas/tree/main/data/imports",
    tier: 4,
    published_date: null,
    license: "CC BY 4.0",
    adapter: "csv-import",
  }),
  async run(ctx: AdapterContext) {
    const dir = join(process.cwd(), "data", "imports");
    const total = emptyResult();
    for (const f of readdirSync(dir)
      .filter((f) => f.endsWith(".csv"))
      .sort()) {
      const r = await importCsv(ctx, join(dir, f), this.id);
      total.observations += r.observations;
      total.entities += r.entities;
      total.review += r.review;
    }
    return total;
  },
};
