import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { adapterById } from "../../pipeline/adapters";
import {
  azureGlobeRegions,
  GLOBE_URL,
  type GlobeRegion,
} from "../../pipeline/adapters/azure-globe-regions";
import type { Adapter } from "../../pipeline/adapters/types";
import type { SqliteDb } from "../../pipeline/db";
import { fixtureFetch } from "../../pipeline/fixtures";
import { runAdapters } from "../../pipeline/run";
import { DATA, FIX, fast, fixedNow, memoryDb } from "./helpers";

const WEST_US_ANNOUNCEMENT =
  "https://web.archive.org/web/20120530115120/http:/blogs.msdn.com/b/windowsazure/archive/2012/04/05/announcing-new-datacenter-options-for-windows-azure.aspx";

let cache = "";
let db: SqliteDb;
beforeEach(async () => {
  cache = mkdtempSync(join(tmpdir(), "ca-globe-"));
  db = await memoryDb();
});
afterEach(async () => {
  rmSync(cache, { recursive: true, force: true });
  await db.close();
});

const run = (adapters: Adapter[], fetchImpl = fixtureFetch(FIX)) =>
  runAdapters(adapters, {
    db,
    dataRoot: DATA,
    dataset: "live",
    cacheDir: cache,
    now: fixedNow,
    fetchDefaults: fast,
    fetchImpl,
  });

const withRegions = () => [adapterById("azure-regions") as Adapter, azureGlobeRegions];
const records = () =>
  JSON.parse(readFileSync(join(FIX, "azure-globe-regions.json"), "utf8")) as GlobeRegion[];

describe("azure-globe-regions adapter", () => {
  test("the recorded globe holds ten regions, one closed and one outside the public list", () => {
    const rs = records();
    expect(rs).toHaveLength(10);
    expect(rs.filter((r) => !r.isOpen).map((r) => r.post_title)).toEqual(["Thailand South"]);
    expect(rs.find((r) => r.post_name === "chinanorth3")!.isOpen).toBe(true);
  });

  test("records an opening year per matched region and holds the rest in one item", async () => {
    const { store, outcomes } = await run(withRegions());
    const globe = outcomes.find((o) => o.adapter === "azure-globe-regions")!;
    expect(globe.ok, globe.error ?? "").toBe(true);
    expect(globe.result).toEqual({ observations: 8, entities: 0, signals: 0, review: 1 });

    const source = [...store.sources.values()].find((s) => s.url === GLOBE_URL)!;
    expect(source).toMatchObject({ tier: 1, adapter: "azure-globe-regions" });
    const opened = [...store.observations.values()].filter((o) => o.source_id === source.id);
    expect(opened).toHaveLength(8);
    const westUs = opened.find((o) => store.entities.get(o.entity_id)!.code === "westus")!;
    expect(westUs).toMatchObject({
      metric: "region_count",
      value: 1,
      unit: "regions",
      value_original: "opened 2012",
      status: "operational",
      scope: "region",
      claim_type: "reported",
      effective_date: "2012",
      effective_precision: "year",
      effective_kind: "opened",
      excerpt: "West US | California | regionaz | opened 2012",
      locator: WEST_US_ANNOUNCEMENT,
      review_status: "accepted",
    });
    expect(
      opened.map((o) => [store.entities.get(o.entity_id)!.code, o.effective_date]).sort(),
    ).toEqual([
      ["eastus", "2014"],
      ["eastus2", "2012"],
      ["northeurope", "2009"],
      ["swedencentral", "2021"],
      ["westeurope", "2010"],
      ["westus", "2012"],
      ["westus2", "2007"],
      ["westus3", "2021"],
    ]);
    expect(opened.some((o) => o.excerpt!.startsWith("Thailand South"))).toBe(false);

    const items = [...store.review.values()].filter((r) => r.adapter === "azure-globe-regions");
    expect(items).toHaveLength(1);
    expect(items[0]!.id).toMatch(/^rev_azure-globe-regions_unmatched_[0-9a-f]{16}$/);
    expect(items[0]!.reason).toBe(
      "1 open globe regions match no Azure region entity: China North 3",
    );
    expect(JSON.parse(items[0]!.payload)).toEqual([
      {
        post_title: "China North 3",
        post_name: "chinanorth3",
        location: "Hebei",
        typeId: "regionaz",
        yearOpen: "2022",
        announcementLink:
          "https://azure.microsoft.com/blog/microsoft-azure-expands-to-new-region-in-the-china-market/",
      },
    ]);
  });

  test("with no region entities every open region is unmatched and nothing is written", async () => {
    const { store, outcomes } = await run([azureGlobeRegions]);
    expect(outcomes[0]!.result).toEqual({ observations: 0, entities: 0, signals: 0, review: 1 });
    const item = [...store.review.values()].find((r) => r.adapter === "azure-globe-regions")!;
    expect(JSON.parse(item.payload)).toHaveLength(9);
  });

  test("a second run adds nothing; a changed unmatched list replaces the old item", async () => {
    const first = await run(withRegions());
    const second = await run([azureGlobeRegions]);
    expect(second.outcomes[0]!.result).toEqual({
      observations: 0,
      entities: 0,
      signals: 0,
      review: 0,
    });
    expect(second.store.observations.size).toBe(first.store.observations.size);
    expect(second.store.review.size).toBe(first.store.review.size);

    const renamed = records().map((r) =>
      r.post_name === "westus3"
        ? { ...r, post_name: "westus9", post_title: "West US 9", displayName: "West US 9" }
        : r,
    );
    const third = await run(
      [azureGlobeRegions],
      fixtureFetch(FIX, {
        [GLOBE_URL]: () => new Response(JSON.stringify(renamed), { status: 200 }),
      }),
    );
    expect(third.outcomes[0]!.result!.review).toBe(1);
    const items = [...third.store.review.values()].filter(
      (r) => r.adapter === "azure-globe-regions",
    );
    expect(items).toHaveLength(2);
    const open = items.filter((r) => r.resolved_at === null);
    expect(open).toHaveLength(1);
    expect(open[0]!.reason).toBe(
      "2 open globe regions match no Azure region entity: West US 9, China North 3",
    );
    expect(items.find((r) => r.resolved_at)!.resolution).toBe("replaced by a newer list");
  });

  test("a response that is not a record list fails the run", async () => {
    const { outcomes } = await run(
      [azureGlobeRegions],
      fixtureFetch(FIX, {
        [GLOBE_URL]: () => new Response(JSON.stringify({ error: "nope" }), { status: 200 }),
      }),
    );
    expect(outcomes[0]!.ok).toBe(false);
    expect(outcomes[0]!.error).toMatch(/endpoint changed/);
  });
});
