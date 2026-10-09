import type { ProviderSlug } from "./providers";

export type Dataset = "live" | "demo";

export type EntityType = "provider" | "region" | "zone" | "campus" | "facility" | "phase";

export type LocationPrecision = "exact" | "locality" | "region_centroid" | "unknown";

export type Ownership = "owned" | "leased" | "joint_venture" | "unknown";

export type Status =
  "operational" | "under_construction" | "announced" | "cancelled" | "decommissioned" | "unknown";

export type Scope = "provider_wide" | "public_cloud" | "campus" | "facility" | "phase" | "region";

export type ClaimType = "reported" | "derived" | "unknown";

export type DatePrecision = "day" | "month" | "year";

export type EffectiveKind = "as_of" | "opened" | "announced" | "expected_completion";

export type ReviewStatus = "accepted" | "pending" | "rejected";

export type SourceTier = 1 | 2 | 3 | 4;

export interface Entity {
  id: string;
  dataset: Dataset;
  type: EntityType;
  provider_slug: ProviderSlug;
  parent_id: string | null;
  name: string;
  slug: string;
  code: string | null;
  country_code: string | null;
  admin_area: string | null;
  locality: string | null;
  lat: number | null;
  lon: number | null;
  location_precision: LocationPrecision;
  ownership: Ownership;
  landlord: string | null;
}

export interface Source {
  id: string;
  publisher: string;
  title: string;
  url: string;
  tier: SourceTier;
  published_date: string | null;
  license: string | null;
  adapter: string | null;
}

export interface Method {
  id: string;
  version: number;
  title: string;
  description: string;
  assumptions: string;
}

export interface Observation {
  id: string;
  dataset: Dataset;
  entity_id: string;
  metric: string;
  value: number | null;
  value_low: number | null;
  value_high: number | null;
  unit: string;
  value_original: string | null;
  status: Status;
  scope: Scope;
  claim_type: ClaimType;
  effective_date: string;
  effective_precision: DatePrecision;
  effective_kind: EffectiveKind;
  recorded_at: string;
  retrieved_at: string;
  source_id: string;
  excerpt: string | null;
  locator: string | null;
  method_id: string | null;
  derived_from: string | null;
  supersedes_id: string | null;
  review_status: ReviewStatus;
  notes: string | null;
}

export interface FetchRun {
  adapter: string;
  url: string;
  started_at: string;
  finished_at: string;
  ok: boolean;
  http_status: number | null;
  content_hash: string | null;
  changed: boolean;
  observations: number;
  error: string | null;
}

export type AvailabilitySignalKind =
  | "sku_offered"
  | "spot_ratio"
  | "placement_score"
  | "sell_status"
  | "capacity_report"
  | "interruption_band"
  | "lead_time_days";

export interface AvailabilitySignal {
  id: string;
  provider_slug: ProviderSlug;
  region_code: string;
  zone_code: string | null;
  sku: string;
  sku_family: string;
  signal: AvailabilitySignalKind;
  value: number;
  unit: string;
  observed_at: string;
  source_id: string;
  detail: string | null;
}

export interface ReviewItem {
  id: string;
  created_at: string;
  adapter: string;
  reason: string;
  payload: string;
  resolved_at: string | null;
  resolution: string | null;
}
