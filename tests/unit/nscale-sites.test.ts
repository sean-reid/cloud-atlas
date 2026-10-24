import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  countryCode,
  NSCALE_URL,
  nscaleSites,
  parseSections,
  sectionClaims,
  SITE_METHOD,
  type NscaleSiteReview,
} from "../../pipeline/adapters/nscale-sites";
import type { SqliteDb } from "../../pipeline/db";
import { fixtureFetch } from "../../pipeline/fixtures";
import { loadGeo } from "../../pipeline/geo";
import { runAdapters } from "../../pipeline/run";
import { DATA, FIX, fast, fixedNow, memoryDb } from "./helpers";

const html = readFileSync(join(FIX, "nscale-ai-infrastructure.html"), "utf8");
const geo = loadGeo(DATA);
const NARVIK_PROSE =
  "The data center is designed to deliver 230MW of capacity with plans to expand by an additional 290MW.";

let cache = "";
let db: SqliteDb;
beforeEach(async () => {
  cache = mkdtempSync(join(tmpdir(), "ca-nscale-"));
  db = await memoryDb();
});
afterEach(async () => {
  rmSync(cache, { recursive: true, force: true });
  await db.close();
});

const run = (fetchImpl = fixtureFetch(FIX)) =>
  runAdapters([nscaleSites], {
    db,
    dataRoot: DATA,
    dataset: "live",
    cacheDir: cache,
    now: fixedNow,
    fetchDefaults: fast,
    fetchImpl,
  });

const payloadOf = (p: string) => JSON.parse(p) as NscaleSiteReview;

describe("parsing the recorded Nscale page", () => {
  test("each site section gives a name, a country, and its prose", () => {
    const sections = parseSections(html);
    expect(sections.map((s) => [s.slug, s.name, s.country, s.countryCode])).toEqual([
      ["narvik", "Narvik", "Norway", "NO"],
      ["loughton", "Loughton", "United Kingdom", "GB"],
      ["texas", "Ward County", "Texas, United States", "US"],
    ]);
    expect(sections[0]!.id).toBe("dc-narvik");
    expect(sections[0]!.text).toContain(NARVIK_PROSE);
    expect(countryCode("TEXAS, UNITED STATES")).toBe("US");
    expect(countryCode("NORWAY")).toBe("NO");
    expect(countryCode("ATLANTIS")).toBeNull();
  });

  test("the real prose yields claims the rule cannot accept", () => {
    const [narvik, loughton, texas] = parseSections(html);
    const n = sectionClaims(narvik!, geo.places);
    expect(n.map((c) => [c.value, c.status, c.figures, c.place])).toEqual([
      [230, "announced", 2, null],
      [290, "announced", 2, null],
    ]);
    const l = sectionClaims(loughton!, geo.places);
    expect(l).toHaveLength(1);
    expect(l[0]).toMatchObject({ value: 90, status: "unknown", figures: 1 });
    const t = sectionClaims(texas!, geo.places);
    expect(t.map((c) => c.value)).toEqual([240, 1200]);
    expect(t.every((c) => c.place === null)).toBe(true);
  });
});

