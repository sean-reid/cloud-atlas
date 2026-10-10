import { describe, expect, test } from "vitest";
import { providerTotals, selectSites } from "../../shared/aggregate";
import { selectObservation, type Candidate } from "../../shared/selection";
import type { Entity } from "../../shared/types";

const base: Candidate = {
  id: "o1",
  dataset: "live",
  entity_id: "e1",
  metric: "it_power_mw",
  value: 100,
  value_low: null,
  value_high: null,
  unit: "MW",
  value_original: null,
  status: "operational",
  scope: "campus",
  claim_type: "reported",
  effective_date: "2025-01",
  effective_precision: "month",
  effective_kind: "as_of",
  recorded_at: "2026-01-01T00:00:00Z",
  retrieved_at: "2026-01-01T00:00:00Z",
  source_id: "s1",
  excerpt: null,
  locator: null,
  method_id: null,
  derived_from: null,
  supersedes_id: null,
  review_status: "accepted",
  notes: null,
  tier: 4,
};
const c = (over: Partial<Candidate>): Candidate => ({ ...base, ...over });

describe("selection rule", () => {
  test("latest effective date wins, competing observations are kept", () => {
    const s = selectObservation(
      [
        c({ id: "a", effective_date: "2024", value: 50 }),
        c({ id: "b", effective_date: "2025-06", value: 120 }),
      ],
      null,
      "known",
    )!;
    expect(s.pick.id).toBe("b");
    expect(s.competing.map((o) => o.id)).toEqual(["a"]);
    expect(s.disagreement).toBe(false);
  });
  test("same date: better tier, then reported over derived", () => {
    const s = selectObservation(
      [
        c({ id: "press", tier: 4, value: 300 }),
        c({ id: "official", tier: 1, value: 280 }),
        c({ id: "model", tier: 3, claim_type: "derived", value: 310 }),
      ],
      null,
      "known",
    )!;
    expect(s.pick.id).toBe("official");
    expect(s.disagreement).toBe(true);
  });
  test("superseded observations are hidden but not deleted", () => {
    const s = selectObservation(
      [
        c({ id: "old", value: 100 }),
        c({ id: "new", value: 90, supersedes_id: "old", recorded_at: "2026-02-01T00:00:00Z" }),
      ],
      null,
      "known",
    )!;
    expect(s.pick.id).toBe("new");
    expect(s.competing).toHaveLength(0);
  });
  test("pending observations never reach the dashboard", () => {
    expect(selectObservation([c({ review_status: "pending" })], null, "known")).toBeNull();
  });
  test("known-at excludes what was recorded later; reconstructed includes it", () => {
    const rows = [
      c({ id: "early", effective_date: "2024-05", recorded_at: "2026-01-01T00:00:00Z", value: 10 }),
      c({ id: "late", effective_date: "2024-06", recorded_at: "2026-03-01T00:00:00Z", value: 20 }),
    ];
    expect(selectObservation(rows, "2026-02-01", "known")!.pick.id).toBe("early");
    expect(selectObservation(rows, "2026-02-01", "reconstructed")!.pick.id).toBe("late");
    expect(selectObservation(rows, "2024-05-20", "reconstructed")!.pick.id).toBe("early");
    expect(selectObservation(rows, "2023-12-31", "reconstructed")).toBeNull();
  });
});

const ent = (
  id: string,
  type: Entity["type"],
  parent: string | null,
  lat: number | null = 1,
): Entity => ({
  id,
  dataset: "live",
  type,
  provider_slug: "aws",
  parent_id: parent,
  name: id,
  slug: id,
  code: null,
  country_code: "US",
  admin_area: null,
  locality: null,
  lat,
  lon: lat,
  location_precision: lat === null ? "unknown" : "locality",
  ownership: "owned",
  landlord: null,
});

describe("aggregation without double counting", () => {
  const entities = [
    ent("campus", "campus", null),
    ent("b1", "facility", "campus"),
    ent("b2", "facility", "campus"),
    ent("other", "campus", null, null),
    ent("region", "region", null),
  ];
  test("a campus total covers its buildings; a campus without a total sums them", () => {
    const rows = [
      c({ id: "c", entity_id: "campus", value: 300 }),
      c({ id: "b1", entity_id: "b1", value: 100 }),
      c({ id: "b2", entity_id: "b2", value: 100 }),
      c({ id: "o1", entity_id: "other", value: 40 }),
      c({ id: "r", entity_id: "region", value: 999 }),
    ];
    const totals = providerTotals(entities, selectSites(entities, rows, null, "known"));
    expect(totals[0]!.it_power_mw).toBe(340);
    expect(totals[0]!.it_sites).toBe(2);
    expect(totals[0]!.located_sites).toBe(3);
    const noCampus = providerTotals(
      entities,
      selectSites(
        entities,
        rows.filter((r) => r.id !== "c"),
        null,
        "known",
      ),
    );
    expect(noCampus[0]!.it_power_mw).toBe(240);
  });
  test("IT and facility power stay apart; pipeline is separate from operational", () => {
    const rows = [
      c({ id: "it", entity_id: "campus", value: 300 }),
      c({ id: "fac", entity_id: "campus", metric: "facility_power_mw", value: 400 }),
      c({ id: "ofac", entity_id: "other", metric: "facility_power_mw", value: 50 }),
      c({ id: "plan", entity_id: "other", value: 900, status: "announced" }),
    ];
    const t = providerTotals(entities, selectSites(entities, rows, null, "known"))[0]!;
    expect(t.it_power_mw).toBe(300);
    expect(t.facility_only_power_mw).toBe(50);
    expect(t.pipeline_it_power_mw.announced).toBe(900);
    expect(t.pipeline_it_power_mw.operational).toBe(0);
  });
  test("a campus with an IT figure covers a building that reports facility power", () => {
    const rows = [
      c({ id: "cit", entity_id: "campus", value: 300 }),
      c({ id: "bfac", entity_id: "b1", metric: "facility_power_mw", value: 120 }),
      c({
        id: "bplan",
        entity_id: "b2",
        metric: "facility_power_mw",
        value: 80,
        status: "announced",
      }),
    ];
    const t = providerTotals(entities, selectSites(entities, rows, null, "known"))[0]!;
    expect(t.it_power_mw).toBe(300);
    expect(t.it_sites).toBe(1);
    expect(t.facility_only_power_mw).toBe(0);
    expect(t.facility_only_sites).toBe(0);
    expect(t.pipeline_facility_only_power_mw.announced).toBe(80);
  });
  test("unknown is not zero: an entity without observations adds nothing and is not counted as a site", () => {
    const t = providerTotals(
      entities,
      selectSites(entities, [c({ id: "x", entity_id: "campus", value: null })], null, "known"),
    );
    expect(t).toHaveLength(0);
  });
});
