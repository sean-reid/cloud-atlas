import { providerTotals, rowPicks, selectSites, type SitePick } from "../shared/aggregate";
import { dateFloor, daysBetween } from "../shared/dates";
import { METRICS } from "../shared/metrics";
import { PROVIDERS } from "../shared/providers";
import {
  HISTORY_DAY_SQL,
  historyCells,
  levelFor,
  mergeReading,
  spotTerciles,
  type HistoryRow,
  type Level,
  type Readings,
} from "../shared/availability";
import { selectByStatus, selectObservation, type Candidate } from "../shared/selection";
import type {
  AvailabilitySignal,
  Entity,
  FetchRun,
  Method,
  Observation,
  Source,
  Status,
} from "../shared/types";
import { cacheKey, FILTER_PARAMS } from "./cache-key";
import { csvCell } from "./csv";
import { all, loadSites, one, placeholders } from "./db";
import { BadRequest, intParam, queryFilters } from "./params";

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  API_RATE: RateLimit;
}

type Handler = (
  req: Request,
  env: Env,
  url: URL,
  params: Record<string, string>,
) => Promise<Response>;

export const json = (body: unknown, status = 200, extra: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=300",
      ...extra,
    },
  });

const notFound = () => json({ error: "not found" }, 404, { "cache-control": "no-store" });

interface SiteRow {
  id: string;
  name: string;
  type: Entity["type"];
  provider_slug: string;
  parent_id: string | null;
  country_code: string | null;
  admin_area: string | null;
  locality: string | null;
  lat: number | null;
  lon: number | null;
  location_precision: Entity["location_precision"];
  ownership: Entity["ownership"];
  landlord: string | null;
  metrics: Record<
    string,
    {
      value: number | null;
      low: number | null;
      high: number | null;
      unit: string;
      status: Observation["status"];
      claim_type: Observation["claim_type"];
      effective_date: string;
      effective_kind: Observation["effective_kind"];
      tier: number;
      competing: number;
      disagreement: boolean;
      observation_id: string;
    }
  >;
  observation_count: number;
  latest_recorded: string;
  age_days: number | null;
}

function siteRows(entities: Entity[], picks: SitePick[], rows: Candidate[], now: Date): SiteRow[] {
  const byEntity = new Map<string, SiteRow>();
  const counts = new Map<string, { n: number; latest: string }>();
  for (const r of rows) {
    const c = counts.get(r.entity_id) ?? { n: 0, latest: "" };
    c.n++;
    if (r.recorded_at > c.latest) c.latest = r.recorded_at;
    counts.set(r.entity_id, c);
  }
  const today = now.toISOString().slice(0, 10);
  for (const p of rowPicks(picks)) {
    const e = p.entity;
    let row = byEntity.get(e.id);
    if (!row) {
      const c = counts.get(e.id) ?? { n: 0, latest: "" };
      row = {
        id: e.id,
        name: e.name,
        type: e.type,
        provider_slug: e.provider_slug,
        parent_id: e.parent_id,
        country_code: e.country_code,
        admin_area: e.admin_area,
        locality: e.locality,
        lat: e.lat,
        lon: e.lon,
        location_precision: e.location_precision,
        ownership: e.ownership,
        landlord: e.landlord,
        metrics: {},
        observation_count: c.n,
        latest_recorded: c.latest,
        age_days: null,
      };
      byEntity.set(e.id, row);
    }
    const o = p.selection.pick;
    row.metrics[p.metric] = {
      value: o.value,
      low: o.value_low,
      high: o.value_high,
      unit: o.unit,
      status: o.status,
      claim_type: o.claim_type,
      effective_date: o.effective_date,
      effective_kind: o.effective_kind,
      tier: o.tier,
      competing: p.selection.competing.length,
      disagreement: p.selection.disagreement,
      observation_id: o.id,
    };
    const age = daysBetween(dateFloor(o.effective_date), today);
    row.age_days = row.age_days === null ? age : Math.min(row.age_days, age);
  }
  void entities;
  return [...byEntity.values()].sort((a, b) => a.name.localeCompare(b.name));
}

const health: Handler = async () => json({ ok: true }, 200, { "cache-control": "no-store" });

