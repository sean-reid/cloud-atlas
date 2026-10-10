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
    "The provider's sell status for the instance type in the zone: in stock is available, low stock constrained, sold out tight.",
  capacity_report:
    "The provider's capacity report verdict for the shape: available, or out of host capacity, which reads tight.",
};

// Direct verdicts outrank scores, scores outrank market prices. Each threshold is the one
// SIGNAL_NOTES states for that signal; the spot ratio's arrive from the caller because they are
// relative within a family.
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

// A verdict folded from several zones names the zone it came from and how many were asked.
const zoned = (text: string, r: SignalReading): string =>
  typeof r.detail?.zones === "number" && r.detail.zones > 1
    ? `${text} in ${String(r.detail.zone)}, ${r.detail.zones} zones`
    : text;

// The provider's own number behind a level, for the cell text and tooltips.
export function measureFor(r: Readings): string {
  if (r.capacity_report)
    return zoned(
      r.capacity_report.value >= 1
        ? "capacity available"
        : String(r.capacity_report.detail?.status ?? "out of host capacity"),
      r.capacity_report,
    );
  if (r.sell_status)
    return zoned(
      r.sell_status.value >= 1 ? "in stock" : r.sell_status.value > 0 ? "low stock" : "sold out",
      r.sell_status,
    );
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

// Higher is worse for prices, interruption bands, and lead times; lower is worse for scores and
// verdicts.
export const HIGHER_IS_WORSE = new Set<AvailabilitySignalKind>([
  "spot_ratio",
  "interruption_band",
  "lead_time_days",
]);

// Positional terciles of the spot ratios in one family at one moment.
export function spotTerciles(ratios: readonly number[]): { q33: number; q66: number } | null {
  if (!ratios.length) return null;
  const sorted = [...ratios].sort((a, b) => a - b);
  const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
  return { q33: q(0.33), q66: q(0.66) };
}

const askOf = (d: Record<string, unknown> | null | undefined): number =>
  Number(d?.target_capacity ?? d?.instance_count ?? Infinity);

// Folds one more row for a region and SKU into the reading shown for it. Probes that ask for
// several sizes land as one row each, and the smallest ask is what most buyers feel; zone
// verdicts at the same ask collapse to the worst zone, carrying the zone count.
export function mergeReading(
  prev: SignalReading | undefined,
  next: {
    signal: AvailabilitySignalKind;
    value: number;
    detail: Record<string, unknown> | null;
    zone_code: string | null;
  },
  baseline: number | null,
): SignalReading {
  const zones =
    (typeof prev?.detail?.zones === "number" ? (prev.detail.zones as number) : 0) +
    (next.zone_code ? 1 : 0);
  const ask = askOf(next.detail);
  const prevAsk = askOf(prev?.detail);
  const worse =
    !!prev &&
    ask === prevAsk &&
    (HIGHER_IS_WORSE.has(next.signal) ? next.value > prev.value : next.value < prev.value);
  if (!prev || ask < prevAsk || worse)
    return {
      value: next.value,
      detail: {
        ...(next.detail ?? {}),
        ...(next.zone_code ? { zone: next.zone_code, zones } : {}),
      },
      baseline,
    };
  return next.zone_code ? { ...prev, detail: { ...(prev.detail ?? {}), zones } } : prev;
}

export interface DayCell {
  day: string;
  level: Level;
  measure: string;
  samples: number;
}

export interface HistoryRow {
  region_code: string;
  sku: string;
  zone_code: string | null;
  signal: AvailabilitySignalKind;
  day: string;
  value: number;
  detail: Record<string, unknown> | null;
  samples: number;
}

export interface HistorySeries {
  region_code: string;
  sku: string;
  days: DayCell[];
}

const worseFirst = `CASE WHEN signal IN (${[...HIGHER_IS_WORSE].map((s) => `'${s}'`).join(", ")}) THEN -value ELSE value END`;

// One row per region, SKU, zone, signal, ask and UTC day for a provider and family since a date:
// the worst hour's value and detail, and the hours seen. SQLite fills the bare value and detail
// columns from the row holding the single MIN, so the deciding hour's detail travels with it.
export const HISTORY_DAY_SQL = `SELECT region_code, sku, zone_code, signal, substr(observed_at, 1, 10) AS day,
    MIN(${worseFirst}) AS worst, value, detail, COUNT(*) AS samples
  FROM availability_signal
  WHERE provider_slug = ? AND sku_family = ? AND observed_at >= ?
  GROUP BY region_code, sku, zone_code, signal, day,
    json_extract(detail, '$.target_capacity'), json_extract(detail, '$.instance_count')
  ORDER BY region_code, sku, day`;

// Builds the day cells for one family. A day folds its asks and zones the way the latest view
// folds its hour: smallest ask, worst zone at that ask, worst hour. Spot terciles are relative
// within the family on that day, as the latest view's are at its hour.
export function historyCells(rows: readonly HistoryRow[]): HistorySeries[] {
  const series = new Map<string, Map<string, { readings: Readings; samples: number }>>();
  for (const r of rows) {
    const key = `${r.region_code}|${r.sku}`;
    const days = series.get(key) ?? new Map<string, { readings: Readings; samples: number }>();
    const d = days.get(r.day) ?? { readings: {}, samples: 0 };
    d.readings[r.signal] = mergeReading(
      d.readings[r.signal],
      { signal: r.signal, value: r.value, detail: r.detail, zone_code: r.zone_code },
      null,
    );
    d.samples = Math.max(d.samples, r.samples);
    days.set(r.day, d);
    series.set(key, days);
  }
  const spotByDay = new Map<string, number[]>();
  for (const days of series.values())
    for (const [day, d] of days)
      if (d.readings.spot_ratio)
        spotByDay.set(day, [...(spotByDay.get(day) ?? []), d.readings.spot_ratio.value]);
  return [...series.entries()].map(([key, days]) => {
    const [region_code, sku] = key.split("|") as [string, string];
    return {
      region_code,
      sku,
      days: [...days.entries()]
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([day, d]) => ({
          day,
          level: levelFor(d.readings, spotTerciles(spotByDay.get(day) ?? [])),
          measure: measureFor(d.readings),
          samples: d.samples,
        })),
    };
  });
}
