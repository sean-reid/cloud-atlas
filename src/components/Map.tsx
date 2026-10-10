import * as maplibregl from "maplibre-gl";
import type { Map as MLMap, MapGeoJSONFeature, MapMouseEvent } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import { useEffect, useRef, useState } from "react";
import { feature } from "topojson-client";
import type { Topology, GeometryCollection } from "topojson-specification";
import { useLocation } from "wouter";
import { providerBySlug, PROVIDERS } from "../../shared/providers";
import { fmtMw, precisionLabel, statusLabel } from "../lib/format";
import { escapeHtml } from "../lib/html";
import type { SiteRow } from "../lib/types";

export interface RegionMarker {
  id: string;
  code: string | null;
  name: string;
  provider_slug: string;
  lat: number | null;
  lon: number | null;
  az_count: number | null;
  opened: string | null;
  level?: string;
}

interface Props {
  sites: SiteRow[];
  regions: RegionMarker[];
  metric: string;
  variant?: "atlas" | "availability";
  onSelect?: (id: string) => void;
}

const LEVEL_COLOR: Record<string, string> = {
  available: "#2f8f4e",
  constrained: "#c8721a",
  tight: "#b3301b",
  offered: "#8f887a",
  unknown: "#8f887a",
};

// The bundler rewrites the worker's own imports; MapLibre only needs to know where it landed.
maplibregl.setWorkerUrl(workerUrl);

// Country polygons rather than the merged land object: the merged shape crosses the antimeridian
// and fills the Arctic when drawn flat. Coarse coastlines paint first; the detailed set follows.
// Rings that touch both edges of the map (Russia, Fiji) are shifted east so they stay continuous;
// Antarctica is dropped since it has no sites and its clipped edge draws a line across the map.
function unwrap(fc: GeoJSON.FeatureCollection): GeoJSON.FeatureCollection {
  const fixRing = (ring: GeoJSON.Position[]) => {
    const lons = ring.map((c) => c[0]!);
    if (Math.min(...lons) > -179 || Math.max(...lons) < 179) return ring;
    return ring.map((c) => (c[0]! < 0 ? [c[0]! + 360, c[1]!] : c));
  };
  const features = fc.features
    .filter((f) => f.id !== "010" && f.properties?.name !== "Antarctica")
    .map((f) => {
      const g = f.geometry;
      if (g.type === "Polygon")
        return { ...f, geometry: { ...g, coordinates: g.coordinates.map(fixRing) } };
      if (g.type === "MultiPolygon")
        return {
          ...f,
          geometry: { ...g, coordinates: g.coordinates.map((poly) => poly.map(fixRing)) },
        };
      return f;
    });
  return { type: "FeatureCollection", features };
}

const toLand = (m: { default: unknown }) => {
  const topo = m.default as Topology<{ countries: GeometryCollection }>;
  return unwrap(feature(topo, topo.objects.countries) as GeoJSON.FeatureCollection);
};
const coarseLand = () => import("world-atlas/countries-110m.json").then(toLand);
const fineLand = () => import("world-atlas/countries-50m.json").then(toLand);

function radius(value: number | null): number {
  if (value === null || value <= 0) return 4;
  return Math.max(4, Math.min(22, 3 + Math.sqrt(value) * 0.5));
}

const paperStyle = (dark: boolean) => ({
  version: 8 as const,
  sources: {},
  layers: [
    {
      id: "bg",
      type: "background" as const,
      paint: { "background-color": dark ? "#1a1916" : "#ebe5d8" },
    },
  ],
});

