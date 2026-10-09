import { useEffect, useRef, useState } from "react";

export interface Loaded<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
}

const cache = new Map<string, unknown>();
const IDLE: Loaded<never> = { data: null, error: null, loading: false };

interface Result<T> extends Loaded<T> {
  path: string;
}

// Small fetch hook with an in-memory cache keyed by URL, so the map, charts, and table share
// one request per filter state and never disagree. State for a stale path is ignored.
export function useApi<T>(path: string | null): Loaded<T> {
  const [result, setResult] = useState<Result<T> | null>(null);
  const latest = useRef(path);
  useEffect(() => {
    latest.current = path;
    if (!path || cache.has(path)) return;
    const ctrl = new AbortController();
    fetch(path, { signal: ctrl.signal })
      .then(async (r) => {
        if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
        return (await r.json()) as T;
      })
      .then((data) => {
        cache.set(path, data);
        if (latest.current === path) setResult({ path, data, error: null, loading: false });
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return;
        setResult({
          path,
          data: null,
          error: err instanceof Error ? err.message : String(err),
          loading: false,
        });
      });
    return () => ctrl.abort();
  }, [path]);
  if (!path) return IDLE;
  if (cache.has(path)) return { data: cache.get(path) as T, error: null, loading: false };
  if (result && result.path === path) return result;
  return { data: null, error: null, loading: true };
}
