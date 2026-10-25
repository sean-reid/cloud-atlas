import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { safeFetch, type FetchOptions } from "../../pipeline/fetch";
import { fixtureFetch } from "../../pipeline/fixtures";
import { ECB_HOST, fetchRates, parseRates, toUsd, usdPer } from "../../pipeline/fx";
import { FIX, fast } from "./helpers";

const xml = readFileSync(join(FIX, "eurofxref-daily.xml"), "utf8");

let cache = "";
beforeEach(() => {
  cache = mkdtempSync(join(tmpdir(), "ca-fx-"));
});
afterEach(() => {
  rmSync(cache, { recursive: true, force: true });
});

const fetchFor =
  (allowHosts: string[]) =>
  (url: string, opts: Partial<FetchOptions> = {}) =>
    safeFetch(url, {
      adapter: "fx-test",
      allowHosts,
      cacheDir: cache,
      fetchImpl: fixtureFetch(FIX),
      ...fast,
      ...opts,
    });

describe("ECB reference rates", () => {
  test("the recorded daily file gives the date and the euro rates for USD and GBP", () => {
    expect(parseRates(xml)).toEqual({ date: "2026-10-23", eurUsd: 1.1193, eurGbp: 0.83728 });
  });

  test("euros convert at the USD rate and pounds through the euro cross", () => {
    const rates = parseRates(xml);
    expect(toUsd(600e6, "EUR", rates)).toBeCloseTo(671_580_000, 0);
    expect(toUsd(5e9, "GBP", rates)).toBeCloseTo(6_684_143_894.5, 0);
    expect(usdPer("GBP", rates).toFixed(4)).toBe("1.3368");
  });

  test("a file missing the date or a rate fails instead of converting at nothing", () => {
    expect(() =>
      parseRates("<Cube time='2026-10-23'><Cube currency='JPY' rate='175.51'/></Cube>"),
    ).toThrow(/layout changed/);
    expect(() => parseRates("<Cube currency='USD' rate='1.1193'/>")).toThrow(/layout changed/);
  });

  test("fetchRates goes through the adapter fetch and its host allow-list", async () => {
    expect(await fetchRates({ fetch: fetchFor([ECB_HOST]) })).toEqual({
      date: "2026-10-23",
      eurUsd: 1.1193,
      eurGbp: 0.83728,
    });
    await expect(fetchRates({ fetch: fetchFor(["datacenters.google"]) })).rejects.toThrow(
      /not allowed/,
    );
  });
});
