import { afterEach, beforeEach, expect, test } from "vitest";
import type { SqliteDb } from "../../pipeline/db";
import { effectiveDateRange } from "../../shared/filters";
import { memoryDb } from "./helpers";

let db: SqliteDb;
beforeEach(async () => {
  db = await memoryDb();
  await db.exec(
    `INSERT INTO source (id, publisher, title, url, tier) VALUES ('s', 'p', 't', 'https://example.test', 1);
     INSERT INTO entity (id, type, provider_slug, name, slug) VALUES ('e', 'campus', 'aws', 'e', 'e');`,
  );
  const obs = (id: string, date: string, precision: string) =>
    `INSERT INTO observation (id, entity_id, metric, value, unit, status, scope, claim_type, effective_date, effective_precision, effective_kind, recorded_at, retrieved_at, source_id)
     VALUES ('${id}', 'e', 'it_power_mw', 1, 'MW', 'operational', 'campus', 'reported', '${date}', '${precision}', 'as_of', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 's');`;
  await db.exec(
    [
      obs("year", "2025", "year"),
      obs("month", "2025-06", "month"),
      obs("day", "2025-06-15", "day"),
    ].join("\n"),
  );
});
afterEach(async () => {
  await db.close();
});

const matching = async (from: string, to: string) => {
  const r = effectiveDateRange({ from, to });
  const sql = `SELECT id FROM observation o${r.where.length ? ` WHERE ${r.where.join(" AND ")}` : ""} ORDER BY id`;
  return (await db.query<{ id: string }>(sql, r.params)).map((x) => x.id);
};

const ALL = ["day", "month", "year"];

test("a bound at any precision keeps every row whose period may reach it", async () => {
  for (const from of ["2025", "2025-06", "2025-06-15", "2025-01-01", "2025-06-01"])
    expect(await matching(from, ""), `from=${from}`).toEqual(ALL);
  for (const to of ["2025", "2025-06", "2025-06-15", "2025-12-31", "2025-06-30"])
    expect(await matching("", to), `to=${to}`).toEqual(ALL);
  expect(await matching("2025-06", "2025-06")).toEqual(ALL);
});

test("a bound past a row's own period drops it and keeps the coarser rows", async () => {
  expect(await matching("2025-06-16", "")).toEqual(["month", "year"]);
  expect(await matching("2025-07", "")).toEqual(["year"]);
  expect(await matching("2026", "")).toEqual([]);
  expect(await matching("", "2025-06-14")).toEqual(["month", "year"]);
  expect(await matching("", "2025-05")).toEqual(["year"]);
  expect(await matching("", "2024")).toEqual([]);
  expect(await matching("2025-07-01", "2025-07-31")).toEqual(["year"]);
});

test("a bound that is not a date is ignored rather than compared as text", async () => {
  expect(effectiveDateRange({ from: "soon", to: "" }).where).toEqual([]);
  expect(await matching("soon", "later")).toEqual(ALL);
});
