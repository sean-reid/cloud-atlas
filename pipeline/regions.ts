import type { Adapter, AdapterContext } from "./adapters/types";
import { ensureEntity } from "./entities";
import { recordFirstSeen } from "./first-seen";
import { regionGeo } from "./geo";
import type { ProviderSlug } from "../shared/providers";
import type { Entity, Source } from "../shared/types";

// Upserts one region entity from a provider's own region list, placing it from the geo index.
// A code the index lacks still gets an entity, unplaced, plus a review item asking for its
// coordinates, so the map never guesses and nothing is dropped.
export async function ensureRegion(
  ctx: AdapterContext,
  adapter: Adapter,
  input: {
    provider: ProviderSlug;
    code: string;
    name: string | null;
    parent: Entity;
    source: Source;
  },
): Promise<{ entity: Entity; observations: number; review: number }> {
  const { store } = ctx;
  const { provider, code, parent, source } = input;
  const geo = regionGeo(ctx.geo, provider, code);
  const now = ctx.now().toISOString();
  const wasKnown = [...store.entities.values()].some(
    (e) => e.type === "region" && e.provider_slug === provider && e.code === code,
  );
  const entity = await ensureEntity(store, {
    dataset: ctx.dataset,
    type: "region",
    provider,
    name: geo?.name ?? input.name ?? code,
    code,
    slug: code,
    parent_id: parent.id,
    country_code: geo?.country_code ?? null,
    admin_area: geo?.admin_area ?? null,
    locality: geo?.locality ?? null,
    lat: geo?.lat ?? null,
    lon: geo?.lon ?? null,
    location_precision: geo ? "region_centroid" : "unknown",
    ownership: "owned",
  });
  const observations = (await recordFirstSeen(ctx, adapter, entity, wasKnown, source)) ? 1 : 0;
  const reviewId = `rev_${provider}_geo_${code}`;
  let review = 0;
  if (geo) await store.resolveReview(reviewId, "geography added", now);
  else if (
    await store.queueReview({
      id: reviewId,
      created_at: now,
      adapter: adapter.id,
      reason: `region ${code} has no entry in data/geo/regions.json`,
      payload: JSON.stringify({ code, name: input.name }),
      resolved_at: null,
      resolution: null,
    })
  )
    review = 1;
  return { entity, observations, review };
}
