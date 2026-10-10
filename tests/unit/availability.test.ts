import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { SqliteDb } from "../../pipeline/db";
import {
  HISTORY_DAY_SQL,
  historyCells,
  levelFor,
  measureFor,
  spotTerciles,
  worstLevel,
  type HistoryRow,
  type Readings,
} from "../../shared/availability";
import { memoryDb } from "./helpers";

const r = (partial: Readings): Readings => partial;
const terciles = { q33: 0.3, q66: 0.6 };

describe("availability levels", () => {
  test("direct verdicts outrank everything else", () => {
    expect(
      levelFor(
        r({
          capacity_report: { value: 0, detail: { status: "OUT_OF_HOST_CAPACITY" }, baseline: null },
          placement_score: { value: 9, detail: null, baseline: null },
        }),
        null,
      ),
    ).toBe("tight");
    expect(
      levelFor(
        r({
          sell_status: { value: 1, detail: null, baseline: null },
          spot_ratio: { value: 0.9, detail: null, baseline: null },
        }),
        terciles,
      ),
    ).toBe("available");
  });
  test("scores and lead times follow the documented thresholds", () => {
    expect(levelFor(r({ placement_score: { value: 7, detail: null, baseline: null } }), null)).toBe(
      "available",
    );
    expect(levelFor(r({ placement_score: { value: 4, detail: null, baseline: null } }), null)).toBe(
      "constrained",
    );
    expect(levelFor(r({ placement_score: { value: 3, detail: null, baseline: null } }), null)).toBe(
      "tight",
    );
    expect(levelFor(r({ lead_time_days: { value: 0, detail: null, baseline: null } }), null)).toBe(
      "available",
    );
    expect(levelFor(r({ lead_time_days: { value: 3, detail: null, baseline: null } }), null)).toBe(
      "constrained",
    );
    expect(
      levelFor(r({ lead_time_days: { value: 999, detail: null, baseline: null } }), null),
    ).toBe("tight");
  });
  test("market signals are relative within the family and fall back to offered", () => {
    expect(
      levelFor(r({ spot_ratio: { value: 0.2, detail: null, baseline: null } }), terciles),
    ).toBe("available");
    expect(
      levelFor(r({ spot_ratio: { value: 0.5, detail: null, baseline: null } }), terciles),
    ).toBe("constrained");
    expect(
      levelFor(r({ spot_ratio: { value: 0.8, detail: null, baseline: null } }), terciles),
    ).toBe("tight");
    expect(levelFor(r({ spot_ratio: { value: 0.8, detail: null, baseline: null } }), null)).toBe(
      "unknown",
    );
    expect(levelFor(r({ sku_offered: { value: 1, detail: null, baseline: null } }), null)).toBe(
      "offered",
    );
    expect(
      levelFor(r({ interruption_band: { value: 2, detail: null, baseline: null } }), null),
    ).toBe("constrained");
  });
});

describe("measurements shown beside a level", () => {
  test("each signal renders the provider's own number", () => {
    expect(
      measureFor(r({ interruption_band: { value: 4, detail: { label: ">20%" }, baseline: null } })),
    ).toBe("over 20%");
    expect(measureFor(r({ spot_ratio: { value: 0.185, detail: null, baseline: null } }))).toBe(
      "19% of list",
    );
    expect(measureFor(r({ placement_score: { value: 8, detail: null, baseline: null } }))).toBe(
      "score 8/10",
    );
    expect(measureFor(r({ lead_time_days: { value: 2, detail: null, baseline: null } }))).toBe(
      "starts in 2 days",
    );
    expect(measureFor(r({ lead_time_days: { value: 0, detail: null, baseline: null } }))).toBe(
      "starts now",
    );
    expect(measureFor(r({ sell_status: { value: 0, detail: null, baseline: null } }))).toBe(
      "sold out",
    );
    expect(measureFor(r({ sku_offered: { value: 1, detail: { zones: 3 }, baseline: null } }))).toBe(
      "3 zones",
    );
  });
  test("the worst level in a family wins", () => {
    const cells = [
      { level: "available" as const },
      { level: "tight" as const },
      { level: "constrained" as const },
    ];
    expect(worstLevel(cells)?.level).toBe("tight");
    expect(worstLevel([])).toBeNull();
  });
});

