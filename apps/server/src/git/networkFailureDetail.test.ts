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
it.each([
  [
    "To https://example.test/repo.git\n ! [remote rejected] feature -> feature (pre-receive hook declined: secret policy)\nerror: failed to push some refs to 'https://example.test/repo.git'",
    "The remote rejected the push. Push this branch from a terminal to see the server's message.",
  ],
  [
    "To https://example.test/repo.git\n ! [rejected]        feature -> feature (fetch first)\nerror: failed to push some refs to 'https://example.test/repo.git'",
    "The remote branch has newer commits. Fetch and reconcile them before retrying.",
  ],
  [
    " ! [remote rejected] main -> main (protected branch hook declined)\nerror: failed to push some refs",
    "The remote rejected this write under its branch protection rules.",
  ],
])("explains a refused push without quoting the server: %s", (stderr, expected) => {
  const result = networkFailureDetail(stderr);
  expect(result).toBe(expected);
  expect(result).not.toContain("secret");
});
it("does not persist unrecognized remote output", () => {
  expect(networkFailureDetail("password=secret failed with code 128")).not.toContain("secret");
});
