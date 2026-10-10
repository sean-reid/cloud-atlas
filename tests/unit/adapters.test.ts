import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ADAPTERS, adapterById } from "../../pipeline/adapters";
import { importCsv, validateRow } from "../../pipeline/adapters/csv-import";
import type { Adapter } from "../../pipeline/adapters/types";
import { fixtureFetch } from "../../pipeline/fixtures";
import { runAdapters } from "../../pipeline/run";
import { Store } from "../../pipeline/store";
import type { SqliteDb } from "../../pipeline/db";
import { loadGeo } from "../../pipeline/geo";
import { ensureMethods } from "../../pipeline/methods";
import { DATA, FIX, fast, fixedNow, memoryDb } from "./helpers";

const fakeFetch = (overrides: Record<string, () => Response> = {}) => fixtureFetch(FIX, overrides);

let cache = "";
let db: SqliteDb;
beforeEach(async () => {
  cache = mkdtempSync(join(tmpdir(), "ca-cache-"));
  db = await memoryDb();
});
afterEach(async () => {
  rmSync(cache, { recursive: true, force: true });
  await db.close();
});

// Adapters that need an account run against recorded responses in their own test files.
const scheduled = ADAPTERS.filter((a) => a.schedule !== "manual" && !a.credentials?.length);

describe("adapters against fixtures", () => {
  test("every scheduled adapter runs and writes typed rows", async () => {
    const { store, outcomes } = await runAdapters(scheduled, {
      db,
      dataRoot: DATA,
      dataset: "live",
      cacheDir: cache,
      now: fixedNow,
      fetchDefaults: fast,
      fetchImpl: fakeFetch(),
    });
    for (const o of outcomes) expect(o.ok, `${o.adapter}: ${o.error}`).toBe(true);
    const by = Object.fromEntries(outcomes.map((o) => [o.adapter, o.result!]));
    expect(by["aws-regions"]!.entities).toBe(34);
    expect(
      [...store.entities.values()].filter((e) => e.provider_slug === "gcp" && e.type === "region"),
    ).toHaveLength(12);
    expect(
      [...store.entities.values()].filter((e) => e.provider_slug === "gcp" && e.type === "zone")
        .length,
    ).toBeGreaterThanOrEqual(36);
    expect(by["azure-regions"]!.entities).toBeGreaterThanOrEqual(50);
    expect(by["epoch-ai"]!.entities).toBeGreaterThanOrEqual(20);
    expect(by["azure-retail-prices"]!.signals).toBeGreaterThan(0);
    expect(by["aws-spot-advisor"]!.signals).toBeGreaterThan(0);

    const regions = [...store.entities.values()].filter((e) => e.type === "region");
    expect(
      regions.every(
        (e) => e.location_precision === "region_centroid" || e.location_precision === "unknown",
      ),
    ).toBe(true);
    const mwOnRegions = [...store.observations.values()].filter(
      (o) => o.metric.endsWith("_mw") && regions.some((r) => r.id === o.entity_id),
    );
    expect(mwOnRegions).toHaveLength(0);

    const launches = [...store.observations.values()].filter(
      (o) => o.effective_kind === "opened" && o.metric === "region_count",
    );
    expect(launches.length).toBeGreaterThan(20);
    expect(launches.some((o) => o.effective_date === "2006-08-25")).toBe(true);

    const epoch = [...store.observations.values()].filter(
      (o) => o.method_id === "epoch-ai-satellite.v1",
    );
    expect(epoch.every((o) => o.claim_type === "derived")).toBe(true);
    const speculative = [...store.entities.values()].find((e) => e.name === "Goodnight");
    expect(speculative).toBeDefined();
    expect(
      [...store.observations.values()]
        .filter((o) => o.entity_id === speculative!.id)
        .every((o) => o.review_status === "pending"),
    ).toBe(true);

    const scope = store.review.get("rev_gcp_scope_us-east7");
    expect(scope).toBeDefined();
    expect(scope!.resolved_at).not.toBeNull();
    expect(scope!.resolution).toMatch(/pre-launch/);
    expect(store.fetchRuns.filter((r) => r.ok)).toHaveLength(scheduled.length);
  });

  test("a second run over unchanged input adds nothing", async () => {
    const first = await runAdapters(scheduled, {
      db,
      dataRoot: DATA,
      dataset: "live",
      cacheDir: cache,
      now: fixedNow,
      fetchDefaults: fast,
      fetchImpl: fakeFetch(),
    });
    const before = {
      obs: first.store.observations.size,
      sig: first.store.signalIds.size,
      ent: first.store.entities.size,
    };
    const second = await runAdapters(scheduled, {
      db,
      dataRoot: DATA,
      dataset: "live",
      cacheDir: cache,
      now: fixedNow,
      fetchDefaults: fast,
      fetchImpl: fakeFetch(),
    });
    expect(second.outcomes.every((o) => o.ok)).toBe(true);
    expect(
      second.outcomes.every((o) => o.result!.observations === 0 && o.result!.signals === 0),
    ).toBe(true);
    expect(second.store.observations.size).toBe(before.obs);
    expect(second.store.signalIds.size).toBe(before.sig);
    expect(second.store.entities.size).toBe(before.ent);
    expect(second.store.fetchRuns.filter((r) => r.ok)).toHaveLength(scheduled.length * 2);
    expect(second.store.fetchRuns.slice(-scheduled.length).every((r) => r.changed === false)).toBe(
      true,
    );
  });

  test("one failing source does not stop the others and keeps earlier data", async () => {
    await runAdapters(scheduled, {
      db,
      dataRoot: DATA,
      dataset: "live",
      cacheDir: cache,
      now: fixedNow,
      fetchDefaults: fast,
      fetchImpl: fakeFetch(),
    });
    const broken = fakeFetch({ "https://epoch.ai/": () => new Response("gone", { status: 500 }) });
    const { store, outcomes } = await runAdapters(scheduled, {
      db,
      dataRoot: DATA,
      dataset: "live",
      cacheDir: cache,
      now: fixedNow,
      fetchDefaults: fast,
      fetchImpl: broken,
    });
    const epoch = outcomes.find((o) => o.adapter === "epoch-ai")!;
    expect(epoch.ok).toBe(false);
    expect(epoch.error).toMatch(/500/);
    expect(outcomes.filter((o) => o.ok)).toHaveLength(scheduled.length - 1);
    const failed = store.fetchRuns.filter((r) => r.adapter === "epoch-ai" && !r.ok);
    expect(failed).toHaveLength(1);
    expect(failed[0]!.http_status).toBe(500);
    expect(
      [...store.observations.values()].some((o) => o.method_id === "epoch-ai-satellite.v1"),
    ).toBe(true);
  });

  test("a changed page layout fails the adapter instead of writing junk", async () => {
    const bad = fakeFetch({
      "https://learn.microsoft.com/": () =>
        new Response("<html><table><tr><th>Nothing</th></tr></table></html>", { status: 200 }),
    });
    const { outcomes } = await runAdapters([adapterById("azure-regions") as Adapter], {
      db,
      dataRoot: DATA,
      dataset: "live",
      cacheDir: cache,
      now: fixedNow,
      fetchDefaults: fast,
      fetchImpl: bad,
    });
    expect(outcomes[0]!.ok).toBe(false);
    expect(outcomes[0]!.error).toMatch(/layout changed/);
  });

  test("adapters refuse hosts outside their allow list", async () => {
    const hijack = fakeFetch({
      "https://www.gstatic.com/ipranges/cloud.json": () =>
        new Response(JSON.stringify({ prefixes: [] }), { status: 200 }),
    });
    const sneaky: Adapter = {
      ...(adapterById("gcp-regions") as Adapter),
      id: "sneaky",
      hosts: ["docs.cloud.google.com"],
    };
    const { outcomes } = await runAdapters([sneaky], {
      db,
      dataRoot: DATA,
      dataset: "live",
      cacheDir: cache,
      now: fixedNow,
      fetchDefaults: fast,
      fetchImpl: hijack,
    });
    expect(outcomes[0]!.ok).toBe(false);
    expect(outcomes[0]!.error).toMatch(/not allowed/);
  });
});

