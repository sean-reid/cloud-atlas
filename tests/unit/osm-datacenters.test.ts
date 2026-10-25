import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { importCsv } from "../../pipeline/adapters/csv-import";
import {
  CAMPUS_KM,
  CLUSTER_KM,
  distanceKm,
  facilityName,
  FALLBACK_URL,
  ODBL,
  OSM_USER_AGENT,
  osmDatacenters,
  OVERPASS_URL,
  parseOverpass,
  providerFor,
  queryUrl,
  statusFor,
  type ItPowerReview,
} from "../../pipeline/adapters/osm-datacenters";
import type { SqliteDb } from "../../pipeline/db";
import { fixtureFetch } from "../../pipeline/fixtures";
import { loadGeo } from "../../pipeline/geo";
import { ensureMethods } from "../../pipeline/methods";
import { runAdapters } from "../../pipeline/run";
import { Store } from "../../pipeline/store";
import type { Entity } from "../../shared/types";
import { DATA, FIX, fast, fixedNow, memoryDb } from "./helpers";

const body = readFileSync(join(FIX, "osm-datacenters.json"), "utf8");
const objects = parseOverpass(body);
const object = (key: string) => objects.find((o) => `${o.type}/${o.id}` === key)!;

let cache = "";
let db: SqliteDb;
beforeEach(async () => {
  cache = mkdtempSync(join(tmpdir(), "ca-osm-"));
  db = await memoryDb();
});
afterEach(async () => {
  rmSync(cache, { recursive: true, force: true });
  await db.close();
});

// The reviewed CSVs seed the campuses the fixture's Boardman, Hamina, Dublin, Fredericia,
// New Albany and Middenmeer buildings attach to.
async function seedImports() {
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
  const dir = join(DATA, "imports");
  for (const f of readdirSync(dir)
    .filter((f) => f.endsWith(".csv"))
    .sort())
    await importCsv(ctx, join(dir, f), "csv-import");
  await store.flush();
}

const run = (fetchImpl = fixtureFetch(FIX), now = fixedNow) =>
  runAdapters([osmDatacenters], {
    db,
    dataRoot: DATA,
    dataset: "live",
    cacheDir: cache,
    now,
    fetchDefaults: fast,
    fetchImpl,
  });

const osmEntities = (store: Store) =>
  [...store.entities.values()].filter((e) => e.slug.startsWith("osm-"));
const bySlug = (store: Store, slug: string): Entity => {
  const e = osmEntities(store).find((x) => x.slug === slug);
  if (!e) throw new Error(`no entity ${slug}`);
  return e;
};
const parentOf = (store: Store, slug: string): Entity =>
  store.entities.get(bySlug(store, slug).parent_id!)!;

describe("operator mapping", () => {
  test("operator text maps to a provider slug and anything else is skipped", () => {
    expect(providerFor("Amazon Web Services")).toBe("aws");
    expect(providerFor("amazon web services")).toBe("aws");
    expect(providerFor("AWS")).toBe("aws");
    expect(providerFor("Microsoft")).toBe("azure");
    expect(providerFor("Google LLC")).toBe("gcp");
    expect(providerFor("Aliyun")).toBe("alibaba");
    expect(providerFor("IBM")).toBe("ibm");
    expect(providerFor("Nebius")).toBe("nebius");
    expect(providerFor("Equinix")).toBeNull();
    expect(providerFor("Laws and Partners")).toBeNull();
    expect(providerFor(undefined)).toBeNull();
  });

  test("the recorded fixture spans five providers", () => {
    const slugs = new Set(objects.map((o) => providerFor(o.tags.operator)));
    expect([...slugs].sort()).toEqual(["aws", "azure", "gcp", "ibm", "nebius"]);
  });
});