const meta: Handler = async (_req, env) => {
  const runs = await all<FetchRun>(
    env.DB,
    "SELECT * FROM fetch_run ORDER BY started_at DESC LIMIT 200",
  );
  const latest = new Map<string, FetchRun>();
  const latestOk = new Map<string, FetchRun>();
  for (const r of runs) {
    if (!latest.has(r.adapter)) latest.set(r.adapter, r);
    if (r.ok && !latestOk.has(r.adapter)) latestOk.set(r.adapter, r);
  }
  const counts = await all<{ provider_slug: string; metric: string; status: string; n: number }>(
    env.DB,
    `SELECT e.provider_slug, o.metric, o.status, COUNT(*) AS n FROM observation o JOIN entity e ON e.id = o.entity_id
     WHERE o.dataset = 'live' AND o.review_status = 'accepted' GROUP BY e.provider_slug, o.metric, o.status`,
  );
  const countries = await all<{ country_code: string; n: number }>(
    env.DB,
    "SELECT country_code, COUNT(*) AS n FROM entity WHERE dataset = 'live' AND country_code IS NOT NULL AND type IN ('campus','facility','phase') GROUP BY country_code ORDER BY n DESC",
  );
  return json({
    providers: PROVIDERS,
    metrics: METRICS,
    countries,
    coverage: counts,
    freshness: [...latest.values()].map((r) => ({
      adapter: r.adapter,
      last_attempt: r.started_at,
      last_success: latestOk.get(r.adapter)?.finished_at ?? null,
      ok: !!r.ok,
      changed: !!r.changed,
      error: r.error,
    })),
  });
};

const summary: Handler = async (_req, env, url) => {
  const f = queryFilters(url.searchParams);
  const { entities, rows } = await loadSites(env.DB, f);
  const picks = selectSites(entities, rows, f.asof || null, f.mode);
  const totals = providerTotals(entities, picks);
  const providerWide = await all<Candidate & { provider_slug: string }>(
    env.DB,
    `SELECT o.*, s.tier, e.provider_slug FROM observation o JOIN source s ON s.id = o.source_id JOIN entity e ON e.id = o.entity_id
     WHERE o.dataset = ? AND e.type = 'provider' AND o.review_status = 'accepted'`,
    [f.demo ? "demo" : "live"],
  );
  const stated: Record<string, Record<string, ReturnType<typeof selectObservation>>> = {};
  const grouped = new Map<string, Candidate[]>();
  for (const r of providerWide) {
    const key = `${r.provider_slug}|${r.metric}|${r.status}`;
    grouped.set(key, [...(grouped.get(key) ?? []), r]);
  }
  for (const [key, list] of grouped) {
    const [slug, metric, status] = key.split("|") as [string, string, string];
    const sel = selectObservation(list, f.asof || null, f.mode);
    if (!sel) continue;
    stated[slug] ??= {};
    stated[slug][`${metric}|${status}`] = sel;
  }
  const latestRecorded = rows.reduce((m, r) => (r.recorded_at > m ? r.recorded_at : m), "");
  return json({
    filters: f,
    totals,
    tracked: {
      it_power_mw: Math.round(totals.reduce((n, t) => n + t.it_power_mw, 0) * 10) / 10,
      facility_only_power_mw:
        Math.round(totals.reduce((n, t) => n + t.facility_only_power_mw, 0) * 10) / 10,
      sites: totals.reduce((n, t) => n + t.sites, 0),
      located_sites: totals.reduce((n, t) => n + t.located_sites, 0),
      pipeline_it_power_mw: {
        under_construction: totals.reduce(
          (n, t) => n + t.pipeline_it_power_mw.under_construction,
          0,
        ),
        announced: totals.reduce((n, t) => n + t.pipeline_it_power_mw.announced, 0),
      },
      pipeline_facility_only_power_mw: {
        under_construction: totals.reduce(
          (n, t) => n + t.pipeline_facility_only_power_mw.under_construction,
          0,
        ),
        announced: totals.reduce((n, t) => n + t.pipeline_facility_only_power_mw.announced, 0),
      },
    },
    provider_stated: stated,
    evidence: { observations: rows.length, latest_recorded: latestRecorded || null },
  });
};

const sites: Handler = async (_req, env, url) => {
  const f = queryFilters(url.searchParams);
  const { entities, rows } = await loadSites(env.DB, f);
  const picks = selectSites(entities, rows, f.asof || null, f.mode);
  return json({ filters: f, sites: siteRows(entities, picks, rows, new Date()) });
};

