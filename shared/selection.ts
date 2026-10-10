import { dateFloor } from "./dates";
import type { ClaimType, Observation, SourceTier, Status } from "./types";

export interface Candidate extends Observation {
  tier: SourceTier;
}

export type TimeMode = "known" | "reconstructed";

export interface Selection {
  pick: Candidate;
  competing: Candidate[];
  disagreement: boolean;
}

const claimRank: Record<ClaimType, number> = { reported: 0, derived: 1, unknown: 2 };

// Dashboard selection rule, applied per entity and metric:
// 1. only accepted observations the system knew (known) or that describe reality (reconstructed) by `asOf`;
// 2. drop anything a later observation explicitly supersedes;
// 3. the most recent effective date wins; ties go to the better source tier, then reported over
//    derived, then the most recently recorded.
// Competing observations are returned so the detail view can show the disagreement.
export function selectObservation(
  all: readonly Candidate[],
  asOf: string | null,
  mode: TimeMode,
): Selection | null {
  const limit = asOf ? dateFloor(asOf.slice(0, 10)) : null;
  const visible = all.filter((o) => {
    if (o.review_status !== "accepted") return false;
    if (o.value === null && (o.value_low === null || o.value_high === null)) return false;
    if (!limit) return true;
    if (mode === "known") return o.recorded_at.slice(0, 10) <= limit;
    return dateFloor(o.effective_date) <= limit;
  });
  const superseded = new Set(
    visible.map((o) => o.supersedes_id).filter((id): id is string => !!id),
  );
  const live = visible.filter((o) => !superseded.has(o.id));
  if (!live.length) return null;
  const sorted = [...live].sort((a, b) => {
    const da = dateFloor(a.effective_date);
    const db = dateFloor(b.effective_date);
    if (da !== db) return da < db ? 1 : -1;
    if (a.tier !== b.tier) return a.tier - b.tier;
    if (claimRank[a.claim_type] !== claimRank[b.claim_type])
      return claimRank[a.claim_type] - claimRank[b.claim_type];
    return a.recorded_at < b.recorded_at ? 1 : a.recorded_at > b.recorded_at ? -1 : 0;
  });
  const pick = sorted[0]!;
  const competing = sorted.slice(1);
  const sameDate = competing.filter(
    (o) => dateFloor(o.effective_date) === dateFloor(pick.effective_date),
  );
  const disagreement = sameDate.some((o) => o.value !== pick.value);
  return { pick, competing, disagreement };
}

// When one metric has a pick at several statuses, the operational figure speaks for the site,
// then the nearest stage of the pipeline.
export const STATUS_PRIORITY: readonly Status[] = [
  "operational",
  "under_construction",
  "announced",
  "unknown",
  "cancelled",
  "decommissioned",
];

export const statusRank = (s: Status): number => STATUS_PRIORITY.indexOf(s);

// One selection per status present, so a 2028 announcement never hides the operational figure.
export function selectByStatus(
  rows: readonly Candidate[],
  asOf: string | null,
  mode: TimeMode,
): Map<Status, Selection> {
  const byStatus = new Map<Status, Candidate[]>();
  for (const r of rows) byStatus.set(r.status, [...(byStatus.get(r.status) ?? []), r]);
  const out = new Map<Status, Selection>();
  for (const status of STATUS_PRIORITY) {
    const list = byStatus.get(status);
    const sel = list && selectObservation(list, asOf, mode);
    if (sel) out.set(status, sel);
  }
  return out;
}

// Operational figures and planned expansion coexist at one site, so the grouping key carries
// the status as well as the metric.
export function groupByEntityMetric(rows: readonly Candidate[]): Map<string, Candidate[]> {
  const out = new Map<string, Candidate[]>();
  for (const r of rows) {
    const key = `${r.entity_id}\u0000${r.metric}\u0000${r.status}`;
    const list = out.get(key) ?? [];
    list.push(r);
    out.set(key, list);
  }
  return out;
}
