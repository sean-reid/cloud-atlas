import { parseMoneyUsd } from "../../shared/metrics";
import type { Entity } from "../../shared/types";
import {
  ensureEntity,
  ensureSource,
  findSite,
  makeObservation,
  providerEntity,
  type EntityInput,
} from "../entities";
import { FetchError } from "../fetch";
import {
  ECB_HOST,
  ECB_SOURCE,
  fetchRates,
  isFxCurrency,
  toUsd,
  usdPer,
  type FxCurrency,
  type Rates,
} from "../fx";
import { placesNamed, resolveAddress, stateAgrees, type Gazetteer, type Place } from "../geo";
import { stripTags } from "../html";
import { log } from "../log";
import type { Store } from "../store";
import { emptyResult, meta, type Adapter, type AdapterContext } from "./types";

export const INDEX_URL = "https://datacenters.google/locations/";

export interface StatCard {
  label: string;
  figure: string;
  prose: string;
}

export interface InvestmentFigure {
  usd: boolean;
  currency: string;
  value: number;
  lowerBound: boolean;
}

export interface GcpSiteReview {
  page: string;
  title: string;
  figure: string;
  value: number;
  usd: boolean;
  lower_bound: boolean;
  established: string | null;
  excerpt: string;
  localities: string[];
  places_named: string[];
  proposed: Omit<EntityInput, "dataset"> | null;
  why: string;
}

const INVEST = /invest/i;
const ESTABLISHED = /established|since|year/i;
const LOWER_BOUND = /more than|over|at least|\+/i;
const FIGURE =
  /^(US\$|\$|€|£|¥|₹)\s?(\d[\d,]*(?:\.\d+)?)\s*(trillion|billion|million|bn|b|m|k)?\s*(\+)?$/i;
const CURRENCY: Record<string, string> = {
  $: "USD",
  US$: "USD",
  "€": "EUR",
  "£": "GBP",
  "¥": "JPY",
  "₹": "INR",
};

// The index embeds one record per locality with the page that describes it, so a page with
// several records covers several places.
export function parseIndex(html: string): Map<string, string[]> {
  const block = /<div id="data-centers-data"[^>]*>([\s\S]*?)<\/div>/.exec(html)?.[1]?.trim();
  if (!block) return new Map();
  const flat = block.replace(/\s*\n\s*/g, " ");
  const raw = flat.startsWith("[") ? flat : `[${flat}]`;
  let entries: { location?: string; detailPage?: string }[];
  try {
    entries = JSON.parse(raw) as { location?: string; detailPage?: string }[];
  } catch {
    return new Map();
  }
  const pages = new Map<string, string[]>();
  for (const e of entries) {
    if (!e.detailPage || !e.location) continue;
    const url = new URL(e.detailPage, INDEX_URL).toString();
    pages.set(url, [...(pages.get(url) ?? []), e.location]);
  }
  return pages;
}

// The document title puts the page name before a dash and the site name after it.
export function pageTitle(html: string): string | null {
  const raw = /<title>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  if (!raw) return null;
  return (
    stripTags(raw)
      .split(/\s[^\w\s]\s/)[0]!
      .trim() || null
  );
}

export function parseCards(html: string): StatCard[] {
  const out: StatCard[] = [];
  for (const li of html.matchAll(/<li[^>]*data-cy="card-list"[^>]*>([\s\S]*?)<\/li\s*>/g)) {
    const card = li[1]!;
    const label = /data-cy="card-category"[^>]*>([\s\S]*?)<\/p\s*>/.exec(card)?.[1];
    const figure = /data-cy="text-attr"[^>]*>([\s\S]*?)<\/span\s*>/.exec(card)?.[1];
    const prose = /data-cy="card-description"[^>]*>([\s\S]*?)<\/p\s*>/.exec(card)?.[1];
    if (!label || !figure || !prose) continue;
    out.push({ label: stripTags(label), figure: stripTags(figure), prose: stripTags(prose) });
  }
  return out;
}

