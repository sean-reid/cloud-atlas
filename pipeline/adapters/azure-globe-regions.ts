import { stableId } from "../../shared/ids";
import type { Entity } from "../../shared/types";
import { ensureSource, makeObservation } from "../entities";
import type { Store } from "../store";
import { emptyResult, meta, type Adapter, type AdapterContext } from "./types";

export const GLOBE_URL = "https://datacenters.microsoft.com/wp-json/globe/regions";

export interface GlobeRegion {
  post_title: string;
  post_name: string;
  location: string;
  latitude: string;
  longitude: string;
  typeId: string;
  isOpen: boolean;
  yearOpen: string | null;
  announcementLink: string | null;
  displayName?: string;
}

const UNMATCHED = "rev_azure-globe-regions_unmatched";

// The globe's post_name is the region's programmatic name for every open region so far; the
// title is the fallback for a record that spells its code differently.
export function matchRegion(store: Store, r: GlobeRegion): Entity | null {
  const names = new Set(
    [r.post_title, r.displayName].filter((s): s is string => !!s).map((s) => s.toLowerCase()),
  );
  for (const e of store.entities.values()) {
    if (e.provider_slug !== "azure" || e.type !== "region") continue;
    if (e.code === r.post_name || names.has(e.name.toLowerCase())) return e;
  }
  return null;
}

export const azureGlobeRegions: Adapter = {
  ...meta("azure-globe-regions"),
  url: GLOBE_URL,
  tier: 1,
  license: "Microsoft Terms of Use, personal and non-commercial use; robots.txt Crawl-delay 10",
  hosts: ["datacenters.microsoft.com"],
  source: () => ({
    id: "",
    publisher: "Microsoft",
    title: "Microsoft datacenter globe, regions",
    url: GLOBE_URL,
    tier: 1,
    published_date: null,
    license: "Microsoft Terms of Use",
    adapter: "azure-globe-regions",
  }),
  async run(ctx: AdapterContext) {
    const result = emptyResult();
    const now = ctx.now();
    const { store, dataset } = ctx;
    const source = await ensureSource(store, { ...this.source(), adapter: this.id });
    const records = JSON.parse((await ctx.fetch(GLOBE_URL)).body) as unknown;
    if (!Array.isArray(records) || records.length < 10 || !("post_name" in records[0]))
      throw new Error("globe regions response is not a record list; endpoint changed");

    const unmatched: GlobeRegion[] = [];
    for (const r of records as GlobeRegion[]) {
      const year = (r.yearOpen ?? "").trim();
      if (!r.isOpen || !/^\d{4}$/.test(year)) continue;
      const entity = matchRegion(store, r);
      if (!entity) {
        unmatched.push(r);
        continue;
      }
      const obs = await makeObservation(
        {
          entity_id: entity.id,
          metric: "region_count",
          value: 1,
          value_low: null,
          value_high: null,
          unit: "regions",
          value_original: `opened ${year}`,
          status: "operational",
          scope: "region",
          claim_type: "reported",
          effective_date: year,
          effective_precision: "year",
          effective_kind: "opened",
          source_id: source.id,
          excerpt: `${r.post_title} | ${r.location} | ${r.typeId} | opened ${year}`,
          locator: r.announcementLink || null,
          method_id: null,
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

    if (unmatched.length) {
      const names = unmatched.map((r) => r.post_name).sort();
      const id = await stableId(UNMATCHED, names);
      for (const item of store.review.values()) {
        if (item.adapter === this.id && item.id.startsWith(UNMATCHED) && item.id !== id)
          await store.resolveReview(item.id, "replaced by a newer list", now.toISOString());
      }
      if (
        await store.queueReview({
          id,
          created_at: now.toISOString(),
          adapter: this.id,
          reason: `${unmatched.length} open globe regions match no Azure region entity: ${unmatched.map((r) => r.post_title).join(", ")}`,
          payload: JSON.stringify(
            unmatched.map((r) => ({
              post_title: r.post_title,
              post_name: r.post_name,
              location: r.location,
              typeId: r.typeId,
              yearOpen: r.yearOpen,
              announcementLink: r.announcementLink,
            })),
          ),
          resolved_at: null,
          resolution: null,
        })
      )
        result.review++;
    }
    return result;
  },
};
