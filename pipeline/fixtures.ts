import { readFileSync } from "node:fs";
import { join } from "node:path";

export const FIXTURE_DIR = join(process.cwd(), "tests", "fixtures");

const ROUTES: Record<string, string> = {
  "https://docs.aws.amazon.com/global-infrastructure/latest/regions/aws-regions.html":
    "aws-regions.html",
  "https://docs.aws.amazon.com/global-infrastructure/latest/regions/doc-history.html":
    "aws-history.html",
  "https://raw.githubusercontent.com/boto/botocore/develop/botocore/data/endpoints.json":
    "endpoints.json",
  "https://docs.cloud.google.com/compute/docs/regions-zones": "gcp-zones.html",
  "https://www.gstatic.com/ipranges/cloud.json": "cloud.json",
  "https://learn.microsoft.com/en-us/azure/reliability/regions-list": "azure-regions.html",
  "https://epoch.ai/data/data_centers/data_centers.csv": "epoch-sites.csv",
  "https://epoch.ai/data/data_centers/data_center_timelines.csv": "epoch-timelines.csv",
  "https://spot-bid-advisor.s3.amazonaws.com/spot-advisor-data.json": "spot-advisor.json",
  "https://docs.cloud.google.com/compute/docs/gpus/gpu-regions-zones": "gcp-gpu-zones.html",
};

// Serves recorded copies of every source so tests and offline seeding never touch the network.
export function fixtureFetch(
  dir = FIXTURE_DIR,
  overrides: Record<string, () => Response> = {},
): typeof fetch {
  const read = (name: string) => readFileSync(join(dir, name), "utf8");
  return (async (input: URL | string | Request) => {
    const url = String(input);
    const override = Object.entries(overrides).find(([k]) => url.startsWith(k));
    if (override) return override[1]();
    if (url.startsWith("https://prices.azure.com/"))
      return new Response(read("azure-prices.json"), { status: 200 });
    const file = ROUTES[url];
    if (!file) return new Response("not found", { status: 404 });
    return new Response(read(file), { status: 200, headers: { etag: `"${file}"` } });
  }) as typeof fetch;
}
