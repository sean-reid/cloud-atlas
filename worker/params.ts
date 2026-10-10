import { datePrecision } from "../shared/dates";
import { parseFilters, type Filters } from "../shared/filters";

export class BadRequest extends Error {}

export function intParam(
  params: URLSearchParams,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = params.get(name);
  if (raw === null || raw === "") return fallback;
  const n = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(n) || n < min || n > max)
    throw new BadRequest(`${name} must be a whole number from ${min} to ${max}`);
  return n;
}

export function dateParam(params: URLSearchParams, name: string): string {
  const raw = params.get(name);
  if (raw === null || raw === "") return "";
  if (!datePrecision(raw)) throw new BadRequest(`${name} must be YYYY, YYYY-MM, or YYYY-MM-DD`);
  return raw;
}

// parseFilters is shared with the browser and stays lenient; the API rejects what dateFloor
// would otherwise throw on mid-query.
export function queryFilters(params: URLSearchParams): Filters {
  const f = parseFilters(params);
  for (const name of ["from", "to", "asof"] as const) f[name] = dateParam(params, name);
  return f;
}
