import type { ProviderSlug } from "./providers";
import type { AvailabilitySignalKind } from "./types";

export type IngestMode = "automated" | "manual_review" | "unsupported";
export type Schedule = "hourly" | "daily" | "weekly" | "manual";

export interface AdapterMeta {
  id: string;
  title: string;
  publisher: string;
  mode: IngestMode;
  schedule: Schedule;
  measures: string;
  credentials?: readonly string[];
  provider?: ProviderSlug;
  signals?: readonly AvailabilitySignalKind[];
}

// One list for the pipeline, the sources page, and the methodology page. An adapter that
// names credentials runs only when every variable is set and shows as waiting otherwise.
export const ADAPTER_META: readonly AdapterMeta[] = [
  {
    id: "aws-regions",
    title: "AWS regions and zones",
    publisher: "Amazon Web Services",
    mode: "automated",
    schedule: "daily",
    measures:
      "Region codes, names, availability zone counts, and launch dates. Geography only; no power.",
  },
  {
    id: "gcp-regions",
    title: "Google Cloud regions and zones",
    publisher: "Google Cloud",
    mode: "automated",
    schedule: "daily",
    measures:
      "Zone codes with their cities, zones per region, and region codes present in the public IP range feed. Geography only.",
  },
  {
    id: "azure-regions",
    title: "Azure regions list",
    publisher: "Microsoft",
    mode: "automated",
    schedule: "daily",
    measures:
      "Public cloud regions with availability zone counts and physical locations. Geography only.",
  },
  {
    id: "epoch-ai",
    title: "Epoch AI, AI data centers",
    publisher: "Epoch AI",
    mode: "automated",
    schedule: "daily",
    measures:
      "Estimated IT power, total power, and H100-equivalent compute for the largest AI data centers, with dated construction timelines. AI facilities only.",
  },
  {
    id: "csv-import",
    title: "Reviewed observations",
    publisher: "Cloud Atlas maintainers",
    mode: "manual_review",
    schedule: "manual",
    measures:
      "Hand-reviewed capacity, investment, land, and count observations transcribed with a citation and excerpt.",
  },
  {
    id: "azure-retail-prices",
    title: "Azure Retail Prices",
    publisher: "Microsoft",
    mode: "automated",
    schedule: "hourly",
    measures:
      "Which VM SKUs are offered per region, and the spot to pay-as-you-go price ratio as a scarcity proxy.",
  },
  {
    id: "aws-spot-advisor",
    title: "AWS Spot Instance Advisor",
    publisher: "Amazon Web Services",
    mode: "automated",
    schedule: "hourly",
    measures:
      "Spot interruption frequency band per instance type and region over the trailing month.",
  },
  {
    id: "gcp-gpu-zones",
    title: "Google Cloud GPU zones",
    publisher: "Google Cloud",
    mode: "automated",
    schedule: "daily",
    measures: "GPU machine types offered per zone, from the documentation. Offering only.",
  },
  {
    id: "aws-ec2-probes",
    title: "AWS placement scores and Capacity Blocks",
    publisher: "Amazon Web Services",
    mode: "automated",
    schedule: "hourly",
    measures:
      "Spot placement score per instance type and region for 8 and 64 units, and days until the earliest 24 hour Capacity Block for p5.48xlarge and p5en.48xlarge.",
    credentials: ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"],
    provider: "aws",
    signals: ["placement_score", "lead_time_days"],
  },
  {
    id: "gcp-calendar-mode",
    title: "Google Cloud calendar-mode advice",
    publisher: "Google Cloud",
    mode: "automated",
    schedule: "hourly",
    measures:
      "Days until Compute Engine can start a 24-hour block of 1 or 8 A3 or A4 GPU VMs per region, from the calendar-mode advice API.",
    credentials: ["GCP_PROJECT", "GCP_SERVICE_ACCOUNT_JSON"],
    provider: "gcp",
    signals: ["lead_time_days"],
  },
  {
    id: "oci-capacity-report",
    title: "Oracle Cloud capacity reports",
    publisher: "Oracle",
    mode: "automated",
    schedule: "hourly",
    measures:
      "Capacity report verdict per GPU shape and availability domain across the tenancy's subscribed regions.",
    credentials: ["OCI_TENANCY", "OCI_USER", "OCI_FINGERPRINT", "OCI_PRIVATE_KEY", "OCI_REGION"],
    provider: "oracle",
    signals: ["capacity_report"],
  },
  {
    id: "alibaba-available-resource",
    title: "Alibaba Cloud available resources",
    publisher: "Alibaba Cloud",
    mode: "automated",
    schedule: "hourly",
    measures: "Sell status per GPU instance type and zone from the ECS available resource check.",
    credentials: ["ALIBABA_ACCESS_KEY_ID", "ALIBABA_ACCESS_KEY_SECRET"],
    provider: "alibaba",
    signals: ["sell_status"],
  },
  {
    id: "tencent-zone-config",
    title: "Tencent Cloud zone instance configs",
    publisher: "Tencent Cloud",
    mode: "automated",
    schedule: "hourly",
    measures: "Sell status per GPU instance type and zone from the CVM zone configuration listing.",
    credentials: ["TENCENT_SECRET_ID", "TENCENT_SECRET_KEY"],
    provider: "tencent",
    signals: ["sell_status"],
  },
];

export const adapterMeta = (id: string): AdapterMeta | undefined =>
  ADAPTER_META.find((a) => a.id === id);