const regions: Handler = async (_req, env, url) => {
  const f = queryFilters(url.searchParams);
  const where = ["e.dataset = ?", "e.type = 'region'"];
  const params: unknown[] = [f.demo ? "demo" : "live"];
  if (f.providers.length) {
    where.push(`e.provider_slug IN (${f.providers.map(() => "?").join(",")})`);
    params.push(...f.providers);
  }
  const list = await all<Entity>(
    env.DB,
    `SELECT e.* FROM entity e WHERE ${where.join(" AND ")}`,
    params,
  );
  const ids = list.map((e) => e.id);
  const obs: Candidate[] = [];
  for (let i = 0; i < ids.length; i += 80) {
    const chunk = ids.slice(i, i + 80);
    obs.push(
      ...(await all<Candidate>(
        env.DB,
        `SELECT o.*, s.tier FROM observation o JOIN source s ON s.id = o.source_id WHERE o.review_status = 'accepted' AND o.entity_id IN (${chunk.map(() => "?").join(",")})`,
        chunk,
      )),
    );
  }
  const out = list.map((e) => {
    const mine = obs.filter((o) => o.entity_id === e.id);
    const az = selectObservation(
      mine.filter((o) => o.metric === "az_count"),
      f.asof || null,
      f.mode,
    );
    const opened = mine
      .filter((o) => o.effective_kind === "opened")
      .sort((a, b) => (a.effective_date < b.effective_date ? -1 : 1))[0];
    return {
      id: e.id,
      code: e.code,
      name: e.name,
      provider_slug: e.provider_slug,
      country_code: e.country_code,
      locality: e.locality,
      lat: e.lat,
      lon: e.lon,
      location_precision: e.location_precision,
      az_count: az?.pick.value ?? null,
      az_effective: az?.pick.effective_date ?? null,
      opened: opened?.effective_date ?? null,
      zones: 0,
    };
  });
  const zones = await all<{ parent_id: string; n: number }>(
    env.DB,
    "SELECT parent_id, COUNT(*) AS n FROM entity WHERE type = 'zone' GROUP BY parent_id",
  );
  const zoneCount = new Map(zones.map((z) => [z.parent_id, z.n]));
  for (const r of out) r.zones = zoneCount.get(r.id) ?? 0;
  return json({ regions: out });
};

interface SeriesPoint {
  date: string;
  it_power_mw: number;
  facility_only_power_mw: number;
  sites: number;
  new_sites: number;
  revised_sites: number;
}

// Monthly series by re-running the selection rule at each month end. "known" uses what was
// recorded by then; "reconstructed" uses the dates the claims describe. The per-step site
// difference separates newly tracked sites from revisions of sites already tracked.
const timeseries: Handler = async (_req, env, url) => {
  const f = queryFilters(url.searchParams);
  const { entities, rows } = await loadSites(env.DB, f);
  if (!rows.length) return json({ filters: f, series: {} });
  const dates = rows.map((r) =>
    f.mode === "known" ? r.recorded_at.slice(0, 10) : dateFloor(r.effective_date),
  );
  const min = dates.reduce((a, b) => (a < b ? a : b));
  const end = new Date();
  const start = new Date(`${min.slice(0, 7)}-01T00:00:00Z`);
  const floorStart = new Date(
    Date.UTC(Math.max(start.getUTCFullYear(), end.getUTCFullYear() - 8), start.getUTCMonth(), 1),
  );
  const series: Record<string, SeriesPoint[]> = {};
  let prev = new Map<string, Map<string, number>>();
  for (
    let d = floorStart;
    d <= end;
    d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))
  ) {
    const monthEnd = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0))
      .toISOString()
      .slice(0, 10);
    const asOf =
      monthEnd > end.toISOString().slice(0, 10) ? end.toISOString().slice(0, 10) : monthEnd;
    const picks = selectSites(entities, rows, asOf, f.mode);
    const totals = providerTotals(entities, picks);
    const cur = new Map<string, Map<string, number>>();
    for (const p of picks) {
      if (p.metric !== "it_power_mw" || p.selection.pick.status !== "operational") continue;
      const m = cur.get(p.entity.provider_slug) ?? new Map<string, number>();
      m.set(p.entity.id, p.selection.pick.value ?? 0);
      cur.set(p.entity.provider_slug, m);
    }
    for (const t of totals) {
      const now = cur.get(t.provider_slug) ?? new Map<string, number>();
      const before = prev.get(t.provider_slug) ?? new Map<string, number>();
      let newSites = 0;
      let revised = 0;
      for (const [id, v] of now) {
        if (!before.has(id)) newSites++;
        else if (before.get(id) !== v) revised++;
      }
      (series[t.provider_slug] ??= []).push({
        date: asOf.slice(0, 7),
        it_power_mw: t.it_power_mw,
        facility_only_power_mw: t.facility_only_power_mw,
        sites: t.it_sites + t.facility_only_sites,
        new_sites: newSites,
        revised_sites: revised,
      });
    }
    prev = cur;
  }
  return json({ filters: f, series });
};

