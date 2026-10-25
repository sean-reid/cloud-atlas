import type { Source } from "../shared/types";
import type { AdapterContext } from "./adapters/types";

export const ECB_URL = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml";
export const ECB_HOST = "www.ecb.europa.eu";

export const ECB_SOURCE: Omit<Source, "id"> = {
  publisher: "European Central Bank",
  title: "Euro foreign exchange reference rates",
  url: ECB_URL,
  tier: 1,
  published_date: null,
  license: "ECB copyright; free reuse with the ECB cited as the source and any modification stated",
  adapter: null,
};

export type FxCurrency = "EUR" | "GBP";

export interface Rates {
  date: string;
  eurUsd: number;
  eurGbp: number;
}

const rateOf = (xml: string, code: string): number => {
  const m = new RegExp(`<Cube\\s[^>]*currency=['"]${code}['"][^>]*rate=['"]([\\d.]+)['"]`).exec(
    xml,
  );
  return m ? Number(m[1]) : NaN;
};

// The daily file is one Cube per currency under a dated Cube; a strict XML parser would add a
// dependency for no gain.
export function parseRates(xml: string): Rates {
  const date = /<Cube\s[^>]*time=['"](\d{4}-\d{2}-\d{2})['"]/.exec(xml)?.[1];
  const eurUsd = rateOf(xml, "USD");
  const eurGbp = rateOf(xml, "GBP");
  if (!date || !(eurUsd > 0) || !(eurGbp > 0))
    throw new Error("no date, USD, or GBP rate in the ECB file; file layout changed");
  return { date, eurUsd, eurGbp };
}

export async function fetchRates(ctx: Pick<AdapterContext, "fetch">): Promise<Rates> {
  const res = await ctx.fetch(ECB_URL, { accept: "application/xml, text/xml;q=0.9, */*;q=0.5" });
  return parseRates(res.body);
}

// USD per one unit of the currency; GBP goes through the euro cross since the ECB quotes both
// against the euro.
export function usdPer(currency: FxCurrency, rates: Rates): number {
  return currency === "EUR" ? rates.eurUsd : rates.eurUsd / rates.eurGbp;
}

export function toUsd(amount: number, currency: FxCurrency, rates: Rates): number {
  return amount * usdPer(currency, rates);
}

export const isFxCurrency = (c: string): c is FxCurrency => c === "EUR" || c === "GBP";
