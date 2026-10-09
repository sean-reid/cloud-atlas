import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

// First-load budget for the entry chunks (gzipped). The map library and land geometry load lazily.
const BUDGET = 180 * 1024;
const dir = "dist/assets";
let total = 0;
for (const name of readdirSync(dir)) {
  if (!name.endsWith(".js") || /^(map|land-|Map-|maplibre-gl-worker)/.test(name)) continue;
  const path = join(dir, name);
  if (!statSync(path).isFile()) continue;
  const gz = gzipSync(readFileSync(path)).length;
  total += gz;
  console.log(`${name}\t${(gz / 1024).toFixed(1)} KiB gz`);
}
console.log(
  `first-load\t${(total / 1024).toFixed(1)} KiB gz (budget ${(BUDGET / 1024).toFixed(0)} KiB)`,
);
if (total > BUDGET) {
  console.error("first-load JS exceeds budget");
  process.exit(1);
}
