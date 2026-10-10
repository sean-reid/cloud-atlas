import { stableId } from "../../shared/ids";
import { metricById } from "../../shared/metrics";
import { PROVIDERS, type ProviderSlug } from "../../shared/providers";
import type {
  Dataset,
  Entity,
  FeedOutcome,
  Observation,
  ReviewItem,
  Source,
} from "../../shared/types";
import { autoAccept, extractClaims, type Claim, type ClaimPlace } from "../claims";
import {
  ensureEntity,
  ensureSource,
  findSite,
  makeObservation,
  providerEntity,
  type EntityInput,
} from "../entities";
import { log } from "../log";
import { parseFeed, sentences, type FeedEntry } from "../rss";
import type { Store } from "../store";
import { emptyResult, meta, type Adapter, type AdapterContext, type AdapterResult } from "./types";

export const FEED_METHOD = "feed-sentence.v1";

export interface Feed {
  id: string;
  title: string;
  publisher: string;
  url: string;
  provider: ProviderSlug;
  brand: string;
  tier: 1 | 2;
  license: string | null;
}

// Provider-owned feeds whose robots.txt admits a polite reader. Tier 2 is the community blog,
// whose figures become leads for review and never observations.
export const FEEDS: readonly Feed[] = [
  {
    id: "aws-whats-new",
    title: "AWS What's New",
    publisher: "Amazon Web Services",
    url: "https://aws.amazon.com/about-aws/whats-new/recent/feed/",
    provider: "aws",
    brand: "AWS",
    tier: 1,
    license: "AWS Site Terms",
  },
  {
    id: "aws-news-blog",
    title: "AWS News Blog",
    publisher: "Amazon Web Services",
    url: "https://aws.amazon.com/blogs/aws/feed/",
    provider: "aws",
    brand: "AWS",
    tier: 1,
    license: "AWS Site Terms",
  },
  {
    id: "about-amazon",
    title: "About Amazon news",
    publisher: "Amazon",
    url: "https://www.aboutamazon.com/rss/feed.rss",
    provider: "aws",
    brand: "AWS",
    tier: 1,
    license: "Amazon Conditions of Use",
  },
  {
    id: "google-cloud-blog",
    title: "Google Cloud blog",
    publisher: "Google Cloud",
    url: "https://cloudblog.withgoogle.com/rss/",
    provider: "gcp",
    brand: "Google",
    tier: 1,
    license: "Google Terms of Service",
  },
  {
    id: "google-global-network",
    title: "The Keyword: Global Network",
    publisher: "Google",
    url: "https://blog.google/innovation-and-ai/infrastructure-and-cloud/global-network/rss/",
    provider: "gcp",
    brand: "Google",
    tier: 1,
    license: "Google Terms of Service",
  },
  {
    id: "microsoft-on-the-issues",
    title: "Microsoft On the Issues",
    publisher: "Microsoft",
    url: "https://blogs.microsoft.com/on-the-issues/feed/",
    provider: "azure",
    brand: "Microsoft",
    tier: 1,
    license: "Microsoft Terms of Use",
  },
  {
    id: "microsoft-local",
    title: "Microsoft Local blog",
    publisher: "Microsoft",
    url: "https://local.microsoft.com/blog/feed/",
    provider: "azure",
    brand: "Microsoft",
    tier: 2,
    license: "Microsoft Terms of Use",
  },
  {
    id: "alizila",
    title: "Alizila",
    publisher: "Alibaba Group",
    url: "https://www.alizila.com/feed/",
    provider: "alibaba",
    brand: "Alibaba Cloud",
    tier: 1,
    license: null,
  },
];

const ACCEPT = "application/rss+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.5";

export interface FeedClaimPayload {
  feed: string;
  provider: ProviderSlug;
  link: string;
  title: string;
  published: string | null;
  claim: Claim;
  entity: string | null;
  proposed: Omit<EntityInput, "dataset"> | null;
}

export const feedById = (id: string): Feed | undefined => FEEDS.find((f) => f.id === id);

const city = (place: ClaimPlace): string => place.key.split(",")[0]!.trim();

function proposal(feed: Feed, place: ClaimPlace): Omit<EntityInput, "dataset"> {
  return {
    type: "campus",
    provider: feed.provider,
    name: `${feed.brand} ${city(place)} campus`,
    country_code: place.country_code,
    admin_area: place.admin_area,
    locality: city(place),
    lat: place.lat,
    lon: place.lon,
    location_precision: "locality",
  };
}

async function feedSource(store: Store, feed: Feed): Promise<Source> {
  return await ensureSource(store, {
    publisher: feed.publisher,
    title: feed.title,
    url: feed.url,
    tier: feed.tier,
    published_date: null,
    license: feed.license,
    adapter: "news-feeds",
  });
}

