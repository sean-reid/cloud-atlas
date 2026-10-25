import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { importCsv } from "../../pipeline/adapters/csv-import";
import {
  gcpSites,
  INDEX_URL,
  pageTitle,
  parseCards,
  parseIndex,
  parseInvestmentFigure,
  type GcpSiteReview,
} from "../../pipeline/adapters/gcp-sites";
import type { SqliteDb } from "../../pipeline/db";
import { fixtureFetch } from "../../pipeline/fixtures";
import { loadGeo } from "../../pipeline/geo";
import { ensureMethods } from "../../pipeline/methods";
import { runAdapters } from "../../pipeline/run";
import { Store } from "../../pipeline/store";
import { DATA, FIX, fast, fixedNow, memoryDb } from "./helpers";

const IOWA = "https://datacenters.google/locations/iowa/";
const OREGON = "https://datacenters.google/locations/oregon/";
const LENOIR = "https://datacenters.google/locations/north-carolina/";

const page = (name: string) => readFileSync(join(FIX, name), "utf8");

let cache = "";
let db: SqliteDb;
beforeEach(async () => {
  cache = mkdtempSync(join(tmpdir(), "ca-gcp-sites-"));
  db = await memoryDb();
});
afterEach(async () => {
  rmSync(cache, { recursive: true, force: true });
  await db.close();
});

const run = (fetchImpl = fixtureFetch(FIX)) =>
  runAdapters([gcpSites], {
    db,
    dataRoot: DATA,
    dataset: "live",
    cacheDir: cache,
    now: fixedNow,
    fetchDefaults: fast,
    fetchImpl,
  });

async function importGoogleSites(): Promise<void> {
  const geo = loadGeo(DATA);
  const store = await Store.open(db, "live");
  await ensureMethods(store);
  await importCsv(
    {
      store,
      dataset: "live",
      now: fixedNow,
      geo: geo.regions,
      places: geo.places,
      fetch: async () => {
        throw new Error("no fetch");
      },
    },
    join(DATA, "imports", "gcp.csv"),
    "csv-import",
  );
  await store.flush();
}

describe("parsing the recorded Google location pages", () => {
  test("the index maps each page to the localities it covers", () => {
    const pages = parseIndex(page("gcp-locations.html"));
    expect([...pages.keys()].sort()).toEqual([IOWA, LENOIR, OREGON]);
    expect(pages.get(IOWA)).toEqual(["Cedar Rapids, Iowa", "Council Bluffs, Iowa"]);
    expect(pages.get(OREGON)).toEqual(["The Dalles, Oregon"]);
    expect(parseIndex("<html><body>nothing</body></html>").size).toBe(0);
  });

  test("titles drop the site suffix and cards keep label, figure, and prose", () => {
    expect(pageTitle(page("gcp-location-iowa.html"))).toBe("Iowa");
    expect(pageTitle(page("gcp-location-oregon.html"))).toBe("The Dalles, Oregon");
    const cards = parseCards(page("gcp-location-iowa.html"));
    expect(cards).toHaveLength(5);
    expect(cards[0]).toEqual({
      label: "Investment to date",
      figure: "$20B+",
      prose:
        "Google has invested more than $20 billion in Iowa since building our data center in Council Bluffs in 2007.",
    });
    expect(cards[1]).toMatchObject({ label: "Established in Iowa", figure: "2007" });
  });

  test("investment figures parse with currency and lower bound", () => {
    expect(parseInvestmentFigure("$20B+")).toEqual({ usd: true, value: 20e9, lowerBound: true });
    expect(parseInvestmentFigure("$1.6B+")).toEqual({ usd: true, value: 1.6e9, lowerBound: true });
    expect(parseInvestmentFigure("US$5B")).toEqual({ usd: true, value: 5e9, lowerBound: false });
    expect(parseInvestmentFigure("$6B", "Google has invested more than $6 billion")).toEqual({
      usd: true,
      value: 6e9,
      lowerBound: true,
    });
    expect(parseInvestmentFigure("€600 million")).toEqual({
      usd: false,
      value: 600e6,
      lowerBound: false,
    });
    expect(parseInvestmentFigure("£5B")?.usd).toBe(false);
    expect(parseInvestmentFigure("2007")).toBeNull();
    expect(parseInvestmentFigure("153K+")).toBeNull();
  });
});

