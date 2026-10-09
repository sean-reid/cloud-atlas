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
