import { ensureEntity, ensureSource, makeObservation, providerEntity } from "../entities";
import { regionGeo } from "../geo";
import { columnIndex, tableWithColumns } from "../html";
import { emptyResult, type Adapter, type AdapterContext } from "./types";

const ZONES_URL = "https://docs.cloud.google.com/compute/docs/regions-zones";
const RANGES_URL = "https://www.gstatic.com/ipranges/cloud.json";

interface CloudJson {
  prefixes: { scope?: string }[];
}

export const gcpRegions: Adapter = {
  id: "gcp-regions",
  title: "Google Cloud regions and zones",
  publisher: "Google Cloud",
  url: ZONES_URL,
  tier: 1,
  license:
    "Google Cloud documentation, CC BY 4.0; cloud.json carries no licence and is used for code discovery only",
  measures:
    "Zone codes with their cities, zones per region, and region codes present in the public IP range feed. Geography only.",
  mode: "automated",
  schedule: "daily",
  hosts: ["docs.cloud.google.com", "www.gstatic.com"],
  source: () => ({
    id: "",
    publisher: "Google Cloud",
    title: "Compute Engine regions and zones",
    url: ZONES_URL,
    tier: 1,
    published_date: null,
    license: "CC BY 4.0",
    adapter: "gcp-regions",
  }),
  async run(ctx: AdapterContext) {
    const result = emptyResult();
    const now = ctx.now();
    const today = now.toISOString().slice(0, 10);
    const { store, dataset } = ctx;
    const provider = await providerEntity(store, "gcp", "Google Cloud", dataset);
    const source = await ensureSource(store, { ...this.source(), adapter: this.id });

    const page = await ctx.fetch(ZONES_URL);
    const table = tableWithColumns(page.body, ["zones", "location"]);
    if (!table || table.length < 30) throw new Error("zones table missing or too short");
    const header = table[0]!;
    const iZone = columnIndex(header, "zones");
    const iLoc = columnIndex(header, "location");

    const ranges = JSON.parse((await ctx.fetch(RANGES_URL)).body) as CloudJson;
    const feedScopes = new Set(
      ranges.prefixes.map((p) => p.scope).filter((s): s is string => !!s && s !== "global"),
    );

    const zonesByRegion = new Map<string, { zones: string[]; location: string }>();
    for (const row of table.slice(1)) {
      const zone = row[iZone]?.trim();
      const m = zone ? /^([a-z]+-[a-z]+\d+)-[a-z]$/.exec(zone) : null;
      if (!zone || !m) continue;
      const region = m[1]!;
      const entry = zonesByRegion.get(region) ?? { zones: [], location: row[iLoc] ?? "" };
      entry.zones.push(zone);
      zonesByRegion.set(region, entry);
    }

    for (const [code, { zones, location }] of zonesByRegion) {
      const geo = regionGeo(ctx.geo, "gcp", code);
      const parts = location.split(",").map((s) => s.trim());
      const region = await ensureEntity(store, {
        dataset,
        type: "region",
        provider: "gcp",
        name: geo?.name ?? `${code} (${parts[0] ?? location})`,
        code,
        slug: code,
        parent_id: provider.id,
        country_code: geo?.country_code ?? null,
        admin_area: geo?.admin_area ?? null,
        locality: geo?.locality ?? parts[0] ?? null,
        lat: geo?.lat ?? null,
        lon: geo?.lon ?? null,
        location_precision: geo ? "region_centroid" : "unknown",
        ownership: "owned",
      });
      result.entities++;
      if (geo)
        await store.resolveReview(`rev_gcp_geo_${code}`, "geography added", now.toISOString());
      if (
        !geo &&
        (await store.queueReview({
          id: `rev_gcp_geo_${code}`,
          created_at: now.toISOString(),
          adapter: this.id,
          reason: `region ${code} has no entry in data/geo/regions.json`,
          payload: JSON.stringify({ code, location }),
          resolved_at: null,
          resolution: null,
        }))
      )
        result.review++;
      for (const zone of zones) {
        await ensureEntity(store, {
          dataset,
          type: "zone",
          provider: "gcp",
          name: zone,
          code: zone,
          slug: zone,
          parent_id: region.id,
          country_code: region.country_code,
          admin_area: region.admin_area,
          locality: region.locality,
          lat: null,
          lon: null,
          location_precision: "unknown",
          ownership: "owned",
        });
        result.entities++;
      }
      const obs = await makeObservation(
        {
          entity_id: region.id,
          metric: "az_count",
          value: zones.length,
          value_low: null,
          value_high: null,
          unit: "zones",
          value_original: zones.join(", "),
          status: "operational",
          scope: "region",
          claim_type: "derived",
          effective_date: today,
          effective_precision: "day",
          effective_kind: "as_of",
          source_id: source.id,
          excerpt: `${zones[0]} | ${location}`,
          locator: "table: Zones, Location",
          method_id: "count-from-table.v1",
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

    for (const scope of feedScopes) {
      if (zonesByRegion.has(scope)) continue;
      if (
        await store.queueReview({
          id: `rev_gcp_scope_${scope}`,
          created_at: now.toISOString(),
          adapter: this.id,
          reason: `region code ${scope} appears in cloud.json but not in the public zones table (pre-launch or internal)`,
          payload: JSON.stringify({ scope }),
          resolved_at: null,
          resolution: null,
        })
      )
        result.review++;
    }

    const regionCount = await makeObservation(
      {
        entity_id: provider.id,
        metric: "region_count",
        value: zonesByRegion.size,
        value_low: null,
        value_high: null,
        unit: "regions",
        value_original: `${zonesByRegion.size} regions in table`,
        status: "operational",
        scope: "public_cloud",
        claim_type: "derived",
        effective_date: today,
        effective_precision: "day",
        effective_kind: "as_of",
        source_id: source.id,
        excerpt: null,
        locator: "table: Zones, Location",
        method_id: "count-from-table.v1",
        derived_from: null,
        supersedes_id: null,
        review_status: "accepted",
        notes: null,
      },
      dataset,
      now,
    );
    if (await store.appendObservation(regionCount)) result.observations++;
    const zoneTotal = [...zonesByRegion.values()].reduce((n, r) => n + r.zones.length, 0);
    const zoneCount = await makeObservation(
      {
        entity_id: provider.id,
        metric: "az_count",
        value: zoneTotal,
        value_low: null,
        value_high: null,
        unit: "zones",
        value_original: `${zoneTotal} zones in table`,
        status: "operational",
        scope: "public_cloud",
        claim_type: "derived",
        effective_date: today,
        effective_precision: "day",
        effective_kind: "as_of",
        source_id: source.id,
        excerpt: null,
        locator: "table: Zones, Location",
        method_id: "count-from-table.v1",
        derived_from: null,
        supersedes_id: null,
        review_status: "accepted",
        notes: null,
      },
      dataset,
      now,
    );
    if (await store.appendObservation(zoneCount)) result.observations++;
    return result;
  },
};
