import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { CLI_TARGETS } from "@t3tools/shared/cliRelease";

const root = fileURLToPath(new URL("../", import.meta.url));
interface Workflow {
  jobs: Record<
    string,
    {
      steps?: { id?: string; run?: string }[];
      uses?: string;
      with?: Record<string, unknown>;
      if?: string;
    }
  >;
  on: Record<string, unknown>;
  permissions: Record<string, string>;
}
const workflow = (name: string) =>
  parse(readFileSync(join(root, `.github/workflows/${name}.yml`), "utf8")) as Workflow;
const build = workflow("build-cli");
const weekly = workflow("distribution-checks");
const notifier = weekly.jobs["scheduled-status"]!.steps![0]!.run!;
const mockGh = `
gh() {
  case "$1 $2" in
    'issue list') printf '%s\\n' "$ISSUE" ;;
    'issue view') printf '%s\\n' "$BODY" ;;
    'api --paginate') printf '%s\\n' "$COMMENTS" ;;
    'issue create') echo "create: $*" ;;
    'issue comment') echo "comment: $*" ;;
    *) echo "Unexpected gh call $*" >&2; return 1 ;;
  esac
}
`;
function notify(env: Record<string, string> = {}) {
  const result = spawnSync("bash", ["-c", mockGh + notifier], {
    encoding: "utf8",
    env: {
      ...process.env,
      GH_REPO: "example/f5",
      GITHUB_SHA: "sha",
      GITHUB_RUN_ID: "42",
      GITHUB_RUN_ATTEMPT: "2",
      RUN_URL: "https://example.test/runs/42",
      ISSUE: "1",
      COMMENTS: "",
      BODY: "",
      SECRET_LOG: "must-not-be-attached",
      ...env,
    },
  });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout;
}
describe("distribution workflows", () => {
  it.each([false, true])("builds the intended matrix (Windows only: %s)", (windowsOnly) => {
    const dir = mkdtempSync(join(tmpdir(), "f5-cli-matrix-"));
    try {
      const output = join(dir, "output");
      const script = build.jobs.metadata!.steps!.find((step) => step.id === "metadata")!.run!;
      const result = spawnSync("bash", ["-c", script], {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          INPUT_VERSION: "0.1.0-check.1",
          WINDOWS_ONLY: String(windowsOnly),
          GITHUB_OUTPUT: output,
        },
      });
      expect(result.status, result.stderr).toBe(0);
      const matrix = JSON.parse(
        readFileSync(output, "utf8")
          .split("\n")
          .find((line) => line.startsWith("matrix="))!
          .slice(7),
      );
      expect(matrix.include.map((row: { target: string }) => row.target)).toEqual(
        CLI_TARGETS.filter((target) => !windowsOnly || target.startsWith("win32-")),
      );
      expect(
        matrix.include.find((row: { target: string }) => row.target === "win32-arm64").bun,
      ).toBe("1.3.11");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("shares the five-target builder without duplicate release/weekly CLI artifacts", () => {
    for (const caller of [workflow("release"), weekly]) {
      expect(caller.jobs["build-cli"]!.uses).toBe("./.github/workflows/build-cli.yml");
      expect(caller.jobs.windows!.with?.["check-cli"]).toBe(false);
    }
    expect(workflow("windows-release-checks").on.pull_request).toBeUndefined();
    expect(weekly.permissions).toEqual({ contents: "read" });
    expect(weekly.jobs["scheduled-status"]!.if).toContain("github.event_name == 'schedule'");
  });
  it("creates a scheduled failure issue with a run link and no raw logs", () => {
    const text = notify({ ISSUE: "" });
    expect(text).toContain("create:");
    expect(text).toContain("https://example.test/runs/42");
    expect(text).not.toContain("must-not-be-attached");
  });
  it("deduplicates comments and initial issue bodies by run ID and attempt", () => {
    expect(notify()).toContain("comment:");
    for (const key of ["COMMENTS", "BODY"])
      expect(notify({ [key]: "<!-- distribution:42:2 -->" })).not.toContain("comment:");
    expect(notify({ COMMENTS: "<!-- distribution:42:1 -->" })).toContain("comment:");
  });
});
