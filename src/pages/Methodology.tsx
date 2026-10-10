import { Link } from "wouter";
import { METRICS } from "../../shared/metrics";
import { PROVIDERS } from "../../shared/providers";
import { useApi } from "../lib/api";
import type { Meta } from "../lib/types";

const FAMILIES: [string, string[]][] = [
  ["IT power", ["it_power_mw"]],
  ["Facility power", ["facility_power_mw", "utility_power_mw"]],
  ["Buildings and sites", ["building_count", "facility_count", "campus_count"]],
  ["Regions and zones", ["region_count", "az_count"]],
  ["Hardware", ["gpu_count", "h100_equivalents"]],
  ["Land and floor area", ["land_area_acres", "floor_area_sqft"]],
  ["Investment", ["investment_usd"]],
];

export function Methodology() {
  const meta = useApi<Meta>("/api/meta");
  const count = (slug: string, metrics: string[]) =>
    (meta.data?.coverage ?? [])
      .filter((c) => c.provider_slug === slug && metrics.includes(c.metric))
      .reduce((n, c) => n + c.n, 0);
  return (
    <div className="prose">
      <section className="block" style={{ paddingTop: "0.5rem" }}>
        <h1>Methodology and coverage</h1>
        <p className="muted" style={{ marginTop: "0.5rem" }}>
          How a number gets onto this site, what it means, and where the evidence runs out.
        </p>
      </section>

      <h2>What capacity means here</h2>
      <p>
        The headline metric is <strong>operational IT power in megawatts</strong>: the electrical
        load available to servers, storage, and network gear. It is a proxy for infrastructure
        scale. It is not computational performance and not capacity a customer can rent.
      </p>
      <p>
        Facility power (the whole building, including cooling and losses), utility supply capacity,
        building and campus counts, cloud region and zone counts, GPU counts, land, and investment
        are each tracked as their own metric and never combined. Where a source gives facility power
        and we show IT power, the conversion names its PUE assumption and is labelled derived.
      </p>
      <p>
        Physical sites (campuses, buildings, phases) and logical geography (regions, availability
        zones) are separate entities. A region never carries power. A zone is not a building.
      </p>

      <h2>Where figures come from</h2>
      <ul>
        <li>
          <strong>Tier 1, official:</strong> provider pages, releases, filings, investor materials.
          Region and zone inventories are read automatically from AWS, Google Cloud, and Microsoft
          documentation every day.
        </li>
        <li>
          <strong>Tier 2, public records:</strong> planning permissions, utility filings, county and
          state documents.
        </li>
        <li>
          <strong>Tier 3, research datasets:</strong> Epoch AI&apos;s AI data centers dataset (CC BY
          4.0), read automatically every day. It covers large AI sites only and estimates IT power
          from satellite imagery, permits, and statements; Epoch states that 80% of its IT power
          estimates fall within a factor of 1.4 of the true value. It is not a measure of cloud
          coverage and is always labelled derived.
        </li>
        <li>
          <strong>Tier 4, reporting:</strong> trade and news reporting with attributable evidence,
          transcribed by hand with a quoted excerpt.
        </li>
      </ul>
      <p>
        Hand-transcribed observations enter through a reviewed CSV import that validates every field
        and sends anything ambiguous to a review queue. No capacity figure is extracted from prose
        automatically.
      </p>

      <h2>Provenance on every observation</h2>
      <p>
        Source URL, publisher, title, and publication date; the date the claim describes and its
        precision; the date we recorded it; entity and scope; metric, value as written, and
        normalized units; reported or derived; a quoted excerpt or table locator; the method and
        assumptions for anything derived; review status; and a link to any observation it
        supersedes. Observations are never edited or deleted. Disagreements coexist and are shown on
        the entity page.
      </p>

      <h2>Which figure the dashboard shows</h2>
      <p>For each site and metric, the selection rule picks one observation:</p>
      <ul>
        <li>only accepted observations, and only those visible at the chosen date;</li>
        <li>anything a later observation explicitly supersedes is hidden;</li>
        <li>
          the most recent claim date wins; ties go to the better source tier, then reported over
          derived, then the most recently recorded.
        </li>
      </ul>
      <p>Everything that lost is listed under the winner on the entity page.</p>

      <h2>How totals are built</h2>
      <p>
        A total is the sum of selected operational IT power figures over physical sites, with one
        guard: a site counts only if no parent of it already counts the same metric at the same
        status. A campus total replaces its buildings; a campus without a total is the sum of its
        buildings. Sites with only a facility power figure are shown in a separate facility-only
        total. Provider-wide statements (&quot;400 datacenters&quot;) are shown as such and never
        added to site totals.
      </p>
      <p>
        Totals are <em>tracked</em> capacity: the sum over sites we can document. Unknown is not
        zero, and no percentage of a global total is shown because the denominator is unknown.
      </p>

      <h2>Time</h2>
      <p>
        Every observation has an effective date (what period the claim describes) and a recorded
        date (when this system learned it). The &quot;best current reconstruction&quot; view uses
        effective dates; the &quot;as known at the time&quot; view uses recorded dates and so cannot
        use later evidence to describe an earlier month. Series are step lines because capacity
        changes at observations, not between them. Markers separate newly tracked sites from revised
        figures: a rise in tracked capacity is not the same as new construction.
      </p>
      <p>
        Historical values before this system started come only from dated evidence, chiefly Epoch
        AI&apos;s construction timelines and dated statements. Nothing is interpolated.
      </p>

      <h2>Availability signals</h2>
      <p>
        A separate family of measurements asks whether a new customer could get a given virtual
        machine SKU in a given region right now. Public signals: Azure&apos;s spot to pay-as-you-go
        price ratio and SKU offering map, AWS&apos;s spot interruption frequency bands, and
        Google&apos;s GPU offering per zone. Account signals, run only when read-only credentials
        exist: AWS placement scores and capacity block lead times, Google&apos;s calendar-mode lead
        times, Oracle capacity reports, and Alibaba and Tencent sell status. Each level is relative
        within one provider and SKU family, the provider&apos;s own measurement is shown next to it,
        and nothing is converted to megawatts or compared across providers.
      </p>

      <h2>Confidence</h2>
      <p>
        Categories, not probabilities. <strong>Reported</strong> means the figure appears in the
        cited source as written. <strong>Derived</strong> means a documented method produced it (a
        PUE conversion, a currency conversion, a table count, or Epoch AI&apos;s model). Source tier
        says who said it. The tilde and dashed marks on the site mean derived; the italic stale tag
        means the latest claim is over eighteen months old.
      </p>

      <h2>Coverage matrix</h2>
      <p className="small muted">
        Accepted observations per provider and metric family, live dataset. A dash means no evidence
        yet.
      </p>
      <div className="table-scroll">
        <table className="matrix">
          <thead>
            <tr>
              <th>Provider</th>
              {FAMILIES.map(([label]) => (
                <th key={label}>{label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {PROVIDERS.map((p) => (
              <tr key={p.slug}>
                <td>
                  <Link href={`/providers/${p.slug}`}>{p.shortName}</Link>
                </td>
                {FAMILIES.map(([label, metrics]) => {
                  const n = count(p.slug, metrics);
                  return (
                    <td key={label} className={n ? "" : "faint"}>
                      {n || "-"}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2>Known gaps</h2>
      <ul>
        <li>
          No cloud provider publishes power per region or per facility. Site-level MW rests on
          permits, filings, and reporting.
        </li>
        <li>
          Alibaba, Tencent, Huawei, and IBM are tracked at provider level; their region pages give
          counts, not sites. Baidu AI Cloud and OVHcloud have no evidence yet and appear as gaps.
        </li>
        <li>
          Coverage outside the United States is thin because that is where open permit records and
          the Epoch dataset concentrate.
        </li>
        <li>
          Capacity Microsoft rents from suppliers such as CoreWeave or Nebius is recorded as
          supplier-operated and flagged in notes.
        </li>
        <li>
          The AWS placement score and Capacity Block probe runs only once read-only account keys are
          set. The Oracle capacity report and Alibaba and Tencent sold-out probes are designed but
          not yet written.
        </li>
        <li>The metrics tracked here: {METRICS.map((m) => m.label.toLowerCase()).join("; ")}.</li>
      </ul>
    </div>
  );
}
