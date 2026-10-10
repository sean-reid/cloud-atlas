import type { Db } from "./db";

export const HOURLY_DAYS = 90;

// Hourly readings older than the window collapse to one row per zone, SKU, signal and UTC day:
// the worst hour, by the same direction rule the daily cells use. The row keeps its original
// observed_at, so series and history queries need no special case.
export async function pruneSignals(db: Db, now: Date, days = HOURLY_DAYS): Promise<number> {
  const cutoff = new Date(now.getTime() - days * 86_400_000).toISOString();
  const before = await db.query<{ n: number }>(
    "SELECT COUNT(*) AS n FROM availability_signal WHERE observed_at < ?",
    [cutoff],
  );
  await db.query(
    `DELETE FROM availability_signal WHERE observed_at < ? AND id NOT IN (
       SELECT id FROM (
         SELECT id, ROW_NUMBER() OVER (
           PARTITION BY provider_slug, region_code, zone_code, sku, signal, substr(observed_at, 1, 10)
           ORDER BY CASE WHEN signal IN ('spot_ratio', 'interruption_band', 'lead_time_days') THEN -value ELSE value END, observed_at
         ) AS rn
         FROM availability_signal WHERE observed_at < ?
       ) WHERE rn = 1
     )`,
    [cutoff, cutoff],
  );
  const after = await db.query<{ n: number }>(
    "SELECT COUNT(*) AS n FROM availability_signal WHERE observed_at < ?",
    [cutoff],
  );
  return (before[0]?.n ?? 0) - (after[0]?.n ?? 0);
}
