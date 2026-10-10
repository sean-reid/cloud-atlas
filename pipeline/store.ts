import type {
  AvailabilitySignal,
  Dataset,
  Entity,
  FeedItem,
  FetchRun,
  Method,
  Observation,
  ReviewItem,
  Source,
} from "../shared/types";
import { PROVIDERS } from "../shared/providers";
import { Batch, lit, type Db, type Row } from "./db";

export const FETCH_RUN_RETENTION = 500;

const row = <T>(r: Row): T => r as unknown as T;

function insertSql(table: string, obj: object): string {
  const rec = obj as Record<string, string | number | boolean | null | undefined>;
  const cols = Object.keys(rec);
  return `INSERT OR IGNORE INTO ${table} (${cols.join(",")}) VALUES (${cols.map((c) => lit(rec[c])).join(",")});`;
}

// An upsert that updates in place; REPLACE would delete the row and break every reference to it.
function upsertSql(table: string, key: string, obj: object): string {
  const rec = obj as Record<string, string | number | boolean | null | undefined>;
  const cols = Object.keys(rec);
  const sets = cols.filter((c) => c !== key).map((c) => `${c} = excluded.${c}`);
  return `INSERT INTO ${table} (${cols.join(",")}) VALUES (${cols.map((c) => lit(rec[c])).join(",")}) ON CONFLICT(${key}) DO UPDATE SET ${sets.join(", ")};`;
}

// The evidence store over D1. Reference tables are loaded into memory on open so adapters can
// resolve entities synchronously; every mutation is written through in batches. Observations,
// signals, and fetch runs are append only.
export class Store {
  readonly entities = new Map<string, Entity>();
  readonly sources = new Map<string, Source>();
  readonly methods = new Map<string, Method>();
  readonly observations = new Map<string, Observation>();
  readonly review = new Map<string, ReviewItem>();
  readonly feedItems = new Map<string, FeedItem>();
  readonly signalIds = new Set<string>();
  readonly regionProvidersAtOpen = new Set<string>();
  aliases = new Map<string, string>();
  decisions = new Map<string, string>();
  fetchRuns: FetchRun[] = [];
  private readonly batch: Batch;
  private added = { observations: 0, signals: 0, entities: 0, review: 0 };

  private constructor(
    readonly db: Db,
    readonly dataset: Dataset,
  ) {
    this.batch = new Batch(db);
  }

  static async open(db: Db, dataset: Dataset, now: Date = new Date()): Promise<Store> {
    const s = new Store(db, dataset);
    for (const p of PROVIDERS) {
      await s.batch.add(
        upsertSql("provider", "slug", {
          slug: p.slug,
          name: p.name,
          short_name: p.shortName,
          company: p.company,
          category: p.category,
          color: p.color,
        }),
      );
    }
    await s.batch.flush();
    for (const r of await db.query("SELECT * FROM entity WHERE dataset = ?", [dataset])) {
      const e = row<Entity>(r);
      s.entities.set(e.id, e);
      if (e.type === "region") s.regionProvidersAtOpen.add(e.provider_slug);
    }
    for (const r of await db.query("SELECT * FROM source"))
      s.sources.set(String(r.id), row<Source>(r));
    for (const r of await db.query("SELECT * FROM method"))
      s.methods.set(String(r.id), row<Method>(r));
    for (const r of await db.query("SELECT * FROM observation WHERE dataset = ?", [dataset]))
      s.observations.set(String(r.id), row<Observation>(r));
    for (const r of await db.query("SELECT * FROM review_item"))
      s.review.set(String(r.id), row<ReviewItem>(r));
    for (const r of await db.query("SELECT * FROM feed_item"))
      s.feedItems.set(String(r.link), row<FeedItem>(r));
    const since = new Date(now.getTime() - 48 * 3_600_000).toISOString();
    for (const r of await db.query("SELECT id FROM availability_signal WHERE observed_at >= ?", [
      since,
    ]))
      s.signalIds.add(String(r.id));
    s.fetchRuns = (
      await db.query(
        `SELECT * FROM fetch_run ORDER BY started_at DESC LIMIT ${FETCH_RUN_RETENTION}`,
      )
    )
      .map((r) => ({ ...row<FetchRun>(r), ok: !!r.ok, changed: !!r.changed }))
      .reverse();
    return s;
  }

