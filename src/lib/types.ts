import type { Entity, Observation } from "../../shared/types";
import type { ProviderTotals } from "../../shared/aggregate";

export interface SiteMetric {
  value: number | null;
  low: number | null;
  high: number | null;
  unit: string;
  status: Observation["status"];
  claim_type: Observation["claim_type"];
  effective_date: string;
  effective_kind: Observation["effective_kind"];
  tier: number;
  competing: number;
  disagreement: boolean;
  observation_id: string;
}

export interface SiteRow {
  id: string;
  name: string;
  type: Entity["type"];
  provider_slug: string;
  parent_id: string | null;
  country_code: string | null;
  admin_area: string | null;
  locality: string | null;
  lat: number | null;
  lon: number | null;
  location_precision: Entity["location_precision"];
  ownership: Entity["ownership"];
  landlord: string | null;
  metrics: Record<string, SiteMetric>;
  observation_count: number;
  latest_recorded: string;
  age_days: number | null;
}

export interface Summary {
  totals: ProviderTotals[];
  tracked: {
    it_power_mw: number;
    facility_only_power_mw: number;
    sites: number;
    located_sites: number;
    pipeline_it_power_mw: { under_construction: number; announced: number };
    pipeline_facility_only_power_mw: { under_construction: number; announced: number };
  };
  provider_stated: Record<
    string,
    Record<
      string,
      { pick: Observation & { tier: number }; competing: unknown[]; disagreement: boolean }
    >
  >;
  evidence: { observations: number; latest_recorded: string | null };
}

export interface SeriesPoint {
  date: string;
  it_power_mw: number;
  facility_only_power_mw: number;
  sites: number;
  new_sites: number;
  revised_sites: number;
}

export interface Meta {
  countries: { country_code: string; n: number }[];
  coverage: { provider_slug: string; metric: string; status: string; n: number }[];
  freshness: {
    adapter: string;
    last_attempt: string;
    last_success: string | null;
    ok: boolean;
    changed: boolean;
    error: string | null;
  }[];
}

export interface FeedItem extends Observation {
  tier: number;
  entity_name: string;
  entity_type: string;
  provider_slug: string;
  publisher: string;
  title: string;
  url: string;
  kind: string;
}
