import { expect, it } from "vitest";
import { parsePublicationLease, parsePublicationSelection } from "./release/release-lease.ts";

const lease = { sourceSha: "a".repeat(40), candidateRun: 123, attempt: 2 };
it("reads candidate leases and completed no-candidate selections", () => {
  expect(parsePublicationSelection(lease)).toEqual(lease);
  expect(parsePublicationSelection({ candidateRun: null })).toEqual({ candidateRun: null });
  expect(() => parsePublicationLease({ candidateRun: null })).toThrow("Invalid publication lease");
});
it.each([
  null,
  {},
  { candidateRun: null, sourceSha: "a".repeat(40) },
  { ...lease, sourceSha: "bad" },
  { ...lease, attempt: 0 },
  { ...lease, candidateRun: -1 },
])("rejects malformed selection markers: %j", (value) => {
  expect(() => parsePublicationSelection(value)).toThrow();
});
