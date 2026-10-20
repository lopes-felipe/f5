import { describe, expect, it } from "vitest";
import { validateDependencyAudit } from "./ci-dependency-audit.ts";

const advisory = {
  id: 1,
  title: "Advisory",
  url: "https://example.test/advisory",
  vulnerable_versions: "<2.0.0",
  severity: "high",
};
describe("weekly dependency audit", () => {
  it("accepts a valid clean result and visible findings below the high threshold", () => {
    expect(validateDependencyAudit("{}", 0)).toBe(0);
    expect(
      validateDependencyAudit(
        JSON.stringify({ package: [{ ...advisory, severity: "moderate" }] }),
        0,
      ),
    ).toBe(1);
  });
  it.each(["high", "critical"])("rejects %s even if the scanner reports success", (severity) => {
    expect(() =>
      validateDependencyAudit(JSON.stringify({ package: [{ ...advisory, severity }] }), 0),
    ).toThrow("high/critical");
  });
  it.each(["", "{", "null", "[]", '{"error":"unavailable"}', '{"package":[{}]}', '{"package":[]}'])(
    "rejects missing, truncated or malformed output",
    (stdout) => expect(() => validateDependencyAudit(stdout, 0)).toThrow(),
  );
  it.each([1, 2, null])("rejects scanner errors with otherwise valid output", (status) => {
    expect(() => validateDependencyAudit("{}", status)).toThrow("scanner failed");
  });
});
