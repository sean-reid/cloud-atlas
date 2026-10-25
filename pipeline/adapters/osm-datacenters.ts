import { datePrecision } from "../../shared/dates";
import { providerBySlug, type ProviderSlug } from "../../shared/providers";
import type { Entity, Status } from "../../shared/types";
import { countryAt } from "../country";
import { ensureEntity, ensureSource, entityId, makeObservation, providerEntity } from "../entities";
import { FetchError } from "../fetch";
import { log } from "../log";
import type { Store } from "../store";
import { emptyResult, meta, type Adapter, type AdapterContext } from "./types";

export const OVERPASS_URL = "https://overpass-api.de/api/interpreter";
export const FALLBACK_URL = "https://overpass.kumi.systems/api/interpreter";
export const QUERY =
  '[out:json][timeout:180]; nwr["telecom"="data_center"]["operator"~"amazon|aws|microsoft|azure|google|oracle|alibaba|aliyun|tencent|huawei|ibm|coreweave|nebius|nscale|crusoe",i]; out center tags;';
export const OSM_USER_AGENT =
  "cloud-atlas/0.1 (+https://cloud-atlas.dwainosaur.com; OpenStreetMap datacenter layer)";
export const COPYRIGHT_URL = "https://www.openstreetmap.org/copyright";
export const ODBL = "ODbL 1.0";
export const CAMPUS_KM = 10;
export const CLUSTER_KM = 3;

const OWNERSHIP_NOTE =
  "OSM tags the operator, not the owner; ownership is recorded as owned on that basis.";

export const queryUrl = (base: string): string => `${base}?data=${encodeURIComponent(QUERY)}`;

export type OsmType = "node" | "way" | "relation";

export interface OsmObject {
  type: OsmType;
  id: number;
  lat: number;
  lon: number;
  tags: Record<string, string>;
}

export interface ItPowerReview {
  object: string;
  entity: string;
  name: string;
  it_power: string;
  input_electricity: string | null;
}

const OPERATORS: readonly [RegExp, ProviderSlug][] = [
  [/amazon|\baws\b/i, "aws"],
  [/microsoft|azure/i, "azure"],
  [/google/i, "gcp"],
  [/oracle/i, "oracle"],
  [/alibaba|aliyun/i, "alibaba"],
  [/tencent/i, "tencent"],
  [/huawei/i, "huawei"],
  [/\bibm\b/i, "ibm"],
  [/coreweave/i, "coreweave"],
  [/nebius/i, "nebius"],
  [/nscale/i, "nscale"],
  [/crusoe/i, "crusoe"],
];

export function providerFor(operator: string | undefined): ProviderSlug | null {
  if (!operator) return null;
  return OPERATORS.find(([re]) => re.test(operator))?.[1] ?? null;
}

const TYPES = new Set<string>(["node", "way", "relation"]);

export function parseOverpass(body: string): OsmObject[] {
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    throw new Error("Overpass response is not JSON; endpoint changed");
  }
  const elements = (data as { elements?: unknown }).elements;
  if (!Array.isArray(elements))
    throw new Error("no elements in the Overpass response; API changed");
  const out: OsmObject[] = [];
  for (const raw of elements as Record<string, unknown>[]) {
    const center = raw.center as { lat?: unknown; lon?: unknown } | undefined;
    const lat = center?.lat ?? raw.lat;
    const lon = center?.lon ?? raw.lon;
    const tags = raw.tags;
    if (
      typeof raw.type !== "string" ||
      !TYPES.has(raw.type) ||
      typeof raw.id !== "number" ||
      typeof lat !== "number" ||
      typeof lon !== "number" ||
      !tags ||
      typeof tags !== "object"
    )
      continue;
    out.push({
      type: raw.type as OsmType,
      id: raw.id,
      lat,
      lon,
      tags: tags as Record<string, string>,
    });
  }
  return out.sort((a, b) => a.type.localeCompare(b.type) || a.id - b.id);
}

export const objectUrl = (o: Pick<OsmObject, "type" | "id">): string =>
  `https://www.openstreetmap.org/${o.type}/${o.id}`;

