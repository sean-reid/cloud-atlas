import { dateCeil, dateFloor, datePrecision } from "./dates";
import type { ClaimType, LocationPrecision, Status } from "./types";

export interface Filters {
  providers: string[];
  countries: string[];
  statuses: Status[];
  metric: string;
  claim: ClaimType | "";
  tier: number | null;
  from: string;
  to: string;
  asof: string;
  mode: "known" | "reconstructed";
  q: string;
  precision: LocationPrecision | "";
  demo: boolean;
}

export const DEFAULT_FILTERS: Filters = {
  providers: [],
  countries: [],
  statuses: [],
  metric: "it_power_mw",
  claim: "",
  tier: null,
  from: "",
  to: "",
  asof: "",
  mode: "reconstructed",
  q: "",
  precision: "",
  demo: false,
};

const list = (v: string | null) => (v ? v.split(",").filter(Boolean) : []);

// One encoding shared by the URL bar, the API, and the export, so a copied link reproduces
// exactly the view that was on screen.
export function parseFilters(params: URLSearchParams): Filters {
  const tier = params.get("tier");
  return {
    providers: list(params.get("provider")),
    countries: list(params.get("country")).map((c) => c.toUpperCase()),
    statuses: list(params.get("status")) as Status[],
    metric: params.get("metric") || DEFAULT_FILTERS.metric,
    claim: (params.get("claim") as ClaimType | null) ?? "",
    tier: tier && /^[1-4]$/.test(tier) ? Number(tier) : null,
    from: params.get("from") ?? "",
    to: params.get("to") ?? "",
    asof: params.get("asof") ?? "",
    mode: params.get("mode") === "known" ? "known" : "reconstructed",
    q: params.get("q") ?? "",
    precision: (params.get("precision") as LocationPrecision | null) ?? "",
    demo: params.get("demo") === "1",
  };
}

export function serializeFilters(f: Filters): URLSearchParams {
  const p = new URLSearchParams();
  if (f.providers.length) p.set("provider", f.providers.join(","));
  if (f.countries.length) p.set("country", f.countries.join(","));
  if (f.statuses.length) p.set("status", f.statuses.join(","));
  if (f.metric !== DEFAULT_FILTERS.metric) p.set("metric", f.metric);
  if (f.claim) p.set("claim", f.claim);
  if (f.tier) p.set("tier", String(f.tier));
  if (f.from) p.set("from", f.from);
  if (f.to) p.set("to", f.to);
  if (f.asof) p.set("asof", f.asof);
  if (f.mode !== DEFAULT_FILTERS.mode) p.set("mode", f.mode);
  if (f.q) p.set("q", f.q);
  if (f.precision) p.set("precision", f.precision);
  if (f.demo) p.set("demo", "1");
  return p;
}

// A row dated "2025" may fall anywhere in 2025, so it matches a bound inside that year: the
// bound's floor or ceiling is cut to the row's own precision before the comparison.
export function effectiveDateRange(
  f: Pick<Filters, "from" | "to">,
  alias = "o",
): { where: string[]; params: string[] } {
  const own = `substr(?, 1, CASE ${alias}.effective_precision WHEN 'year' THEN 4 WHEN 'month' THEN 7 ELSE 10 END)`;
  const where: string[] = [];
  const params: string[] = [];
  if (f.from && datePrecision(f.from)) {
    where.push(`${alias}.effective_date >= ${own}`);
    params.push(dateFloor(f.from));
  }
  if (f.to && datePrecision(f.to)) {
    where.push(`${alias}.effective_date <= ${own}`);
    params.push(dateCeil(f.to));
  }
  return { where, params };
}
