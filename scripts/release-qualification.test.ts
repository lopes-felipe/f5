import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { expect, it } from "vitest";
import {
  assertReleaseCiJobs,
  dryRunReleaseVersion,
  requiredReleaseCiJobs,
  selectReleaseCiRun,
  type CiWorkflow,
  type CiRun,
} from "./lib/release-qualification.ts";
const workflow = parse(
  readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"),
) as CiWorkflow;
const main: CiRun = {
  id: 10,
  head_branch: "main",
  head_sha: "release",
  event: "push",
  status: "completed",
  conclusion: "success",
  run_attempt: 1,
  run_number: 10,
};
it("preserves beta feed selection and stable tags in release rehearsals", () => {
  expect(dryRunReleaseVersion("0.1.1-beta.2", "42")).toBe("0.1.1-beta.2.dryrun.42");
  expect(dryRunReleaseVersion("0.1.1", "42")).toBe("0.1.1");
  expect(() => dryRunReleaseVersion("v0.1.1", "42")).toThrow();
  expect(() => dryRunReleaseVersion("0.1.1", "42\nchannel=beta")).toThrow();
});
it("requires a main push run and rejects failed latest attempts instead of using older green runs", () => {
  expect(
    selectReleaseCiRun([main, { ...main, head_branch: "feature", run_number: 11 }], "release"),
  ).toEqual(main);
  expect(() => selectReleaseCiRun([{ ...main, head_branch: "feature" }], "release")).toThrow();
  expect(() =>
    selectReleaseCiRun([main, { ...main, run_attempt: 2, conclusion: "failure" }], "release"),
  ).toThrow();
  expect(() =>
    selectReleaseCiRun(
      [main, { ...main, id: 11, run_number: 11, conclusion: "failure" }],
      "release",
    ),
  ).toThrow();
});
it("derives matrix jobs and release-platform skips from the workflow and release profile", () => {
  const windows = requiredReleaseCiJobs(workflow, "windows"),
    all = requiredReleaseCiJobs(workflow, "all");
  expect(windows).toContain("windows-server-unit (3)");
  expect(windows).toContain("server-unit (2)");
  expect(windows).not.toContain("macos-suite");
  expect(all).toContain("macos-suite");
  const successful = all.map((name) => ({ name, conclusion: "success" }));
  expect(() => assertReleaseCiJobs(successful, all)).not.toThrow();
  expect(() =>
    assertReleaseCiJobs(
      successful.filter((job) => job.name !== "browser"),
      all,
    ),
  ).toThrow("browser");
  const skipped = successful.map((job) =>
    job.name.startsWith("macos") ? { ...job, conclusion: "skipped" } : job,
  );
  expect(() => assertReleaseCiJobs(skipped, windows)).not.toThrow();
  expect(() => assertReleaseCiJobs(skipped, all)).toThrow("macos");
  expect(() =>
    assertReleaseCiJobs(
      successful.map((job) =>
        job.name === "windows-build" ? { ...job, conclusion: "skipped" } : job,
      ),
      windows,
    ),
  ).toThrow("windows-build");
});
