import { afterEach, beforeEach, expect, test } from "vitest";
import type { SqliteDb } from "../../pipeline/db";
import { pruneSignals } from "../../pipeline/retention";
import { memoryDb } from "./helpers";

let db: SqliteDb;
beforeEach(async () => {
  db = await memoryDb();
  await db.exec(
    "INSERT INTO source (id, publisher, title, url, tier, published_date, license, adapter) VALUES ('src_t', 'p', 't', 'https://example.test', 1, NULL, NULL, 'test');",
  );
});
afterEach(async () => {
  await db.close();
});

const row = (id: string, signal: string, value: number, at: string, zone = "z1", detail = "NULL") =>
  `INSERT INTO availability_signal VALUES ('${id}','aws','us-east-1','${zone}','p5.48xlarge','H100','${signal}',${value},'u','${at}','src_t',${detail});`;
const ask = (n: number) => `'{"target_capacity":${n},"instance_types":["p5.48xlarge"]}'`;

test("old hours collapse to the worst hour per zone and day; recent hours stay", async () => {
  const now = new Date("2026-10-09T12:00:00Z");
  await db.exec(
    [
      row("old1", "placement_score", 9, "2026-06-01T01:00:00Z"),
      row("old2", "placement_score", 3, "2026-06-01T07:00:00Z"),
      row("old3", "placement_score", 6, "2026-06-01T20:00:00Z"),
      row("old4", "placement_score", 1, "2026-06-01T05:00:00Z", "z2"),
      row("band1", "interruption_band", 1, "2026-06-01T01:00:00Z"),
      row("band2", "interruption_band", 3, "2026-06-01T13:00:00Z"),
      row("new1", "placement_score", 9, "2026-10-01T01:00:00Z"),
      row("new2", "placement_score", 2, "2026-10-01T02:00:00Z"),
    ].join("\n"),
  );
  const removed = await pruneSignals(db, now);
  expect(removed).toBe(3);
  const left = await db.query<{ id: string }>("SELECT id FROM availability_signal ORDER BY id");
  expect(left.map((r) => r.id)).toEqual(["band2", "new1", "new2", "old2", "old4"]);
});

test("each ask keeps its own worst hour", async () => {
  const now = new Date("2026-10-09T12:00:00Z");
  await db.exec(
    [
      row("s8a", "placement_score", 9, "2026-06-01T10:00:00Z", "z1", ask(8)),
      row("s8b", "placement_score", 7, "2026-06-01T11:00:00Z", "z1", ask(8)),
      row("s64a", "placement_score", 2, "2026-06-01T10:00:00Z", "z1", ask(64)),
      row("s64b", "placement_score", 4, "2026-06-01T11:00:00Z", "z1", ask(64)),
      row("l1", "lead_time_days", 1, "2026-06-01T10:00:00Z", "z1", `'{"instance_count":1}'`),
      row("l4", "lead_time_days", 3, "2026-06-01T10:00:00Z", "z1", `'{"instance_count":4}'`),
    ].join("\n"),
  );
  expect(await pruneSignals(db, now)).toBe(2);
  const left = await db.query<{ id: string }>("SELECT id FROM availability_signal ORDER BY id");
  expect(left.map((r) => r.id)).toEqual(["l1", "l4", "s64a", "s8b"]);
});

test("a second pass removes nothing", async () => {
  const now = new Date("2026-10-09T12:00:00Z");
  await db.exec(
    [
      row("a", "sell_status", 1, "2026-05-01T01:00:00Z"),
      row("b", "sell_status", 0, "2026-05-01T02:00:00Z"),
    ].join("\n"),
  );
  expect(await pruneSignals(db, now)).toBe(1);
  expect(await pruneSignals(db, now)).toBe(0);
  const left = await db.query<{ id: string }>("SELECT id FROM availability_signal");
  expect(left.map((r) => r.id)).toEqual(["b"]);
});