  async upsertEntity(e: Entity): Promise<Entity> {
    if (!this.entities.has(e.id)) this.added.entities++;
    const prev = this.entities.get(e.id);
    if (JSON.stringify(prev) !== JSON.stringify(e))
      await this.batch.add(upsertSql("entity", "id", e));
    this.entities.set(e.id, e);
    return e;
  }

  async upsertSource(s: Source): Promise<Source> {
    if (JSON.stringify(this.sources.get(s.id)) !== JSON.stringify(s))
      await this.batch.add(upsertSql("source", "id", s));
    this.sources.set(s.id, s);
    return s;
  }

  async upsertMethod(m: Method): Promise<Method> {
    if (JSON.stringify(this.methods.get(m.id)) !== JSON.stringify(m))
      await this.batch.add(upsertSql("method", "id", m));
    this.methods.set(m.id, m);
    return m;
  }

  // Returns false when an identical observation already exists, so a rerun is a no-op.
  async appendObservation(o: Observation): Promise<boolean> {
    if (this.observations.has(o.id)) return false;
    if (!this.entities.has(o.entity_id))
      throw new Error(`observation ${o.id} names unknown entity ${o.entity_id}`);
    if (!this.sources.has(o.source_id))
      throw new Error(`observation ${o.id} names unknown source ${o.source_id}`);
    if (o.supersedes_id && !this.observations.has(o.supersedes_id)) {
      throw new Error(`observation ${o.id} supersedes unknown ${o.supersedes_id}`);
    }
    await this.batch.add(insertSql("observation", o));
    this.observations.set(o.id, o);
    this.added.observations++;
    return true;
  }

  async appendSignal(g: AvailabilitySignal): Promise<boolean> {
    if (this.signalIds.has(g.id)) return false;
    await this.batch.add(insertSql("availability_signal", g));
    this.signalIds.add(g.id);
    this.added.signals++;
    return true;
  }

  async appendFetchRun(run: FetchRun): Promise<void> {
    this.fetchRuns.push(run);
    await this.batch.add(
      insertSql("fetch_run", { ...run, ok: run.ok ? 1 : 0, changed: run.changed ? 1 : 0 }),
    );
    await this.batch.add(
      `DELETE FROM fetch_run WHERE id NOT IN (SELECT id FROM fetch_run ORDER BY started_at DESC LIMIT ${FETCH_RUN_RETENTION});`,
    );
  }

  // A recorded decision lands the item already resolved, so the queue only shows new questions.
  async queueReview(item: ReviewItem): Promise<boolean> {
    if (this.review.has(item.id)) return false;
    const decided = this.decisions.get(item.id);
    const row = decided ? { ...item, resolved_at: item.created_at, resolution: decided } : item;
    await this.batch.add(insertSql("review_item", row));
    this.review.set(item.id, row);
    if (!decided) this.added.review++;
    return !decided;
  }

  // One row per feed entry ever read, so a rerun skips it whatever the first outcome was.
  async recordFeedItem(item: FeedItem): Promise<boolean> {
    if (this.feedItems.has(item.link)) return false;
    await this.batch.add(insertSql("feed_item", item));
    this.feedItems.set(item.link, item);
    return true;
  }

  async resolveReview(id: string, resolution: string, at: string): Promise<void> {
    const item = this.review.get(id);
    if (!item || item.resolved_at) return;
    item.resolved_at = at;
    item.resolution = resolution;
    await this.batch.add(
      `UPDATE review_item SET resolved_at = ${lit(at)}, resolution = ${lit(resolution)} WHERE id = ${lit(id)};`,
    );
  }

  async setReviewStatus(
    observationId: string,
    status: Observation["review_status"],
  ): Promise<void> {
    const o = this.observations.get(observationId);
    if (!o || o.review_status === status) return;
    o.review_status = status;
    await this.batch.add(
      `UPDATE observation SET review_status = ${lit(status)} WHERE id = ${lit(observationId)};`,
    );
  }

  summary(): { observations: number; signals: number; entities: number; review: number } {
    return { ...this.added };
  }

  latestObservationFor(entityId: string, metric: string): Observation | undefined {
    let best: Observation | undefined;
    for (const o of this.observations.values()) {
      if (o.entity_id !== entityId || o.metric !== metric) continue;
      if (!best || o.recorded_at > best.recorded_at) best = o;
    }
    return best;
  }

  async flush(): Promise<void> {
    await this.batch.flush();
  }
}
