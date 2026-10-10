import { createVerify } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  acsSign,
  makeAdapter as makeAlibaba,
  sellValue as acsSellValue,
} from "../../pipeline/adapters/alibaba-available-resource";
import {
  capacityValue,
  makeAdapter as makeOci,
  ociSign,
} from "../../pipeline/adapters/oci-capacity-report";
import {
  makeAdapter as makeTencent,
  sellValue as tc3SellValue,
  tc3Sign,
} from "../../pipeline/adapters/tencent-zone-config";
import type { Adapter } from "../../pipeline/adapters/types";
import type { SqliteDb } from "../../pipeline/db";
import { runAdapters } from "../../pipeline/run";
import {
  sha256Hex,
  type HttpClient,
  type HttpRequest,
  type HttpResponse,
} from "../../pipeline/signed";
import type { AvailabilitySignal } from "../../shared/types";
import { DATA, FIXTURES, fixedNow, memoryDb } from "./helpers";

// Test key pair printed in the OCI request signing guide, for signing code only.
const OCI_TEST_PRIVATE_KEY = `-----BEGIN RSA PRIVATE KEY-----
MIICXgIBAAKBgQDCFENGw33yGihy92pDjZQhl0C36rPJj+CvfSC8+q28hxA161QF
NUd13wuCTUcq0Qd2qsBe/2hFyc2DCJJg0h1L78+6Z4UMR7EOcpfdUE9Hf3m/hs+F
UR45uBJeDK1HSFHD8bHKD6kv8FPGfJTotc+2xjJwoYi+1hqp1fIekaxsyQIDAQAB
AoGBAJR8ZkCUvx5kzv+utdl7T5MnordT1TvoXXJGXK7ZZ+UuvMNUCdN2QPc4sBiA
QWvLw1cSKt5DsKZ8UETpYPy8pPYnnDEz2dDYiaew9+xEpubyeW2oH4Zx71wqBtOK
kqwrXa/pzdpiucRRjk6vE6YY7EBBs/g7uanVpGibOVAEsqH1AkEA7DkjVH28WDUg
f1nqvfn2Kj6CT7nIcE3jGJsZZ7zlZmBmHFDONMLUrXR/Zm3pR5m0tCmBqa5RK95u
412jt1dPIwJBANJT3v8pnkth48bQo/fKel6uEYyboRtA5/uHuHkZ6FQF7OUkGogc
mSJluOdc5t6hI1VsLn0QZEjQZMEOWr+wKSMCQQCC4kXJEsHAve77oP6HtG/IiEn7
kpyUXRNvFsDE0czpJJBvL/aRFUJxuRK91jhjC68sA7NsKMGg5OXb5I5Jj36xAkEA
gIT7aFOYBFwGgQAQkWNKLvySgKbAZRTeLBacpHMuQdl1DfdntvAyqpAZ0lY0RKmW
G6aFKaqQfOXKCyWoUiVknQJAXrlgySFci/2ueKlIE1QqIiLSZ8V8OlpFLRnb1pzI
7U1yQXnTAEFYM560yJlzUpOb1V4cScGd365tiSMvxLOvTA==
-----END RSA PRIVATE KEY-----`;
const OCI_TEST_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDCFENGw33yGihy92pDjZQhl0C3
6rPJj+CvfSC8+q28hxA161QFNUd13wuCTUcq0Qd2qsBe/2hFyc2DCJJg0h1L78+6
Z4UMR7EOcpfdUE9Hf3m/hs+FUR45uBJeDK1HSFHD8bHKD6kv8FPGfJTotc+2xjJw
oYi+1hqp1fIekaxsyQIDAQAB
-----END PUBLIC KEY-----`;

const ENV: Record<string, Record<string, string>> = {
  oci: {
    OCI_TENANCY: "ocid1.tenancy.oc1..aaaaaaaafixturetenancy",
    OCI_USER: "ocid1.user.oc1..aaaaaaaafixtureuser",
    OCI_FINGERPRINT: "20:3b:97:13:55:1c:5b:0d:d3:37:d8:50:4e:c5:3a:34",
    OCI_PRIVATE_KEY: OCI_TEST_PRIVATE_KEY.replace(/\n/g, "\\n"),
    OCI_REGION: "us-ashburn-1",
  },
  alibaba: {
    ALIBABA_ACCESS_KEY_ID: "LTAI5tFixtureKeyId",
    ALIBABA_ACCESS_KEY_SECRET: "fixtureSecretThatIsNotReal",
  },
  tencent: {
    TENCENT_SECRET_ID: "AKIDfixtureSecretIdNotReal",
    TENCENT_SECRET_KEY: "fixtureSecretKeyNotReal",
  },
};

const ALL_VARS = Object.values(ENV).flatMap((e) => Object.keys(e));
const setEnv = (which: keyof typeof ENV) => Object.assign(process.env, ENV[which]);
const clearEnv = () => ALL_VARS.forEach((v) => delete process.env[v]);

const fixture = (name: string): HttpResponse => ({
  status: 200,
  headers: { "content-type": "application/json" },
  body: readFileSync(join(FIXTURES, name), "utf8"),
});
const status = (code: number, body = "{}"): HttpResponse => ({ status: code, headers: {}, body });

// A client that routes each signed request to a fixture and records every call.
function replay(route: (req: HttpRequest) => HttpResponse) {
  const calls: HttpRequest[] = [];
  const client: HttpClient = async (req) => {
    calls.push(req);
    return route(req);
  };
  return { calls, factory: () => client };
}

const slept: number[] = [];
const instant = { tries: 3, sleep: async (ms: number) => void slept.push(ms) };

let cache = "";
let db: SqliteDb;
beforeEach(async () => {
  cache = mkdtempSync(join(tmpdir(), "ca-probe-"));
  db = await memoryDb();
  slept.length = 0;
  clearEnv();
});
afterEach(async () => {
  rmSync(cache, { recursive: true, force: true });
  await db.close();
  clearEnv();
});

const run = (adapters: Adapter[]) =>
  runAdapters(adapters, { db, dataRoot: DATA, dataset: "live", cacheDir: cache, now: fixedNow });

const signals = async () =>
  (await db.query(
    "SELECT * FROM availability_signal ORDER BY region_code, zone_code, sku",
  )) as unknown as AvailabilitySignal[];

const ociRoute = (req: HttpRequest): HttpResponse => {
  const path = new URL(req.url).pathname;
  if (path.endsWith("/regionSubscriptions")) return fixture("oci-region-subscriptions.json");
  if (path.endsWith("/availabilityDomains")) return fixture("oci-availability-domains.json");
  if (path.endsWith("/computeCapacityReports")) return fixture("oci-capacity-report.json");
  return status(404);
};

describe("oci-capacity-report", () => {
  test("signs with the headers the signing guide lists and a key the published pair verifies", () => {
    setEnv("oci");
    const creds = {
      tenancy: ENV.oci!.OCI_TENANCY!,
      user: ENV.oci!.OCI_USER!,
      fingerprint: ENV.oci!.OCI_FINGERPRINT!,
      privateKey: OCI_TEST_PRIVATE_KEY,
      region: "us-ashburn-1",
    };
    const body = JSON.stringify({ compartmentId: creds.tenancy });
    const req = ociSign(
      creds,
      "POST",
      "https://iaas.us-phoenix-1.oraclecloud.com/20160918/computeCapacityReports",
      body,
      new Date("2014-01-05T21:31:40Z"),
    );
    expect(req.headers.date).toBe("Sun, 05 Jan 2014 21:31:40 GMT");
    expect(req.headers["content-length"]).toBe(String(body.length));
    expect(req.headers["x-content-sha256"]).toHaveLength(44);
    const auth = req.headers.authorization!;
    expect(auth).toContain('Signature version="1"');
    expect(auth).toContain(`keyId="${creds.tenancy}/${creds.user}/${creds.fingerprint}"`);
    expect(auth).toContain('algorithm="rsa-sha256"');
    expect(auth).toContain(
      'headers="date (request-target) host content-length content-type x-content-sha256"',
    );
    const signature = /signature="([^"]+)"/.exec(auth)![1]!;
    const signingString = [
      `date: ${req.headers.date}`,
      "(request-target): post /20160918/computeCapacityReports",
      "host: iaas.us-phoenix-1.oraclecloud.com",
      `content-length: ${body.length}`,
      "content-type: application/json",
      `x-content-sha256: ${req.headers["x-content-sha256"]}`,
    ].join("\n");
    const ok = createVerify("RSA-SHA256")
      .update(signingString)
      .verify(OCI_TEST_PUBLIC_KEY, signature, "base64");
    expect(ok).toBe(true);
    const get = ociSign(
      creds,
      "GET",
      "https://identity.us-ashburn-1.oci.oraclecloud.com/20160918/availabilityDomains?compartmentId=x",
      "",
      new Date(),
    );
    expect(get.headers.authorization).toContain('headers="date (request-target) host"');
    expect(get.headers["x-content-sha256"]).toBeUndefined();
  });

  test("maps the verdicts and skips shapes the domain does not support", async () => {
    setEnv("oci");
    const { calls, factory } = replay(ociRoute);
    const { outcomes } = await run([makeOci(factory, instant)]);
    expect(outcomes[0]!.ok, outcomes[0]!.error ?? "").toBe(true);
    // Two READY regions, two domains each, four of five shapes carry a verdict.
    expect(outcomes[0]!.result!.signals).toBe(16);
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(4);
    const posted = JSON.parse(calls.find((c) => c.method === "POST")!.body);
    expect(posted.shapeAvailabilities).toContainEqual({
      instanceShape: "VM.Standard.E5.Flex",
      instanceShapeConfig: { ocpus: 2, memoryInGBs: 24 },
    });
    const rows = await signals();
    const ad1 = rows.filter(
      (r) => r.region_code === "us-ashburn-1" && r.zone_code === "Uocm:US-ASHBURN-AD-1",
    );
    expect(ad1.map((r) => [r.sku, r.sku_family, r.value])).toEqual([
      ["BM.GPU.A100-v2.8", "A100", 0],
      ["BM.GPU.H100.8", "H100", 0],
      ["BM.GPU.H200.8", "H200", 1],
      ["VM.Standard.E5.Flex", "general", 1],
    ]);
    expect(rows.some((r) => r.sku === "VM.GPU.A10.1")).toBe(false);
    expect(JSON.parse(ad1[1]!.detail!)).toMatchObject({
      status: "OUT_OF_HOST_CAPACITY",
      available_count: 0,
    });
    expect(rows.every((r) => r.signal === "capacity_report" && r.provider_slug === "oracle")).toBe(
      true,
    );
    const regions = (await db.query(
      "SELECT code, locality, lat FROM entity WHERE type = 'region' AND provider_slug = 'oracle' ORDER BY code",
    )) as { code: string; locality: string; lat: number }[];
    expect(regions).toEqual([
      { code: "us-ashburn-1", locality: "Ashburn", lat: 39.04 },
      { code: "us-phoenix-1", locality: "Phoenix", lat: 33.45 },
    ]);
    expect(new Set(rows.map((r) => r.region_code))).toEqual(
      new Set(["us-ashburn-1", "us-phoenix-1"]),
    );
    expect(capacityValue("HARDWARE_NOT_SUPPORTED")).toBe(0);
  });

  test("a second run in the same hour adds nothing", async () => {
    setEnv("oci");
    const { factory } = replay(ociRoute);
    await run([makeOci(factory, instant)]);
    const { outcomes, store } = await run([makeOci(factory, instant)]);
    expect(outcomes[0]!.ok).toBe(true);
    expect(outcomes[0]!.result!.signals).toBe(0);
    expect(store.signalIds.size).toBe(16);
  });

  test("one region failing keeps the others and retries throttled calls", async () => {
    setEnv("oci");
    let throttles = 0;
    const { calls, factory } = replay((req) => {
      const u = new URL(req.url);
      if (u.host.includes("us-phoenix-1")) return status(500, '{"code":"InternalError"}');
      if (u.pathname.endsWith("/computeCapacityReports") && throttles++ < 2)
        return { status: 429, headers: { "retry-after": "1" }, body: '{"code":"TooManyRequests"}' };
      return ociRoute(req);
    });
    const { outcomes } = await run([makeOci(factory, instant)]);
    expect(outcomes[0]!.ok).toBe(true);
    expect(outcomes[0]!.result!.signals).toBe(8);
    expect(slept).toEqual([1000, 1000]);
    expect(calls.filter((c) => c.url.includes("us-phoenix-1"))).toHaveLength(1);
    const rows = await signals();
    expect(rows.every((r) => r.region_code === "us-ashburn-1")).toBe(true);
  });

  test("every region failing fails the run", async () => {
    setEnv("oci");
    const { factory } = replay((req) =>
      new URL(req.url).pathname.endsWith("/regionSubscriptions") ? ociRoute(req) : status(503),
    );
    const { outcomes } = await run([makeOci(factory, { ...instant, tries: 1 })]);
    expect(outcomes[0]!.ok).toBe(false);
    expect(outcomes[0]!.error).toMatch(/every subscribed region failed \(2\)/);
  });

  test("without credentials the runner records a waiting run and never calls out", async () => {
    const { calls, factory } = replay(ociRoute);
    const { outcomes, store } = await run([makeOci(factory, instant)]);
    expect(outcomes[0]!.skipped).toBe(true);
    expect(store.fetchRuns[0]!.error).toBe("waiting for credentials");
    expect(calls).toHaveLength(0);
  });
});

const acsRoute = (req: HttpRequest): HttpResponse => {
  switch (req.headers["x-acs-action"]) {
    case "DescribeRegions":
      return fixture("alibaba-regions.json");
    case "DescribeAvailableResource":
      return fixture("alibaba-available-resource.json");
    default:
      return status(404);
  }
};

describe("alibaba-available-resource", () => {
  test("builds the ACS3 canonical request the signature guide describes", () => {
    const req = acsSign(
      { keyId: "testAccessKeyId", secret: "testSecret" },
      {
        host: "ecs.cn-hangzhou.aliyuncs.com",
        action: "DescribeAvailableResource",
        params: {
          RegionId: "cn-hangzhou",
          DestinationResource: "InstanceType",
          InstanceType: "ecs.g7.large",
        },
        now: new Date("2025-04-16T07:45:55.123Z"),
        nonce: "315484d3-b129-4966-974a-699b7ee56647",
      },
    );
    expect(req.method).toBe("GET");
    expect(req.url).toBe(
      "https://ecs.cn-hangzhou.aliyuncs.com/?DestinationResource=InstanceType&InstanceType=ecs.g7.large&RegionId=cn-hangzhou",
    );
    expect(req.headers["x-acs-date"]).toBe("2025-04-16T07:45:55Z");
    expect(req.headers["x-acs-version"]).toBe("2014-05-26");
    expect(req.headers["x-acs-content-sha256"]).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(req.headers.authorization).toMatch(
      /^ACS3-HMAC-SHA256 Credential=testAccessKeyId,SignedHeaders=host;x-acs-action;x-acs-content-sha256;x-acs-date;x-acs-signature-nonce;x-acs-version,Signature=[0-9a-f]{64}$/,
    );
    const again = acsSign(
      { keyId: "testAccessKeyId", secret: "testSecret" },
      {
        host: "ecs.cn-hangzhou.aliyuncs.com",
        action: "DescribeAvailableResource",
        params: {
          InstanceType: "ecs.g7.large",
          RegionId: "cn-hangzhou",
          DestinationResource: "InstanceType",
        },
        now: new Date("2025-04-16T07:45:55Z"),
        nonce: "315484d3-b129-4966-974a-699b7ee56647",
      },
    );
    expect(again.headers.authorization).toBe(req.headers.authorization);
  });

  test("emits one sell status per zone that lists the instance type", async () => {
    setEnv("alibaba");
    const { calls, factory } = replay(acsRoute);
    const { outcomes } = await run([makeAlibaba(factory, instant)]);
    expect(outcomes[0]!.ok, outcomes[0]!.error ?? "").toBe(true);
    // Two regions, five types asked per region, the fixture answers for one type in three zones.
    expect(
      calls.filter((c) => c.headers["x-acs-action"] === "DescribeAvailableResource"),
    ).toHaveLength(10);
    expect(outcomes[0]!.result!.signals).toBe(6);
    const asked = new URL(calls[1]!.url).searchParams;
    expect(asked.get("DestinationResource")).toBe("InstanceType");
    expect(asked.get("IoOptimized")).toBe("optimized");
    expect(calls[1]!.url.startsWith("https://ecs.cn-hangzhou.aliyuncs.com/")).toBe(true);
    const rows = (await signals()).filter((r) => r.region_code === "cn-hangzhou");
    expect(rows.map((r) => [r.zone_code, r.sku, r.sku_family, r.value])).toEqual([
      ["cn-hangzhou-i", "ecs.gn7i-c8g1.2xlarge", "A10", 1],
      ["cn-hangzhou-j", "ecs.gn7i-c8g1.2xlarge", "A10", 1],
      ["cn-hangzhou-k", "ecs.gn7i-c8g1.2xlarge", "A10", 0],
    ]);
    expect(JSON.parse(rows[2]!.detail!)).toEqual({
      status: "SoldOut",
      status_category: "WithoutStock",
    });
    expect(rows.every((r) => r.signal === "sell_status" && r.provider_slug === "alibaba")).toBe(
      true,
    );
    expect(acsSellValue("Limited")).toBe(0.5);
    const regions = (await db.query(
      "SELECT code, name, lat, lon, country_code FROM entity WHERE type = 'region' AND provider_slug = 'alibaba' ORDER BY code",
    )) as { code: string; name: string; lat: number; lon: number; country_code: string }[];
    expect(regions).toEqual([
      { code: "ap-southeast-1", name: "Singapore", lat: 1.35, lon: 103.82, country_code: "SG" },
      {
        code: "cn-hangzhou",
        name: "China (Hangzhou)",
        lat: 30.27,
        lon: 120.15,
        country_code: "CN",
      },
    ]);
    expect(outcomes[0]!.result!.entities).toBe(2);
  });

  test("a second run in the same hour adds nothing", async () => {
    setEnv("alibaba");
    const { factory } = replay(acsRoute);
    await run([makeAlibaba(factory, instant)]);
    const { outcomes, store } = await run([makeAlibaba(factory, instant)]);
    expect(outcomes[0]!.result!.signals).toBe(0);
    expect(store.signalIds.size).toBe(6);
  });

  test("one region failing keeps the others and throttling codes are retried", async () => {
    setEnv("alibaba");
    let throttles = 0;
    const { factory } = replay((req) => {
      if (req.url.includes("ap-southeast-1")) return status(403, '{"Code":"Forbidden.RAM"}');
      if (req.headers["x-acs-action"] === "DescribeAvailableResource" && throttles++ < 1)
        return status(
          429,
          '{"Code":"Throttling.User","Message":"Request was denied due to user flow control."}',
        );
      return acsRoute(req);
    });
    const { outcomes } = await run([makeAlibaba(factory, instant)]);
    expect(outcomes[0]!.ok).toBe(true);
    expect(outcomes[0]!.result!.signals).toBe(3);
    expect(slept).toEqual([1000]);
  });

  test("without credentials the runner records a waiting run", async () => {
    const { calls, factory } = replay(acsRoute);
    const { outcomes, store } = await run([makeAlibaba(factory, instant)]);
    expect(outcomes[0]!.skipped).toBe(true);
    expect(store.fetchRuns[0]!.error).toBe("waiting for credentials");
    expect(calls).toHaveLength(0);
  });
});

const tc3Route = (req: HttpRequest): HttpResponse => {
  switch (req.headers["x-tc-action"]) {
    case "DescribeRegions":
      return fixture("tencent-regions.json");
    case "DescribeZoneInstanceConfigInfos":
      return fixture("tencent-zone-instance-config.json");
    default:
      return status(404);
  }
};

describe("tencent-zone-config", () => {
  test("reproduces the canonical request hash from the TC3 signing guide", () => {
    const body = '{"Limit": 1, "Filters": [{"Values": ["unnamed"], "Name": "instance-name"}]}';
    expect(sha256Hex(body)).toBe(
      "99d58dfbc6745f6747f36bfca17dee5e6881dc0428a0a36f96199342bc5b4907",
    );
    const canonical = [
      "POST",
      "/",
      "",
      "content-type:application/json; charset=utf-8\nhost:cvm.tencentcloudapi.com\n",
      "content-type;host",
      sha256Hex(body),
    ].join("\n");
    expect(sha256Hex(canonical)).toBe(
      "2815843035062fffda5fd6f2a44ea8a34818b0dc46f024b8b3786976a3adda7a",
    );
    const req = tc3Sign(
      { secretId: "AKIDexample", secretKey: "examplekey" },
      { action: "DescribeInstances", region: "ap-guangzhou", body, timestamp: 1551113065 },
    );
    expect(req.url).toBe("https://cvm.tencentcloudapi.com/");
    expect(req.headers["x-tc-timestamp"]).toBe("1551113065");
    expect(req.headers["x-tc-version"]).toBe("2017-03-12");
    expect(req.headers["x-tc-region"]).toBe("ap-guangzhou");
    expect(req.headers.authorization).toMatch(
      /^TC3-HMAC-SHA256 Credential=AKIDexample\/2019-02-25\/cvm\/tc3_request, SignedHeaders=content-type;host, Signature=[0-9a-f]{64}$/,
    );
  });

  test("emits sell status per zone and instance type for the basket families", async () => {
    setEnv("tencent");
    const { calls, factory } = replay(tc3Route);
    const { outcomes } = await run([makeTencent(factory, instant)]);
    expect(outcomes[0]!.ok, outcomes[0]!.error ?? "").toBe(true);
    // Two AVAILABLE regions, six quota rows each.
    expect(outcomes[0]!.result!.signals).toBe(12);
    const zoneCalls = calls.filter(
      (c) => c.headers["x-tc-action"] === "DescribeZoneInstanceConfigInfos",
    );
    expect(zoneCalls.map((c) => c.headers["x-tc-region"])).toEqual([
      "ap-guangzhou",
      "ap-singapore",
    ]);
    expect(JSON.parse(zoneCalls[0]!.body).Filters).toEqual([
      { Name: "instance-family", Values: ["GN10Xp", "GT4", "PNV4", "GN7", "S5"] },
      { Name: "instance-charge-type", Values: ["POSTPAID_BY_HOUR"] },
    ]);
    const rows = (await signals()).filter((r) => r.region_code === "ap-guangzhou");
    expect(rows.map((r) => [r.zone_code, r.sku, r.sku_family, r.value])).toEqual([
      ["ap-guangzhou-6", "GN10Xp.2XLARGE40", "V100", 1],
      ["ap-guangzhou-6", "GN7.2XLARGE32", "T4", 1],
      ["ap-guangzhou-6", "GT4.41XLARGE948", "A100", 0],
      ["ap-guangzhou-6", "S5.LARGE8", "general", 1],
      ["ap-guangzhou-7", "PNV4.7XLARGE116", "A10", 0.5],
      ["ap-guangzhou-7", "S5.LARGE8", "general", 1],
    ]);
    expect(JSON.parse(rows[2]!.detail!)).toEqual({
      status: "SOLD_OUT",
      status_category: "WithoutStock",
      sold_out_reason: "ResourcesSoldOut.SpecifiedInstanceType",
    });
    expect(rows.every((r) => r.signal === "sell_status" && r.provider_slug === "tencent")).toBe(
      true,
    );
    expect(tc3SellValue("SELL", "EnoughStock")).toBe(1);
    expect(tc3SellValue("SELL", "UnderStock")).toBe(0.5);
    expect(tc3SellValue("SOLD_OUT", "WithoutStock")).toBe(0);
  });

  test("a second run in the same hour adds nothing", async () => {
    setEnv("tencent");
    const { factory } = replay(tc3Route);
    await run([makeTencent(factory, instant)]);
    const { outcomes, store } = await run([makeTencent(factory, instant)]);
    expect(outcomes[0]!.result!.signals).toBe(0);
    expect(store.signalIds.size).toBe(12);
  });

  test("one region failing keeps the others and a 200 with RequestLimitExceeded is retried", async () => {
    setEnv("tencent");
    let throttles = 0;
    const limited = status(
      200,
      JSON.stringify({
        Response: {
          Error: {
            Code: "RequestLimitExceeded",
            Message: "Your current request times equals to the frequency limit.",
          },
          RequestId: "f1b2",
        },
      }),
    );
    const { factory } = replay((req) => {
      if (req.headers["x-tc-region"] === "ap-singapore")
        return status(
          200,
          JSON.stringify({
            Response: { Error: { Code: "UnsupportedRegion", Message: "no" }, RequestId: "x" },
          }),
        );
      if (req.headers["x-tc-action"] === "DescribeZoneInstanceConfigInfos" && throttles++ < 2)
        return limited;
      return tc3Route(req);
    });
    const { outcomes } = await run([makeTencent(factory, instant)]);
    expect(outcomes[0]!.ok).toBe(true);
    expect(outcomes[0]!.result!.signals).toBe(6);
    expect(slept).toEqual([1000, 2000]);
  });

  test("without credentials the runner records a waiting run", async () => {
    const { calls, factory } = replay(tc3Route);
    const { outcomes, store } = await run([makeTencent(factory, instant)]);
    expect(outcomes[0]!.skipped).toBe(true);
    expect(store.fetchRuns[0]!.error).toBe("waiting for credentials");
    expect(calls).toHaveLength(0);
  });
});
