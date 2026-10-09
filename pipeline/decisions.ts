import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { csvRecords } from "./csv";
import { nameTokens } from "./entities";

export interface Reviewed {
  aliases: Map<string, string>;
  decisions: Map<string, string>;
}

export const aliasKey = (provider: string, name: string) =>
  `${provider}|${[...nameTokens(name)].sort().join(" ")}`;

// Hand-reviewed resolutions live in git next to the imports: which source names denote the same
// site, and how each review item was decided, so a fresh database replays the review.
export function loadReviewed(dataRoot: string): Reviewed {
  const aliases = new Map<string, string>();
  const decisions = new Map<string, string>();
  const a = join(dataRoot, "aliases.csv");
  if (existsSync(a)) {
    for (const r of csvRecords(readFileSync(a, "utf8"))) {
      if (r.provider_slug && r.alias && r.canonical)
        aliases.set(aliasKey(r.provider_slug, r.alias), r.canonical);
    }
  }
  const d = join(dataRoot, "review-decisions.csv");
  if (existsSync(d)) {
    for (const r of csvRecords(readFileSync(d, "utf8")))
      if (r.id && r.resolution) decisions.set(r.id, r.resolution);
  }
  return { aliases, decisions };
}
