import { PROVIDERS } from "../../shared/providers";
import type { Filters } from "../../shared/filters";
import { DEFAULT_FILTERS } from "../../shared/filters";
import type { Status } from "../../shared/types";
import { statusLabel } from "../lib/format";

interface Props {
  filters: Filters;
  update: (patch: Partial<Filters>) => void;
  countries: { country_code: string; n: number }[];
}

const STATUSES: Status[] = [
  "operational",
  "under_construction",
  "announced",
  "cancelled",
  "decommissioned",
  "unknown",
];
const regionNames =
  typeof Intl !== "undefined" && "DisplayNames" in Intl
    ? new Intl.DisplayNames(["en"], { type: "region" })
    : null;
export const countryName = (code: string) => {
  try {
    return regionNames?.of(code) ?? code;
  } catch {
    return code;
  }
};

export function FilterBar({ filters, update, countries }: Props) {
  const toggle = (slug: string) => {
    const set = new Set(filters.providers);
    if (set.has(slug)) set.delete(slug);
    else set.add(slug);
    update({ providers: [...set] });
  };
  const toggleStatus = (s: Status) => {
    const set = new Set(filters.statuses);
    if (set.has(s)) set.delete(s);
    else set.add(s);
    update({ statuses: [...set] });
  };
  const dirty =
    JSON.stringify({ ...filters, demo: false }) !==
    JSON.stringify({ ...DEFAULT_FILTERS, demo: false });
  const advancedCount =
    (filters.claim ? 1 : 0) + (filters.asof ? 1 : 0) + (filters.mode !== "reconstructed" ? 1 : 0);
  const advancedOpen = advancedCount > 0;
  const active =
    filters.providers.length +
    filters.statuses.length +
    filters.countries.length +
    (filters.claim ? 1 : 0) +
    (filters.tier ? 1 : 0) +
    (filters.from ? 1 : 0) +
    (filters.to ? 1 : 0) +
    (filters.asof ? 1 : 0) +
    (filters.q ? 1 : 0) +
    (filters.mode !== "reconstructed" ? 1 : 0);
  return (
    <details
      className="filters-drawer"
      open={typeof window !== "undefined" && window.innerWidth >= 900}
    >
      <summary>
        <span className="cap">Filters{active ? ` · ${active} active` : ""}</span>
        <span className="muted small">
          {filters.providers.length ? filters.providers.join(", ") : "all providers"}
        </span>
      </summary>
      <form
        className="filters"
        role="search"
        aria-label="Filters"
        onSubmit={(e) => e.preventDefault()}
      >
        <div className="field wide">
          <span>Provider</span>
          <div className="chips">
            {PROVIDERS.map((p) => (
              <button
                type="button"
                key={p.slug}
                className="chip"
                aria-pressed={filters.providers.includes(p.slug)}
                onClick={() => toggle(p.slug)}
                style={{ ["--c" as string]: p.color }}
              >
                <span className="dot" />
                {p.shortName}
              </button>
            ))}
          </div>
        </div>
        <div className="field wide">
          <span>Status</span>
          <div className="chips">
            {STATUSES.map((s) => (
              <button
                type="button"
                key={s}
                className="chip"
                aria-pressed={filters.statuses.includes(s)}
                onClick={() => toggleStatus(s)}
              >
                {statusLabel[s]}
              </button>
            ))}
          </div>
        </div>
        <label className="field">
          <span>Country</span>
          <select
            value={filters.countries[0] ?? ""}
            onChange={(e) => update({ countries: e.target.value ? [e.target.value] : [] })}
          >
            <option value="">all</option>
            {countries.map((c) => (
              <option key={c.country_code} value={c.country_code}>
                {countryName(c.country_code)} ({c.n})
              </option>
            ))}
          </select>
        </label>
        <label className="field wide">
          <span>Search</span>
          <input
            type="search"
            placeholder="site or place"
            value={filters.q}
            onChange={(e) => update({ q: e.target.value })}
          />
        </label>
        <details className="field more" open={advancedOpen}>
          <summary className="cap">
            More filters{advancedCount ? ` · ${advancedCount} active` : ""}
          </summary>
          <div className="filters inner">
            <label className="field">
              <span>Evidence</span>
              <select
                value={filters.claim}
                onChange={(e) => update({ claim: e.target.value as Filters["claim"] })}
              >
                <option value="">reported and derived</option>
                <option value="reported">reported</option>
                <option value="derived">derived</option>
              </select>
            </label>

            <label className="field">
              <span>As of</span>
              <input
                type="date"
                value={filters.asof}
                onChange={(e) => update({ asof: e.target.value })}
              />
            </label>

            <label className="field">
              <span>Time</span>
              <select
                value={filters.mode}
                onChange={(e) => update({ mode: e.target.value as Filters["mode"] })}
              >
                <option value="reconstructed">current reconstruction</option>
                <option value="known">as known then</option>
              </select>
            </label>
          </div>
        </details>
        {dirty && (
          <button
            type="button"
            className="reset"
            onClick={() => update({ ...DEFAULT_FILTERS, demo: filters.demo })}
          >
            reset filters
          </button>
        )}
      </form>
    </details>
  );
}
