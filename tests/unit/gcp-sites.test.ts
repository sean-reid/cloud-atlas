import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
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
import { ECB_URL } from "../../pipeline/fx";
import { loadGeo } from "../../pipeline/geo";
import { ensureMethods } from "../../pipeline/methods";
import { runAdapters } from "../../pipeline/run";
import { Store } from "../../pipeline/store";
import { DATA, FIX, fast, fixedNow, memoryDb } from "./helpers";

const IOWA = "https://datacenters.google/locations/iowa/";
const OREGON = "https://datacenters.google/locations/oregon/";
const LENOIR = "https://datacenters.google/locations/north-carolina/";
const HAMINA = "https://datacenters.google/locations/hamina-finland/";

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
    expect([...pages.keys()].sort()).toEqual([HAMINA, IOWA, LENOIR, OREGON]);
    expect(pages.get(IOWA)).toEqual(["Cedar Rapids, Iowa", "Council Bluffs, Iowa"]);
    expect(pages.get(OREGON)).toEqual(["The Dalles, Oregon"]);
    expect(pages.get(HAMINA)).toEqual(["Hamina, Finland"]);
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
    expect(pageTitle(page("gcp-location-hamina-finland.html"))).toBe("Hamina, Finland");
    expect(parseCards(page("gcp-location-hamina-finland.html"))[0]).toMatchObject({
      label: "Investment to date",
      figure: "€3.5B",
    });
  });

  test("investment figures parse with currency and lower bound", () => {
    const usd = { usd: true, currency: "USD" };
    expect(parseInvestmentFigure("$20B+")).toEqual({ ...usd, value: 20e9, lowerBound: true });
    expect(parseInvestmentFigure("$1.6B+")).toEqual({ ...usd, value: 1.6e9, lowerBound: true });
    expect(parseInvestmentFigure("US$5B")).toEqual({ ...usd, value: 5e9, lowerBound: false });
    expect(parseInvestmentFigure("$6B", "Google has invested more than $6 billion")).toEqual({
      ...usd,
      value: 6e9,
      lowerBound: true,
    });
    expect(parseInvestmentFigure("€600 million")).toEqual({
      usd: false,
      currency: "EUR",
      value: 600e6,
      lowerBound: false,
    });
    expect(parseInvestmentFigure("£5B")).toMatchObject({ usd: false, currency: "GBP" });
    expect(parseInvestmentFigure("¥100B")).toMatchObject({ usd: false, currency: "JPY" });
    expect(parseInvestmentFigure("2007")).toBeNull();
    expect(parseInvestmentFigure("153K+")).toBeNull();
  });
});

describe("gcp-sites adapter", () => {
  test("creates a campus per single-city page and holds the state page for review", async () => {
    const { store, outcomes } = await run();
    expect(outcomes[0]!.ok, outcomes[0]!.error ?? "").toBe(true);
    expect(outcomes[0]!.result).toEqual({ observations: 3, entities: 3, signals: 0, review: 1 });

    const campuses = [...store.entities.values()].filter((e) => e.type === "campus");
    expect(campuses.map((c) => c.name).sort()).toEqual([
      "Google Hamina campus",
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

    const hamina = campuses.find((c) => c.name === "Google Hamina campus")!;
    expect(hamina).toMatchObject({ country_code: "FI", locality: "Hamina", lat: 60.57, lon: 27.2 });
    const euro = [...store.observations.values()].find((o) => o.entity_id === hamina.id)!;
    expect(euro).toMatchObject({
      metric: "investment_usd",
      value: 3.92e9,
      value_low: null,
      unit: "USD",
      value_original: "€3.5B",
      claim_type: "derived",
      method_id: "fx-conversion.v1",
      derived_from: null,
      source_id: obs[0]!.source_id,
      locator: HAMINA,
      review_status: "accepted",
      notes: "EUR 3.5 billion at ECB reference rate 1.1193 USD per EUR on 2026-10-23",
    });
    expect(euro.excerpt).toMatch(/€3\.5 billion invested in the region to date/);
    const ecb = [...store.sources.values()].find((s) => s.url === ECB_URL)!;
    expect(ecb).toMatchObject({ publisher: "European Central Bank", tier: 1 });
    expect(ecb.license).toMatch(/ECB cited as the source/);

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
    expect(outcomes[0]!.result).toEqual({ observations: 3, entities: 0, signals: 0, review: 1 });
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
    expect(outcomes[0]!.result!.observations).toBe(2);
    expect([...store.entities.values()].some((e) => e.name === "Google Lenoir campus")).toBe(true);

    const gone = () => new Response("gone", { status: 404 });
    const none = fixtureFetch(FIX, {
      [IOWA]: gone,
      [OREGON]: gone,
      [LENOIR]: gone,
      [HAMINA]: gone,
    });
    const failed = await run(none);
    expect(failed.outcomes[0]!.ok).toBe(false);
    expect(failed.outcomes[0]!.error).toMatch(/every location page failed/);
  });

  test("a euro page waits for review when the ECB file is down, logged once", async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      lines.push(String(chunk));
      return true;
    });
    try {
      const down = fixtureFetch(FIX, { [ECB_URL]: () => new Response("down", { status: 503 }) });
      const { store, outcomes } = await run(down);
      expect(outcomes[0]!.ok, outcomes[0]!.error ?? "").toBe(true);
      expect(outcomes[0]!.result).toEqual({ observations: 2, entities: 2, signals: 0, review: 2 });
      expect([...store.entities.values()].some((e) => e.name === "Google Hamina campus")).toBe(
        false,
      );
      const item = store.review.get("rev_gcp-sites_hamina-finland")!;
      expect(item.resolved_at).toBeNull();
      expect(item.reason).toBe(
        'Google Hamina, Finland: "€3.5B" (Investment to date); "€3.5B" is not in US dollars',
      );
      const payload = JSON.parse(item.payload) as GcpSiteReview;
      expect(payload).toMatchObject({ page: HAMINA, value: 3.5e9, usd: false });
      expect(payload.proposed).toMatchObject({ name: "Google Hamina campus", country_code: "FI" });
      expect([...store.sources.values()].some((s) => s.url === ECB_URL)).toBe(false);
    } finally {
      spy.mockRestore();
    }
    expect(lines.filter((l) => l.includes('"event":"fx.unavailable"'))).toHaveLength(1);
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
