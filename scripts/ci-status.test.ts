import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const workflow = parse(
  readFileSync(new URL("../.github/workflows/ci-main-status.yml", import.meta.url), "utf8"),
) as {
  jobs: Record<string, { steps: { name: string; run: string }[] }>;
};
const step = (name: string) => workflow.jobs.report!.steps.find((s) => s.name === name)!.run;
const reconcile = step("Reconcile main status issue");
const findLatest = step("Find the newest main CI result");
// Substitute only gh, so these cases exercise the exact inline workflow script.
const mockGh = `
gh() {
  case "$1 $2" in
    'api repos/example/f5/commits/main') printf '%s\\n' "$MAIN_HEAD" ;;
    'api repos/example/f5/actions/runs/42') printf '%s\\n' "$CURRENT_ATTEMPT" ;;
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
      SOURCE_SHA: "current",
      MAIN_HEAD: "current",
      RESULT: "failure",
      ISSUES: JSON.stringify([{ number: 1, title: "CI failing on main" }]),
      ORIGINAL_BODY: "",
      COMMENTS: "",
      SOURCE_RUN: "42",
      SOURCE_ATTEMPT: "2",
      CURRENT_ATTEMPT: "2",
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
  it("ignores stale CI attempts", () =>
    expect(runStatus({ CURRENT_ATTEMPT: "3" })).not.toContain("mutation:"));
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

// Scheduled passes catch reruns started with GITHUB_TOKEN, which raise no workflow_run event.
describe.skipIf(process.platform === "win32")("scheduled main status lookup", () => {
  const mockLookupGh = `
gh() {
  case "$1 $2" in
    'api repos/example/f5/commits/main') printf '%s\\n' current ;;
    api\\ repos/example/f5/actions/workflows/ci.yml/runs*) printf '%s\\n' "$RUNS" | jq -r "\${@: -1}" ;;
    *) echo "Unexpected gh call: $*" >&2; return 1 ;;
  esac
}
`;
  function lookup(runs: unknown[]) {
    const dir = mkdtempSync(join(tmpdir(), "ci-main-status-"));
    const output = join(dir, "output");
    writeFileSync(output, "");
    const result = spawnSync("bash", ["-c", mockLookupGh + findLatest], {
      encoding: "utf8",
      env: {
        ...process.env,
        GH_REPO: "example/f5",
        GITHUB_OUTPUT: output,
        RUNS: JSON.stringify({ workflow_runs: runs }),
      },
    });
    expect(result.status, result.stderr).toBe(0);
    const text = readFileSync(output, "utf8");
    rmSync(dir, { recursive: true, force: true });
    return text;
  }
  const run = (overrides: Record<string, unknown>) => ({
    id: 42,
    path: ".github/workflows/ci.yml",
    head_sha: "current",
    head_repository: { full_name: "example/f5" },
    run_attempt: 2,
    conclusion: "success",
    html_url: "https://example.test/run/42",
    ...overrides,
  });

  it("reports the newest trusted run for main HEAD", () =>
    expect(lookup([run({ head_repository: { full_name: "fork/f5" }, id: 7 }), run({})])).toBe(
      "result=success\nsha=current\nrun=42\nattempt=2\nurl=https://example.test/run/42\n",
    ));
  it("leaves the result empty while that run is still going", () =>
    expect(lookup([run({ conclusion: null })])).toContain("result=\n"));
  it("writes nothing when main HEAD has no CI run", () => expect(lookup([])).toBe(""));
});
