export type ProviderSlug =
  | "aws"
  | "azure"
  | "gcp"
  | "oracle"
  | "alibaba"
  | "tencent"
  | "huawei"
  | "ibm"
  | "coreweave"
  | "nebius"
  | "nscale"
  | "crusoe"
  | "baidu"
  | "ovhcloud";

export type ProviderCategory = "hyperscale" | "regional" | "gpu";

export interface Provider {
  slug: ProviderSlug;
  name: string;
  shortName: string;
  company: string;
  category: ProviderCategory;
  color: string;
}

export const PROVIDERS: readonly Provider[] = [
  {
    slug: "aws",
    name: "Amazon Web Services",
    shortName: "AWS",
    company: "Amazon",
    category: "hyperscale",
    color: "#c8721a",
  },
  {
    slug: "azure",
    name: "Microsoft Azure",
    shortName: "Azure",
    company: "Microsoft",
    category: "hyperscale",
    color: "#2a6fbf",
  },
  {
    slug: "gcp",
    name: "Google Cloud",
    shortName: "Google",
    company: "Alphabet",
    category: "hyperscale",
    color: "#2f8f4e",
  },
  {
    slug: "oracle",
    name: "Oracle Cloud Infrastructure",
    shortName: "Oracle",
    company: "Oracle",
    category: "hyperscale",
    color: "#b3301b",
  },
  {
    slug: "alibaba",
    name: "Alibaba Cloud",
    shortName: "Alibaba",
    company: "Alibaba Group",
    category: "regional",
    color: "#d9823b",
  },
  {
    slug: "tencent",
    name: "Tencent Cloud",
    shortName: "Tencent",
    company: "Tencent",
    category: "regional",
    color: "#2b7fa6",
  },
  {
    slug: "huawei",
    name: "Huawei Cloud",
    shortName: "Huawei",
    company: "Huawei",
    category: "regional",
    color: "#8a3a5c",
  },
  {
    slug: "ibm",
    name: "IBM Cloud",
    shortName: "IBM",
    company: "IBM",
    category: "regional",
    color: "#4b5ca8",
  },
  {
    slug: "coreweave",
    name: "CoreWeave",
    shortName: "CoreWeave",
    company: "CoreWeave",
    category: "gpu",
    color: "#5e7a3a",
  },
  {
    slug: "nebius",
    name: "Nebius",
    shortName: "Nebius",
    company: "Nebius Group",
    category: "gpu",
    color: "#3f8a8a",
  },
  {
    slug: "nscale",
    name: "Nscale",
    shortName: "Nscale",
    company: "Nscale",
    category: "gpu",
    color: "#7b6b2e",
  },
  {
    slug: "crusoe",
    name: "Crusoe Cloud",
    shortName: "Crusoe",
    company: "Crusoe Energy",
    category: "gpu",
    color: "#9c5a2a",
  },
  {
    slug: "baidu",
    name: "Baidu AI Cloud",
    shortName: "Baidu",
    company: "Baidu",
    category: "regional",
    color: "#2f4f8f",
  },
  {
    slug: "ovhcloud",
    name: "OVHcloud",
    shortName: "OVHcloud",
    company: "OVH Groupe",
    category: "regional",
    color: "#1f6f9f",
  },
];

export const providerBySlug = (slug: string): Provider | undefined =>
  PROVIDERS.find((p) => p.slug === slug);
