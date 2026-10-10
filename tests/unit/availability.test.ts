import { describe, expect, test } from "vitest";
import { levelFor, measureFor, worstLevel, type Readings } from "../../shared/availability";

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
  test("the worst hour decides the day, by direction of each signal", async () => {
    const { dayCells, worstOfDay } = await import("../../shared/availability");
    expect(worstOfDay("spot_ratio", 0.2, 0.9)).toBe(0.9);
    expect(worstOfDay("placement_score", 3, 9)).toBe(3);
    const cells = dayCells(
      [
        { day: "2026-10-09", signal: "spot_ratio", min: 0.2, max: 0.9, samples: 24, detail: null },
        { day: "2026-10-10", signal: "spot_ratio", min: 0.1, max: 0.25, samples: 20, detail: null },
        { day: "2026-10-08", signal: "placement_score", min: 2, max: 9, samples: 24, detail: null },
      ],
      { q33: 0.3, q66: 0.6 },
    );
    expect(cells.map((c) => c.day)).toEqual(["2026-10-08", "2026-10-09", "2026-10-10"]);
    expect(cells.map((c) => c.level)).toEqual(["tight", "tight", "available"]);
    expect(cells[1]!.measure).toBe("90% of list");
    expect(cells[0]!.measure).toBe("score 2/10");
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

    const lead = mergeReading(
      { value: 2, detail: { instance_count: 1 }, baseline: null },
      { signal: "lead_time_days", value: 5, detail: { instance_count: 1 }, zone_code: null },
      null,
    );
    expect(lead.value).toBe(5);
  });
});
