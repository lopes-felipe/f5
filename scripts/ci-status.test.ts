import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const workflow = parse(
  readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"),
) as {
  jobs: Record<string, { steps: { run: string }[] }>;
};
const reconcile = workflow.jobs["main-status"]!.steps[0]!.run;
// Substitute only gh, so these cases exercise the exact inline workflow script.
const mockGh = `
gh() {
  case "$1 $2" in
    'api repos/example/f5/commits/main') printf '%s\\n' "$MAIN_HEAD" ;;
    'issue list') printf '%s\\n' "$ISSUES" | jq "\${@: -1}" ;;
    'issue view') printf '%s\\n' "$ORIGINAL_BODY" ;;
    'api --paginate') printf '%s\\n' "$COMMENTS" ;;
    'label create') echo 'mutation: label' ;;
    'issue create') echo 'mutation: create' ;;
    'issue comment') echo 'mutation: comment' ;;
    'issue close') echo 'mutation: close' ;;
    *) echo "Unexpected gh call: $*" >&2; return 1 ;;
  esac
}
`;
function runStatus(env: Record<string, string>) {
  const result = spawnSync("bash", ["-c", mockGh + reconcile], {
    encoding: "utf8",
    env: {
      ...process.env,
      GH_REPO: "example/f5",
      GITHUB_SHA: "current",
      MAIN_HEAD: "current",
      RESULT: "failure",
      ISSUES: JSON.stringify([{ number: 1, title: "CI failing on main" }]),
      ORIGINAL_BODY: "",
      COMMENTS: "",
      GITHUB_RUN_ID: "42",
      GITHUB_RUN_ATTEMPT: "2",
      RUN_URL: "https://example.test/run/42",
      ...env,
    },
  });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout;
}

// This tests the Ubuntu workflow's Bash/jq script, not the Windows application.
describe.skipIf(process.platform === "win32")("main status reconciliation", () => {
  it("ignores stale SHAs", () =>
    expect(runStatus({ MAIN_HEAD: "newer" })).not.toContain("mutation:"));
  it("closes an open issue after success", () =>
    expect(runStatus({ RESULT: "success" })).toContain("mutation: close"));
  it("does nothing on success without an issue", () =>
    expect(runStatus({ RESULT: "success", ISSUES: "[]" })).not.toContain("mutation:"));
  it("creates the first failure issue", () =>
    expect(runStatus({ ISSUES: "[]" })).toContain("mutation: create"));
  it("comments on an existing failure issue", () =>
    expect(runStatus({})).toContain("mutation: comment"));
  it("ignores unrelated issues carrying the label", () => {
    const ISSUES = JSON.stringify([{ number: 2, title: "Investigate a different CI problem" }]);
    expect(runStatus({ RESULT: "success", ISSUES })).not.toContain("mutation:");
    expect(runStatus({ ISSUES })).toContain("mutation: create");
  });
  it("deduplicates a run attempt in comments or the initial issue body", () => {
    for (const key of ["COMMENTS", "ORIGINAL_BODY"])
      expect(runStatus({ [key]: "<!-- ci-main:42:2 -->" })).not.toContain("mutation: comment");
    expect(runStatus({ COMMENTS: "<!-- ci-main:42:1 -->" })).toContain("mutation: comment");
  });
});
