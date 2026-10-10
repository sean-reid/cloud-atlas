import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { importCsv } from "../../pipeline/adapters/csv-import";
import {
  acceptFeedClaim,
  FEED_METHOD,
  FEEDS,
  newsFeeds,
  type FeedClaimPayload,
} from "../../pipeline/adapters/news-feeds";
import { autoAccept, extractClaims } from "../../pipeline/claims";
import type { SqliteDb } from "../../pipeline/db";
import { fixtureFetch } from "../../pipeline/fixtures";
import { loadGeo } from "../../pipeline/geo";
import { ensureMethods } from "../../pipeline/methods";
import { parseFeed, sentences, type FeedEntry } from "../../pipeline/rss";
import { runAdapters } from "../../pipeline/run";
import { Store } from "../../pipeline/store";
import type { ReviewItem } from "../../shared/types";
import { DATA, FIX, fast, fixedNow, memoryDb } from "./helpers";

const WEST_MEMPHIS =
  "https://blog.google/company-news/inside-google/company-announcements/google-american-innovation-arkansas/";
const ALABAMA =
  "https://blog.google/innovation-and-ai/infrastructure-and-cloud/global-network/alabama-investment-june-2026/";
const HORNDAL =
  "https://blog.google/innovation-and-ai/infrastructure-and-cloud/global-network/blue-yellow-and-green-google-invests-in-its-first-data-center-in-sweden/";
const WARSAW =
  "https://blogs.microsoft.com/on-the-issues/2025/02/27/trump-administration-ai-global-race/";
const WISCONSIN =
  "https://blogs.microsoft.com/on-the-issues/2025/09/18/made-in-wisconsin-the-worlds-most-powerful-ai-datacenter/";
const EDDIE_WU =
  "https://www.alizila.com/aliviews-eddie-wu-shares-alibabas-strategic-full-stack-ai-roadmap-at-the-2026-apsara-conference/";
const MOUNT_PLEASANT = "https://www.mtpleasantwi.gov/m/newsflash/home/detail/639";

const geo = loadGeo(DATA);
const feed = (file: string): FeedEntry[] => parseFeed(readFileSync(join(FIX, file), "utf8"));
const entry = (entries: FeedEntry[], link: string): FeedEntry =>
  entries.find((e) => e.link === link)!;
const claimsOf = (e: FeedEntry) =>
  sentences(`${e.title}. ${e.text}`).flatMap((s) => extractClaims(s, geo.places));
const payloadOf = (item: ReviewItem) => JSON.parse(item.payload) as FeedClaimPayload;

let cache = "";
let db: SqliteDb;
beforeEach(async () => {
  cache = mkdtempSync(join(tmpdir(), "ca-feeds-"));
  db = await memoryDb();
});
afterEach(async () => {
  rmSync(cache, { recursive: true, force: true });
  await db.close();
});

const run = (fetchImpl = fixtureFetch(FIX)) =>
  runAdapters([newsFeeds], {
    db,
    dataRoot: DATA,
    dataset: "live",
    cacheDir: cache,
    now: fixedNow,
    fetchDefaults: fast,
    fetchImpl,
  });

// The reviewed Google rows give the store the sites a feed sentence can land on.
async function importGoogleSites(): Promise<void> {
  const store = await Store.open(db, "live");
  await ensureMethods(store);
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
  await importCsv(ctx, join(DATA, "imports", "gcp.csv"), "csv-import");
  await store.flush();
}

