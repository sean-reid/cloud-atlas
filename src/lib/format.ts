export const fmtMw = (v: number | null | undefined, digits = 0): string => {
  if (v === null || v === undefined || !Number.isFinite(v)) return "unknown";
  if (v >= 1000) return `${(v / 1000).toFixed(v >= 10000 ? 1 : 2)} GW`;
  return `${v.toFixed(digits)} MW`;
};

export const fmtNum = (v: number | null | undefined): string =>
  v === null || v === undefined || !Number.isFinite(v)
    ? "unknown"
    : new Intl.NumberFormat("en", { maximumFractionDigits: 0 }).format(v);

export const fmtUsd = (v: number): string => {
  if (v >= 1e9) return `$${(v / 1e9).toFixed(v >= 1e11 ? 0 : 1)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(0)}M`;
  return `$${fmtNum(v)}`;
};

export const fmtMetric = (
  metric: string,
  value: number | null,
  low: number | null,
  high: number | null,
): string => {
  if (value === null && low !== null && high !== null)
    return `${fmtMetric(metric, low, null, null)} to ${fmtMetric(metric, high, null, null)}`;
  if (value === null) return "unknown";
  if (metric.endsWith("_mw")) return fmtMw(value);
  if (metric === "investment_usd") return fmtUsd(value);
  if (metric === "land_area_acres") return `${fmtNum(value)} acres`;
  if (metric === "floor_area_sqft") return `${fmtNum(value)} sq ft`;
  return fmtNum(value);
};

export const fmtDate = (iso: string | null | undefined): string => {
  if (!iso) return "undated";
  if (iso.length === 4) return iso;
  if (iso.length === 7) {
    const [y, m] = iso.split("-");
    return `${new Date(Date.UTC(Number(y), Number(m) - 1, 1)).toLocaleString("en", { month: "short", timeZone: "UTC" })} ${y}`;
  }
  return new Date(iso).toLocaleDateString("en", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
};

export const fmtAgo = (iso: string | null | undefined): string => {
  if (!iso) return "never";
  const days = Math.floor((Date.now() - Date.parse(iso)) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 60) return `${days} days ago`;
  if (days < 730) return `${Math.round(days / 30)} months ago`;
  return `${Math.round(days / 365)} years ago`;
};

export const statusLabel: Record<string, string> = {
  operational: "operational",
  under_construction: "under construction",
  announced: "announced",
  cancelled: "cancelled",
  decommissioned: "decommissioned",
  unknown: "status unknown",
};

export const precisionLabel: Record<string, string> = {
  exact: "site location",
  locality: "town or county",
  region_centroid: "region centroid",
  unknown: "location unknown",
};

export const tierLabel: Record<number, string> = {
  1: "official",
  2: "public record",
  3: "research dataset",
  4: "reporting",
};
