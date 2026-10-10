import type { Dataset, Source } from "../../shared/types";
import type { FetchOptions, FetchResult } from "../fetch";
import type { Gazetteer } from "../geo";
import type { Store } from "../store";

import { adapterMeta, type AdapterMeta } from "../../shared/adapters-meta";

export type { IngestMode, Schedule } from "../../shared/adapters-meta";

export interface AdapterContext {
  store: Store;
  dataset: Dataset;
  now: () => Date;
  fetch: (url: string, opts?: Partial<FetchOptions>) => Promise<FetchResult>;
  geo: GeoIndex;
  places: Gazetteer;
}

// Thrown by a probe whose account the provider has not admitted to the API it needs. The runner
// records the run as waiting, like missing credentials, instead of as a failure.
export class ProbeUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProbeUnavailable";
  }
}

export interface AdapterResult {
  observations: number;
  entities: number;
  signals: number;
  review: number;
}

export interface Adapter extends AdapterMeta {
  url: string;
  tier: 1 | 2 | 3 | 4;
  license: string;
  hosts: readonly string[];
  source: () => Source;
  run: (ctx: AdapterContext) => Promise<AdapterResult>;
}

export interface GeoRegion {
  code: string;
  name: string;
  locality: string | null;
  admin_area: string | null;
  country_code: string;
  lat: number;
  lon: number;
}

export type GeoIndex = Record<string, Record<string, GeoRegion>>;

export const emptyResult = (): AdapterResult => ({
  observations: 0,
  entities: 0,
  signals: 0,
  review: 0,
});

export function meta(id: string): AdapterMeta {
  const m = adapterMeta(id);
  if (!m) throw new Error(`adapter ${id} has no entry in shared/adapters-meta.ts`);
  return m;
}