export function statusFor(tags: Record<string, string>): Status {
  if (Object.keys(tags).some((k) => /^(disused|abandoned)(:|$)/.test(k))) return "decommissioned";
  if (
    tags.construction === "yes" ||
    tags.landuse === "construction" ||
    tags.building === "construction"
  )
    return "under_construction";
  return "operational";
}

export function facilityName(provider: ProviderSlug, o: OsmObject): string {
  const short = providerBySlug(provider)!.shortName;
  const name = o.tags.name?.trim();
  if (name) return name;
  const ref = o.tags.ref?.trim();
  return ref ? `${short} ${ref}` : `${short} facility ${o.id}`;
}

export function distanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const p = Math.PI / 180;
  const dLat = (lat2 - lat1) * p;
  const dLon = (lon2 - lon1) * p;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * p) * Math.cos(lat2 * p) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

const isOsmCampus = (e: Entity) => e.slug.startsWith("osm-campus-");

function nearestCampus(
  store: Store,
  provider: ProviderSlug,
  o: OsmObject,
  maxKm: number,
  keep: (e: Entity) => boolean,
): Entity | null {
  let best: Entity | null = null;
  let bestKm = Infinity;
  for (const e of store.entities.values()) {
    if (e.provider_slug !== provider || e.type !== "campus" || e.lat === null || e.lon === null)
      continue;
    if (!keep(e)) continue;
    const km = distanceKm(o.lat, o.lon, e.lat, e.lon);
    if (km <= maxKm && km < bestKm) {
      best = e;
      bestKm = km;
    }
  }
  return best;
}

// A mapper's own addr:country beats the polygon lookup.
const countryTag = (tags: Record<string, string>): string | null => {
  const cc = tags["addr:country"]?.trim().toUpperCase();
  return cc && /^[A-Z]{2}$/.test(cc) ? cc : null;
};

const excerptOf = (tags: Record<string, string>): string =>
  ["operator", "name", "ref"]
    .filter((k) => tags[k])
    .map((k) => `${k}=${tags[k]}`)
    .join("; ");

async function fetchOverpass(ctx: AdapterContext, adapter: string): Promise<string> {
  const opts = { timeoutMs: 200_000, accept: "application/json", userAgent: OSM_USER_AGENT };
  try {
    return (await ctx.fetch(queryUrl(OVERPASS_URL), opts)).body;
  } catch (err) {
    if (!(err instanceof FetchError) || err.status === null) throw err;
    if (err.status !== 429 && err.status < 500) throw err;
    log("warn", "osm.fallback", { adapter, status: err.status });
    return (await ctx.fetch(queryUrl(FALLBACK_URL), opts)).body;
  }
}

