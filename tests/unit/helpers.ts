import { join } from "node:path";
import { applyMigrations, SqliteDb } from "../../pipeline/db";
import { PROVIDERS } from "../../shared/providers";

export const FIX = join(__dirname, "..", "fixtures");
export const DATA = join(__dirname, "..", "..", "data");
export const fixedNow = () => new Date("2026-10-09T12:34:56Z");
export const fast = { minIntervalMs: 0, retries: 1 };

export async function memoryDb(): Promise<SqliteDb> {
  const db = new SqliteDb(":memory:");
  await applyMigrations(db, join(__dirname, "..", "..", "migrations"));
  await db.exec(
    PROVIDERS.map(
      (p) =>
        `INSERT INTO provider (slug,name,short_name,company,category,color) VALUES ('${p.slug}','${p.name}','${p.shortName}','${p.company}','${p.category}','${p.color}');`,
    ).join("\n"),
  );
  return db;
}
