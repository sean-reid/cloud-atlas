import type { Method } from "../shared/types";
import type { Store } from "./store";

// Every derived value names one of these. Bump the version when the rule changes and
// keep the old row, since existing observations still point at it.
export const METHODS: readonly Method[] = [
  {
    id: "count-from-table.v1",
    version: 1,
    title: "Count of rows in an official table",
    description:
      "The value is the number of rows the adapter counted in a provider's published table at retrieval time, not a figure the provider stated.",
    assumptions: "Every row is a distinct entity; the table is complete for the public cloud.",
  },
  {
    id: "epoch-ai-satellite.v1",
    version: 1,
    title: "Epoch AI satellite and permit estimate",
    description:
      "IT power estimated by Epoch AI from cooling equipment visible in satellite imagery, permits, and company statements. Epoch states that 80% of its IT power estimates fall within a factor of 1.4 of the true value.",
    assumptions:
      "Epoch AI's own model; facility power is their total site power estimate. Cloud Atlas does not re-derive these figures.",
  },
  {
    id: "pue-conversion.v1",
    version: 1,
    title: "Facility to IT power by PUE",
    description: "IT power = facility power divided by an assumed power usage effectiveness.",
    assumptions:
      "PUE stated per observation in its notes; hyperscale default 1.2 when a source gives none.",
  },
  {
    id: "fx-conversion.v1",
    version: 1,
    title: "Currency conversion to USD",
    description:
      "Non-USD investment figures converted at an approximate annual average rate stated in the observation notes.",
    assumptions: "Rates are indicative, not the rate on the announcement date.",
  },
  {
    id: "first-seen.v1",
    version: 1,
    title: "First appearance in provider documentation",
    description:
      "The date a region code first appeared in the provider's published region table, read daily. A lower bound on age: the region may have opened before the table listed it.",
    assumptions:
      "The table is read at least daily; the seed run records nothing because every region is new to it.",
  },
  {
    id: "spot-ratio.v1",
    version: 1,
    title: "Spot to on-demand price ratio",
    description:
      "Spot price divided by the pay-as-you-go Linux price for the same SKU in the same region. A ratio near 1 means the spot pool is tight; a missing spot price means no spot pool is offered there.",
    assumptions:
      "Both prices from the same retail price snapshot; Windows and low-priority meters excluded.",
  },
  {
    id: "interruption-band.v1",
    version: 1,
    title: "Spot interruption frequency band",
    description:
      "AWS publishes the interruption frequency of each instance type per region in five bands over the trailing 30 days. The band index (0 lowest to 4 highest) is stored as the signal value.",
    assumptions:
      "Reclaim rate reflects pressure on the spot pool; a low band can also mean low spot usage of that type.",
  },
  {
    id: "feed-sentence.v1",
    version: 1,
    title: "Figure read from a provider news feed",
    description:
      "A power or investment figure matched by rule in one sentence of a provider's own news feed; the sentence is the excerpt and the entry link is the locator. Accepted without review only when the sentence holds one figure, a status word, and a place that resolves to a site already tracked for that provider. Every other figure waits in the review queue.",
    assumptions:
      "The figure describes the place named in the same sentence; the entry's publication date is the claim date.",
  },
  {
    id: "lead-time-days.v1",
    version: 1,
    title: "Capacity Block lead time",
    description:
      "Whole days from the probe time to the earliest start date AWS offers for one instance for 24 hours within the next 14 days. 0 means a start within 24 hours; 999 means no offering came back.",
    assumptions:
      "The earliest offered start is the soonest a new customer could get the instance type; the account's own reservations do not change what is offered.",
  },
];

export async function ensureMethods(store: Store): Promise<void> {
  for (const m of METHODS) await store.upsertMethod(m);
}
