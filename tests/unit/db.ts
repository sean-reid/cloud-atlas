import { join } from "node:path";
import { applyMigrations, SqliteDb } from "../../pipeline/db";
import { PROVIDERS } from "../../shared/providers";

const MIGRATIONS = join(__dirname, "..", "..", "migrations");

export async function memoryDb(): Promise<SqliteDb> {
  const db = new SqliteDb(":memory:");
  await applyMigrations(db, MIGRATIONS);
  await db.exec(
    PROVIDERS.map(
      (p) =>
        `INSERT INTO provider (slug,name,short_name,company,category,color) VALUES ('${p.slug}','${p.name}','${p.shortName}','${p.company}','${p.category}','${p.color}');`,
    ).join("\n"),
  );
  return db;
}