describe("feed parsing and claim extraction on the recorded feeds", () => {
  test("Google's Keyword feed: one placed claim, one unplaced, one entry without a figure", () => {
    const entries = feed("feed-google-global-network.xml");
    expect(entries).toHaveLength(3);
    const wm = entry(entries, WEST_MEMPHIS);
    expect(wm.published).toBe("2025-10-02T20:30:00.000Z");
    expect(wm.text).not.toContain("<img");
    const claims = claimsOf(wm);
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({
      metric: "investment_usd",
      value: 4_000_000_000,
      value_original: "$4 billion",
      status: "announced",
      effective_kind: "announced",
      figures: 1,
    });
    expect(claims[0]!.place?.key).toBe("West Memphis, AR, US");
    expect(claims[0]!.sentence).toMatch(/^Google is announcing a new \$4 billion investment/);

    const alabama = claimsOf(entry(entries, ALABAMA));
    expect(alabama).toHaveLength(1);
    expect(alabama[0]!.value).toBe(1_500_000_000);
    expect(alabama[0]!.place).toBeNull();

    expect(claimsOf(entry(entries, HORNDAL))).toHaveLength(0);
  });

  test("a power figure and an investment figure in one sentence count as two figures", () => {
    const claims = extractClaims(
      "Google will build a 100 MW data center in West Memphis, Arkansas, backed by a $4 billion investment.",
      geo.places,
    );
    expect(claims.map((c) => c.metric).sort()).toEqual(["facility_power_mw", "investment_usd"]);
    expect(claims.every((c) => c.figures === 2 && c.place?.key === "West Memphis, AR, US")).toBe(
      true,
    );
    expect(claims.some((c) => autoAccept(c, 1))).toBe(false);
    const one = extractClaims(
      "Google will build a 100 MW data center in West Memphis, Arkansas.",
      geo.places,
    );
    expect(one).toHaveLength(1);
    expect(autoAccept(one[0]!, 1)).toBe(true);
  });

  test("Microsoft On the Issues: a placed investment and a post with several figures", () => {
    const entries = feed("feed-microsoft-on-the-issues.xml");
    expect(entries).toHaveLength(3);
    const warsaw = claimsOf(entry(entries, WARSAW));
    expect(warsaw).toHaveLength(1);
    expect(warsaw[0]).toMatchObject({ value: 700_000_000, status: "announced", figures: 1 });
    expect(warsaw[0]!.place?.key).toBe("Warsaw, PL");

    const wisconsin = claimsOf(entry(entries, WISCONSIN));
    expect(wisconsin.map((c) => c.value).sort((a, b) => a - b)).toEqual([
      3_300_000_000, 4_000_000_000, 7_000_000_000,
    ]);
    expect(wisconsin.every((c) => c.metric === "investment_usd" && c.place === null)).toBe(true);
    expect(wisconsin.filter((c) => c.figures === 2)).toHaveLength(2);
  });

  test("Alizila: a gigawatt target with no place reads as power with unknown status", () => {
    const entries = feed("feed-alizila.xml");
    const claims = claimsOf(entry(entries, EDDIE_WU));
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({
      metric: "facility_power_mw",
      value: 20_000,
      value_original: "20GW",
      status: "unknown",
      place: null,
    });
  });

  test("product announcement feeds carry no claims", () => {
    for (const file of [
      "feed-aws-whats-new.xml",
      "feed-aws-news-blog.xml",
      "feed-about-amazon.xml",
      "feed-google-cloud-blog.xml",
      "feed-microsoft-local.xml",
    ]) {
      const entries = feed(file);
      expect(entries.length, file).toBeGreaterThanOrEqual(2);
      for (const e of entries) expect(claimsOf(e), `${file}: ${e.title}`).toHaveLength(0);
    }
  });
});

