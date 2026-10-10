import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { localD1Path } from "../../pipeline/db";

test("the local D1 path is the hashed database file, never miniflare's metadata", () => {
  const root = mkdtempSync(join(tmpdir(), "ca-d1-"));
  const dir = join(root, ".wrangler", "state", "v3", "d1", "miniflare-D1DatabaseObject");
  mkdirSync(dir, { recursive: true });
  const db = join(dir, "9ba2b04bf514d9facfd57ed57d849e77241a7adc99d1c1545d06688b43d84248.sqlite");
  writeFileSync(db, "");
  writeFileSync(join(dir, "metadata.sqlite"), "");
  const older = new Date(Date.now() - 60_000);
  utimesSync(db, older, older);
  expect(localD1Path(root)).toBe(db);
  expect(localD1Path(join(root, "nowhere"))).toBeNull();
  rmSync(root, { recursive: true, force: true });
});
