import { slugify, stableId } from "../shared/ids";
import type { ProviderSlug } from "../shared/providers";
import type { Dataset, Entity, EntityType, Observation, Source } from "../shared/types";
import type { Store } from "./store";

export async function entityId(provider: string, type: EntityType, slug: string): Promise<string> {
  return stableId("ent", [provider, type, slug]);
}

export async function sourceId(url: string): Promise<string> {
  return stableId("src", [url.trim()]);
}

export async function providerEntity(
  store: Store,
  provider: ProviderSlug,
  name: string,
  dataset: Dataset,
): Promise<Entity> {
  const id = await entityId(provider, "provider", provider);
  const existing = store.entities.get(id);
  if (existing) return existing;
  return await store.upsertEntity({
    id,
    dataset,
    type: "provider",
    provider_slug: provider,
    parent_id: null,
    name,
    slug: provider,
    code: null,
    country_code: null,
    admin_area: null,
    locality: null,
    lat: null,
    lon: null,
    location_precision: "unknown",
    ownership: "owned",
    landlord: null,
  });
}

export interface EntityInput {
  dataset: Dataset;
  type: EntityType;
  provider: ProviderSlug;
  name: string;
  slug?: string;
  code?: string | null;
  parent_id?: string | null;
  country_code?: string | null;
  admin_area?: string | null;
  locality?: string | null;
  lat?: number | null;
  lon?: number | null;
  location_precision?: Entity["location_precision"];
  ownership?: Entity["ownership"];
  landlord?: string | null;
}

// Keyed by provider, type, and slug, so a rerun finds the same entity. Geography fields
// are only filled in, never blanked, when a later source knows less than an earlier one.
export async function ensureEntity(store: Store, input: EntityInput): Promise<Entity> {
  const slug = input.slug ?? slugify(input.code ?? input.name);
  const id = await entityId(input.provider, input.type, slug);
  const prev = store.entities.get(id);
  const next: Entity = {
    id,
    dataset: input.dataset,
    type: input.type,
    provider_slug: input.provider,
    parent_id: input.parent_id ?? prev?.parent_id ?? null,
    name: input.name || prev?.name || slug,
    slug,
    code: input.code ?? prev?.code ?? null,
    country_code: input.country_code ?? prev?.country_code ?? null,
    admin_area: input.admin_area ?? prev?.admin_area ?? null,
    locality: input.locality ?? prev?.locality ?? null,
    lat: input.lat ?? prev?.lat ?? null,
    lon: input.lon ?? prev?.lon ?? null,
    location_precision: input.location_precision ?? prev?.location_precision ?? "unknown",
    ownership:
      input.ownership && input.ownership !== "unknown"
        ? input.ownership
        : (prev?.ownership ?? "unknown"),
    landlord: input.landlord ?? prev?.landlord ?? null,
  };
  return await store.upsertEntity(next);
}

export async function ensureSource(store: Store, s: Omit<Source, "id">): Promise<Source> {
  const id = await sourceId(s.url);
  return await store.upsertSource({ ...s, id });
}

export type ObservationInput = Omit<
  Observation,
  "id" | "recorded_at" | "retrieved_at" | "dataset"
> & {
  recorded_at?: string;
  retrieved_at?: string;
};

// The id covers everything that makes a claim distinct, so the same figure from the same
// source with the same effective date is one observation however often it is re-read.
export async function makeObservation(
  input: ObservationInput,
  dataset: Dataset,
  now: Date,
): Promise<Observation> {
  const id = await stableId("obs", [
    input.entity_id,
    input.metric,
    input.value,
    input.value_low,
    input.value_high,
    input.status,
    input.scope,
    input.claim_type,
    input.effective_date,
    input.effective_kind,
    input.source_id,
    input.method_id ?? null,
  ]);
  const iso = now.toISOString();
  return {
    id,
    dataset,
    recorded_at: input.recorded_at ?? iso,
    retrieved_at: input.retrieved_at ?? iso,
    ...input,
  };
}

const NOISE = new Set([
  "campus",
  "campuses",
  "data",
  "center",
  "centre",
  "centers",
  "centres",
  "datacenter",
  "datacenters",
  "site",
  "project",
  "the",
  "of",
  "and",
  "aws",
  "amazon",
  "microsoft",
  "azure",
  "google",
  "gcp",
  "oracle",
  "oci",
  "coreweave",
  "alibaba",
  "tencent",
  "huawei",
  "ibm",
  "cloud",
  "ai",
  "zone",
  "mega",
  "new",
]);

export function nameTokens(name: string): Set<string> {
  return new Set(
    name
      .toLowerCase()
      .replace(/\(.*?\)/g, " ")
      .split(/[^a-z0-9]+/)
      .filter((t) => t && !NOISE.has(t)),
  );
}

export interface Match {
  entity: Entity;
  kind: "same" | "similar";
}

// Entity resolution for physical sites: identical token sets after dropping provider and
// generic words are the same campus; a strict subset or superset is similar and goes to
// review rather than being merged.
export function findSite(
  store: Store,
  provider: ProviderSlug,
  name: string,
  types: readonly EntityType[] = ["campus"],
): Match | null {
  const want = nameTokens(name);
  if (!want.size) return null;
  const canonical = store.aliases.get(`${provider}|${[...want].sort().join(" ")}`);
  if (canonical) {
    const target = nameTokens(canonical);
    for (const e of store.entities.values()) {
      if (e.provider_slug !== provider || !types.includes(e.type)) continue;
      const have = nameTokens(e.name);
      if (have.size === target.size && [...have].every((t) => target.has(t)))
        return { entity: e, kind: "same" };
    }
  }
  let similar: Entity | null = null;
  for (const e of store.entities.values()) {
    if (e.provider_slug !== provider || !types.includes(e.type)) continue;
    const have = nameTokens(e.name);
    if (!have.size) continue;
    const same = have.size === want.size && [...have].every((t) => want.has(t));
    if (same) return { entity: e, kind: "same" };
    const sub = [...have].every((t) => want.has(t)) || [...want].every((t) => have.has(t));
    if (sub && !similar) similar = e;
  }
  return similar ? { entity: similar, kind: "similar" } : null;
}
