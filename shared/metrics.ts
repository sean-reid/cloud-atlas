export type MetricFamily = "power" | "count" | "hardware" | "land" | "money";

export interface MetricDef {
  id: string;
  label: string;
  short: string;
  unit: string;
  family: MetricFamily;
  comparable: boolean;
}

export const METRICS: readonly MetricDef[] = [
  {
    id: "it_power_mw",
    label: "IT power capacity",
    short: "IT power",
    unit: "MW",
    family: "power",
    comparable: true,
  },
  {
    id: "facility_power_mw",
    label: "Facility power capacity",
    short: "Facility power",
    unit: "MW",
    family: "power",
    comparable: true,
  },
  {
    id: "utility_power_mw",
    label: "Utility supply capacity",
    short: "Utility power",
    unit: "MW",
    family: "power",
    comparable: true,
  },
  {
    id: "building_count",
    label: "Buildings",
    short: "Buildings",
    unit: "buildings",
    family: "count",
    comparable: false,
  },
  {
    id: "facility_count",
    label: "Datacenters",
    short: "Datacenters",
    unit: "facilities",
    family: "count",
    comparable: false,
  },
  {
    id: "campus_count",
    label: "Campuses",
    short: "Campuses",
    unit: "campuses",
    family: "count",
    comparable: false,
  },
  {
    id: "region_count",
    label: "Cloud regions",
    short: "Regions",
    unit: "regions",
    family: "count",
    comparable: false,
  },
  {
    id: "az_count",
    label: "Availability zones",
    short: "Zones",
    unit: "zones",
    family: "count",
    comparable: false,
  },
  {
    id: "gpu_count",
    label: "GPU count",
    short: "GPUs",
    unit: "GPUs",
    family: "hardware",
    comparable: false,
  },
  {
    id: "h100_equivalents",
    label: "H100 equivalents",
    short: "H100e",
    unit: "H100e",
    family: "hardware",
    comparable: false,
  },
  {
    id: "land_area_acres",
    label: "Land area",
    short: "Land",
    unit: "acres",
    family: "land",
    comparable: false,
  },
  {
    id: "floor_area_sqft",
    label: "Floor area",
    short: "Floor area",
    unit: "sq ft",
    family: "land",
    comparable: false,
  },
  {
    id: "investment_usd",
    label: "Announced investment",
    short: "Investment",
    unit: "USD",
    family: "money",
    comparable: false,
  },
];

export const metricById = (id: string): MetricDef | undefined => METRICS.find((m) => m.id === id);

export const POWER_METRICS = new Set(["it_power_mw", "facility_power_mw", "utility_power_mw"]);

const POWER_FACTORS: Record<string, number> = { kw: 0.001, mw: 1, gw: 1000 };
const AREA_FACTORS: Record<string, number> = { sqft: 1, sqm: 10.7639 };
const LAND_FACTORS: Record<string, number> = { acres: 1, hectares: 2.47105, ha: 2.47105 };
const MONEY_SCALE: Record<string, number> = {
  "": 1,
  k: 1e3,
  m: 1e6,
  million: 1e6,
  b: 1e9,
  bn: 1e9,
  billion: 1e9,
  t: 1e12,
  trillion: 1e12,
};

export interface Parsed {
  value: number;
  unit: string;
}

const NUMBER = /-?\d+(?:,\d{3})*(?:\.\d+)?/;

function number(text: string): number | null {
  const m = NUMBER.exec(text);
  if (!m) return null;
  return Number(m[0].replace(/,/g, ""));
}

// Parses power text such as "1.2 GW", "300MW", "960 megawatts" into MW.
export function parsePowerMw(text: string): Parsed | null {
  const n = number(text);
  if (n === null) return null;
  const unit = /(?<![a-z])(kilowatts?|megawatts?|gigawatts?|kw|mw|gw)(?![a-z])/i
    .exec(text)?.[1]
    ?.toLowerCase();
  if (!unit) return null;
  const key = unit.startsWith("k") ? "kw" : unit.startsWith("g") ? "gw" : "mw";
  const factor = POWER_FACTORS[key] ?? 1;
  return { value: round(n * factor, 3), unit: "MW" };
}

export function parseAreaSqft(text: string): Parsed | null {
  const n = number(text);
  if (n === null) return null;
  const isMetric = /(sq\.?\s*m\b|square met|m²|m2)/i.test(text);
  const factor = isMetric ? AREA_FACTORS.sqm! : AREA_FACTORS.sqft!;
  return { value: round(n * factor, 0), unit: "sq ft" };
}

export function parseLandAcres(text: string): Parsed | null {
  const n = number(text);
  if (n === null) return null;
  const isHa = /(hectare|\bha\b)/i.test(text);
  const factor = isHa ? LAND_FACTORS.hectares! : LAND_FACTORS.acres!;
  return { value: round(n * factor, 1), unit: "acres" };
}

export function parseMoneyUsd(text: string): Parsed | null {
  const n = number(text);
  if (n === null) return null;
  const scale =
    /(?<=[\d\s])(trillion|billion|million|bn|b|m|k|t)(?![a-z])/i.exec(text)?.[1]?.toLowerCase() ??
    "";
  const factor = MONEY_SCALE[scale] ?? 1;
  return { value: Math.round(n * factor), unit: "USD" };
}

export function parseCount(text: string): Parsed | null {
  const n = number(text);
  if (n === null) return null;
  return { value: Math.round(n), unit: "count" };
}

export function parseMetric(metric: string, text: string): Parsed | null {
  if (POWER_METRICS.has(metric)) return parsePowerMw(text);
  if (metric === "floor_area_sqft") return parseAreaSqft(text);
  if (metric === "land_area_acres") return parseLandAcres(text);
  if (metric === "investment_usd") return parseMoneyUsd(text);
  return parseCount(text);
}

export function round(n: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

// Facility to IT power. Labelled derived; the PUE assumption travels with the result.
export function facilityToItMw(facilityMw: number, pue: number): number {
  if (pue < 1) throw new RangeError("PUE below 1");
  return round(facilityMw / pue, 2);
}