const entityDetail: Handler = async (_req, env, _url, params) => {
  const e = await one<Entity>(env.DB, "SELECT * FROM entity WHERE id = ?", [params.id]);
  if (!e) return notFound();
  const chain: Entity[] = [];
  let cur = e;
  while (cur.parent_id) {
    const p = await one<Entity>(env.DB, "SELECT * FROM entity WHERE id = ?", [cur.parent_id]);
    if (!p) break;
    chain.push(p);
    cur = p;
  }
  const children = await all<Entity>(
    env.DB,
    "SELECT * FROM entity WHERE parent_id = ? ORDER BY name",
    [e.id],
  );
  const obs = await all<
    Candidate & { publisher: string; title: string; url: string; published_date: string | null }
  >(
    env.DB,
    `SELECT o.*, s.tier, s.publisher, s.title, s.url, s.published_date FROM observation o JOIN source s ON s.id = o.source_id
     WHERE o.entity_id = ? AND o.review_status = 'accepted' ORDER BY o.metric, o.effective_date DESC, o.recorded_at DESC`,
    [e.id],
  );
  const methodIds = [...new Set(obs.map((o) => o.method_id).filter((m): m is string => !!m))];
  const methods = methodIds.length
    ? await all<Method>(
        env.DB,
        `SELECT * FROM method WHERE id IN (${methodIds.map(() => "?").join(",")})`,
        methodIds,
      )
    : [];
  // The dashboard selects per status, so an announced 2028 figure and the operational one are
  // both marked; `selected` is the one a site row leads with.
  const byMetric: Record<
    string,
    {
      selected: string | null;
      selected_by_status: Partial<Record<Status, string>>;
      observations: typeof obs;
    }
  > = {};
  for (const o of obs) {
    (byMetric[o.metric] ??= {
      selected: null,
      selected_by_status: {},
      observations: [],
    }).observations.push(o);
  }
  for (const group of Object.values(byMetric)) {
    const picks = [...selectByStatus(group.observations, null, "reconstructed")];
    for (const [status, sel] of picks) group.selected_by_status[status] = sel.pick.id;
    group.selected = picks[0]?.[1].pick.id ?? null;
  }
  return json({ entity: e, ancestors: chain, children, metrics: byMetric, methods });
};

const providerDetail: Handler = async (_req, env, url, params) => {
  const provider = PROVIDERS.find((p) => p.slug === params.slug);
  if (!provider) return notFound();
  const f = queryFilters(url.searchParams);
  f.providers = [provider.slug];
  const { entities, rows } = await loadSites(env.DB, f);
  const picks = selectSites(entities, rows, f.asof || null, f.mode);
  const totals = providerTotals(entities, picks)[0] ?? null;
  const providerEntity = await one<Entity>(
    env.DB,
    "SELECT * FROM entity WHERE type = 'provider' AND provider_slug = ? AND dataset = 'live'",
    [provider.slug],
  );
  const stated = providerEntity
    ? await all<Candidate & { publisher: string; title: string; url: string }>(
        env.DB,
        `SELECT o.*, s.tier, s.publisher, s.title, s.url FROM observation o JOIN source s ON s.id = o.source_id
         WHERE o.entity_id = ? AND o.review_status = 'accepted' ORDER BY o.metric, o.effective_date DESC`,
        [providerEntity.id],
      )
    : [];
  const regionCount = await one<{ n: number }>(
    env.DB,
    "SELECT COUNT(*) AS n FROM entity WHERE type = 'region' AND provider_slug = ? AND dataset = 'live'",
    [provider.slug],
  );
  return json({
    provider,
    totals,
    sites: siteRows(entities, picks, rows, new Date()),
    stated,
    regions_tracked: regionCount?.n ?? 0,
  });
};

