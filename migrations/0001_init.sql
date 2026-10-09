-- Providers and the entities they operate. Regions and zones are logical; campuses,
-- facilities, and phases are physical. A region never carries capacity.
CREATE TABLE provider (
  slug TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  short_name TEXT NOT NULL,
  company TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('hyperscale', 'regional', 'gpu')),
  color TEXT NOT NULL
);

CREATE TABLE entity (
  id TEXT PRIMARY KEY,
  dataset TEXT NOT NULL DEFAULT 'live' CHECK (dataset IN ('live', 'demo')),
  type TEXT NOT NULL CHECK (type IN ('provider', 'region', 'zone', 'campus', 'facility', 'phase')),
  provider_slug TEXT NOT NULL REFERENCES provider(slug),
  parent_id TEXT REFERENCES entity(id),
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  code TEXT,
  country_code TEXT,
  admin_area TEXT,
  locality TEXT,
  lat REAL,
  lon REAL,
  location_precision TEXT NOT NULL DEFAULT 'unknown'
    CHECK (location_precision IN ('exact', 'locality', 'region_centroid', 'unknown')),
  ownership TEXT NOT NULL DEFAULT 'unknown'
    CHECK (ownership IN ('owned', 'leased', 'joint_venture', 'unknown')),
  landlord TEXT,
  UNIQUE (provider_slug, type, slug)
);
CREATE INDEX entity_provider ON entity(provider_slug, type);
CREATE INDEX entity_parent ON entity(parent_id);
CREATE INDEX entity_country ON entity(country_code);

CREATE TABLE source (
  id TEXT PRIMARY KEY,
  publisher TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  tier INTEGER NOT NULL CHECK (tier BETWEEN 1 AND 4),
  published_date TEXT,
  license TEXT,
  adapter TEXT
);

CREATE TABLE method (
  id TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  assumptions TEXT NOT NULL
);

-- Append only. effective_date is when the claim describes reality; recorded_at is when
-- this system learned of it. Disagreements coexist; supersedes_id links revisions.
CREATE TABLE observation (
  id TEXT PRIMARY KEY,
  dataset TEXT NOT NULL DEFAULT 'live' CHECK (dataset IN ('live', 'demo')),
  entity_id TEXT NOT NULL REFERENCES entity(id),
  metric TEXT NOT NULL,
  value REAL,
  value_low REAL,
  value_high REAL,
  unit TEXT NOT NULL,
  value_original TEXT,
  status TEXT NOT NULL CHECK (status IN
    ('operational', 'under_construction', 'announced', 'cancelled', 'decommissioned', 'unknown')),
  scope TEXT NOT NULL CHECK (scope IN ('provider_wide', 'public_cloud', 'campus', 'facility', 'phase', 'region')),
  claim_type TEXT NOT NULL CHECK (claim_type IN ('reported', 'derived', 'unknown')),
  effective_date TEXT NOT NULL,
  effective_precision TEXT NOT NULL CHECK (effective_precision IN ('day', 'month', 'year')),
  effective_kind TEXT NOT NULL CHECK (effective_kind IN ('as_of', 'opened', 'announced', 'expected_completion')),
  recorded_at TEXT NOT NULL,
  retrieved_at TEXT NOT NULL,
  source_id TEXT NOT NULL REFERENCES source(id),
  excerpt TEXT,
  locator TEXT,
  method_id TEXT REFERENCES method(id),
  derived_from TEXT,
  supersedes_id TEXT REFERENCES observation(id),
  review_status TEXT NOT NULL DEFAULT 'accepted'
    CHECK (review_status IN ('accepted', 'pending', 'rejected')),
  notes TEXT
);
CREATE INDEX observation_entity_metric ON observation(entity_id, metric, effective_date);
CREATE INDEX observation_recorded ON observation(recorded_at);
CREATE INDEX observation_source ON observation(source_id);

-- One row per fetch attempt per adapter. Source health reads the latest rows.
CREATE TABLE fetch_run (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  adapter TEXT NOT NULL,
  url TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  ok INTEGER NOT NULL,
  http_status INTEGER,
  content_hash TEXT,
  changed INTEGER NOT NULL DEFAULT 0,
  observations INTEGER NOT NULL DEFAULT 0,
  error TEXT
);
CREATE INDEX fetch_run_adapter ON fetch_run(adapter, started_at);

-- Short-lived accessibility signals (spot price ratios, placement scores, SKU offerings).
-- A different measurement from capacity; never converted to MW.
CREATE TABLE availability_signal (
  id TEXT PRIMARY KEY,
  provider_slug TEXT NOT NULL REFERENCES provider(slug),
  region_code TEXT NOT NULL,
  zone_code TEXT,
  sku TEXT NOT NULL,
  sku_family TEXT NOT NULL,
  signal TEXT NOT NULL,
  value REAL NOT NULL,
  unit TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  source_id TEXT NOT NULL REFERENCES source(id),
  detail TEXT
);
CREATE INDEX availability_signal_lookup ON availability_signal(provider_slug, signal, observed_at);

CREATE TABLE review_item (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  adapter TEXT NOT NULL,
  reason TEXT NOT NULL,
  payload TEXT NOT NULL,
  resolved_at TEXT,
  resolution TEXT
);
