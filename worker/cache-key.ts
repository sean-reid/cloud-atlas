export const FILTER_PARAMS = [
  "provider",
  "country",
  "status",
  "metric",
  "claim",
  "tier",
  "from",
  "to",
  "asof",
  "mode",
  "q",
  "precision",
  "demo",
] as const;

// Edge cache key: the path plus only the parameters the route reads, sorted, so an unknown or
// reordered parameter cannot bypass the cache or fill it with duplicates.
export function cacheKey(url: URL, known: readonly string[]): string {
  const keep = new URLSearchParams();
  for (const name of [...known].sort()) {
    const value = url.searchParams.get(name);
    if (value !== null && value !== "") keep.set(name, value);
  }
  const query = keep.toString();
  return `${url.origin}${url.pathname}${query ? `?${query}` : ""}`;
}