const feed: Handler = async (_req, env, url) => {
  const f = queryFilters(url.searchParams);
  const limit = intParam(url.searchParams, "limit", 40, 1, 200);
  const rows = await all<
    Observation & {
      tier: number;
      entity_name: string;
      entity_type: string;
      provider_slug: string;
      publisher: string;
      title: string;
      url: string;
    }
  >(
    env.DB,
    `SELECT o.*, s.tier, s.publisher, s.title, s.url, e.name AS entity_name, e.type AS entity_type, e.provider_slug
     FROM observation o JOIN source s ON s.id = o.source_id JOIN entity e ON e.id = o.entity_id
     WHERE o.dataset = ? AND o.review_status = 'accepted' AND e.type <> 'zone'
     ORDER BY o.recorded_at DESC, o.effective_date DESC LIMIT ?`,
    [f.demo ? "demo" : "live", limit * 3],
  );
  const kind = (o: (typeof rows)[number]) => {
    if (o.supersedes_id) return "revision";
    if (o.status === "cancelled" || o.status === "decommissioned") return "cancellation";
    if (o.effective_kind === "opened") return "opening";
    if (o.status === "announced" || o.effective_kind === "announced") return "announcement";
    if (o.claim_type === "derived") return "estimate";
    return "update";
  };
  const seen = new Set<string>();
  const items = [];
  for (const o of rows) {
    const key = `${o.entity_id}|${o.source_id}|${o.recorded_at.slice(0, 10)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ ...o, kind: kind(o) });
    if (items.length >= limit) break;
  }
  const runs = await all<FetchRun>(
    env.DB,
    "SELECT * FROM fetch_run WHERE changed = 1 ORDER BY started_at DESC LIMIT 10",
  );
  return json({ items, source_updates: runs });
};

const sources: Handler = async (_req, env) => {
  const list = await all<Source & { n: number; latest_effective: string | null }>(
    env.DB,
    `SELECT s.*, COUNT(o.id) AS n, MAX(o.effective_date) AS latest_effective FROM source s
     LEFT JOIN observation o ON o.source_id = s.id AND o.review_status = 'accepted' AND o.dataset = 'live'
     GROUP BY s.id ORDER BY s.tier, n DESC`,
  );
  const runs = await all<FetchRun>(
    env.DB,
    "SELECT * FROM fetch_run ORDER BY started_at DESC LIMIT 300",
  );
  const open = await one<{ n: number }>(
    env.DB,
    "SELECT COUNT(*) AS n FROM review_item WHERE resolved_at IS NULL",
  );
  return json({ sources: list, runs, review_open: open?.n ?? 0 });
};

// Levels are relative within one provider and SKU family at the latest observation hour,
// never across providers, because each signal measures something different.
const availability: Handler = async (_req, env, url) => {
  const slugs = (url.searchParams.get("provider") ?? "").split(",").filter(Boolean);
  const where = slugs.length ? `WHERE provider_slug IN (${placeholders(slugs.length)})` : "";
  const params = slugs;
  const latest = await all<{ provider_slug: string; observed_at: string }>(
    env.DB,
    `SELECT provider_slug, MAX(observed_at) AS observed_at FROM availability_signal ${where} GROUP BY provider_slug`,
    params,
  );
  const out: Record<
    string,
    { observed_at: string; signals: string[]; families: Record<string, unknown[]> }
  > = {};
  for (const l of latest) {
    // Daily probes and hourly probes land in different hours; take each signal's latest hour.
    const rows = await all<AvailabilitySignal>(
      env.DB,
      `SELECT s.* FROM availability_signal s JOIN (
         SELECT signal, MAX(observed_at) AS observed_at FROM availability_signal WHERE provider_slug = ? GROUP BY signal
       ) m ON m.signal = s.signal AND m.observed_at = s.observed_at WHERE s.provider_slug = ?`,
      [l.provider_slug, l.provider_slug],
    );
    const weekAgo = new Date(Date.parse(l.observed_at) - 7 * 86_400_000).toISOString();
    const baseline = await all<{ region_code: string; sku: string; signal: string; avg: number }>(
      env.DB,
      `SELECT region_code, sku, signal, AVG(value) AS avg FROM availability_signal
       WHERE provider_slug = ? AND observed_at >= ? AND observed_at < ? GROUP BY region_code, sku, signal`,
      [l.provider_slug, weekAgo, l.observed_at],
    );
    const base = new Map(baseline.map((b) => [`${b.region_code}|${b.sku}|${b.signal}`, b.avg]));
    const families: Record<string, unknown[]> = {};
    const byFamily = new Map<string, AvailabilitySignal[]>();
    for (const r of rows) byFamily.set(r.sku_family, [...(byFamily.get(r.sku_family) ?? []), r]);
    for (const [family, list] of byFamily) {
      const terciles = spotTerciles(
        list.filter((r) => r.signal === "spot_ratio").map((r) => r.value),
      );
      const byRegion = new Map<
        string,
        { region_code: string; sku: string; offered: boolean; signals: Readings; level: Level }
      >();
      for (const r of list) {
        const key = `${r.region_code}|${r.sku}`;
        const entry = byRegion.get(key) ?? {
          region_code: r.region_code,
          sku: r.sku,
          offered: false,
          signals: {},
          level: "unknown" as Level,
        };
        const detail = r.detail ? (JSON.parse(r.detail) as Record<string, unknown>) : null;
        if (r.signal === "sku_offered") {
          entry.offered = true;
          // Zone-level offering rows collapse to their region, keeping the zone count.
          const prevZones =
            typeof entry.signals.sku_offered?.detail?.zones === "number"
              ? (entry.signals.sku_offered.detail.zones as number)
              : 0;
          entry.signals.sku_offered = {
            value: 1,
            detail: { ...(detail ?? {}), ...(r.zone_code ? { zones: prevZones + 1 } : {}) },
            baseline: null,
          };
        } else {
          entry.signals[r.signal] = mergeReading(
            entry.signals[r.signal],
            { signal: r.signal, value: r.value, detail, zone_code: r.zone_code },
            base.get(`${r.region_code}|${r.sku}|${r.signal}`) ?? null,
          );
        }
        byRegion.set(key, entry);
      }
      for (const entry of byRegion.values()) entry.level = levelFor(entry.signals, terciles);
      families[family] = [...byRegion.values()].sort((a, b) =>
        a.region_code.localeCompare(b.region_code),
      );
    }
    out[l.provider_slug] = {
      observed_at: l.observed_at,
      signals: [...new Set(rows.map((r) => r.signal))].sort(),
      families,
    };
  }
  return json({ providers: out });
};

// Daily history per region and SKU for one provider and family: the worst hour of each day
// decides the day's level, so the ribbon shows when a region was ever tight, not its average.
const availabilityHistory: Handler = async (_req, env, url) => {
  const provider = url.searchParams.get("provider");
  const family = url.searchParams.get("family");
  if (!provider || !family)
    return json({ error: "provider and family are required" }, 400, {
      "cache-control": "no-store",
    });
  const days = intParam(url.searchParams, "days", 30, 1, 180);
  const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  const rows = await all<Omit<HistoryRow, "detail"> & { detail: string | null }>(
    env.DB,
    HISTORY_DAY_SQL,
    [provider, family, since],
  );
  const series = historyCells(
    rows.map((r) => ({
      ...r,
      detail: r.detail ? (JSON.parse(r.detail) as Record<string, unknown>) : null,
    })),
  );
  const allDays = [...new Set(rows.map((r) => r.day))].sort();
  return json({ provider, family, since, days: allDays, series });
};

// Hourly readings for one region and SKU, for the line beneath the ribbon.
const availabilitySeries: Handler = async (_req, env, url) => {
  const provider = url.searchParams.get("provider");
  const region = url.searchParams.get("region");
  const sku = url.searchParams.get("sku");
  if (!provider || !region || !sku)
    return json({ error: "provider, region, and sku are required" }, 400, {
      "cache-control": "no-store",
    });
  const days = intParam(url.searchParams, "days", 30, 1, 180);
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const rows = await all<{
    signal: string;
    observed_at: string;
    value: number;
    detail: string | null;
  }>(
    env.DB,
    `SELECT signal, observed_at, value, detail FROM availability_signal WHERE provider_slug = ? AND region_code = ? AND sku = ? AND observed_at >= ? ORDER BY observed_at`,
    [provider, region, sku, since],
  );
  return json({
    provider,
    region,
    sku,
    points: rows.map((r) => ({ ...r, detail: r.detail ? JSON.parse(r.detail) : null })),
  });
};

const exportCsv: Handler = async (_req, env, url) => {
  const f = queryFilters(url.searchParams);
  const { entities, rows } = await loadSites(env.DB, f);
  const byId = new Map(entities.map((e) => [e.id, e]));
  const sourceIds = [...new Set(rows.map((r) => r.source_id))];
  const sources = new Map<string, Source>();
  for (let i = 0; i < sourceIds.length; i += 80) {
    const chunk = sourceIds.slice(i, i + 80);
    for (const s of await all<Source>(
      env.DB,
      `SELECT * FROM source WHERE id IN (${chunk.map(() => "?").join(",")})`,
      chunk,
    ))
      sources.set(s.id, s);
  }
  const cols = [
    "observation_id",
    "provider",
    "entity",
    "entity_type",
    "parent_id",
    "country",
    "admin_area",
    "locality",
    "lat",
    "lon",
    "location_precision",
    "metric",
    "value",
    "value_low",
    "value_high",
    "unit",
    "value_original",
    "status",
    "scope",
    "claim_type",
    "effective_date",
    "effective_precision",
    "effective_kind",
    "recorded_at",
    "retrieved_at",
    "source_publisher",
    "source_title",
    "source_url",
    "source_tier",
    "source_published",
    "excerpt",
    "method_id",
    "supersedes_id",
    "review_status",
    "notes",
  ];
  const lines = [cols.join(",")];
  for (const r of rows) {
    const e = byId.get(r.entity_id)!;
    const s = sources.get(r.source_id);
    lines.push(
      [
        r.id,
        e.provider_slug,
        e.name,
        e.type,
        e.parent_id,
        e.country_code,
        e.admin_area,
        e.locality,
        e.lat,
        e.lon,
        e.location_precision,
        r.metric,
        r.value,
        r.value_low,
        r.value_high,
        r.unit,
        r.value_original,
        r.status,
        r.scope,
        r.claim_type,
        r.effective_date,
        r.effective_precision,
        r.effective_kind,
        r.recorded_at,
        r.retrieved_at,
        s?.publisher,
        s?.title,
        s?.url,
        s?.tier,
        s?.published_date,
        r.excerpt,
        r.method_id,
        r.supersedes_id,
        r.review_status,
        r.notes,
      ]
        .map(csvCell)
        .join(","),
    );
  }
  return new Response(lines.join("\n") + "\n", {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="cloud-atlas-observations.csv"`,
      "cache-control": "public, max-age=300",
    },
  });
};

