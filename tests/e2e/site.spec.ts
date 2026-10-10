import { expect, test, type Page } from "@playwright/test";
import { ADAPTER_META } from "../../shared/adapters-meta";

// The filter drawer is collapsed below 900px.
const openFilters = async (page: Page) => {
  const summary = page.locator("details.filters-drawer > summary");
  if (await summary.isVisible()) await summary.click();
};

const shot = async (page: Page, name: string) => {
  await page.screenshot({
    path: `test-results/screens/${test.info().project.name}-${name}.png`,
    fullPage: true,
  });
};

test("health endpoint answers", async ({ request }) => {
  const res = await request.get("/api/health");
  expect(res.ok()).toBe(true);
  expect(await res.json()).toEqual({ ok: true });
});

test("overview shows tracked totals, the map, charts, and the feed", async ({ page }) => {
  const violations: string[] = [];
  page.on("console", (msg) => {
    if (/Content Security Policy|Refused to/.test(msg.text())) violations.push(msg.text());
  });
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Cloud datacenter capacity");
  await expect(page.getByText("Tracked operational IT power")).toBeVisible();
  await expect(page.locator(".stat .value").first()).not.toContainText("...");
  await expect(page.getByRole("region", { name: /World map/ })).toBeVisible();
  await expect(
    page.getByRole("img", { name: "Tracked operational IT power by provider" }),
  ).toBeVisible();
  await expect(page.locator(".feed li").first()).toBeVisible();
  await expect(page.locator(".maplibregl-canvas")).toBeVisible();
  await shot(page, "overview");
  expect(violations).toEqual([]);
});

test("filters live in the URL and drive the summary, table, and series together", async ({
  page,
}) => {
  await page.goto("/");
  await openFilters(page);
  await page.getByRole("button", { name: "Google", exact: true }).click();
  await expect(page).toHaveURL(/provider=gcp/);
  await page.getByRole("button", { name: "operational", exact: true }).click();
  await expect(page).toHaveURL(/status=operational/);
  await page.reload();
  await expect(page.locator(".stat .value").first()).not.toContainText("...");
  const legend = page.locator(".map-legend");
  await expect(legend).toContainText("Google");
  await expect(legend).not.toContainText("AWS");
  await page.goto("/sites?provider=gcp&status=operational");
  const providers = await page.locator("tbody tr td:nth-child(2)").allInnerTexts();
  expect(providers.length).toBeGreaterThan(0);
  expect(providers.every((p) => p.includes("Google"))).toBe(true);
  await openFilters(page);
  await page.getByRole("button", { name: "reset filters" }).click();
  await expect(page).toHaveURL(/\/sites$/);
});

test("the sites table sorts, searches, and links to evidence", async ({ page }) => {
  await page.goto("/sites");
  await expect(page.locator("tbody tr").first()).toBeVisible();
  // Column headers become stacked labels on phones, so sorting is a desktop interaction.
  if (test.info().project.name !== "mobile") {
    await page.getByRole("button", { name: /^Site/ }).click();
    const first = await page.locator("tbody tr td:first-child").first().innerText();
    await page.getByRole("button", { name: /^Site/ }).click();
    const last = await page.locator("tbody tr td:first-child").first().innerText();
    expect(first).not.toBe(last);
  }
  await openFilters(page);
  await page.getByPlaceholder("site or place").fill("Abilene");
  await expect(page).toHaveURL(/q=Abilene/);
  await expect(page.locator("tbody")).toContainText(/Abilene/);
  const rows = await page.locator("tbody tr").count();
  expect(rows).toBeLessThan(12);
  await shot(page, "sites");
  await page
    .getByRole("link", { name: /Abilene campus/ })
    .first()
    .click();
  await expect(page).toHaveURL(/\/sites\/ent_/);
  await expect(page.getByRole("heading", { level: 1 })).toContainText(/Abilene/);
  await expect(page.locator("blockquote").first()).toBeVisible();
  await expect(page.locator("tbody a[href^='https://']").first()).toBeVisible();
  await shot(page, "entity");
});

test("provider, methodology, sources, availability, and API pages render", async ({ page }) => {
  await page.goto("/providers/azure");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Microsoft Azure");
  await expect(page.getByText("never summed with site figures")).toBeVisible();
  await page.goto("/methodology");
  await expect(page.getByRole("heading", { name: "Coverage matrix" })).toBeVisible();
  await expect(page.locator(".matrix tbody tr")).toHaveCount(14);
  await shot(page, "methodology");
  await page.goto("/sources");
  await expect(page.getByRole("heading", { name: "Ingestion paths" })).toBeVisible();
  await expect(page.locator("table").first().locator("tbody tr")).toHaveCount(ADAPTER_META.length);
  await shot(page, "sources");
  await page.goto("/availability");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Availability signals");
  await expect(page.locator(".avail-grid").first()).toBeVisible();
  await shot(page, "availability");
  await page.goto("/api");
  await expect(page.getByText("GET /api/summary")).toBeVisible();
});