describe("parsing the recorded Overpass response", () => {
  test("reads nodes, ways and relations at their centre, sorted by type and id", () => {
    expect(objects).toHaveLength(28);
    expect(objects[0]).toMatchObject({ type: "node", id: 11902288339 });
    expect(objects.filter((o) => o.type === "relation").map((o) => o.id)).toEqual([
      1604367, 4510018,
    ]);
    const iad78 = object("way/463571875");
    expect(iad78.lat).toBeCloseTo(39.0264, 3);
    expect(iad78.lon).toBeCloseTo(-77.4495, 3);
    expect(iad78.tags.ref).toBe("IAD-78");
  });

  test("a body that is not an Overpass result fails the run", () => {
    expect(() => parseOverpass("<html>busy</html>")).toThrow(/not JSON/);
    expect(() => parseOverpass('{"remark":"runtime error"}')).toThrow(/no elements/);
    expect(parseOverpass('{"elements":[{"type":"way","id":1,"tags":{}}]}')).toEqual([]);
  });

  test("names come from the name tag, then the ref, then the id", () => {
    expect(facilityName("aws", object("way/463571875"))).toBe("Amazon IAD-78");
    expect(facilityName("gcp", object("way/323686447"))).toBe("Google LPP");
    expect(facilityName("azure", object("way/546153676"))).toBe("Azure facility 546153676");
  });

  test("status follows the construction and disuse tags", () => {
    expect(statusFor({})).toBe("operational");
    expect(statusFor({ landuse: "construction" })).toBe("under_construction");
    expect(statusFor({ construction: "yes" })).toBe("under_construction");
    expect(statusFor({ building: "construction" })).toBe("under_construction");
    expect(statusFor({ "disused:telecom": "data_center" })).toBe("decommissioned");
    expect(statusFor({ abandoned: "yes" })).toBe("decommissioned");
    expect(statusFor(object("way/1088665595").tags)).toBe("under_construction");
  });
});

