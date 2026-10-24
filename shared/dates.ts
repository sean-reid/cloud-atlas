import type { DatePrecision } from "./types";

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MONTH = /^\d{4}-\d{2}$/;
const YEAR = /^\d{4}$/;

export function datePrecision(text: string): DatePrecision | null {
  if (DAY.test(text)) return "day";
  if (MONTH.test(text)) return "month";
  if (YEAR.test(text)) return "year";
  return null;
}

// Sort key that places a coarse date at the start of its period, so a claim dated
// "2025" is treated as known no later than any claim dated inside 2025.
export function dateFloor(text: string): string {
  const p = datePrecision(text);
  if (p === "day") return text;
  if (p === "month") return `${text}-01`;
  if (p === "year") return `${text}-01-01`;
  throw new RangeError(`bad date ${text}`);
}

export function dateCeil(text: string): string {
  const p = datePrecision(text);
  if (p === "day") return text;
  if (p === "month") {
    const [y, m] = text.split("-").map(Number) as [number, number];
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return `${text}-${String(last).padStart(2, "0")}`;
  }
  if (p === "year") return `${text}-12-31`;
  throw new RangeError(`bad date ${text}`);
}

export function daysBetween(fromIso: string, toIso: string): number {
  const a = Date.parse(dateFloor(fromIso.slice(0, 10)));
  const b = Date.parse(dateFloor(toIso.slice(0, 10)));
  return Math.round((b - a) / 86_400_000);
}

const PRECISION_RANK: Record<DatePrecision, number> = { year: 0, month: 1, day: 2 };

// The earliest opening among dated claims: the earliest year wins, and within that year the
// finest precision, so "2012-06-07" beats a bare "2012" instead of losing the string sort.
export function earliestOpened<
  T extends { effective_date: string; effective_precision: DatePrecision },
>(items: readonly T[]): T | null {
  let best: T | null = null;
  for (const o of items) {
    if (!best) {
      best = o;
      continue;
    }
    const year = o.effective_date.slice(0, 4);
    const bestYear = best.effective_date.slice(0, 4);
    if (year !== bestYear) {
      if (year < bestYear) best = o;
      continue;
    }
    const rank = PRECISION_RANK[o.effective_precision];
    const bestRank = PRECISION_RANK[best.effective_precision];
    if (rank !== bestRank) {
      if (rank > bestRank) best = o;
      continue;
    }
    if (o.effective_date < best.effective_date) best = o;
  }
  return best;
}
