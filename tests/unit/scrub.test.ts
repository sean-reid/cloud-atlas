import { describe, expect, test } from "vitest";
import { scrubError } from "../../pipeline/scrub";

describe("scrubError", () => {
  test("removes OCIDs and keeps the rest of the message", () => {
    expect(
      scrubError(
        "http 404 from iaas.us-ashburn-1.oraclecloud.com: compartment ocid1.compartment.oc1..aaaaaaaabcd123 not found",
      ),
    ).toBe(
      "http 404 from iaas.us-ashburn-1.oraclecloud.com: compartment ocid1.[redacted] not found",
    );
  });
  test("removes Google project paths", () => {
    expect(
      scrubError("403 Permission denied on resource projects/my-prod-12345/zones/us-east1-b"),
    ).toBe("403 Permission denied on resource projects/[redacted]/zones/us-east1-b");
  });
  test("removes request ids in the forms providers use", () => {
    expect(
      scrubError("UnauthorizedOperation (RequestId: 7f0a1b2c-3d4e-5f60-7182-93a4b5c6d7e8)"),
    ).toBe("UnauthorizedOperation (RequestId [redacted])");
    expect(scrubError("opc-request-id: ABCDEF123456/XYZ failed")).toBe(
      "opc-request-id [redacted] failed",
    );
    expect(scrubError('{"x-ms-request-id":"0f8fad5b-d9cb-469f-a165-70867728950e"}')).toBe(
      '{"x-ms-request-id":"[uuid]"}',
    );
    expect(scrubError("trace 0f8fad5b-d9cb-469f-a165-70867728950e")).toBe("trace [uuid]");
  });
  test("leaves ordinary errors alone", () => {
    expect(scrubError("http 503 after 3 attempts")).toBe("http 503 after 3 attempts");
    expect(scrubError("waiting for credentials")).toBe("waiting for credentials");
  });
});
