import { awsEc2Probes } from "./aws-ec2-probes";
import { awsRegions } from "./aws-regions";
import { awsSpotAdvisor } from "./aws-spot-advisor";
import { azureRegions } from "./azure-regions";
import { azureRetailPrices } from "./azure-retail-prices";
import { csvImport } from "./csv-import";
import { epochAi } from "./epoch-ai";
import { gcpGpuZones } from "./gcp-gpu-zones";
import { gcpRegions } from "./gcp-regions";
import type { Adapter } from "./types";

export const ADAPTERS: readonly Adapter[] = [
  awsRegions,
  gcpRegions,
  azureRegions,
  epochAi,
  csvImport,
  azureRetailPrices,
  awsSpotAdvisor,
  gcpGpuZones,
  awsEc2Probes,
];

export const adapterById = (id: string): Adapter | undefined => ADAPTERS.find((a) => a.id === id);