describe("news-feeds adapter", () => {
  test("accepts a one-figure claim on a tracked site, queues the rest, records every entry", async () => {
    await importGoogleSites();
    const { store, outcomes } = await run();
    expect(outcomes[0]!.ok, outcomes[0]!.error ?? "").toBe(true);
    expect(outcomes[0]!.result!.observations).toBe(1);
    expect(outcomes[0]!.result!.entities).toBe(0);

    const obs = [...store.observations.values()].filter((o) => o.method_id === FEED_METHOD);
    expect(obs).toHaveLength(1);
    const site = store.entities.get(obs[0]!.entity_id)!;
    expect(site.name).toBe("Google West Memphis campus");
    expect(obs[0]).toMatchObject({
      metric: "investment_usd",
      value: 4_000_000_000,
      status: "announced",
      claim_type: "reported",
      effective_date: "2025-10-02",
      effective_precision: "day",
      locator: WEST_MEMPHIS,
      review_status: "accepted",
    });
    expect(obs[0]!.excerpt).toMatch(/located in West Memphis/);
    const source = store.sources.get(obs[0]!.source_id)!;
    expect(source.tier).toBe(1);
    expect(source.url).toBe(FEEDS.find((f) => f.id === "google-global-network")!.url);

    const queued = [...store.review.values()].filter((r) => r.adapter === "news-feeds");
    expect(queued).toHaveLength(7);
    expect(queued.every((r) => r.resolved_at === null)).toBe(true);
    const warsaw = queued.find((r) => payloadOf(r).link === WARSAW)!;
    const wp = payloadOf(warsaw);
    expect(wp.claim.value).toBe(700_000_000);
    expect(wp.published).toBe("2025-02-27T13:00:06.000Z");
    expect(wp.entity).toBeNull();
    expect(wp.proposed).toMatchObject({
      type: "campus",
      provider: "azure",
      name: "Microsoft Warsaw campus",
      country_code: "PL",
      lat: 52.23,
      lon: 21.01,
      location_precision: "locality",
    });
    expect(warsaw.reason).toMatch(/\$700 million.*no site tracked there/);
    const eddie = queued.find((r) => payloadOf(r).link === EDDIE_WU)!;
    expect(payloadOf(eddie).proposed).toBeNull();
    expect(payloadOf(eddie).claim.metric).toBe("facility_power_mw");

    expect(store.feedItems.size).toBe(20);
    expect(store.feedItems.get(HORNDAL)!.outcome).toBe("ignored");
    expect(store.feedItems.get(MOUNT_PLEASANT)!.outcome).toBe("ignored");
    expect(store.feedItems.get(WEST_MEMPHIS)!.outcome).toBe("accepted");
    expect(store.feedItems.get(WARSAW)!.outcome).toBe("candidate");
    expect(store.feedItems.get(WISCONSIN)!.published).toBe("2025-09-18T14:00:11.000Z");
    const rows = await db.query("SELECT outcome, COUNT(*) AS n FROM feed_item GROUP BY outcome");
    expect(Object.fromEntries(rows.map((r) => [r.outcome, r.n]))).toEqual({
      accepted: 1,
      candidate: 5,
      ignored: 14,
    });
  });

  test("a second run over the same feeds adds nothing", async () => {
    await importGoogleSites();
    const first = await run();
    const second = await run();
    expect(second.outcomes[0]!.ok).toBe(true);
    expect(second.outcomes[0]!.result).toEqual({
      observations: 0,
      entities: 0,
      signals: 0,
      review: 0,
    });
    expect(second.store.feedItems.size).toBe(first.store.feedItems.size);
    expect(second.store.observations.size).toBe(first.store.observations.size);
    expect(second.store.review.size).toBe(first.store.review.size);
  });

  test("one unreachable feed does not stop the others", async () => {
    const broken = fixtureFetch(FIX, {
      "https://blogs.microsoft.com/": () => new Response("gone", { status: 500 }),
    });
    const { store, outcomes } = await run(broken);
    expect(outcomes[0]!.ok).toBe(true);
    expect(store.feedItems.has(WEST_MEMPHIS)).toBe(true);
    expect(store.feedItems.has(WARSAW)).toBe(false);
  });

  test("review accept turns a proposed site into an entity with the observation", async () => {
    await run();
    const store = await Store.open(db, "live");
    const item = [...store.review.values()].find(
      (r) => r.adapter === "news-feeds" && payloadOf(r).link === WARSAW,
    )!;
    await store.resolveReview(item.id, "accepted", fixedNow().toISOString());
    const obs = await acceptFeedClaim(store, item, "live", fixedNow());
    await store.flush();
    expect(obs).not.toBeNull();
    const again = await Store.open(db, "live");
    const site = again.entities.get(obs!.entity_id)!;
    expect(site).toMatchObject({
      type: "campus",
      provider_slug: "azure",
      name: "Microsoft Warsaw campus",
      country_code: "PL",
      locality: "Warsaw",
      lat: 52.23,
      lon: 21.01,
      location_precision: "locality",
    });
    expect(again.entities.get(site.parent_id!)!.type).toBe("provider");
    expect(again.observations.get(obs!.id)).toMatchObject({
      metric: "investment_usd",
      value: 700_000_000,
      status: "announced",
      effective_date: "2025-02-27",
      locator: WARSAW,
      review_status: "accepted",
      method_id: FEED_METHOD,
    });
    expect(again.observations.get(obs!.id)!.excerpt).toMatch(/\$700 million expansion/);
    expect(again.review.get(item.id)!.resolved_at).not.toBeNull();

    const unplaced = [...again.review.values()].find(
      (r) => r.adapter === "news-feeds" && payloadOf(r).link === EDDIE_WU,
    )!;
    expect(await acceptFeedClaim(again, unplaced, "live", fixedNow())).toBeNull();
  });
});