const ROW = {
  provider_slug: "aws",
  entity_type: "campus",
  entity_name: "Test campus",
  parent_entity: "",
  country_code: "US",
  admin_area: "Oregon",
  locality: "Boardman",
  lat: "",
  lon: "",
  location_precision: "",
  metric: "facility_power_mw",
  value: "100",
  value_low: "",
  value_high: "",
  value_original: "100 MW",
  status: "operational",
  scope: "campus",
  ownership: "owned",
  landlord: "",
  effective_date: "2025-06",
  effective_date_kind: "as_of",
  claim_type: "reported",
  source_tier: "1",
  source_publisher: "Test",
  source_title: "Test page",
  source_url: "https://example.com/page",
  source_published_date: "2025-06-01",
  excerpt: "a 100 MW campus",
  notes: "",
};

describe("csv import validation", () => {
  test("a clean row validates", () => {
    expect(validateRow(ROW)).toEqual([]);
  });
  test("each broken field is reported", () => {
    expect(validateRow({ ...ROW, provider_slug: "nope" })).toContainEqual(
      expect.stringMatching(/unknown provider/),
    );
    expect(validateRow({ ...ROW, metric: "power" })).toContainEqual(
      expect.stringMatching(/unknown metric/),
    );
    expect(validateRow({ ...ROW, value: "", value_low: "", value_high: "" })).toContainEqual(
      expect.stringMatching(/value or both bounds/),
    );
    expect(validateRow({ ...ROW, value: "", value_low: "200", value_high: "100" })).toContainEqual(
      expect.stringMatching(/value_low above/),
    );
    expect(validateRow({ ...ROW, status: "maybe" })).toContainEqual(
      expect.stringMatching(/bad status/),
    );
    expect(validateRow({ ...ROW, effective_date: "June 2025" })).toContainEqual(
      expect.stringMatching(/bad effective_date/),
    );
    expect(validateRow({ ...ROW, source_url: "http://example.com" })).toContainEqual(
      expect.stringMatching(/https/),
    );
    expect(validateRow({ ...ROW, claim_type: "derived", notes: "" })).toContainEqual(
      expect.stringMatching(/derived rows need notes/),
    );
    expect(validateRow({ ...ROW, lat: "45.8" })).toContainEqual(
      expect.stringMatching(/lat and lon/),
    );
  });

  test("import resolves places, merges same-named sites, and queues bad rows", async () => {
    const store = await Store.open(db, "live");
    await ensureMethods(store);
    const geo = loadGeo(DATA);
    const ctx = {
      store,
      dataset: "live" as const,
      now: fixedNow,
      geo: geo.regions,
      places: geo.places,
      fetch: async () => {
        throw new Error("no fetch");
      },
    };
    const cols = Object.keys(ROW);
    const rows = [
      ROW,
      {
        ...ROW,
        entity_name: "AWS Test campus",
        metric: "land_area_acres",
        value: "1000",
        value_original: "1,000 acres",
      },
      {
        ...ROW,
        entity_name: "Test campus phase 2",
        metric: "facility_power_mw",
        value: "50",
        value_original: "50 MW",
        status: "under_construction",
      },
      { ...ROW, status: "bogus" },
    ];
    const csv = [
      cols.join(","),
      ...rows.map((r) => cols.map((c) => `"${(r as Record<string, string>)[c] ?? ""}"`).join(",")),
    ].join("\n");
    const file = join(cache, "test.csv");
    writeFileSync(file, csv);
    const result = await importCsv(ctx, file, "csv-import");
    expect(result.observations).toBe(3);
    expect(result.review).toBe(2);
    const campuses = [...store.entities.values()].filter((e) => e.type === "campus");
    expect(campuses.map((c) => c.name).sort()).toEqual(["Test campus", "Test campus phase 2"]);
    const main = campuses.find((c) => c.name === "Test campus")!;
    expect(main.location_precision).toBe("locality");
    expect(main.lat).toBeCloseTo(45.84, 1);
    const dup = [...store.review.values()].find((r) => r.reason.includes("may be the same site"));
    expect(dup).toBeDefined();
    const again = await importCsv(ctx, file, "csv-import");
    expect(again.observations).toBe(0);
  });
});

