import { expect, test } from "vitest";
import { ingestAdaptersFor, ingestDispatch, INGEST_WORKFLOW_URL } from "../../shared/dispatch";

test("the hourly dispatch asks for the hourly adapters and 05:00 UTC asks for everything", () => {
  expect(ingestAdaptersFor(new Date("2026-10-25T14:17:00Z"))).toBe("--schedule hourly");
  expect(ingestAdaptersFor(new Date("2026-10-25T05:17:00Z"))).toBe("");
});

test("the request targets the ingest workflow on main with the token", () => {
  const { url, init } = ingestDispatch(new Date("2026-10-25T14:17:00Z"), "tok");
  expect(url).toBe(INGEST_WORKFLOW_URL);
  expect(init.method).toBe("POST");
  const headers = init.headers as Record<string, string>;
  expect(headers.authorization).toBe("Bearer tok");
  expect(headers["x-github-api-version"]).toBe("2022-11-28");
  expect(JSON.parse(init.body as string)).toEqual({
    ref: "main",
    inputs: { adapters: "--schedule hourly" },
  });
});