describe("nscale-sites adapter", () => {
  test("holds every recorded site for review with the sentence and the reason", async () => {
    const { store, outcomes } = await run();
    expect(outcomes[0]!.ok, outcomes[0]!.error ?? "").toBe(true);
    expect(outcomes[0]!.result).toEqual({ observations: 0, entities: 0, signals: 0, review: 3 });
    expect([...store.entities.values()].filter((e) => e.provider_slug === "nscale")).toHaveLength(
      0,
    );

    const narvik = store.review.get("rev_nscale-sites_narvik")!;
    expect(narvik.reason).toBe(
      'Nscale Narvik (Norway): "230MW": 2 figures in one sentence; "290MW": 2 figures in one sentence',
    );
    const np = payloadOf(narvik.payload);
    expect(np).toMatchObject({
      site: "Narvik",
      country: "Norway",
      place: "Narvik, NO",
      locator: `${NSCALE_URL}#dc-narvik`,
      sentences: [NARVIK_PROSE],
    });
    expect(np.claims).toHaveLength(2);
    expect(np.proposed).toMatchObject({
      type: "campus",
      provider: "nscale",
      name: "Nscale Narvik campus",
      country_code: "NO",
      location_precision: "locality",
    });

    const loughton = store.review.get("rev_nscale-sites_loughton")!;
    expect(loughton.reason).toBe('Nscale Loughton (United Kingdom): "90MW": no status word');
    expect(payloadOf(loughton.payload).place).toBe("Loughton, GB");

    const texas = store.review.get("rev_nscale-sites_texas")!;
    expect(texas.reason).toMatch(
      /^Nscale Ward County \(Texas, United States\): "240MW": 2 figures/,
    );
    const tp = payloadOf(texas.payload);
    expect(tp.place).toBeNull();
    expect(tp.proposed).toBeNull();
    expect(tp.sentences[0]).toMatch(/^Ward County is a roughly 240MW AI data center in West Texas/);
  });

  test("a one-figure sentence with a status word lands on a campus named from the heading", async () => {
    // The fixture is prettier-wrapped, so the sentence is matched across line breaks.
    const prose = new RegExp(
      NARVIK_PROSE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+"),
      "g",
    );
    const rewritten = html.replace(
      prose,
      "The data center is now operational with 230MW of capacity. A second data center in Narvik is under construction with 290MW.",
    );
    expect(rewritten).not.toBe(html);
    const fetchImpl = fixtureFetch(FIX, {
      [NSCALE_URL]: () => new Response(rewritten, { status: 200 }),
    });
    const { store, outcomes } = await run(fetchImpl);
    expect(outcomes[0]!.result).toEqual({ observations: 2, entities: 1, signals: 0, review: 2 });

    const campus = [...store.entities.values()].find((e) => e.name === "Nscale Narvik campus")!;
    expect(campus).toMatchObject({
      type: "campus",
      provider_slug: "nscale",
      country_code: "NO",
      locality: "Narvik",
      lat: 68.44,
      lon: 17.43,
      location_precision: "locality",
    });
    expect(store.entities.get(campus.parent_id!)).toMatchObject({
      type: "provider",
      provider_slug: "nscale",
    });

    const obs = [...store.observations.values()]
      .filter((o) => o.entity_id === campus.id)
      .sort((a, b) => a.value! - b.value!);
    expect(obs).toHaveLength(2);
    expect(obs[0]).toMatchObject({
      metric: "facility_power_mw",
      value: 230,
      unit: "MW",
      value_original: "230MW",
      status: "operational",
      scope: "campus",
      claim_type: "reported",
      effective_date: "2026-10-09",
      effective_precision: "day",
      effective_kind: "opened",
      excerpt: "The data center is now operational with 230MW of capacity.",
      locator: `${NSCALE_URL}#dc-narvik`,
      method_id: SITE_METHOD,
      review_status: "accepted",
    });
    expect(obs[1]).toMatchObject({
      value: 290,
      status: "under_construction",
      effective_kind: "as_of",
    });
    expect(store.sources.get(obs[0]!.source_id)!.url).toBe(NSCALE_URL);
    expect(store.methods.has(SITE_METHOD)).toBe(true);
    expect(store.review.has("rev_nscale-sites_narvik")).toBe(false);
    expect(store.review.has("rev_nscale-sites_loughton")).toBe(true);

    const again = await run(fetchImpl);
    expect(again.outcomes[0]!.result).toEqual({
      observations: 0,
      entities: 0,
      signals: 0,
      review: 0,
    });
  });

  test("a page without site sections fails the run", async () => {
    const { outcomes } = await run(
      fixtureFetch(FIX, {
        [NSCALE_URL]: () => new Response("<html><body><p>hello</p></body></html>", { status: 200 }),
      }),
    );
    expect(outcomes[0]!.ok).toBe(false);
    expect(outcomes[0]!.error).toMatch(/layout changed/);
  });
});
