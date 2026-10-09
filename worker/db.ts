import type { Filters } from "../shared/filters";
import type { Candidate } from "../shared/selection";
import type { Entity } from "../shared/types";

export async function all<T>(db: D1Database, sql: string, params: unknown[] = []): Promise<T[]> {
  const res = await db
    .prepare(sql)
    .bind(...params)
    .all<T>();
  return res.results;
}

export async function one<T>(
  db: D1Database,
  sql: string,
  params: unknown[] = [],
): Promise<T | null> {
  const res = await db
    .prepare(sql)
    .bind(...params)
    .first<T>();
  return res ?? null;
}

const placeholders = (n: number) => Array.from({ length: n }, () => "?").join(",");

// Physical entities and their candidate observations for the current filters. Selection and
// aggregation happen in TypeScript so the same rules serve the API, the export, and tests.
export async function loadSites(
  db: D1Database,
  f: Filters,
): Promise<{ entities: Entity[]; rows: Candidate[] }> {
  const dataset = f.demo ? "demo" : "live";
  const where: string[] = ["e.dataset = ?", "e.type IN ('campus','facility','phase')"];
  const params: unknown[] = [dataset];
  if (f.providers.length) {
    where.push(`e.provider_slug IN (${placeholders(f.providers.length)})`);
    params.push(...f.providers);
  }
  if (f.countries.length) {
    where.push(`e.country_code IN (${placeholders(f.countries.length)})`);
    params.push(...f.countries);
  }
  if (f.precision) {
    where.push("e.location_precision = ?");
    params.push(f.precision);
  }
  if (f.q) {
    where.push("(e.name LIKE ? OR e.locality LIKE ? OR e.admin_area LIKE ?)");
    const like = `%${f.q}%`;
    params.push(like, like, like);
  }
  const entities = await all<Entity>(
    db,
    `SELECT e.* FROM entity e WHERE ${where.join(" AND ")}`,
    params,
  );
  if (!entities.length) return { entities, rows: [] };

  const obsWhere: string[] = ["o.dataset = ?", "o.review_status = 'accepted'"];
  const obsParams: unknown[] = [dataset];
  if (f.statuses.length) {
    obsWhere.push(`o.status IN (${placeholders(f.statuses.length)})`);
    obsParams.push(...f.statuses);
  }
  if (f.claim) {
    obsWhere.push("o.claim_type = ?");
    obsParams.push(f.claim);
  }
  if (f.tier) {
    obsWhere.push("s.tier <= ?");
    obsParams.push(f.tier);
  }
  if (f.from) {
    obsWhere.push("o.effective_date >= ?");
    obsParams.push(f.from);
  }
  if (f.to) {
    obsWhere.push("o.effective_date <= ?");
    obsParams.push(f.to);
  }
  const rows: Candidate[] = [];
  // D1 caps bound parameters per statement, so entity ids go in chunks.
  const ids = entities.map((e) => e.id);
  for (let i = 0; i < ids.length; i += 80) {
    const chunk = ids.slice(i, i + 80);
    const sql = `SELECT o.*, s.tier FROM observation o JOIN source s ON s.id = o.source_id
      WHERE ${obsWhere.join(" AND ")} AND o.entity_id IN (${placeholders(chunk.length)})`;
    rows.push(...(await all<Candidate>(db, sql, [...obsParams, ...chunk])));
  }
  return { entities, rows };
}
