import { expect, test } from "vitest";
import { statedPowerMw, statedVsTracked } from "../../src/lib/stated";

const pick = (metric: string, value: number, status = "operational", kind = "as_of") =>
  ({
    pick: { metric, value, status, effective_date: "2026-06-30", effective_kind: kind, tier: 1 },
  }) as unknown as import("../../src/lib/stated").StatedPick;

const stated = {
  coreweave: {
    "facility_count|operational": pick("facility_count", 43),
    "it_power_mw|operational": pick("it_power_mw", 1500),
  },
  azure: {
    "facility_count|operational": pick("facility_count", 500),
    "region_count|operational": pick("region_count", 58),
    "facility_power_mw|operational": pick("facility_power_mw", 1000, "operational", "opened"),
  },
};
const totals = [
  { provider_slug: "coreweave", it_power_mw: 679, it_sites: 7 },
  { provider_slug: "azure", it_power_mw: 1520, it_sites: 6 },
  { provider_slug: "gcp", it_power_mw: 3180, it_sites: 17 },
];
const regions = [...Array(58)].map(() => ({ provider_slug: "azure" }));
const sites = [
  ...[...Array(153)].map(() => ({ provider_slug: "azure", lat: 1 })),
  { provider_slug: "azure", lat: null },
  ...[...Array(12)].map(() => ({ provider_slug: "coreweave", lat: 1 })),
];

test("stated figures sit beside tracked counts per provider, largest tracked power first", () => {
  const rows = statedVsTracked(stated, totals, regions, sites);
  expect(rows.map((r) => r.provider_slug)).toEqual(["gcp", "azure", "coreweave"]);
  const azure = rows[1]!;
  expect(azure.regions).toMatchObject({ tracked: 58 });
  expect(azure.regions.stated?.pick.value).toBe(58);
  expect(azure.datacenters).toMatchObject({ mapped: 153 });
  expect(azure.datacenters.stated?.pick.value).toBe(500);
  expect(azure.power).toMatchObject({ stated: null, tracked_mw: 1520, sites: 6 });
  const cw = rows[2]!;
  expect(cw.power.stated?.pick.value).toBe(1500);
  expect(cw.power.tracked_mw).toBe(679);
  expect(rows[0]!.regions.stated).toBeNull();
});

test("the bars take stated fleet totals, not capacity added in a period", () => {
  expect(statedPowerMw(stated)).toEqual({ coreweave: 1500 });
});
