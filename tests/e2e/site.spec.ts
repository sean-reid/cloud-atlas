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
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Cloud datacenter capacity");
  await expect(page.getByText("Tracked operational IT power")).toBeVisible();
  await expect(page.locator(".stat .value").first()).not.toContainText("...");
  await expect(page.getByRole("region", { name: /World map/ })).toBeVisible();
  await expect(
    page.getByRole("img", { name: "Tracked operational IT power by provider" }),
  ).toBeVisible();
  await expect(page.locator(".feed li").first()).toBeVisible();
  await shot(page, "overview");
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
  await expect(page.getByText("Last attempted")).toBeVisible();
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
  }
});

test("api responses carry cache headers and a budget", async ({ request }) => {
  const res = await request.get("/api/meta");
  expect(res.ok()).toBe(true);
  expect(res.headers()["cache-control"]).toContain("max-age=300");
  const again = await request.get("/api/meta");
  expect(again.ok()).toBe(true);
});

test("demo mode is visibly separate", async ({ page }) => {
  await page.goto("/?demo=1");
  await expect(page.locator(".banner")).toContainText("Demo mode");
  await expect(page.locator(".stat .value").first()).toContainText("0 MW");
});
