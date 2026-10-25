import type { Observation } from "../../shared/types";

export interface StatedPick {
  pick: Observation & { tier: number };
}

export interface StatedRow {
  provider_slug: string;
  regions: { stated: StatedPick | null; tracked: number };
  datacenters: { stated: StatedPick | null; mapped: number };
  power: { stated: StatedPick | null; tracked_mw: number; sites: number };
}

const operational = (metrics: Record<string, StatedPick>, metric: string): StatedPick | null =>
  metrics[`${metric}|operational`] ?? null;

// A fleet total is a point-in-time statement. Capacity added in a quarter is recorded with the
// opened kind and never stands in for the total.
const fleetTotal = (metrics: Record<string, StatedPick>, metric: string): StatedPick | null => {
  const pick = operational(metrics, metric);
  return pick && pick.pick.effective_kind === "as_of" ? pick : null;
};

// One row per provider that states a fleet-wide figure or has anything tracked, so the
// provider's own numbers sit beside what the evidence covers instead of in a separate list.
export function statedVsTracked(
  stated: Record<string, Record<string, StatedPick>>,
  totals: readonly { provider_slug: string; it_power_mw: number; it_sites: number }[],
  regions: readonly { provider_slug: string }[],
  sites: readonly { provider_slug: string; lat: number | null }[],
): StatedRow[] {
  const slugs = new Set<string>([
    ...Object.keys(stated),
    ...totals.filter((t) => t.it_power_mw > 0).map((t) => t.provider_slug),
  ]);
  return [...slugs]
    .map((slug): StatedRow => {
      const m = stated[slug] ?? {};
      const total = totals.find((t) => t.provider_slug === slug);
      return {
        provider_slug: slug,
        regions: {
          stated: operational(m, "region_count"),
          tracked: regions.filter((r) => r.provider_slug === slug).length,
        },
        datacenters: {
          stated: operational(m, "facility_count"),
          mapped: sites.filter((s) => s.provider_slug === slug && s.lat !== null).length,
        },
        power: {
          stated: fleetTotal(m, "it_power_mw") ?? fleetTotal(m, "facility_power_mw"),
          tracked_mw: total?.it_power_mw ?? 0,
          sites: total?.it_sites ?? 0,
        },
      };
    })
    .sort(
      (a, b) =>
        b.power.tracked_mw - a.power.tracked_mw || a.provider_slug.localeCompare(b.provider_slug),
    );
}

// Stated operational power per provider, for the marker on the bars.
export function statedPowerMw(
  stated: Record<string, Record<string, StatedPick>>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [slug, m] of Object.entries(stated)) {
    const pick = fleetTotal(m, "it_power_mw") ?? fleetTotal(m, "facility_power_mw");
    if (pick?.pick.value) out[slug] = pick.pick.value;
  }
  return out;
}