test("export carries provenance for the filtered set", async ({ request }) => {
  const res = await request.get("/api/export.csv?provider=oracle&claim=reported");
  expect(res.ok()).toBe(true);
  expect(res.headers()["content-type"]).toContain("text/csv");
  const lines = (await res.text()).trim().split("\n");
  expect(lines[0]).toContain("source_url");
  expect(lines[0]).toContain("recorded_at");
  expect(lines.length).toBeGreaterThan(1);
  for (const line of lines.slice(1)) {
    expect(line).toContain(",oracle,");
    expect(line).toContain("https://");
    expect(line).toContain(",reported,");
    expect(line).not.toMatch(/(^|,)[=+@]/);
  }
});

test("api responses carry cache headers and a budget", async ({ request }) => {
  const res = await request.get("/api/meta");
  expect(res.ok()).toBe(true);
  expect(res.headers()["cache-control"]).toContain("max-age=300");
  const again = await request.get("/api/meta");
  expect(again.ok()).toBe(true);
});

test("every response carries the security headers and assets cache for a year", async ({
  request,
}) => {
  for (const path of ["/api/meta", "/", "/sites"]) {
    const res = await request.get(path);
    expect(res.ok(), path).toBe(true);
    const h = res.headers();
    expect(h["x-content-type-options"], path).toBe("nosniff");
    expect(h["x-frame-options"], path).toBe("DENY");
    expect(h["referrer-policy"], path).toBe("strict-origin-when-cross-origin");
    expect(h["content-security-policy"], path).toContain("frame-ancestors 'none'");
    expect(h["content-security-policy"], path).not.toContain("unsafe");
  }
  const html = await (await request.get("/")).text();
  const script = /src="(\/assets\/[^"]+\.js)"/.exec(html)?.[1] as string;
  expect(script).toBeDefined();
  expect((await request.get(script)).headers()["cache-control"]).toBe(
    "public, max-age=31536000, immutable",
  );
  expect((await request.get("/fonts/newsreader-latin.woff2")).headers()["cache-control"]).toBe(
    "public, max-age=31536000",
  );
  expect((await request.get("/")).headers()["cache-control"]).toBe("no-cache");
});

test("bad query parameters answer 400 with a plain message, never 500", async ({ request }) => {
  const cases: [string, RegExp][] = [
    ["/api/feed?limit=abc", /limit must be a whole number/],
    ["/api/feed?limit=0", /limit must be a whole number/],
    ["/api/availability/history?provider=aws&family=p5&days=1e3", /days must be a whole number/],
    ["/api/availability/series?provider=aws&region=us-east-1&sku=x&days=-1", /days must be/],
    ["/api/sites?asof=yesterday", /asof must be YYYY/],
    ["/api/summary?from=2025-6-1", /from must be YYYY/],
    ["/api/export.csv?to=soon", /to must be YYYY/],
  ];
  for (const [path, message] of cases) {
    const res = await request.get(path);
    expect(res.status(), path).toBe(400);
    expect((await res.json()).error, path).toMatch(message);
  }
  const fine = await request.get("/api/sites?asof=2025-06&limit=5&utm_source=x");
  expect(fine.status()).toBe(200);
});

test("source counts cover the same accepted live observations as the coverage matrix", async ({
  request,
}) => {
  const sources = await (await request.get("/api/sources")).json();
  const meta = await (await request.get("/api/meta")).json();
  const cited = sources.sources.reduce((n: number, s: { n: number }) => n + s.n, 0);
  const covered = meta.coverage.reduce((n: number, c: { n: number }) => n + c.n, 0);
  expect(cited).toBeGreaterThan(0);
  expect(cited).toBe(covered);
});

