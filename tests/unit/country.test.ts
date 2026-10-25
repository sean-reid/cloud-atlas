import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, test } from "vitest";
import { countryAt, countryCodeFor } from "../../pipeline/country";

const require = createRequire(import.meta.url);

describe("countryAt", () => {
  test("five known points land in their countries", () => {
    expect(countryAt(39.0264, -77.4495)).toBe("US");
    expect(countryAt(60.5425, 27.1826)).toBe("FI");
    expect(countryAt(53.4138, -6.4005)).toBe("IE");
    expect(countryAt(52.8, 4.99)).toBe("NL");
    expect(countryAt(-33.8688, 151.2093)).toBe("AU");
  });

  test("open ocean is nobody's", () => {
    expect(countryAt(0, -30)).toBeNull();
    expect(countryAt(-60, 100)).toBeNull();
  });

  test("water a few kilometres off a coarse coastline still belongs to that coast", () => {
    expect(countryAt(50.78, -1.25)).toBe("GB");
  });

  test("every shape in the atlas has an alpha-2 code", () => {
    const topo = JSON.parse(
      readFileSync(require.resolve("world-atlas/countries-110m.json"), "utf8"),
    ) as {
      objects: { countries: { geometries: { id?: string; properties: { name: string } }[] } };
    };
    const missing = topo.objects.countries.geometries
      .filter((g) => !countryCodeFor(g.id, g.properties.name))
      .map((g) => g.properties.name);
    expect(missing).toEqual([]);
    expect(topo.objects.countries.geometries.length).toBe(177);
    expect(countryCodeFor("840", "United States of America")).toBe("US");
    expect(countryCodeFor(undefined, "Kosovo")).toBe("XK");
    expect(countryCodeFor("999", "Atlantis")).toBeNull();
  });
});
