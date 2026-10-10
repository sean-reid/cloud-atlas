import { describe, expect, test } from "vitest";
import { ensureSource } from "../../pipeline/entities";
import { Store } from "../../pipeline/store";
import type { Entity, Observation, Source } from "../../shared/types";
import { memoryDb } from "./db";

const entity: Entity = {
  id: "ent_a",
  dataset: "live",
  type: "campus",
  provider_slug: "aws",
  parent_id: null,
  name: "Test campus",
  slug: "test-campus",
  code: null,
  country_code: "US",
  admin_area: null,
  locality: "O'Fallon",
  lat: null,
  lon: null,
  location_precision: "unknown",
  ownership: "unknown",
  landlord: null,
};
const source: Source = {
  id: "src_a",
  publisher: "Test",
  title: "Test page",
  url: "https://example.com/a",
  tier: 4,
  published_date: null,
  license: null,
  adapter: null,
};
const obs = (id: string, recorded: string): Observation => ({
  id,
  dataset: "live",
  entity_id: "ent_a",
  metric: "it_power_mw",
  value: 100,
  value_low: null,
  value_high: null,
  unit: "MW",
  value_original: "100 MW",
  status: "operational",
  scope: "campus",
  claim_type: "reported",
  effective_date: "2025-01",
  effective_precision: "month",
  effective_kind: "as_of",
  recorded_at: recorded,
  retrieved_at: recorded,
  source_id: "src_a",
  excerpt: "it's 'quoted'",
  locator: null,
  method_id: null,
  derived_from: null,
  supersedes_id: null,
  review_status: "accepted",
  notes: null,
});

describe("evidence store over D1", () => {
  test("append is idempotent, written through, and survives a reopen", async () => {
    const db = await memoryDb();
    const s = await Store.open(db, "live");
    await s.upsertEntity(entity);
    await s.upsertSource(source);
    expect(await s.appendObservation(obs("obs_1", "2026-01-01T00:00:00Z"))).toBe(true);
    expect(await s.appendObservation(obs("obs_1", "2026-01-01T00:00:00Z"))).toBe(false);
    expect(await s.appendObservation(obs("obs_2", "2026-02-01T00:00:00Z"))).toBe(true);
    await s.flush();
    const again = await Store.open(db, "live");
    expect(again.observations.size).toBe(2);
    expect(again.entities.get("ent_a")?.locality).toBe("O'Fallon");
    expect(again.observations.get("obs_1")?.excerpt).toBe("it's 'quoted'");
    expect(await again.appendObservation(obs("obs_2", "2026-02-01T00:00:00Z"))).toBe(false);
    expect(again.latestObservationFor("ent_a", "it_power_mw")?.id).toBe("obs_2");
    const rows = await db.query("SELECT COUNT(*) AS n FROM observation");
    expect(rows[0]!.n).toBe(2);
  });

  test("refuses dangling references", async () => {
    const db = await memoryDb();
    const s = await Store.open(db, "live");
    await expect(s.appendObservation(obs("obs_1", "2026-01-01T00:00:00Z"))).rejects.toThrow(
      /unknown entity/,
    );
    await s.upsertEntity(entity);
    await expect(s.appendObservation(obs("obs_1", "2026-01-01T00:00:00Z"))).rejects.toThrow(
      /unknown source/,
    );
  });

  test("datasets are separate", async () => {
    const db = await memoryDb();
    const live = await Store.open(db, "live");
    await live.upsertEntity(entity);
    await live.flush();
    const demo = await Store.open(db, "demo");
    expect(demo.entities.size).toBe(0);
    expect((await Store.open(db, "live")).entities.size).toBe(1);
  });

  test("review items resolve in place and fetch runs are capped", async () => {
    const db = await memoryDb();
    const s = await Store.open(db, "live");
    await s.queueReview({
      id: "rev_1",
      created_at: "2026-01-01T00:00:00Z",
      adapter: "t",
      reason: "r",
      payload: "{}",
      resolved_at: null,
      resolution: null,
    });
    await s.resolveReview("rev_1", "done", "2026-01-02T00:00:00Z");
    await s.flush();
    const r = await db.query("SELECT resolution FROM review_item WHERE id = 'rev_1'");
    expect(r[0]!.resolution).toBe("done");
    for (let i = 0; i < 510; i++) {
      await s.appendFetchRun({
        adapter: "t",
        url: "https://x",
        started_at: `2026-01-01T00:${String(i % 60).padStart(2, "0")}:${String(Math.floor(i / 60)).padStart(2, "0")}Z`,
        finished_at: "x",
        ok: true,
        http_status: 200,
        content_hash: null,
        changed: false,
        observations: 0,
        error: null,
      });
    }
    await s.flush();
    const n = await db.query("SELECT COUNT(*) AS n FROM fetch_run");
    expect(n[0]!.n).toBe(500);
  });
});

describe("source identity", () => {
  test("two adapters never share a source row", async () => {
    const db = await memoryDb();
    const s = await Store.open(db, "live");
    const a = await ensureSource(s, {
      publisher: "A",
      title: "A",
      url: "https://a.example/x",
      tier: 1,
      published_date: null,
      license: null,
      adapter: "a",
    });
    const b = await ensureSource(s, {
      publisher: "B",
      title: "B",
      url: "https://b.example/y",
      tier: 1,
      published_date: null,
      license: null,
      adapter: "b",
    });
    expect(a.id).not.toBe(b.id);
    expect(a.id).toMatch(/^src_/);
    expect(s.sources.size).toBe(2);
  });
});
