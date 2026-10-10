import { datePrecision } from "../../shared/dates";
import { ensureEntity, ensureSource, makeObservation, providerEntity } from "../entities";
import { recordFirstSeen } from "../first-seen";
import { regionGeo } from "../geo";
import { columnIndex, stripTags, tableWithColumns } from "../html";
import { emptyResult, meta, type Adapter, type AdapterContext } from "./types";

const REGIONS_URL =
  "https://docs.aws.amazon.com/global-infrastructure/latest/regions/aws-regions.html";
const HISTORY_URL =
  "https://docs.aws.amazon.com/global-infrastructure/latest/regions/doc-history.html";
const ENDPOINTS_URL =
  "https://raw.githubusercontent.com/boto/botocore/develop/botocore/data/endpoints.json";

const MONTHS: Record<string, string> = {
  january: "01",
  february: "02",
  march: "03",
  april: "04",
  may: "05",
  june: "06",
  july: "07",
  august: "08",
  september: "09",
  october: "10",
  november: "11",
  december: "12",
};

export function parseLongDate(text: string): string | null {
  const m = /([A-Za-z]+) (\d{1,2}), (\d{4})/.exec(text);
  if (!m) return null;
  const month = MONTHS[m[1]!.toLowerCase()];
  if (!month) return null;
  return `${m[3]}-${month}-${m[2]!.padStart(2, "0")}`;
}

interface Endpoints {
  partitions: { partition: string; regions: Record<string, { description: string }> }[];
}