async function claimObservation(
  store: Store,
  dataset: Dataset,
  now: Date,
  feed: Feed,
  entity: Entity,
  claim: Claim,
  entry: { link: string; published: string | null },
): Promise<Observation> {
  const source = await feedSource(store, feed);
  const metric = metricById(claim.metric)!;
  return await makeObservation(
    {
      entity_id: entity.id,
      metric: metric.id,
      value: claim.value,
      value_low: null,
      value_high: null,
      unit: metric.unit,
      value_original: claim.value_original,
      status: claim.status,
      scope: entity.type === "facility" || entity.type === "phase" ? entity.type : "campus",
      claim_type: "reported",
      effective_date: (entry.published ?? now.toISOString()).slice(0, 10),
      effective_precision: "day",
      effective_kind: claim.effective_kind,
      source_id: source.id,
      excerpt: claim.sentence.slice(0, 500),
      locator: entry.link,
      method_id: FEED_METHOD,
      derived_from: null,
      supersedes_id: null,
      review_status: "accepted",
      notes: null,
    },
    dataset,
    now,
  );
}

async function processEntry(
  ctx: AdapterContext,
  feed: Feed,
  entry: FeedEntry,
  result: AdapterResult,
  adapterId: string,
): Promise<FeedOutcome> {
  const { store, dataset } = ctx;
  const now = ctx.now();
  const seen = new Set<string>();
  const claims = sentences(`${entry.title}. ${entry.text}`)
    .flatMap((s) => extractClaims(s, ctx.places))
    .filter((c) => {
      const key = `${c.metric}|${c.value}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  if (!claims.length) return "ignored";
  let outcome: FeedOutcome = feed.tier === 1 ? "candidate" : "lead";
  for (const claim of claims) {
    const match = claim.place ? findSite(store, feed.provider, city(claim.place)) : null;
    if (feed.tier === 1 && autoAccept(claim, feed.tier) && match?.kind === "same") {
      const obs = await claimObservation(store, dataset, now, feed, match.entity, claim, entry);
      if (await store.appendObservation(obs)) result.observations++;
      outcome = "accepted";
      continue;
    }
    const payload: FeedClaimPayload = {
      feed: feed.id,
      provider: feed.provider,
      link: entry.link,
      title: entry.title,
      published: entry.published,
      claim,
      entity: match?.entity.id ?? null,
      proposed: claim.place && !match ? proposal(feed, claim.place) : null,
    };
    const where = match
      ? `${match.kind === "same" ? "on" : "near"} "${match.entity.name}"`
      : claim.place
        ? `at ${claim.place.key}, no site tracked there`
        : "with no place resolved";
    if (
      await store.queueReview({
        id: await stableId("rev_feed", [entry.link, claim.metric, claim.value, claim.sentence]),
        created_at: now.toISOString(),
        adapter: adapterId,
        reason: `${feed.title}: "${claim.value_original}" ${where} in "${entry.title}"`,
        payload: JSON.stringify(payload),
        resolved_at: null,
        resolution: null,
      })
    )
      result.review++;
  }
  return outcome;
}

// Materialises an accepted review item: the proposed site when the payload carries one, else
// the site the claim matched, then the observation. Returns null when the claim has no place.
export async function acceptFeedClaim(
  store: Store,
  item: ReviewItem,
  dataset: Dataset,
  now: Date,
): Promise<Observation | null> {
  const payload = JSON.parse(item.payload) as FeedClaimPayload;
  const feed = feedById(payload.feed);
  if (!feed) throw new Error(`review item ${item.id} names unknown feed ${payload.feed}`);
  let entity = payload.entity ? store.entities.get(payload.entity) : undefined;
  if (!entity && payload.proposed) {
    const provider = PROVIDERS.find((p) => p.slug === feed.provider)!;
    const parent = await providerEntity(store, feed.provider, provider.name, dataset);
    entity = await ensureEntity(store, { ...payload.proposed, dataset, parent_id: parent.id });
  }
  if (!entity) return null;
  const obs = await claimObservation(store, dataset, now, feed, entity, payload.claim, payload);
  await store.appendObservation(obs);
  return obs;
}

export const newsFeeds: Adapter = {
  ...meta("news-feeds"),
  url: FEEDS[0]!.url,
  tier: 1,
  license: "Publisher terms; one sentence quoted per figure with attribution",
  hosts: [
    "aws.amazon.com",
    "www.aboutamazon.com",
    "cloudblog.withgoogle.com",
    "blog.google",
    "blogs.microsoft.com",
    "local.microsoft.com",
    "www.alizila.com",
  ],
  source: () => ({
    id: "",
    publisher: FEEDS[0]!.publisher,
    title: FEEDS[0]!.title,
    url: FEEDS[0]!.url,
    tier: 1,
    published_date: null,
    license: FEEDS[0]!.license,
    adapter: "news-feeds",
  }),
  async run(ctx: AdapterContext) {
    const result = emptyResult();
    const { store } = ctx;
    let failed = 0;
    for (const feed of FEEDS) {
      let entries: FeedEntry[];
      try {
        entries = parseFeed((await ctx.fetch(feed.url, { accept: ACCEPT })).body);
        if (!entries.length) throw new Error("no entries parsed");
      } catch (err) {
        failed++;
        log("warn", "feed.failed", { adapter: this.id, feed: feed.id, error: String(err) });
        continue;
      }
      for (const entry of entries) {
        if (store.feedItems.has(entry.link)) continue;
        const outcome = await processEntry(ctx, feed, entry, result, this.id);
        await store.recordFeedItem({
          link: entry.link,
          feed: feed.id,
          title: entry.title,
          published: entry.published,
          seen_at: ctx.now().toISOString(),
          outcome,
        });
      }
    }
    if (failed === FEEDS.length) throw new Error("every feed failed");
    return result;
  },
};
