import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const workflow = parse(
  readFileSync(new URL("../.github/workflows/release-status.yml", import.meta.url), "utf8"),
) as { jobs: Record<string, { steps: { run: string }[] }> };
const reconcile = workflow.jobs.report!.steps[0]!.run;
// Substitute only gh; jq filters run for real against the fixtures, as gh --jq would.
const mockGh = `
gh() {
  case "$1 $2" in
    api\\ repos/example/f5/actions/runs/*)
      printf '%s\\t%s\\t%s\\n' .github/workflows/release-publish.yml "$RESULT" "https://example.test/run/$RUN_ID" ;;
    api\\ repos/example/f5/actions/workflows/*) printf '%s\\n' "$RUNS" | jq -r "\${@: -1}" ;;
    'issue list') printf '%s\\n' "$ISSUES" | jq -r "\${@: -1}" ;;
    'run view') printf '%s\\n' "$LOG" ;;
    'api --paginate') printf '%s\\n' "$COMMENTS" ;;
    'issue view') printf '%s\\n' "$ORIGINAL_BODY" ;;
    'label create') ;;
    'issue create'|'issue comment') echo "mutation: \${2}"; printf '%s\\n' "\${@: -1}" ;;
    'issue close') echo 'mutation: close' ;;
    *) echo "Unexpected gh call: $*" >&2; return 1 ;;
  esac
}
`;
const logLine = (text: string) =>
  `publish\tReconcile releases\t2026-11-06T10:00:00.1234567Z ${text}`;
const failureLog = [
  logLine("Waiting for exact-SHA CI"),
  logLine("SyntaxError: The requested module './x.ts' does not provide an export named 'y'"),
  logLine("##[error]Process completed with exit code 1."),
].join("\n");

function runStatus(env: Record<string, string>) {
  const result = spawnSync("bash", ["-c", mockGh + reconcile], {
    encoding: "utf8",
    env: {
      ...process.env,
      GH_REPO: "example/f5",
      RUN_ID: "42",
      EVENT_NAME: "workflow_run",
      RESULT: "failure",
      RUNS: JSON.stringify({ workflow_runs: [{ id: 42, conclusion: "failure" }] }),
      ISSUES: JSON.stringify([{ number: 1, title: "Release publication blocked" }]),
      LOG: failureLog,
      COMMENTS: "",
      ORIGINAL_BODY: "",
      ...env,
    },
  });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout;
}
const markerOf = (output: string) => /<!-- release-blocked:[0-9a-f]{16} -->/.exec(output)![0];

// This tests the Ubuntu workflow's Bash/jq script, not the Windows application.
describe.skipIf(process.platform === "win32")("release blocked reconciliation", () => {
  it("opens the issue with every kind of JS error line and no runner noise", () => {
    const output = runStatus({ ISSUES: "[]" });
    expect(output).toContain("mutation: create");
    expect(output).toContain("SyntaxError: The requested module './x.ts'");
    expect(output).not.toContain("Process completed");
    expect(output).not.toContain("2026-11-06T");
  });

  it("keeps log text inside the fence", () => {
    const output = runStatus({ ISSUES: "[]", LOG: logLine("Error: ``` @someone breaks out") });
    expect(output).toContain("~~~text\nError:  @someone breaks out\n~~~");
  });

  it("comments only when the failure reason changes, even after human comments", () => {
    const marker = markerOf(runStatus({ ISSUES: "[]" }));
    expect(runStatus({ COMMENTS: `${marker}\nLooking into it` })).not.toContain("mutation:");
    expect(runStatus({ ORIGINAL_BODY: marker })).not.toContain("mutation:");
    expect(runStatus({ COMMENTS: "<!-- release-blocked:0000000000000000 -->" })).toContain(
      "mutation: comment",
    );
  });

  it("alerts for every unclassified failure instead of sharing one fallback marker", () => {
    const first = markerOf(runStatus({ ISSUES: "[]", LOG: logLine("something odd") }));
    const second = runStatus({
      RUN_ID: "43",
      RUNS: JSON.stringify({ workflow_runs: [{ id: 43, conclusion: "failure" }] }),
      LOG: logLine("something odd"),
      COMMENTS: first,
    });
    expect(second).toContain("No error line was found");
    expect(second).toContain("mutation: comment");
  });

  it("ignores stale results but trusts a run when no decisive run is listed", () => {
    const newer = JSON.stringify({ workflow_runs: [{ id: 99, conclusion: "success" }] });
    expect(runStatus({ RUNS: newer })).not.toContain("mutation:");
    expect(runStatus({ RUNS: newer, EVENT_NAME: "workflow_dispatch" })).toContain(
      "mutation: comment",
    );
    const cancelledOnly = JSON.stringify({ workflow_runs: [{ id: 98, conclusion: "cancelled" }] });
    expect(runStatus({ RUNS: cancelledOnly })).toContain("mutation: comment");
  });

  it("closes the issue after success and ignores cancelled runs", () => {
    const success = JSON.stringify({ workflow_runs: [{ id: 42, conclusion: "success" }] });
    expect(runStatus({ RESULT: "success", RUNS: success })).toContain("mutation: close");
    expect(runStatus({ RESULT: "success", RUNS: success, ISSUES: "[]" })).not.toContain(
      "mutation:",
    );
    expect(runStatus({ RESULT: "cancelled" })).not.toContain("mutation:");
  });
});