export const awsRegions: Adapter = {
  ...meta("aws-regions"),
  url: REGIONS_URL,
  tier: 1,
  license: "AWS documentation, CC BY-SA 4.0; botocore endpoints, Apache 2.0",
  hosts: ["docs.aws.amazon.com", "raw.githubusercontent.com"],
  source: () => ({
    id: "",
    publisher: "Amazon Web Services",
    title: "AWS Regions (Global Infrastructure documentation)",
    url: REGIONS_URL,
    tier: 1,
    published_date: null,
    license: "CC BY-SA 4.0",
    adapter: "aws-regions",
  }),
  async run(ctx: AdapterContext) {
    const result = emptyResult();
    const now = ctx.now();
    const today = now.toISOString().slice(0, 10);
    const { store, dataset } = ctx;
    const provider = await providerEntity(store, "aws", "Amazon Web Services", dataset);

    const regionsPage = await ctx.fetch(REGIONS_URL);
    const historyPage = await ctx.fetch(HISTORY_URL);
    const endpoints = JSON.parse((await ctx.fetch(ENDPOINTS_URL)).body) as Endpoints;
    const descriptions = new Map<string, string>();
    for (const p of endpoints.partitions) {
      for (const [code, r] of Object.entries(p.regions)) descriptions.set(code, r.description);
    }

    const table = tableWithColumns(regionsPage.body, ["code", "name", "az", "geography"]);
    if (!table || table.length < 20) throw new Error("region table missing or too short");
    const header = table[0]!;
    const iCode = columnIndex(header, "code");
    const iName = columnIndex(header, "name");
    const iAz = columnIndex(header, "az");
    const iGeo = columnIndex(header, "geography");

    const docsSource = await ensureSource(store, { ...this.source(), adapter: this.id });
    const historySource = await ensureSource(store, {
      publisher: "Amazon Web Services",
      title: "AWS Regions documentation history",
      url: HISTORY_URL,
      tier: 1,
      published_date: null,
      license: "CC BY-SA 4.0",
      adapter: this.id,
    });

    const launches = new Map<string, { date: string; excerpt: string }>();
    const hist = tableWithColumns(historyPage.body, ["change", "description", "date"]);
    for (const row of hist?.slice(1) ?? []) {
      const desc = row[1] ?? "";
      const code = /\(\s*([a-z]{2}-[a-z]+-\d)\s*\)/.exec(desc)?.[1];
      const date = parseLongDate(row[2] ?? "");
      if (code && date && /launched/i.test(desc))
        launches.set(code, { date, excerpt: `${desc} ${row[2]}` });
    }

    let count = 0;
    for (const row of table.slice(1)) {
      const code = row[iCode]?.trim();
      if (!code) continue;
      count++;
      const name = descriptions.get(code) ?? row[iName] ?? code;
      const geo = regionGeo(ctx.geo, "aws", code);
      const wasKnown = [...store.entities.values()].some(
        (e) => e.type === "region" && e.provider_slug === provider.provider_slug && e.code === code,
      );
      const entity = await ensureEntity(store, {
        dataset,
        type: "region",
        provider: "aws",
        name,
        code,
        slug: code,
        parent_id: provider.id,
        country_code: geo?.country_code ?? null,
        admin_area: geo?.admin_area ?? null,
        locality: geo?.locality ?? row[iGeo] ?? null,
        lat: geo?.lat ?? null,
        lon: geo?.lon ?? null,
        location_precision: geo ? "region_centroid" : "unknown",
        ownership: "owned",
      });
      result.entities++;
      if (await recordFirstSeen(ctx, this, entity, wasKnown, docsSource)) result.observations++;
      if (geo)
        await store.resolveReview(`rev_aws_geo_${code}`, "geography added", now.toISOString());
      if (!geo) {
        if (
          await store.queueReview({
            id: `rev_aws_geo_${code}`,
            created_at: now.toISOString(),
            adapter: this.id,
            reason: `region ${code} has no entry in data/geo/regions.json`,
            payload: JSON.stringify({ code, name, geography: row[iGeo] }),
            resolved_at: null,
            resolution: null,
          })
        )
          result.review++;
      }
      const az = parseInt((row[iAz] ?? "").replace(/[^\d]/g, ""), 10);
      if (Number.isFinite(az) && az > 0) {
        const obs = await makeObservation(
          {
            entity_id: entity.id,
            metric: "az_count",
            value: az,
            value_low: null,
            value_high: null,
            unit: "zones",
            value_original: row[iAz] ?? null,
            status: "operational",
            scope: "region",
            claim_type: "reported",
            effective_date: today,
            effective_precision: "day",
            effective_kind: "as_of",
            source_id: docsSource.id,
            excerpt: `${code} | ${row[iName]} | ${row[iAz]} | ${row[iGeo]}`,
            locator: "table: Code, Name, AZs, Geography",
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
      const launch = launches.get(code);
      if (launch) {
        const obs = await makeObservation(
          {
            entity_id: entity.id,
            metric: "region_count",
            value: 1,
            value_low: null,
            value_high: null,
            unit: "regions",
            value_original: launch.date,
            status: "operational",
            scope: "region",
            claim_type: "reported",
            effective_date: launch.date,
            effective_precision: datePrecision(launch.date) ?? "day",
            effective_kind: "opened",
            source_id: historySource.id,
            excerpt: launch.excerpt.slice(0, 300),
            locator: "table: Change, Description, Date",
            method_id: null,
            derived_from: null,
            supersedes_id: null,
            review_status: "accepted",
            notes: "Region launch date from the documentation history table.",
          },
          dataset,
          now,
        );
        if (await store.appendObservation(obs)) result.observations++;
      }
    }

    const stated = /There are currently (\d+) Regions/.exec(stripTags(regionsPage.body));
    const providerObs = await makeObservation(
      {
        entity_id: provider.id,
        metric: "region_count",
        value: stated ? Number(stated[1]) : count,
        value_low: null,
        value_high: null,
        unit: "regions",
        value_original: stated ? stated[0] : `${count} rows`,
        status: "operational",
        scope: "public_cloud",
        claim_type: stated ? "reported" : "derived",
        effective_date: today,
        effective_precision: "day",
        effective_kind: "as_of",
        source_id: docsSource.id,
        excerpt: stated ? stated[0] : null,
        locator: "page text",
        method_id: stated ? null : "count-from-table.v1",
        derived_from: null,
        supersedes_id: null,
        review_status: "accepted",
        notes:
          "Commercial partition only; GovCloud and China regions are listed separately by AWS.",
      },
      dataset,
      now,
    );
    if (await store.appendObservation(providerObs)) result.observations++;
    return result;
  },
};