describe("osm-datacenters adapter", () => {
  test("places every building and attaches it to an existing, a new, or no campus", async () => {
    await seedImports();
    const { store, outcomes } = await run();
    expect(outcomes[0]!.ok, outcomes[0]!.error ?? "").toBe(true);
    expect(outcomes[0]!.result).toEqual({ observations: 34, entities: 33, signals: 0, review: 5 });
    const osm = osmEntities(store);
    expect(osm.filter((e) => e.type === "facility")).toHaveLength(28);
    expect(
      osm
        .filter((e) => e.type === "campus")
        .map((e) => e.name)
        .sort(),
    ).toEqual([
      "AWS Ashburn campus",
      "AWS Sterling campus",
      "Azure San Antonio campus",
      "Azure Singapore campus",
      "IBM Seclin campus",
    ]);

    const pdx91 = bySlug(store, "osm-way-914613836");
    expect(pdx91).toMatchObject({
      type: "facility",
      provider_slug: "aws",
      country_code: "US",
      locality: "Boardman",
      location_precision: "exact",
      ownership: "owned",
    });
    const boardman = parentOf(store, "osm-way-914613836");
    expect(boardman.name).toMatch(/^AWS Boardman/);
    expect(boardman.slug.startsWith("osm-")).toBe(false);
    expect(distanceKm(pdx91.lat!, pdx91.lon!, boardman.lat!, boardman.lon!)).toBeLessThan(
      CAMPUS_KM,
    );
    expect(parentOf(store, "osm-way-323686447").name).toBe("Google Hamina campus");
    expect(parentOf(store, "osm-relation-4510018").name).toBe("Google Hamina campus");
    expect(parentOf(store, "osm-way-926894444").name).toMatch(/^AWS Cruiserath Road/);
    expect(parentOf(store, "osm-way-957632961").name).toBe("Microsoft Middenmeer campus");
    expect(parentOf(store, "osm-way-844391358").name).toBe("Google New Albany campus");

    const iad78 = object("way/463571875");
    const ashburn = parentOf(store, "osm-way-463571875");
    expect(ashburn).toMatchObject({
      type: "campus",
      provider_slug: "aws",
      name: "AWS Ashburn campus",
      locality: "Ashburn",
      admin_area: "VA",
      country_code: "US",
      lat: iad78.lat,
      lon: iad78.lon,
      location_precision: "locality",
    });
    expect(store.entities.get(ashburn.parent_id!)!.type).toBe("provider");
    expect(parentOf(store, "osm-way-463571876").id).toBe(ashburn.id);
    expect(parentOf(store, "osm-way-556599693").id).toBe(ashburn.id);
    const sterling = parentOf(store, "osm-way-697020849");
    expect(sterling.name).toBe("AWS Sterling campus");
    expect(parentOf(store, "osm-way-697020850").id).toBe(sterling.id);
    expect(distanceKm(ashburn.lat!, ashburn.lon!, sterling.lat!, sterling.lon!)).toBeGreaterThan(
      CLUSTER_KM,
    );

    for (const slug of [
      "osm-way-410408073",
      "osm-way-410408074",
      "osm-node-11902288339",
      "osm-way-1553894888",
      "osm-relation-1604367",
    ]) {
      expect(bySlug(store, slug).locality, slug).toBeNull();
      expect(parentOf(store, slug).type, slug).toBe("provider");
    }
    expect(bySlug(store, "osm-node-11902288339").country_code).toBe("GB");
    expect(bySlug(store, "osm-way-546153676").country_code).toBe("SG");
    expect(bySlug(store, "osm-way-125557451").country_code).toBe("FR");
    expect(bySlug(store, "osm-way-436766762").country_code).toBe("DK");
    expect(bySlug(store, "osm-way-1088665595").country_code).toBe("NZ");
  });

  test("writes a dated building count, an opening when tagged, and never a power figure", async () => {
    await seedImports();
    const { store } = await run();
    const source = [...store.sources.values()].find((s) => s.adapter === "osm-datacenters")!;
    expect(source).toMatchObject({
      publisher: "OpenStreetMap contributors",
      title: "OpenStreetMap telecom=data_center objects via Overpass",
      url: "https://www.openstreetmap.org/copyright",
      tier: 3,
      license: ODBL,
    });
    const iad78 = bySlug(store, "osm-way-463571875");
    const obs = [...store.observations.values()]
      .filter((o) => o.entity_id === iad78.id)
      .sort((a, b) => a.effective_kind.localeCompare(b.effective_kind));
    expect(obs).toHaveLength(2);
    expect(obs[0]).toMatchObject({
      metric: "building_count",
      value: 1,
      unit: "buildings",
      status: "operational",
      scope: "facility",
      claim_type: "reported",
      effective_date: "2026-10-09",
      effective_precision: "day",
      effective_kind: "as_of",
      source_id: source.id,
      excerpt: "operator=Amazon Web Services; name=Amazon IAD-78; ref=IAD-78",
      locator: "https://www.openstreetmap.org/way/463571875",
      method_id: null,
      review_status: "accepted",
    });
    expect(obs[0]!.notes).toMatch(/operator, not the owner/);
    expect(obs[1]).toMatchObject({
      metric: "building_count",
      value: 1,
      status: "operational",
      effective_date: "2019",
      effective_precision: "year",
      effective_kind: "opened",
      excerpt: "operator=Amazon Web Services; name=Amazon IAD-78; ref=IAD-78; start_date=2019",
    });

    const fredericia = bySlug(store, "osm-way-436766762");
    expect(
      [...store.observations.values()].find(
        (o) => o.entity_id === fredericia.id && o.effective_kind === "opened",
      ),
    ).toMatchObject({ effective_date: "2020-11-30", effective_precision: "day" });

    const building = bySlug(store, "osm-way-1281982556");
    expect(
      [...store.observations.values()].filter((o) => o.entity_id === building.id),
    ).toMatchObject([{ status: "under_construction", effective_kind: "as_of" }]);

    const all = [...store.observations.values()].filter((o) => o.source_id === source.id);
    expect(all).toHaveLength(34);
    expect(all.every((o) => o.metric === "building_count" && o.value === 1)).toBe(true);
    expect(all.filter((o) => o.effective_kind === "opened")).toHaveLength(6);
    expect(all.some((o) => o.metric.endsWith("_mw"))).toBe(false);
  });

  test("an it_power tag queues one review item with the tag, the object and the facility", async () => {
    await seedImports();
    const { store } = await run();
    const items = [...store.review.values()].filter((r) => r.adapter === "osm-datacenters");
    expect(items).toHaveLength(5);
    expect(items.every((r) => r.resolved_at === null)).toBe(true);
    const item = store.review.get("rev_osm-datacenters_way-463571875_it-power")!;
    expect(item.reason).toBe(
      'OSM way/463571875 "Amazon IAD-78" carries it_power=45 MW; transcribe it through data/imports or reject',
    );
    expect(JSON.parse(item.payload) as ItPowerReview).toEqual({
      object: "https://www.openstreetmap.org/way/463571875",
      entity: bySlug(store, "osm-way-463571875").id,
      name: "Amazon IAD-78",
      it_power: "45 MW",
      input_electricity: "45 MW",
    });
  });

  test("a rerun the next day adds nothing", async () => {
    await seedImports();
    const first = await run();
    const before = {
      observations: first.store.observations.size,
      entities: first.store.entities.size,
      review: first.store.review.size,
    };
    const second = await run(fixtureFetch(FIX), () => new Date("2026-10-10T09:00:00Z"));
    expect(second.outcomes[0]!.ok).toBe(true);
    expect(second.outcomes[0]!.result).toEqual({
      observations: 0,
      entities: 0,
      signals: 0,
      review: 0,
    });
    expect(second.store.observations.size).toBe(before.observations);
    expect(second.store.entities.size).toBe(before.entities);
    expect(second.store.review.size).toBe(before.review);
    expect(second.store.fetchRuns.at(-1)).toMatchObject({ ok: true, changed: false });
  });

  test("falls back to the second endpoint after a 429 and names the contact in its user agent", async () => {
    const calls: { url: string; agent: string }[] = [];
    const impl = (async (input: URL | string | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, agent: (init?.headers as Record<string, string>)["user-agent"] ?? "" });
      if (url.startsWith(OVERPASS_URL))
        return new Response("busy", { status: 429, headers: { "retry-after": "0" } });
      if (url.startsWith(FALLBACK_URL)) return new Response(body, { status: 200 });
      return new Response("not found", { status: 404 });
    }) as typeof fetch;
    const { store, outcomes } = await run(impl);
    expect(outcomes[0]!.ok, outcomes[0]!.error ?? "").toBe(true);
    expect(calls.filter((c) => c.url.startsWith(OVERPASS_URL))).toHaveLength(fast.retries + 1);
    expect(calls.at(-1)!.url).toBe(queryUrl(FALLBACK_URL));
    expect(new Set(calls.map((c) => c.agent))).toEqual(new Set([OSM_USER_AGENT]));
    expect(OSM_USER_AGENT).toContain("https://cloud-atlas.dwainosaur.com");
    expect(osmEntities(store).filter((e) => e.type === "facility")).toHaveLength(28);
  });

  test("a refusal from the primary is a failure, not a reason to try elsewhere", async () => {
    const calls: string[] = [];
    const impl = (async (input: URL | string | Request) => {
      calls.push(String(input));
      return new Response("forbidden", { status: 403 });
    }) as typeof fetch;
    const { outcomes } = await run(impl);
    expect(outcomes[0]!.ok).toBe(false);
    expect(outcomes[0]!.error).toMatch(/403/);
    expect(calls).toEqual([queryUrl(OVERPASS_URL)]);
  });
});
