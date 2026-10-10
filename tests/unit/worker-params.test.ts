import { describe, expect, test } from "vitest";
import { BadRequest, dateParam, intParam, queryFilters } from "../../worker/params";

const q = (s: string) => new URLSearchParams(s);

describe("intParam", () => {
  test("defaults when absent and accepts whole numbers in range", () => {
    expect(intParam(q(""), "limit", 40, 1, 200)).toBe(40);
    expect(intParam(q("limit="), "limit", 40, 1, 200)).toBe(40);
    expect(intParam(q("limit=12"), "limit", 40, 1, 200)).toBe(12);
    expect(intParam(q("days=180"), "days", 30, 1, 180)).toBe(180);
  });
  test("rejects what Number() would have let through to SQL or Date", () => {
    for (const bad of ["abc", "1e3", "0x10", "12.5", "-1", "0", "201", "Infinity", "1,2", " 5"]) {
      expect(() => intParam(q(`limit=${encodeURIComponent(bad)}`), "limit", 40, 1, 200)).toThrow(
        BadRequest,
      );
    }
    expect(() => intParam(q("days=999999999999"), "days", 30, 1, 180)).toThrow(
      "days must be a whole number from 1 to 180",
    );
  });
});

describe("dateParam and queryFilters", () => {
  test("accepts the three precisions and rejects anything else", () => {
    expect(dateParam(q("asof=2025"), "asof")).toBe("2025");
    expect(dateParam(q("asof=2025-06"), "asof")).toBe("2025-06");
    expect(dateParam(q("asof=2025-06-30"), "asof")).toBe("2025-06-30");
    expect(dateParam(q(""), "asof")).toBe("");
    for (const bad of ["yesterday", "2025/06", "2025-6-1", "20250630", "2025-06-30T00:00:00Z"]) {
      expect(() => dateParam(q(`asof=${encodeURIComponent(bad)}`), "asof")).toThrow(
        "asof must be YYYY, YYYY-MM, or YYYY-MM-DD",
      );
    }
  });
  test("queryFilters keeps the shared parse and validates the three date fields", () => {
    const f = queryFilters(q("provider=gcp,oracle&from=2024&to=2025-12&asof=2025-06-30&tier=2"));
    expect(f.providers).toEqual(["gcp", "oracle"]);
    expect(f.tier).toBe(2);
    expect([f.from, f.to, f.asof]).toEqual(["2024", "2025-12", "2025-06-30"]);
    expect(() => queryFilters(q("from=soon"))).toThrow(BadRequest);
    expect(() => queryFilters(q("to=1st+of+May"))).toThrow(BadRequest);
  });
});
