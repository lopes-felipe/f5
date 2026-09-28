import { expect, it } from "vitest";
import { networkFailureDetail } from "./networkFailureDetail.ts";

it.each([
  ["fatal: Authentication failed for https://secret@example.test/repo", "authenticate"],
  ["fatal: Repository not found", "repository"],
  ["fatal: Could not resolve host: example.test", "reach"],
  ["git clone timed out.", "timed out"],
])("classifies remote failures without echoing credentials: %s", (detail, expected) => {
  const result = networkFailureDetail(detail);
  expect(result).toContain(expected);
  expect(result).not.toContain("secret");
  expect(result).not.toContain("example.test");
});
it("does not persist unrecognized remote output", () => {
  expect(networkFailureDetail("password=secret failed with code 128")).not.toContain("secret");
});
