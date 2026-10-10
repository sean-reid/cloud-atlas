import type { Adapter, AdapterContext } from "./adapters/types";
import { makeObservation } from "./entities";
import type { Entity, Source } from "../shared/types";

// A region that appears in a provider's list after that provider already has regions in the
// store is new as of that day. The run that seeds a provider's first regions records nothing,
// since those launch dates are unknown; the CSV import backfills them where a dated
// announcement exists.
export async function recordFirstSeen(
  ctx: AdapterContext,
  adapter: Adapter,
  entity: Entity,
  wasKnown: boolean,
  source: Source,
): Promise<boolean> {
  if (wasKnown) return false;
  if (!ctx.store.regionProvidersAtOpen.has(entity.provider_slug)) return false;
  const now = ctx.now();
  const today = now.toISOString().slice(0, 10);
  const obs = await makeObservation(
    {
      entity_id: entity.id,
      metric: "region_count",
      value: 1,
      value_low: null,
      value_high: null,
      unit: "regions",
      value_original: `first listed ${today}`,
      status: "operational",
      scope: "region",
      claim_type: "derived",
      effective_date: today,
      effective_precision: "day",
      effective_kind: "opened",
      source_id: source.id,
      excerpt: null,
      locator: "first appearance in the region table",
      method_id: "first-seen.v1",
      derived_from: null,
      supersedes_id: null,
      review_status: "accepted",
      notes: `First appeared in ${source.publisher}'s region documentation on this date. The region may have opened earlier.`,
    },
    ctx.dataset,
    now,
  );
  return ctx.store.appendObservation(obs);
}