// "$20B+" and "US$5B" are dollars; "€5B+" and "£5B" keep their own value and currency.
export function parseInvestmentFigure(figure: string, prose = ""): InvestmentFigure | null {
  const m = FIGURE.exec(figure.trim());
  if (!m) return null;
  const parsed = parseMoneyUsd(`${m[2]} ${m[3] ?? ""}`);
  if (!parsed) return null;
  const currency = CURRENCY[m[1]!.toUpperCase()]!;
  return {
    usd: currency === "USD",
    currency,
    value: parsed.value,
    lowerBound: !!m[4] || LOWER_BOUND.test(prose),
  };
}

// Three significant figures, since no card states more than that.
const sig3 = (n: number): number => Number(n.toPrecision(3));

const amountWords = (value: number): string =>
  value >= 1e9 ? `${value / 1e9} billion` : `${value / 1e6} million`;

function convert(
  value: number,
  currency: FxCurrency,
  rates: Rates,
): { value: number; note: string } {
  return {
    value: sig3(toUsd(value, currency, rates)),
    note: `${currency} ${amountWords(value)} at ECB reference rate ${usdPer(currency, rates).toFixed(4)} USD per ${currency} on ${rates.date}`,
  };
}

const city = (key: string): string => key.split(",")[0]!.trim();

function pagePlace(
  places: Gazetteer,
  localities: readonly string[],
): { key: string; place: Place } | null {
  if (localities.length !== 1) return null;
  const hit = resolveAddress(places, localities[0]!, null);
  return hit && stateAgrees(hit.place, localities[0]!) ? hit : null;
}

function proposal(key: string, place: Place): Omit<EntityInput, "dataset"> {
  return {
    type: "campus",
    provider: "gcp",
    name: `Google ${city(key)} campus`,
    country_code: place.country_code,
    admin_area: place.admin_area,
    locality: city(key),
    lat: place.lat,
    lon: place.lon,
    location_precision: "locality",
    ownership: "owned",
  };
}

// Why a figure is not written straight onto a campus, or null when it can be.
function holdReason(
  store: Store,
  places: Gazetteer,
  fig: InvestmentFigure,
  card: StatCard,
  localities: readonly string[],
  place: { key: string; place: Place } | null,
  named: readonly { key: string }[],
  rates: Rates | null,
): string | null {
  if (!fig.usd && !(rates && isFxCurrency(fig.currency)))
    return `"${card.figure}" is not in US dollars`;
  if (localities.length !== 1) return `one figure for ${localities.join(", ")}`;
  if (!place) return `"${localities[0]}" is not in the gazetteer`;
  const others = named.filter((n) => n.key !== place.key).map((n) => n.key);
  if (others.length) return `the card also names ${others.join(", ")}`;
  const match = findSite(store, "gcp", `Google ${city(place.key)} campus`);
  if (match?.kind === "similar")
    return `"Google ${city(place.key)} campus" may be the same site as "${match.entity.name}"`;
  return null;
}