const openapi: Handler = async (_req, _env, url) => {
  const filterParams = [
    {
      name: "provider",
      in: "query",
      schema: { type: "string" },
      description: "Comma-separated provider slugs",
    },
    {
      name: "country",
      in: "query",
      schema: { type: "string" },
      description: "Comma-separated ISO 3166-1 alpha-2 codes",
    },
    {
      name: "status",
      in: "query",
      schema: { type: "string" },
      description:
        "Comma-separated statuses: operational, under_construction, announced, cancelled, decommissioned, unknown",
    },
    { name: "claim", in: "query", schema: { type: "string", enum: ["reported", "derived"] } },
    {
      name: "tier",
      in: "query",
      schema: { type: "integer", minimum: 1, maximum: 4 },
      description: "Worst source tier to admit: 1 keeps official sources only, 4 keeps everything",
    },
    {
      name: "from",
      in: "query",
      schema: { type: "string" },
      description: "Earliest effective date (YYYY, YYYY-MM, or YYYY-MM-DD)",
    },
    { name: "to", in: "query", schema: { type: "string" }, description: "Latest effective date" },
    {
      name: "asof",
      in: "query",
      schema: { type: "string" },
      description: "Evaluate the selection rule as of this date",
    },
    {
      name: "mode",
      in: "query",
      schema: { type: "string", enum: ["known", "reconstructed"] },
      description:
        "known: only evidence recorded by asof; reconstructed: evidence describing reality by asof",
    },
    { name: "q", in: "query", schema: { type: "string" }, description: "Name or place search" },
    {
      name: "demo",
      in: "query",
      schema: { type: "string", enum: ["1"] },
      description: "Read the labelled demo dataset instead of live evidence",
    },
  ];
  const doc = {
    openapi: "3.1.0",
    info: {
      title: "Cloud Atlas API",
      version: "0.1.0",
      description:
        "Read-only access to Cloud Atlas evidence. Every capacity figure carries its source, effective date, recorded date, claim type, and review status. Totals are tracked capacity over documented sites, never a global estimate. IT power and facility power are never combined.",
      license: { name: "CC BY 4.0 for compiled data; each observation cites its own source" },
    },
    servers: [{ url: `${url.origin}/api` }],
    paths: {
      "/health": { get: { summary: "Liveness", responses: { "200": { description: "ok" } } } },
      "/meta": {
        get: {
          summary: "Providers, metrics, coverage counts, and per-adapter freshness",
          responses: { "200": { description: "Metadata" } },
        },
      },
      "/summary": {
        get: {
          summary: "Tracked totals per provider under the given filters",
          parameters: filterParams,
          responses: { "200": { description: "Totals" } },
        },
      },
      "/sites": {
        get: {
          summary: "Physical sites with their selected observation per metric",
          parameters: filterParams,
          responses: { "200": { description: "Sites" } },
        },
      },
      "/regions": {
        get: {
          summary: "Cloud regions with zone counts and launch dates; geography only",
          parameters: filterParams.slice(0, 1),
          responses: { "200": { description: "Regions" } },
        },
      },
      "/timeseries": {
        get: {
          summary: "Monthly tracked IT power per provider with new-site and revision counts",
          parameters: filterParams,
          responses: { "200": { description: "Series" } },
        },
      },
      "/entities/{id}": {
        get: {
          summary: "One entity with every accepted observation, its sources, and methods",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "Entity" }, "404": { description: "Unknown id" } },
        },
      },
      "/providers/{slug}": {
        get: {
          summary: "One provider: totals, sites, and provider-stated figures",
          parameters: [{ name: "slug", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "Provider" } },
        },
      },
      "/feed": {
        get: {
          summary: "Recent evidence, newest recorded first",
          parameters: [
            { name: "limit", in: "query", schema: { type: "integer", maximum: 200, default: 40 } },
            {
              name: "demo",
              in: "query",
              schema: { type: "string", enum: ["1"] },
              description: "Read the labelled demo dataset instead of live evidence",
            },
          ],
          responses: { "200": { description: "Feed" } },
        },
      },
      "/sources": {
        get: {
          summary: "Sources, fetch runs, and the count of items awaiting review",
          responses: { "200": { description: "Sources" } },
        },
      },
      "/availability": {
        get: {
          summary: "Latest availability signals with relative levels per provider and SKU family",
          parameters: filterParams.slice(0, 1),
          responses: { "200": { description: "Signals" } },
        },
      },
      "/availability/history": {
        get: {
          summary:
            "Daily level per region and SKU for one provider and family, worst hour of each day",
          parameters: [
            { name: "provider", in: "query", required: true, schema: { type: "string" } },
            { name: "family", in: "query", required: true, schema: { type: "string" } },
            {
              name: "days",
              in: "query",
              schema: { type: "integer", minimum: 1, maximum: 180, default: 30 },
            },
          ],
          responses: {
            "200": { description: "Daily cells" },
            "400": { description: "Missing provider or family" },
          },
        },
      },
      "/availability/series": {
        get: {
          summary: "Hourly readings for one region and SKU, one point per signal and probe",
          parameters: [
            { name: "provider", in: "query", required: true, schema: { type: "string" } },
            { name: "region", in: "query", required: true, schema: { type: "string" } },
            { name: "sku", in: "query", required: true, schema: { type: "string" } },
            {
              name: "days",
              in: "query",
              schema: { type: "integer", minimum: 1, maximum: 180, default: 30 },
            },
          ],
          responses: {
            "200": { description: "Readings" },
            "400": { description: "Missing provider, region, or sku" },
          },
        },
      },
      "/export.csv": {
        get: {
          summary: "Observations under the given filters as CSV with full provenance",
          parameters: filterParams,
          responses: { "200": { description: "CSV", content: { "text/csv": {} } } },
        },
      },
    },
  };
  return json(doc);
};