describe("regions that appear after the seed run", () => {
  test("regions imported from CSV before the first adapter run get no first-seen date", async () => {
    const store = await Store.open(db, "live");
    await ensureMethods(store);
    const geo = loadGeo(DATA);
    const ctx = {
      store,
      dataset: "live" as const,
      now: fixedNow,
      geo: geo.regions,
      places: geo.places,
      fetch: async () => {
        throw new Error("no fetch");
      },
    };
    await importCsv(ctx, join(DATA, "imports", "region-launches.csv"), "csv-import");
    await store.flush();
    expect([...store.entities.values()].some((e) => e.type === "region")).toBe(true);
    const { store: after } = await runAdapters([adapterById("gcp-regions") as Adapter], {
      db,
      dataRoot: DATA,
      dataset: "live",
      cacheDir: cache,
      now: fixedNow,
      fetchDefaults: fast,
      fetchImpl: fakeFetch(),
    });
    const dated = [...after.observations.values()].filter((o) => o.method_id === "first-seen.v1");
    expect(dated).toHaveLength(0);
  });

  test("a new region code gets a first-seen launch date; the seed run records none", async () => {
    const gcp = adapterById("gcp-regions") as Adapter;
    const first = await runAdapters([gcp], {
      db,
      dataRoot: DATA,
      dataset: "live",
      cacheDir: cache,
      now: fixedNow,
      fetchDefaults: fast,
      fetchImpl: fakeFetch(),
    });
    const firstSeen = (s: Store) =>
      [...s.observations.values()].filter((o) => o.method_id === "first-seen.v1");
    expect(firstSeen(first.store)).toHaveLength(0);

    const page = readFileSync(join(FIX, "gcp-zones.html"), "utf8");
    const extra = `<tr><td>europe-west99-a</td><td>Nowhere, Atlantis</td><td>E2</td><td>Intel</td><td></td><td></td></tr></table>`;
    const grown = fakeFetch({
      "https://docs.cloud.google.com/compute/docs/regions-zones": () =>
        new Response(page.replace("</table>", extra), { status: 200 }),
    });
    const later = () => new Date("2026-10-12T09:00:00Z");
    const second = await runAdapters([gcp], {
      db,
      dataRoot: DATA,
      dataset: "live",
      cacheDir: cache,
      now: later,
      fetchDefaults: fast,
      fetchImpl: grown,
    });
    const seen = firstSeen(second.store);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.effective_date).toBe("2026-10-12");
    expect(seen[0]!.effective_kind).toBe("opened");
    expect(seen[0]!.claim_type).toBe("derived");
    const region = second.store.entities.get(seen[0]!.entity_id)!;
    expect(region.code).toBe("europe-west99");
    const third = await runAdapters([gcp], {
      db,
      dataRoot: DATA,
      dataset: "live",
      cacheDir: cache,
      now: later,
      fetchDefaults: fast,
      fetchImpl: grown,
    });
    expect(firstSeen(third.store)).toHaveLength(1);
  });
});