describe("daily history cells", () => {
  let db: SqliteDb;
  beforeEach(async () => {
    db = await memoryDb();
    await db.exec(
      "INSERT INTO source (id, publisher, title, url, tier) VALUES ('s', 'p', 't', 'https://example.test', 1);",
    );
  });
  afterEach(async () => {
    await db.close();
  });
  const sig = (
    id: string,
    signal: string,
    value: number,
    at: string,
    detail: Record<string, unknown> | null,
    zone: string | null = null,
    region = "us-east-1",
  ) =>
    db.exec(
      `INSERT INTO availability_signal VALUES ('${id}','aws','${region}',${zone ? `'${zone}'` : "NULL"},'p5.48xlarge','H100','${signal}',${value},'u','${at}','s',${detail ? `'${JSON.stringify(detail)}'` : "NULL"});`,
    );
  const history = async () => {
    const rows = await db.query<Omit<HistoryRow, "detail"> & { detail: string | null }>(
      HISTORY_DAY_SQL,
      ["aws", "H100", "2026-01-01"],
    );
    return historyCells(
      rows.map((r) => ({ ...r, detail: r.detail ? JSON.parse(r.detail) : null })),
    );
  };

  test("a day follows the smallest ask, then its worst hour, carrying that hour's detail", async () => {
    await sig("a", "placement_score", 9, "2026-06-01T10:00:00Z", { target_capacity: 8 });
    await sig("b", "placement_score", 2, "2026-06-01T10:00:00Z", { target_capacity: 64 });
    expect((await history())[0]!.days).toEqual([
      { day: "2026-06-01", level: "available", measure: "score 9/10", samples: 1 },
    ]);
    await sig("c", "placement_score", 5, "2026-06-01T11:00:00Z", { target_capacity: 8 });
    await sig("d", "placement_score", 1, "2026-06-01T11:00:00Z", { target_capacity: 64 });
    await sig("e", "placement_score", 8, "2026-06-02T11:00:00Z", { target_capacity: 8 });
    expect((await history())[0]!.days).toEqual([
      { day: "2026-06-01", level: "constrained", measure: "score 5/10", samples: 2 },
      { day: "2026-06-02", level: "available", measure: "score 8/10", samples: 1 },
    ]);
  });

  test("zones fold to the worst zone at the worst hour and the cell names it", async () => {
    await sig("a1", "sell_status", 1, "2026-06-01T10:00:00Z", { status: "Available" }, "a");
    await sig("b1", "sell_status", 1, "2026-06-01T10:00:00Z", { status: "Available" }, "b");
    await sig("a2", "sell_status", 1, "2026-06-01T11:00:00Z", { status: "Available" }, "a");
    await sig("b2", "sell_status", 0, "2026-06-01T11:00:00Z", { status: "SoldOut" }, "b");
    expect((await history())[0]!.days).toEqual([
      { day: "2026-06-01", level: "tight", measure: "sold out in b, 2 zones", samples: 2 },
    ]);
  });

  test("spot terciles are relative within the family on each day, as in the latest view", async () => {
    await sig("r1", "spot_ratio", 0.2, "2026-06-01T10:00:00Z", null, null, "r1");
    await sig("r2", "spot_ratio", 0.5, "2026-06-01T10:00:00Z", null, null, "r2");
    await sig("r3", "spot_ratio", 0.8, "2026-06-01T10:00:00Z", null, null, "r3");
    await sig("r1b", "spot_ratio", 0.9, "2026-06-02T10:00:00Z", null, null, "r1");
    await sig("r2b", "spot_ratio", 0.9, "2026-06-02T10:00:00Z", null, null, "r2");
    const cells = await history();
    expect(cells.map((c) => c.days.map((d) => d.level))).toEqual([
      ["available", "available"],
      ["constrained", "available"],
      ["tight"],
    ]);
    const t = spotTerciles([0.8, 0.2, 0.5])!;
    expect(levelFor({ spot_ratio: { value: 0.5, detail: null, baseline: null } }, t)).toBe(
      "constrained",
    );
  });
});

describe("merging rows for one region and SKU", () => {
  test("the smallest ask wins, then the worst zone, and the zone count rides along", async () => {
    const { mergeReading } = await import("../../shared/availability");
    const big = mergeReading(
      undefined,
      { signal: "placement_score", value: 3, detail: { target_capacity: 64 }, zone_code: null },
      null,
    );
    const small = mergeReading(
      big,
      { signal: "placement_score", value: 8, detail: { target_capacity: 8 }, zone_code: null },
      7.5,
    );
    expect(small.value).toBe(8);
    expect(small.baseline).toBe(7.5);
    expect(
      mergeReading(
        small,
        { signal: "placement_score", value: 2, detail: { target_capacity: 64 }, zone_code: null },
        null,
      ).value,
    ).toBe(8);

    const a = mergeReading(
      undefined,
      {
        signal: "sell_status",
        value: 1,
        detail: { status: "Available" },
        zone_code: "cn-hangzhou-h",
      },
      null,
    );
    const b = mergeReading(
      a,
      {
        signal: "sell_status",
        value: 0,
        detail: { status: "SoldOut" },
        zone_code: "cn-hangzhou-i",
      },
      null,
    );
    const c = mergeReading(
      b,
      {
        signal: "sell_status",
        value: 1,
        detail: { status: "Available" },
        zone_code: "cn-hangzhou-j",
      },
      null,
    );
    expect(c.value).toBe(0);
    expect(c.detail).toEqual({ status: "SoldOut", zone: "cn-hangzhou-i", zones: 3 });
    const { measureFor } = await import("../../shared/availability");
    expect(measureFor({ sell_status: c })).toBe("sold out in cn-hangzhou-i, 3 zones");
    expect(measureFor({ sell_status: a })).toBe("in stock");

    const lead = mergeReading(
      { value: 2, detail: { instance_count: 1 }, baseline: null },
      { signal: "lead_time_days", value: 5, detail: { instance_count: 1 }, zone_code: null },
      null,
    );
    expect(lead.value).toBe(5);
  });
});