// A paper atlas: Natural Earth land from the world-atlas package, no tiles, no keys. Sites with
// a reported figure are filled; derived estimates are rings; region centroids are small dots.
export function AtlasMap({ sites, regions, metric, variant = "atlas", onSelect }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MLMap | null>(null);
  const [ready, setReady] = useState(false);
  const [hover, setHover] = useState<{ x: number; y: number; html: string } | null>(null);
  const [, navigate] = useLocation();
  const dark =
    typeof matchMedia !== "undefined" &&
    matchMedia("(prefers-color-scheme: dark)").matches &&
    document.documentElement.dataset.theme !== "light";

  useEffect(() => {
    if (!ref.current || mapRef.current) return;
    const map = new maplibregl.Map({
      container: ref.current,
      style: paperStyle(dark),
      bounds: [
        [-168, -50],
        [179, 72],
      ],
      fitBoundsOptions: { padding: 8 },
      renderWorldCopies: false,
      minZoom: 0,
      maxZoom: 9,
      attributionControl: false,
      dragRotate: false,
      pitchWithRotate: false,
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    map.addControl(
      new maplibregl.AttributionControl({
        compact: true,
        customAttribution: "Land: Natural Earth",
      }),
      "bottom-right",
    );
    map.touchZoomRotate.disableRotation();
    map.on("load", async () => {
      map.addSource("land", { type: "geojson", data: await coarseLand() });
      void fineLand().then((fine) =>
        (map.getSource("land") as maplibregl.GeoJSONSource | undefined)?.setData(fine),
      );
      map.addLayer({
        id: "land-fill",
        type: "fill",
        source: "land",
        paint: { "fill-color": dark ? "#2b2822" : "#ddd5c3" },
      });
      map.addLayer({
        id: "land-line",
        type: "line",
        source: "land",
        paint: { "line-color": dark ? "#3d3932" : "#cfc7b6", "line-width": 0.6 },
      });
      map.addSource("regions", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      map.addSource("sites", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      map.addLayer({
        id: "regions",
        type: "circle",
        source: "regions",
        paint: {
          "circle-radius": ["to-number", ["coalesce", ["get", "r"], 2.6]],
          "circle-color": [
            "to-color",
            ["coalesce", ["get", "fill"], ["get", "color"], dark ? "#a29b8d" : "#8f887a"],
          ],
          "circle-opacity": ["to-number", ["coalesce", ["get", "opacity"], 0.9]],
          "circle-stroke-color": ["to-color", ["coalesce", ["get", "color"], "rgba(0,0,0,0)"]],
          "circle-stroke-width": ["to-number", ["coalesce", ["get", "stroke"], 0]],
        },
      });
      map.addLayer({
        id: "sites-derived",
        type: "circle",
        source: "sites",
        filter: ["==", ["get", "claim"], "derived"],
        paint: {
          "circle-radius": ["get", "r"],
          "circle-color": dark ? "#161513" : "#f6f2ea",
          "circle-opacity": 0.55,
          "circle-stroke-color": ["get", "color"],
          "circle-stroke-width": 2,
          "circle-stroke-opacity": ["case", ["==", ["get", "planned"], 1], 0.45, 1],
        },
      });
      map.addLayer({
        id: "sites-reported",
        type: "circle",
        source: "sites",
        filter: ["!=", ["get", "claim"], "derived"],
        paint: {
          "circle-radius": ["get", "r"],
          "circle-color": ["get", "color"],
          "circle-opacity": ["case", ["==", ["get", "planned"], 1], 0.22, 0.85],
          "circle-stroke-color": [
            "case",
            ["==", ["get", "planned"], 1],
            ["get", "color"],
            dark ? "#161513" : "#f6f2ea",
          ],
          "circle-stroke-width": 1.2,
        },
      });
      for (const layer of ["sites-reported", "sites-derived", "regions"]) {
        map.on("mousemove", layer, (e: MapMouseEvent & { features?: MapGeoJSONFeature[] }) => {
          const f = e.features?.[0] as MapGeoJSONFeature | undefined;
          if (!f) return;
          map.getCanvas().style.cursor = f.properties.kind === "site" ? "pointer" : "default";
          setHover({ x: e.point.x, y: e.point.y, html: String(f.properties.tip) });
        });
        map.on("mouseleave", layer, () => {
          map.getCanvas().style.cursor = "";
          setHover(null);
        });
      }
      const open = (e: MapMouseEvent & { features?: MapGeoJSONFeature[] }) => {
        const f = e.features?.[0];
        if (!f || f.properties.kind !== "site") return;
        const id = String(f.properties.id);
        if (onSelect) onSelect(id);
        else navigate(`/sites/${id}`);
      };
      map.on("click", "sites-reported", open);
      map.on("click", "sites-derived", open);
      setReady(true);
    });
    mapRef.current = map;
    const ro = new ResizeObserver(() => map.resize());
    ro.observe(ref.current);
    return () => {
      ro.disconnect();
      map.remove();
      mapRef.current = null;
    };
    // The map is created once; data updates flow through setData below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const siteFeatures: GeoJSON.Feature[] = sites
      .filter((s) => s.lat !== null && s.lon !== null)
      .map((s): GeoJSON.Feature => {
        const m =
          s.metrics[metric] ??
          s.metrics["it_power_mw"] ??
          s.metrics["facility_power_mw"] ??
          Object.values(s.metrics)[0];
        const color = providerBySlug(s.provider_slug)?.color ?? "#1b1a17";
        const value = m?.value ?? null;
        const figure = m
          ? `${m.claim_type === "derived" ? "estimated " : ""}${metric.endsWith("_mw") || !s.metrics[metric] ? fmtMw(value) : String(value)}${m.status ? `, ${statusLabel[m.status] ?? escapeHtml(m.status)}` : ""}`
          : "no figure";
        const tip = `<strong>${escapeHtml(s.name)}</strong><br>${escapeHtml(providerBySlug(s.provider_slug)?.shortName ?? s.provider_slug)} · ${figure}<br><span class="muted">${precisionLabel[s.location_precision] ?? escapeHtml(s.location_precision)}</span>`;
        return {
          type: "Feature",
          geometry: { type: "Point", coordinates: [s.lon as number, s.lat as number] },
          properties: {
            kind: "site",
            id: s.id,
            color,
            r: radius(metric.endsWith("_mw") ? value : null),
            claim: m?.claim_type ?? "unknown",
            tip,
          },
        };
      })
      .sort((a, b) => Number(b.properties!.r) - Number(a.properties!.r));
    (map.getSource("sites") as maplibregl.GeoJSONSource).setData({
      type: "FeatureCollection",
      features: siteFeatures,
    });
    const regionFeatures: GeoJSON.Feature[] = regions
      .filter((r) => r.lat !== null && r.lon !== null)
      .map((r): GeoJSON.Feature => ({
        type: "Feature",
        geometry: { type: "Point", coordinates: [r.lon as number, r.lat as number] },
        properties: {
          kind: "region",
          id: r.id,
          ...(variant === "availability" && r.level
            ? {
                r: r.level === "tight" ? 8 : 7,
                color: LEVEL_COLOR[r.level] ?? "#8f887a",
                fill: r.level === "tight" ? (dark ? "#161513" : "#f6f2ea") : null,
                opacity: r.level === "offered" ? 0.5 : 0.9,
                stroke: r.level === "tight" ? 2.5 : 0,
              }
            : {}),
          tip: `<strong>${escapeHtml(r.name)}</strong><br>${escapeHtml(providerBySlug(r.provider_slug)?.shortName ?? r.provider_slug)} region${r.code ? ` <span class="mono">${escapeHtml(r.code)}</span>` : ""}${
            r.az_count ? `<br>${escapeHtml(r.az_count)} availability zones` : ""
          }${r.opened ? `<br>opened ${escapeHtml(r.opened)}` : ""}<br><span class="muted">region centroid, not a facility</span>`,
        },
      }));
    (map.getSource("regions") as maplibregl.GeoJSONSource).setData({
      type: "FeatureCollection",
      features: regionFeatures,
    });
  }, [sites, regions, metric, ready, variant, dark]);

  return (
    <div className="map-wrap">
      <div
        className="map"
        ref={ref}
        role="region"
        aria-label="World map of tracked datacenter sites and cloud regions"
      />
      {hover && (
        <div
          className="map-hover"
          style={{ left: hover.x + 12, top: hover.y + 12, position: "absolute" }}
          dangerouslySetInnerHTML={{ __html: hover.html }}
        />
      )}
      {variant === "availability" ? (
        <div className="map-legend" aria-label="Map legend">
          {Object.entries(LEVEL_COLOR)
            .filter(([k]) => k !== "unknown")
            .map(([k, c]) => (
              <span key={k}>
                <span
                  className={k === "tight" ? "mark ring" : "mark"}
                  style={{ ["--c" as string]: c }}
                />
                {k === "offered" ? "offered, no spot signal" : k}
              </span>
            ))}
          <span className="faint">
            Region centroids, worst SKU in the family. Tight regions are rings; the grid below names
            every level.
          </span>
        </div>
      ) : (
        <div className="map-legend" aria-label="Map legend">
          {PROVIDERS.filter((p) => sites.some((s) => s.provider_slug === p.slug)).map((p) => (
            <span key={p.slug}>
              <span className="mark" style={{ ["--c" as string]: p.color }} />
              {p.shortName}
            </span>
          ))}
          <span>
            <span className="mark derived" /> estimated
          </span>
          <span>
            <span className="mark" style={{ opacity: 0.3 }} /> planned
          </span>
          <span>
            <span className="mark region" /> cloud region centroid
          </span>
          <span className="faint">
            Area follows the selected metric. Unlocated sites appear in the table only.
          </span>
        </div>
      )}
    </div>
  );
}