test("availability history answers per day and per hour", async ({ request }) => {
  const latest = await (await request.get("/api/availability")).json();
  const provider = Object.keys(latest.providers)[0] as string;
  const family = Object.keys(latest.providers[provider].families)[0] as string;
  const history = await (
    await request.get(
      `/api/availability/history?provider=${provider}&family=${encodeURIComponent(family)}`,
    )
  ).json();
  expect(history.days.length).toBeGreaterThan(0);
  expect(history.series[0].days[0]).toHaveProperty("level");
  // The seed holds one hour, so the ribbon's latest day must read as the latest view does.
  for (const entry of latest.providers[provider].families[family]) {
    const s = history.series.find(
      (x: { region_code: string; sku: string }) =>
        x.region_code === entry.region_code && x.sku === entry.sku,
    );
    expect(s, `${entry.region_code} ${entry.sku}`).toBeTruthy();
    expect(s.days.at(-1).level, `${entry.region_code} ${entry.sku}`).toBe(entry.level);
  }
  const first = history.series[0];
  const series = await (
    await request.get(
      `/api/availability/series?provider=${provider}&region=${first.region_code}&sku=${encodeURIComponent(first.sku)}`,
    )
  ).json();
  expect(series.points.length).toBeGreaterThan(0);
  const bad = await request.get("/api/availability/history?provider=aws");
  expect(bad.status()).toBe(400);
});

test("availability history shows the whole window and switches it", async ({ page }) => {
  await page.goto("/availability");
  const history = page.locator(".history");
  await expect(history.locator(".ribbon-head.day")).toHaveCount(30);
  await expect(history.locator(".signal-chart").first()).toBeVisible();
  await history.getByRole("button", { name: "7d" }).click();
  await expect(history.locator(".ribbon-head.day")).toHaveCount(7);
  await history.locator(".ribbon-region.on").click();
  await expect(history.locator(".signal-lines")).toHaveCount(0);
  await shot(page, "availability-history");
});

test("demo mode is visibly separate", async ({ page }) => {
  await page.goto("/?demo=1");
  await expect(page.locator(".banner")).toContainText("Demo mode");
  await expect(page.locator(".stat .value").first()).toContainText("0 MW");
});

test("demo mode keeps the feed and the regions chart on the demo dataset", async ({
  page,
  request,
}) => {
  const live = await (await request.get("/api/feed?limit=12")).json();
  expect(live.items.length).toBeGreaterThan(0);
  const demo = await (await request.get("/api/feed?limit=12&demo=1")).json();
  expect(demo.items.every((i: { dataset: string }) => i.dataset === "demo")).toBe(true);
  const regions = await (await request.get("/api/regions?demo=1")).json();
  await page.goto("/?demo=1");
  await expect(page.getByRole("status")).toContainText("Demo mode");
  await page.waitForLoadState("networkidle");
  await expect(page.locator(".feed li")).toHaveCount(demo.items.length);
  await expect(page.getByText(/cloud regions as centroids/)).toContainText(
    `${regions.regions.length} cloud regions`,
  );
  if (!regions.regions.length)
    await expect(page.getByText("No dated region launches")).toBeVisible();
});

test("no route scrolls sideways", async ({ page, request }) => {
  const { sites } = await (await request.get("/api/sites")).json();
  const routes = [
    "/",
    "/sites",
    `/sites/${sites[0].id}`,
    "/providers/azure",
    "/availability",
    "/methodology",
    "/sources",
    "/api",
    "/?demo=1",
    "/missing",
  ];
  for (const route of routes) {
    await page.goto(route);
    await page.waitForLoadState("networkidle");
    const [scroll, inner] = await page.evaluate(() => [
      document.documentElement.scrollWidth,
      window.innerWidth,
    ]);
    expect(scroll, route).toBeLessThanOrEqual(inner);
  }
});

test("availability shows a loading state until the signals arrive", async ({ page }) => {
  await page.route("**/api/availability", async (route) => {
    await new Promise((r) => setTimeout(r, 1500));
    await route.continue();
  });
  await page.goto("/availability");
  await expect(page.getByText("Loading availability signals")).toBeVisible();
  await expect(page.getByText("No availability signals recorded yet.")).toHaveCount(0);
  await expect(page.locator(".avail-grid").first()).toBeVisible();
  await expect(page.getByText("Loading availability signals")).toHaveCount(0);
});

test("a ribbon region keeps a visible focus ring", async ({ page }) => {
  await page.goto("/availability");
  const row = page.locator(".ribbon-region").first();
  await expect(row).toBeVisible();
  await page.getByRole("button", { name: "90d" }).focus();
  await page.keyboard.press("Tab");
  await expect(row).toBeFocused();
  expect(await row.evaluate((el) => getComputedStyle(el).outlineStyle)).not.toBe("none");
  await expect(page.getByRole("rowheader").first()).toContainText(await row.innerText());
});