const NONE: readonly string[] = [];
const ROUTES: [RegExp, Handler, readonly string[]][] = [
  [/^\/api\/health$/, health, NONE],
  [/^\/api\/meta$/, meta, NONE],
  [/^\/api\/summary$/, summary, FILTER_PARAMS],
  [/^\/api\/sites$/, sites, FILTER_PARAMS],
  [/^\/api\/regions$/, regions, ["provider", "demo"]],
  [/^\/api\/timeseries$/, timeseries, FILTER_PARAMS],
  [/^\/api\/entities\/(?<id>[a-z0-9_]+)$/, entityDetail, NONE],
  [/^\/api\/providers\/(?<slug>[a-z0-9-]+)$/, providerDetail, FILTER_PARAMS],
  [/^\/api\/feed$/, feed, ["limit", "demo"]],
  [/^\/api\/sources$/, sources, NONE],
  [/^\/api\/availability$/, availability, ["provider"]],
  [/^\/api\/availability\/history$/, availabilityHistory, ["provider", "family", "days"]],
  [/^\/api\/availability\/series$/, availabilitySeries, ["provider", "region", "sku", "days"]],
  [/^\/api\/export\.csv$/, exportCsv, FILTER_PARAMS],
  [/^\/api\/openapi\.json$/, openapi, NONE],
];

