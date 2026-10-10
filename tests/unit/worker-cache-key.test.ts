import { describe, expect, test } from "vitest";
import { cacheKey, FILTER_PARAMS } from "../../worker/cache-key";

const u = (s: string) => new URL(s, "https://cloud-atlas.example");

describe("cacheKey", () => {
  test("drops unknown parameters and sorts the known ones", () => {
    const a = cacheKey(u("/api/sites?status=operational&provider=gcp&utm_source=x"), FILTER_PARAMS);
    const b = cacheKey(
      u("/api/sites?provider=gcp&status=operational&cb=1728000000"),
      FILTER_PARAMS,
    );
    expect(a).toBe(b);
    expect(a).toBe("https://cloud-atlas.example/api/sites?provider=gcp&status=operational");
  });
  test("keeps the bare path when nothing known is present", () => {
    expect(cacheKey(u("/api/feed?utm_campaign=spring"), ["limit"])).toBe(
      "https://cloud-atlas.example/api/feed",
    );
    expect(cacheKey(u("/api/feed?limit=12&limit=13"), ["limit"])).toBe(
      "https://cloud-atlas.example/api/feed?limit=12",
    );
  });
  test("different known values stay distinct and empty values fall away", () => {
    expect(cacheKey(u("/api/summary?asof=2025"), FILTER_PARAMS)).not.toBe(
      cacheKey(u("/api/summary?asof=2024"), FILTER_PARAMS),
    );
    expect(cacheKey(u("/api/summary?asof=&q="), FILTER_PARAMS)).toBe(
      "https://cloud-atlas.example/api/summary",
    );
  });
  test("a parameter another route reads does not leak into this one", () => {
    expect(cacheKey(u("/api/availability?provider=aws&days=7"), ["provider"])).toBe(
      "https://cloud-atlas.example/api/availability?provider=aws",
    );
  });
});