describe("gcp-sites adapter", () => {
  test("creates a campus per single-city page and holds the state page for review", async () => {
    const { store, outcomes } = await run();
    expect(outcomes[0]!.ok, outcomes[0]!.error ?? "").toBe(true);
    expect(outcomes[0]!.result).toEqual({ observations: 2, entities: 2, signals: 0, review: 1 });

    const campuses = [...store.entities.values()].filter((e) => e.type === "campus");
    expect(campuses.map((c) => c.name).sort()).toEqual([
      "Google Lenoir campus",
      "Google The Dalles campus",
    ]);
    const dalles = campuses.find((c) => c.name === "Google The Dalles campus")!;
    expect(dalles).toMatchObject({
      provider_slug: "gcp",
      country_code: "US",
      admin_area: "OR",
      locality: "The Dalles",
      lat: 45.59,
      lon: -121.18,
      location_precision: "locality",
    });
    expect(store.entities.get(dalles.parent_id!)!.type).toBe("provider");

    const obs = [...store.observations.values()].filter((o) => o.entity_id === dalles.id);
    expect(obs).toHaveLength(1);
    expect(obs[0]).toMatchObject({
      metric: "investment_usd",
      value: 7e9,
      value_low: 7e9,
      value_high: null,
      unit: "USD",
      value_original: "$7B+",
      status: "operational",
      scope: "campus",
      claim_type: "reported",
      effective_date: "2026-10-09",
      effective_precision: "day",
      effective_kind: "as_of",
      locator: OREGON,
      review_status: "accepted",
      notes: "Established 2006 per the page's stat card.",
    });
    expect(obs[0]!.excerpt).toMatch(/^Google has invested more than \$7 billion in Oregon/);
    const source = store.sources.get(obs[0]!.source_id)!;
    expect(source).toMatchObject({ url: INDEX_URL, tier: 1, adapter: "gcp-sites" });

    const lenoir = [...store.observations.values()].find(
      (o) => o.entity_id === campuses.find((c) => c.name === "Google Lenoir campus")!.id,
    )!;
    expect(lenoir).toMatchObject({ value: 4e9, value_low: 4e9, locator: LENOIR });

    const item = store.review.get("rev_gcp-sites_iowa")!;
    expect(item.resolved_at).toBeNull();
    expect(item.reason).toBe(
      'Google Iowa: "$20B+" (Investment to date); one figure for Cedar Rapids, Iowa, Council Bluffs, Iowa',
    );
    const payload = JSON.parse(item.payload) as GcpSiteReview;
    expect(payload).toMatchObject({
      page: IOWA,
      figure: "$20B+",
      value: 20e9,
      usd: true,
      lower_bound: true,
      established: "2007",
      localities: ["Cedar Rapids, Iowa", "Council Bluffs, Iowa"],
      places_named: ["Council Bluffs, IA, US"],
      proposed: null,
    });
    expect(payload.excerpt).toMatch(/Council Bluffs in 2007/);
    expect([...store.review.values()].filter((r) => r.adapter === "gcp-sites")).toHaveLength(1);
  });

  test("attaches to the reviewed campus when the import already tracks it", async () => {
    await importGoogleSites();
    const before = [...(await Store.open(db, "live")).entities.values()].find(
      (e) => e.name === "Google The Dalles campus",
    )!;
    const { store, outcomes } = await run();
    expect(outcomes[0]!.result).toEqual({ observations: 2, entities: 0, signals: 0, review: 1 });
    const dalles = [...store.entities.values()].filter(
      (e) => e.name === "Google The Dalles campus",
    );
    expect(dalles).toHaveLength(1);
    expect(dalles[0]!.id).toBe(before.id);
    expect(
      [...store.observations.values()].some(
        (o) => o.entity_id === before.id && o.locator === OREGON,
      ),
    ).toBe(true);
  });

  test("a second run on the same day adds nothing", async () => {
    const first = await run();
    const second = await run();
    expect(second.outcomes[0]!.result).toEqual({
      observations: 0,
      entities: 0,
      signals: 0,
      review: 0,
    });
    expect(second.store.observations.size).toBe(first.store.observations.size);
    expect(second.store.entities.size).toBe(first.store.entities.size);
    expect(second.store.review.size).toBe(first.store.review.size);
  });

  test("one missing page does not stop the others; every page missing fails the run", async () => {
    const partial = fixtureFetch(FIX, { [OREGON]: () => new Response("gone", { status: 404 }) });
    const { store, outcomes } = await run(partial);
    expect(outcomes[0]!.ok).toBe(true);
    expect(outcomes[0]!.result!.observations).toBe(1);
    expect([...store.entities.values()].some((e) => e.name === "Google Lenoir campus")).toBe(true);

    const gone = () => new Response("gone", { status: 404 });
    const none = fixtureFetch(FIX, { [IOWA]: gone, [OREGON]: gone, [LENOIR]: gone });
    const failed = await run(none);
    expect(failed.outcomes[0]!.ok).toBe(false);
    expect(failed.outcomes[0]!.error).toMatch(/every location page failed/);
  });

  test("an index without the location list fails instead of writing nothing quietly", async () => {
    const bare = fixtureFetch(FIX, {
      "https://datacenters.google/locations/": () =>
        new Response("<html><body><h1>Locations</h1></body></html>", { status: 200 }),
    });
    const { outcomes } = await run(bare);
    expect(outcomes[0]!.ok).toBe(false);
    expect(outcomes[0]!.error).toMatch(/layout changed/);
  });
});