// Public and keyless, so two guards: a per-client budget of 300 requests a minute, and the
// edge cache in front of D1 so repeated reads of one URL cost one query per five minutes.
export async function handleApi(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD")
    return json({ error: "method not allowed" }, 405, { allow: "GET, HEAD" });
  const url = new URL(request.url);
  const guarded = url.pathname !== "/api/health";
  if (guarded) {
    const key = request.headers.get("cf-connecting-ip") ?? "anonymous";
    const { success } = await env.API_RATE.limit({ key });
    if (!success) {
      return json({ error: "rate limited: 300 requests a minute per client" }, 429, {
        "retry-after": "60",
        "cache-control": "no-store",
      });
    }
  }
  for (const [pattern, handler, known] of ROUTES) {
    const m = pattern.exec(url.pathname);
    if (!m) continue;
    const cacheReq = new Request(cacheKey(url, known), { method: "GET" });
    if (guarded) {
      const hit = await caches.default.match(cacheReq);
      if (hit) return hit;
    }
    try {
      const res = await handler(request, env, url, m.groups ?? {});
      if (guarded && res.ok && request.method === "GET")
        ctx.waitUntil(caches.default.put(cacheReq, res.clone()));
      return res;
    } catch (err) {
      if (err instanceof BadRequest)
        return json({ error: err.message }, 400, { "cache-control": "no-store" });
      console.error("api.failed", url.pathname, err);
      return json({ error: "internal error" }, 500, { "cache-control": "no-store" });
    }
  }
  return notFound();
}
