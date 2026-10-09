import { describe, expect, test } from "vitest";
import {
  facilityToItMw,
  parseAreaSqft,
  parseLandAcres,
  parseMetric,
  parseMoneyUsd,
  parsePowerMw,
} from "../../shared/metrics";
import { dateCeil, dateFloor, datePrecision, daysBetween } from "../../shared/dates";
import { slugify, stableId } from "../../shared/ids";

describe("power parsing", () => {
  test("gigawatts become megawatts", () => {
    expect(parsePowerMw("1.2 GW")).toEqual({ value: 1200, unit: "MW" });
    expect(parsePowerMw("a 2-gigawatt campus")).toEqual({ value: 2000, unit: "MW" });
  });
  test("megawatts and kilowatts", () => {
    expect(parsePowerMw("960 megawatts")).toEqual({ value: 960, unit: "MW" });
    expect(parsePowerMw("300MW")).toEqual({ value: 300, unit: "MW" });
    expect(parsePowerMw("500 kW")).toEqual({ value: 0.5, unit: "MW" });
  });
  test("thousands separators", () => {
    expect(parsePowerMw("1,200 MW")).toEqual({ value: 1200, unit: "MW" });
  });
  test("no unit is not a power figure", () => {
    expect(parsePowerMw("300")).toBeNull();
    expect(parsePowerMw("no number")).toBeNull();
  });
});

describe("other units", () => {
  test("area", () => {
    expect(parseAreaSqft("1,000,000 sq ft")).toEqual({ value: 1_000_000, unit: "sq ft" });
    expect(parseAreaSqft("10,000 square metres")?.value).toBe(107639);
  });
  test("land", () => {
    expect(parseLandAcres("1,030 acres")).toEqual({ value: 1030, unit: "acres" });
    expect(parseLandAcres("100 hectares")?.value).toBeCloseTo(247.1, 1);
  });
  test("money", () => {
    expect(parseMoneyUsd("$10 billion")).toEqual({ value: 1e10, unit: "USD" });
    expect(parseMoneyUsd("$3.3bn")).toEqual({ value: 3.3e9, unit: "USD" });
    expect(parseMoneyUsd("$750 million")).toEqual({ value: 7.5e8, unit: "USD" });
  });
  test("dispatch by metric", () => {
    expect(parseMetric("it_power_mw", "100 MW")?.value).toBe(100);
    expect(parseMetric("az_count", "117 Availability Zones")?.value).toBe(117);
  });
});

describe("derived IT power", () => {
  test("divides by PUE", () => {
    expect(facilityToItMw(130, 1.3)).toBe(100);
  });
  test("rejects impossible PUE", () => {
    expect(() => facilityToItMw(100, 0.9)).toThrow();
  });
});

describe("dates", () => {
  test("precision", () => {
    expect(datePrecision("2025-09-18")).toBe("day");
    expect(datePrecision("2025-09")).toBe("month");
    expect(datePrecision("2025")).toBe("year");
    expect(datePrecision("Sept 2025")).toBeNull();
  });
  test("floor and ceil", () => {
    expect(dateFloor("2025")).toBe("2025-01-01");
    expect(dateCeil("2025")).toBe("2025-12-31");
    expect(dateCeil("2024-02")).toBe("2024-02-29");
  });
  test("days between", () => {
    expect(daysBetween("2025-01-01", "2025-01-31")).toBe(30);
  });
});

describe("ids", () => {
  test("stable across calls and sensitive to input", async () => {
    const a = await stableId("obs", ["x", 1, null]);
    const b = await stableId("obs", ["x", 1, null]);
    const c = await stableId("obs", ["x", 1, ""]);
    expect(a).toBe(b);
    expect(a).toBe(c);
    expect(await stableId("obs", ["x", 2, null])).not.toBe(a);
    expect(a).toMatch(/^obs_[0-9a-f]{16}$/);
  });
  test("slugify", () => {
    expect(slugify("US East (N. Virginia)")).toBe("us-east-n-virginia");
    expect(slugify("Saint-Ghislain, Belgium")).toBe("saint-ghislain-belgium");
  });
});
