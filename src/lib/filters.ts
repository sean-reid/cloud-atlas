import { useCallback, useMemo } from "react";
import { useLocation, useSearch } from "wouter";
import { parseFilters, serializeFilters, type Filters } from "../../shared/filters";

export function useFilters(): [Filters, (patch: Partial<Filters>) => void, string] {
  const search = useSearch();
  const [location, navigate] = useLocation();
  const filters = useMemo(() => parseFilters(new URLSearchParams(search)), [search]);
  const update = useCallback(
    (patch: Partial<Filters>) => {
      const next = serializeFilters({ ...filters, ...patch }).toString();
      navigate(`${location}${next ? `?${next}` : ""}`, { replace: true });
    },
    [filters, location, navigate],
  );
  const query = useMemo(() => serializeFilters(filters).toString(), [filters]);
  return [filters, update, query];
}

export const api = (path: string, query: string) => `/api/${path}${query ? `?${query}` : ""}`;