export const osmDatacenters: Adapter = {
  ...meta("osm-datacenters"),
  url: OVERPASS_URL,
  tier: 3,
  license: ODBL,
  hosts: ["overpass-api.de", "overpass.kumi.systems"],
  source: () => ({
    id: "",
    publisher: "OpenStreetMap contributors",
    title: "OpenStreetMap telecom=data_center objects via Overpass",
    url: COPYRIGHT_URL,
    tier: 3,
    published_date: null,
    license: ODBL,
    adapter: "osm-datacenters",
  }),
  async run(ctx: AdapterContext) {
    const result = emptyResult();
    const now = ctx.now();
    const today = now.toISOString().slice(0, 10);
    const { store, dataset } = ctx;
    const source = await ensureSource(store, { ...this.source(), adapter: this.id });
    const objects = parseOverpass(await fetchOverpass(ctx, this.id));
    if (!objects.length)
      throw new Error("no objects in the Overpass response; query or tags changed");

    // A building already counted at this status is not counted again on a later day.
    const counted = new Set<string>();
    for (const o of store.observations.values())
      if (
        o.source_id === source.id &&
        o.metric === "building_count" &&
        o.effective_kind === "as_of"
      )
        counted.add(`${o.entity_id}|${o.status}`);

    const providers = new Map<ProviderSlug, Entity>();
    const parents = { existing: 0, created: 0, standalone: 0 };
    // Buildings with a town go first so the campuses they create exist before the rest look.
    const ordered = [
      ...objects.filter((o) => o.tags["addr:city"]?.trim()),
      ...objects.filter((o) => !o.tags["addr:city"]?.trim()),
    ];
    for (const o of ordered) {
      const slug = providerFor(o.tags.operator);
      if (!slug) continue;
      let providerEnt = providers.get(slug);
      if (!providerEnt) {
        providerEnt = await providerEntity(store, slug, providerBySlug(slug)!.name, dataset);
        providers.set(slug, providerEnt);
      }
      const short = providerBySlug(slug)!.shortName;
      const city = o.tags["addr:city"]?.trim() || null;
      const admin = o.tags["addr:state"]?.trim() || null;
      const country = countryTag(o.tags) ?? countryAt(o.lat, o.lon);
      const name = facilityName(slug, o);
      const url = objectUrl(o);

      let campus = nearestCampus(store, slug, o, CAMPUS_KM, (e) => !isOsmCampus(e));
      if (campus) parents.existing++;
      else {
        campus = nearestCampus(
          store,
          slug,
          o,
          CLUSTER_KM,
          (e) => isOsmCampus(e) && (!city || e.locality === city),
        );
        if (campus) parents.created++;
        else if (city) {
          campus = await ensureEntity(store, {
            dataset,
            type: "campus",
            provider: slug,
            name: `${short} ${city} campus`,
            slug: `osm-campus-${o.type}-${o.id}`,
            parent_id: providerEnt.id,
            country_code: country,
            admin_area: admin,
            locality: city,
            lat: o.lat,
            lon: o.lon,
            location_precision: "locality",
            ownership: "owned",
          });
          result.entities++;
          parents.created++;
        } else parents.standalone++;
      }

      const facilitySlug = `osm-${o.type}-${o.id}`;
      const fresh = !store.entities.has(await entityId(slug, "facility", facilitySlug));
      const facility = await ensureEntity(store, {
        dataset,
        type: "facility",
        provider: slug,
        name,
        slug: facilitySlug,
        parent_id: campus?.id ?? providerEnt.id,
        country_code: country,
        admin_area: admin,
        locality: city,
        lat: o.lat,
        lon: o.lon,
        location_precision: "exact",
        ownership: "owned",
      });
      if (fresh) result.entities++;

      const status = statusFor(o.tags);
      const excerpt = excerptOf(o.tags);
      const base = {
        entity_id: facility.id,
        metric: "building_count",
        value: 1,
        value_low: null,
        value_high: null,
        unit: "buildings",
        value_original: null,
        scope: "facility" as const,
        claim_type: "reported" as const,
        source_id: source.id,
        locator: url,
        method_id: null,
        derived_from: null,
        supersedes_id: null,
        review_status: "accepted" as const,
        notes: OWNERSHIP_NOTE,
      };
      if (!counted.has(`${facility.id}|${status}`)) {
        const obs = await makeObservation(
          {
            ...base,
            status,
            effective_date: today,
            effective_precision: "day",
            effective_kind: "as_of",
            excerpt,
          },
          dataset,
          now,
        );
        if (await store.appendObservation(obs)) result.observations++;
        counted.add(`${facility.id}|${status}`);
      }
      const start = o.tags.start_date?.trim() ?? "";
      const precision = start ? datePrecision(start) : null;
      if (precision) {
        const obs = await makeObservation(
          {
            ...base,
            status: "operational",
            effective_date: start,
            effective_precision: precision,
            effective_kind: "opened",
            excerpt: `${excerpt}; start_date=${start}`,
          },
          dataset,
          now,
        );
        if (await store.appendObservation(obs)) result.observations++;
      }
      const itPower = o.tags.it_power?.trim();
      if (itPower) {
        const payload: ItPowerReview = {
          object: url,
          entity: facility.id,
          name,
          it_power: itPower,
          input_electricity: o.tags["input:electricity"]?.trim() || null,
        };
        if (
          await store.queueReview({
            id: `rev_osm-datacenters_${o.type}-${o.id}_it-power`,
            created_at: now.toISOString(),
            adapter: this.id,
            reason: `OSM ${o.type}/${o.id} "${name}" carries it_power=${itPower}; transcribe it through data/imports or reject`,
            payload: JSON.stringify(payload),
            resolved_at: null,
            resolution: null,
          })
        )
          result.review++;
      }
    }
    log("info", "osm.parents", { adapter: this.id, ...parents });
    return result;
  },
};
