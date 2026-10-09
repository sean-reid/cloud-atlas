import type { AvailabilitySignalKind } from "./types";

export type Level = "available" | "constrained" | "tight" | "offered" | "unknown";

export interface SignalReading {
  value: number;
  detail: Record<string, unknown> | null;
  baseline: number | null;
}

export type Readings = Partial<Record<AvailabilitySignalKind, SignalReading>>;

export const LEVEL_LABEL: Record<Level | "absent", string> = {
  available: "available",
  constrained: "constrained",
  tight: "tight",
  offered: "offered, no scarcity signal",
  unknown: "unknown",
  absent: "not offered",
};

// What each signal is and who publishes it, for footnotes and the sources page.
export const SIGNAL_NOTES: Record<AvailabilitySignalKind, string> = {
  sku_offered: "The SKU exists in the region, from the provider's own catalogue or documentation.",
  spot_ratio:
    "Spot price as a share of pay-as-you-go. Terciles within the family: cheapest third available, middle constrained, dearest third tight.",
  interruption_band:
    "The provider's published spot interruption frequency band for the trailing month. Under 10% available, 10 to 15% constrained, above tight.",
  placement_score:
    "The provider's own 1 to 10 likelihood that a request of the probed size succeeds. 7 and above available, 4 to 6 constrained, below tight.",
  lead_time_days:
    "Days until the provider's scheduler can start a block of the probed size. Today available, within three days constrained, later or never tight.",
  sell_status:
    "The provider's sell status for the instance type in the zone: in stock is available, sold out is tight.",
  capacity_report:
    "The provider's capacity report verdict for the shape: available, or out of host capacity, which reads tight.",
};

// Direct verdicts outrank scores, scores outrank market prices. Each rule is the one the
// methodology page documents for that signal; thresholds for the spot ratio arrive from the
// caller because they are relative within a family.
export function levelFor(r: Readings, spotTerciles: { q33: number; q66: number } | null): Level {
  if (r.capacity_report) return r.capacity_report.value >= 1 ? "available" : "tight";
  if (r.sell_status)
    return r.sell_status.value >= 1
      ? "available"
      : r.sell_status.value > 0
        ? "constrained"
        : "tight";
  if (r.placement_score) {
    const s = r.placement_score.value;
    return s >= 7 ? "available" : s >= 4 ? "constrained" : "tight";
  }
  if (r.lead_time_days) {
    const d = r.lead_time_days.value;
    return d <= 0 ? "available" : d <= 3 ? "constrained" : "tight";
  }
  if (r.interruption_band) {
    const b = r.interruption_band.value;
    return b <= 1 ? "available" : b === 2 ? "constrained" : "tight";
  }
  if (r.spot_ratio && spotTerciles) {
    const v = r.spot_ratio.value;
    return v <= spotTerciles.q33 ? "available" : v <= spotTerciles.q66 ? "constrained" : "tight";
  }
  if (r.sku_offered) return "offered";
  return "unknown";
}

// The provider's own number behind a level, for the cell text and tooltips.
export function measureFor(r: Readings): string {
  if (r.capacity_report)
    return r.capacity_report.value >= 1
      ? "capacity available"
      : String(r.capacity_report.detail?.status ?? "out of host capacity");
  if (r.sell_status)
    return r.sell_status.value >= 1
      ? "in stock"
      : r.sell_status.value > 0
        ? "low stock"
        : "sold out";
  if (r.placement_score) return `score ${r.placement_score.value}/10`;
  if (r.lead_time_days) {
    const d = r.lead_time_days.value;
    if (d >= 999) return "no start date";
    if (d <= 0) return "starts now";
    return `starts in ${Math.round(d)} day${Math.round(d) === 1 ? "" : "s"}`;
  }
  if (r.interruption_band) {
    const label = String(r.interruption_band.detail?.label ?? r.interruption_band.value);
    return label.replace("<", "under ").replace(">", "over ");
  }
  if (r.spot_ratio) return `${Math.round(r.spot_ratio.value * 100)}% of list`;
  if (r.sku_offered) {
    const zones = r.sku_offered.detail?.zones;
    if (typeof zones === "number") return `${zones} zone${zones === 1 ? "" : "s"}`;
    return "listed";
  }
  return "";
}

const rank: Record<Level, number> = {
  tight: 3,
  constrained: 2,
  available: 1,
  offered: 0,
  unknown: 0,
};

export function worstLevel<T extends { level: Level }>(cells: readonly T[]): T | null {
  return cells.reduce<T | null>((w, c) => (!w || rank[c.level] > rank[w.level] ? c : w), null);
}
