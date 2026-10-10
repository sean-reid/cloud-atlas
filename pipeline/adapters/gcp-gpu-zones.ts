import { stableId } from "../../shared/ids";
import { ensureSource } from "../entities";
import { columnIndex, tableWithColumns } from "../html";
import { emptyResult, meta, type Adapter, type AdapterContext } from "./types";

export const GPU_ZONES_URL = "https://docs.cloud.google.com/compute/docs/gpus/gpu-regions-zones";
const URL = GPU_ZONES_URL;

export interface GpuZoneRow {
  zone: string;
  region: string;
  location: string | null;
  types: string[];
}

export function gpuZoneRows(html: string): GpuZoneRow[] {
  const table = tableWithColumns(html, ["zone", "gpu machine type"]);
  if (!table || table.length < 30) throw new Error("GPU zones table missing or too short");
  const header = table[0]!;
  const iZone = columnIndex(header, "zone");
  const iTypes = columnIndex(header, "gpu machine type");
  const rows: GpuZoneRow[] = [];
  for (const row of table.slice(1)) {
    const zone = row[iZone]?.trim();
    const m = zone ? /^([a-z]+-[a-z]+\d+)-[a-z]$/.exec(zone) : null;
    if (!zone || !m) continue;
    const types = (row[iTypes] ?? "")
      .split("•")
      .map((t) => t.trim())
      .filter(Boolean);
    rows.push({ zone, region: m[1]!, location: row[1] ?? null, types });
  }
  return rows;
}

// Google's GPU machine type names to the accelerator families the rest of the site uses.
const FAMILY: [RegExp, string][] = [
  [/^A3 Ultra/i, "H200"],
  [/^A3/i, "H100"],
  [/^A4X/i, "GB200"],
  [/^A4/i, "B200"],
  [/^A2/i, "A100"],
  [/^G4/i, "RTX PRO 6000"],
  [/^G2/i, "L4"],
  [/T4/i, "T4"],
  [/V100/i, "V100"],
  [/P100/i, "P100"],
  [/P4/i, "P4"],
];

export function familyOf(machineType: string): string {
  for (const [re, fam] of FAMILY) if (re.test(machineType)) return fam;
  return machineType;
}

export const gcpGpuZones: Adapter = {
  ...meta("gcp-gpu-zones"),
  url: URL,
  tier: 1,
  license: "Google Cloud documentation, CC BY 4.0",
  hosts: ["docs.cloud.google.com"],
  source: () => ({
    id: "",
    publisher: "Google Cloud",
    title: "GPU regions and zones availability",
    url: URL,
    tier: 1,
    published_date: null,
    license: "CC BY 4.0",
    adapter: "gcp-gpu-zones",
  }),
  async run(ctx: AdapterContext) {
    const result = emptyResult();
    const now = ctx.now();
    const hour = now.toISOString().slice(0, 13) + ":00:00Z";
    const source = await ensureSource(ctx.store, { ...this.source(), adapter: this.id });
    const page = await ctx.fetch(URL);
    for (const row of gpuZoneRows(page.body)) {
      for (const t of row.types) {
        const id = await stableId("sig", ["gcp", row.zone, t, "sku_offered", hour]);
        if (
          await ctx.store.appendSignal({
            id,
            provider_slug: "gcp",
            region_code: row.region,
            zone_code: row.zone,
            sku: t,
            sku_family: familyOf(t),
            signal: "sku_offered",
            value: 1,
            unit: "boolean",
            observed_at: hour,
            source_id: source.id,
            detail: JSON.stringify({ location: row.location }),
          })
        )
          result.signals++;
      }
    }
    return result;
  },
};
