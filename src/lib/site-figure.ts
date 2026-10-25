import { escapeHtml } from "./html";
import { fmtMetric, statusLabel } from "./format";

export interface SiteMetricPick {
  value: number | null;
  low?: number | null;
  high?: number | null;
  claim_type: string;
  status: string | null;
}

// The figure a site shows on the map: the selected metric, else a power figure, else whatever
// the site has, each formatted in its own unit. Only a power figure sizes the marker.
export function pickSiteMetric(
  metrics: Record<string, SiteMetricPick | undefined>,
  metric: string,
): { key: string; pick: SiteMetricPick } | null {
  for (const key of [metric, "it_power_mw", "facility_power_mw", ...Object.keys(metrics)]) {
    const pick = metrics[key];
    if (pick) return { key, pick };
  }
  return null;
}

export function siteFigure(
  metrics: Record<string, SiteMetricPick | undefined>,
  metric: string,
): { text: string; sizeBy: number | null; claim: string } {
  const found = pickSiteMetric(metrics, metric);
  if (!found) return { text: "no figure", sizeBy: null, claim: "unknown" };
  const { key, pick } = found;
  const amount = fmtMetric(key, pick.value, pick.low ?? null, pick.high ?? null);
  const status = pick.status ? `, ${statusLabel[pick.status] ?? escapeHtml(pick.status)}` : "";
  return {
    text: `${pick.claim_type === "derived" ? "estimated " : ""}${amount}${status}`,
    sizeBy: key.endsWith("_mw") ? pick.value : null,
    claim: pick.claim_type,
  };
}
