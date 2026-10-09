import { POWER_METRICS } from "./metrics";
import {
  groupByEntityMetric,
  selectObservation,
  type Candidate,
  type Selection,
  type TimeMode,
} from "./selection";
import type { Entity, Status } from "./types";

export const PHYSICAL = new Set<Entity["type"]>(["campus", "facility", "phase"]);

export interface SitePick {
  entity: Entity;
  metric: string;
  selection: Selection;
}

export interface ProviderTotals {
  provider_slug: string;
  it_power_mw: number;
  it_sites: number;
  facility_only_power_mw: number;
  facility_only_sites: number;
  pipeline_it_power_mw: Record<Status, number>;
  pipeline_facility_only_power_mw: Record<Status, number>;
  sites: number;
  located_sites: number;
  latest_effective: string | null;
  derived_share: number;
}

const emptyStatus = (): Record<Status, number> => ({
  operational: 0,
  under_construction: 0,
  announced: 0,
  cancelled: 0,
  decommissioned: 0,
  unknown: 0,
});

// Picks one observation per physical entity and metric.
export function selectSites(
  entities: readonly Entity[],
  rows: readonly Candidate[],
  asOf: string | null,
  mode: TimeMode,
): SitePick[] {
  const byId = new Map(entities.map((e) => [e.id, e]));
  const out: SitePick[] = [];
  for (const [key, list] of groupByEntityMetric(rows)) {
    const [entityId, metric] = key.split("\u0000") as [string, string, string];
    const entity = byId.get(entityId);
    if (!entity || !PHYSICAL.has(entity.type)) continue;
    const selection = selectObservation(list, asOf, mode);
    if (selection) out.push({ entity, metric, selection });
  }
  return out;
}

function ancestors(entity: Entity, byId: Map<string, Entity>): Entity[] {
  const out: Entity[] = [];
  let cur = entity.parent_id ? byId.get(entity.parent_id) : undefined;
  while (cur) {
    out.push(cur);
    cur = cur.parent_id ? byId.get(cur.parent_id) : undefined;
  }
  return out;
}

// Sums power without double counting: a site contributes only if no ancestor of it already
// contributes the same metric at the same status. IT and facility power never mix; a site
// with only a facility figure lands in the facility-only bucket.
export function providerTotals(
  entities: readonly Entity[],
  picks: readonly SitePick[],
): ProviderTotals[] {
  const byId = new Map(entities.map((e) => [e.id, e]));
  const totals = new Map<string, ProviderTotals>();
  const get = (slug: string) => {
    let t = totals.get(slug);
    if (!t) {
      t = {
        provider_slug: slug,
        it_power_mw: 0,
        it_sites: 0,
        facility_only_power_mw: 0,
        facility_only_sites: 0,
        pipeline_it_power_mw: emptyStatus(),
        pipeline_facility_only_power_mw: emptyStatus(),
        sites: 0,
        located_sites: 0,
        latest_effective: null,
        derived_share: 0,
      };
      totals.set(slug, t);
    }
    return t;
  };

  const powerPicks = picks.filter(
    (p) => POWER_METRICS.has(p.metric) && p.selection.pick.value !== null,
  );
  const has = new Set(
    powerPicks.map((p) => `${p.entity.id}|${p.metric}|${p.selection.pick.status}`),
  );
  const hasIt = new Set(
    powerPicks
      .filter((p) => p.metric === "it_power_mw")
      .map((p) => `${p.entity.id}|${p.selection.pick.status}`),
  );
  const covered = (p: SitePick) =>
    ancestors(p.entity, byId).some((a) =>
      has.has(`${a.id}|${p.metric}|${p.selection.pick.status}`),
    );

  let derived = 0;
  let counted = 0;
  const seenSites = new Map<string, Set<string>>();
  for (const p of powerPicks) {
    if (covered(p)) continue;
    const t = get(p.entity.provider_slug);
    const status = p.selection.pick.status;
    const value = p.selection.pick.value!;
    if (p.metric === "it_power_mw") {
      if (status === "operational") {
        t.it_power_mw += value;
        t.it_sites++;
      } else t.pipeline_it_power_mw[status] += value;
    } else if (p.metric === "facility_power_mw" && !hasIt.has(`${p.entity.id}|${status}`)) {
      if (status === "operational") {
        t.facility_only_power_mw += value;
        t.facility_only_sites++;
      } else t.pipeline_facility_only_power_mw[status] += value;
    } else continue;
    counted++;
    if (p.selection.pick.claim_type === "derived") derived++;
    const eff = p.selection.pick.effective_date;
    if (!t.latest_effective || eff > t.latest_effective) t.latest_effective = eff;
  }
  for (const p of picks) {
    const set = seenSites.get(p.entity.provider_slug) ?? new Set<string>();
    if (!set.has(p.entity.id)) {
      set.add(p.entity.id);
      const t = get(p.entity.provider_slug);
      t.sites++;
      if (p.entity.lat !== null && p.entity.lon !== null) t.located_sites++;
    }
    seenSites.set(p.entity.provider_slug, set);
  }
  for (const t of totals.values()) {
    t.it_power_mw = Math.round(t.it_power_mw * 10) / 10;
    t.facility_only_power_mw = Math.round(t.facility_only_power_mw * 10) / 10;
    t.derived_share = counted ? Math.round((derived / counted) * 100) / 100 : 0;
  }
  return [...totals.values()].sort((a, b) => b.it_power_mw - a.it_power_mw);
}