export const gcpSites: Adapter = {
  ...meta("gcp-sites"),
  url: INDEX_URL,
  tier: 1,
  license: "Google Terms of Service; robots.txt allows reading",
  hosts: ["datacenters.google", ECB_HOST],
  source: () => ({
    id: "",
    publisher: "Google",
    title: "Google data center locations",
    url: INDEX_URL,
    tier: 1,
    published_date: null,
    license: "Google Terms of Service",
    adapter: "gcp-sites",
  }),
  async run(ctx: AdapterContext) {
    const result = emptyResult();
    const now = ctx.now();
    const today = now.toISOString().slice(0, 10);
    const { store, dataset } = ctx;
    const source = await ensureSource(store, { ...this.source(), adapter: this.id });
    const pages = parseIndex((await ctx.fetch(INDEX_URL)).body);
    if (!pages.size) throw new Error("no locations parsed from the index; page layout changed");

    let failed = 0;
    let rates: Rates | null | undefined;
    const ecbRates = async (): Promise<Rates | null> => {
      if (rates !== undefined) return rates;
      try {
        rates = await fetchRates(ctx);
        await ensureSource(store, ECB_SOURCE);
      } catch (err) {
        rates = null;
        const error = err instanceof Error ? err.message : String(err);
        log("warn", "fx.unavailable", { adapter: this.id, error });
      }
      return rates;
    };
    for (const [url, localities] of pages) {
      let body: string;
      try {
        body = (await ctx.fetch(url)).body;
      } catch (err) {
        if (!(err instanceof FetchError)) throw err;
        failed++;
        log("warn", "page.failed", { adapter: this.id, url, error: err.message });
        continue;
      }
      const slug = new URL(url).pathname.split("/").filter(Boolean).pop()!;
      const title = pageTitle(body) ?? slug;
      const cards = parseCards(body);
      const established =
        cards.find((c) => ESTABLISHED.test(c.label) && /^\d{4}$/.test(c.figure))?.figure ?? null;
      const place = pagePlace(ctx.places, localities);
      let n = 0;
      for (const card of cards.filter((c) => INVEST.test(c.label))) {
        const fig = parseInvestmentFigure(card.figure, card.prose);
        if (!fig || fig.value < 1e8) continue;
        const reviewId = `rev_gcp-sites_${slug}${n ? `-${n}` : ""}`;
        n++;
        const named = placesNamed(ctx.places, card.prose);
        const currency = isFxCurrency(fig.currency) ? fig.currency : null;
        const fx = !fig.usd && currency ? await ecbRates() : null;
        const why = holdReason(store, ctx.places, fig, card, localities, place, named, fx);
        if (why) {
          const payload: GcpSiteReview = {
            page: url,
            title,
            figure: card.figure,
            value: fig.value,
            usd: fig.usd,
            lower_bound: fig.lowerBound,
            established,
            excerpt: card.prose,
            localities: [...localities],
            places_named: named.map((p) => p.key),
            proposed: place ? proposal(place.key, place.place) : null,
            why,
          };
          if (
            await store.queueReview({
              id: reviewId,
              created_at: now.toISOString(),
              adapter: this.id,
              reason: `Google ${title}: "${card.figure}" (${card.label}); ${why}`,
              payload: JSON.stringify(payload),
              resolved_at: null,
              resolution: null,
            })
          )
            result.review++;
          continue;
        }
        const name = `Google ${city(place!.key)} campus`;
        const match = findSite(store, "gcp", name);
        let entity: Entity;
        if (match) entity = match.entity;
        else {
          const parent = await providerEntity(store, "gcp", "Google Cloud", dataset);
          entity = await ensureEntity(store, {
            ...proposal(place!.key, place!.place),
            dataset,
            parent_id: parent.id,
          });
          result.entities++;
        }
        const conv = fx && currency ? convert(fig.value, currency, fx) : null;
        const value = conv ? conv.value : fig.value;
        const notes = [
          conv?.note,
          established ? `Established ${established} per the page's stat card.` : null,
        ].filter((s): s is string => !!s);
        const obs = await makeObservation(
          {
            entity_id: entity.id,
            metric: "investment_usd",
            value,
            value_low: fig.lowerBound ? value : null,
            value_high: null,
            unit: "USD",
            value_original:
              fig.lowerBound && !card.figure.includes("+")
                ? `${card.figure} (more than)`
                : card.figure,
            status: "operational",
            scope: "campus",
            claim_type: conv ? "derived" : "reported",
            effective_date: today,
            effective_precision: "day",
            effective_kind: "as_of",
            source_id: source.id,
            excerpt: card.prose.slice(0, 500),
            locator: url,
            method_id: conv ? "fx-conversion.v1" : null,
            derived_from: null,
            supersedes_id: null,
            review_status: "accepted",
            notes: notes.length ? notes.join(". ") : null,
          },
          dataset,
          now,
        );
        if (await store.appendObservation(obs)) result.observations++;
        await store.resolveReview(reviewId, "recorded on the campus", now.toISOString());
      }
    }
    if (failed === pages.size) throw new Error("every location page failed");
    return result;
  },
};
