import { ensureEntity, ensureSource, makeObservation, providerEntity } from "../entities";
import { regionGeo } from "../geo";
import { columnIndex, tables } from "../html";
import { emptyResult, meta, type Adapter, type AdapterContext } from "./types";

const URL = "https://learn.microsoft.com/en-us/azure/reliability/regions-list";

export const azureRegions: Adapter = {
  ...meta("azure-regions"),
  url: URL,
  tier: 1,
  license:
    "Microsoft Learn; Microsoft Terms of Use permit informational non-commercial use of documents",
  hosts: ["learn.microsoft.com"],
  source: () => ({
    id: "",
    publisher: "Microsoft",
    title: "Azure regions list (Microsoft Learn)",
    url: URL,
    tier: 1,
    published_date: null,
    license: "Microsoft Terms of Use",
    adapter: "azure-regions",
  }),
  async run(ctx: AdapterContext) {
    const result = emptyResult();
    const now = ctx.now();
    const today = now.toISOString().slice(0, 10);
    const { store, dataset } = ctx;
    const provider = await providerEntity(store, "azure", "Microsoft Azure", dataset);
    const source = await ensureSource(store, { ...this.source(), adapter: this.id });

    const page = await ctx.fetch(URL);
    const seen = new Map<string, string[]>();
    for (const t of tables(page.body)) {
      const header = t[0]?.map((h) => h.toLowerCase()) ?? [];
      if (
        !header.some((h) => h.includes("programmatic")) ||
        !header.some((h) => h.includes("availability"))
      )
        continue;
      const iName = columnIndex(header, "region");
      const iAz = columnIndex(header, "availability");
      const iLoc = columnIndex(header, "physical");
      const iCode = columnIndex(header, "programmatic");
      for (const row of t.slice(1)) {
        const code = row[iCode]?.trim();
        if (!code) continue;
        seen.set(code, [row[iName] ?? code, row[iAz] ?? "", row[iLoc] ?? ""]);
      }
    }
    if (seen.size < 40) throw new Error(`only ${seen.size} regions parsed; page layout changed`);

    for (const [code, [name, azText, location]] of seen) {
      const geo = regionGeo(ctx.geo, "azure", code);
      const entity = await ensureEntity(store, {
        dataset,
        type: "region",
        provider: "azure",
        name: name ?? code,
        code,
        slug: code,
        parent_id: provider.id,
        country_code: geo?.country_code ?? null,
        admin_area: geo?.admin_area ?? null,
        locality: geo?.locality ?? location ?? null,
        lat: geo?.lat ?? null,
        lon: geo?.lon ?? null,
        location_precision: geo ? "region_centroid" : "unknown",
        ownership: "owned",
      });
      result.entities++;
      if (geo)
        await store.resolveReview(`rev_azure_geo_${code}`, "geography added", now.toISOString());
      if (
        !geo &&
        (await store.queueReview({
          id: `rev_azure_geo_${code}`,
          created_at: now.toISOString(),
          adapter: this.id,
          reason: `region ${code} has no entry in data/geo/regions.json`,
          payload: JSON.stringify({ code, name, location }),
          resolved_at: null,
          resolution: null,
        }))
      )
        result.review++;
      const az = parseInt(azText ?? "", 10);
      if (Number.isFinite(az) && az > 0) {
        const obs = await makeObservation(
          {
            entity_id: entity.id,
            metric: "az_count",
            value: az,
            value_low: null,
            value_high: null,
            unit: "zones",
            value_original: azText ?? null,
            status: "operational",
            scope: "region",
            claim_type: "reported",
            effective_date: today,
            effective_precision: "day",
            effective_kind: "as_of",
            source_id: source.id,
            excerpt: `${name} | ${azText} | ${location} | ${code}`,
            locator: "table: Region, Availability zones, Physical location, Programmatic name",
            method_id: null,
            derived_from: null,
            supersedes_id: null,
            review_status: "accepted",
            notes: /preview/i.test(azText ?? "")
              ? "Microsoft notes one or more zones in preview."
              : null,
          },
          dataset,
          now,
        );
        if (await store.appendObservation(obs)) result.observations++;
      }
    }

    const obs = await makeObservation(
      {
        entity_id: provider.id,
        metric: "region_count",
        value: seen.size,
        value_low: null,
        value_high: null,
        unit: "regions",
        value_original: `${seen.size} regions listed`,
        status: "operational",
        scope: "public_cloud",
        claim_type: "derived",
        effective_date: today,
        effective_precision: "day",
        effective_kind: "as_of",
        source_id: source.id,
        excerpt: null,
        locator: "tables with a Programmatic name column",
        method_id: "count-from-table.v1",
        derived_from: null,
        supersedes_id: null,
        review_status: "accepted",
        notes:
          "Public cloud only; sovereign clouds are documented separately. Microsoft's own marketing counts more regions, including announced ones.",
      },
      dataset,
      now,
    );
    if (await store.appendObservation(obs)) result.observations++;
    return result;
  },
};
