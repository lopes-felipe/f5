import type { PrHubCheck, PrHubCheckRun, PrHubCheckStatus } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  groupPrChecks,
  prCheckDuration,
  prCheckLogTail,
  prCheckLogUnavailableText,
  prCheckStatusLabel,
  prCheckWorkflows,
  prChecksSummary,
  prFailingChecks,
} from "./prChecks";

const check = (name: string, status: PrHubCheckStatus, required?: boolean): PrHubCheck => ({
  name,
  status,
  description: null,
  url: null,
  ...(required === undefined ? {} : { required }),
});

describe("groupPrChecks", () => {
  it("puts failed checks first, then running, passed and skipped, and drops empty groups", () => {
    const groups = groupPrChecks([
      check("lint", "success"),
      check("docs", "skipped"),
      check("build", "failure"),
      check("deploy", "cancelled"),
      check("e2e", "pending"),
      check("advisory", "neutral"),
    ]);
    expect(groups.map((group) => [group.id, group.checks.map((item) => item.name)])).toEqual([
      ["failed", ["build", "deploy"]],
      ["running", ["e2e"]],
      ["passed", ["lint"]],
      ["skipped", ["advisory", "docs"]],
    ]);
    expect(groupPrChecks([check("lint", "success")]).map((group) => group.id)).toEqual(["passed"]);
    expect(groupPrChecks([])).toEqual([]);
  });

  it("lists required checks before the others in a group", () => {
    const [failed] = groupPrChecks([
      check("alpha", "failure"),
      check("zeta", "failure", true),
      check("beta", "failure", false),
    ]);
    expect(failed?.checks.map((item) => item.name)).toEqual(["zeta", "alpha", "beta"]);
  });
});

describe("check presentation", () => {
  it("names each status", () => {
    expect(prCheckStatusLabel("cancelled")).toBe("Cancelled");
    expect(prCheckStatusLabel("pending")).toBe("Running");
    expect(prCheckStatusLabel("neutral")).toBe("Neutral");
  });

  it("summarizes the groups in one line", () => {
    expect(
      prChecksSummary([
        check("build", "failure"),
        check("e2e", "pending"),
        check("lint", "success"),
        check("unit", "success"),
      ]),
    ).toBe("1 failed, 1 running, 2 passed");
    expect(prChecksSummary([])).toBe("");
  });
});

const run = (
  name: string,
  status: PrHubCheckStatus,
  overrides: Partial<PrHubCheckRun> = {},
): PrHubCheckRun => ({
  ...check(name, status),
  id: name,
  workflow: "CI",
  workflowRunId: "9",
  startedAt: null,
  completedAt: null,
  logAvailable: false,
  ...overrides,
});

describe("prCheckWorkflows", () => {
  it("splits checks by workflow in name order, with the ones that have none last", () => {
    expect(
      prCheckWorkflows([
        run("status", "failure", { workflow: null }),
        run("deploy", "failure", { workflow: "Release" }),
        run("build", "failure"),
        run("unit", "failure"),
      ]).map((workflow) => [workflow.name, workflow.checks.map((item) => item.name)]),
    ).toEqual([
      ["CI", ["build", "unit"]],
      ["Release", ["deploy"]],
      [null, ["status"]],
    ]);
    expect(prCheckWorkflows([])).toEqual([]);
  });
});

describe("prCheckDuration", () => {
  const started = "2026-11-14T06:00:00.000Z";
  const at = (seconds: number) => new Date(Date.parse(started) + seconds * 1000).toISOString();

  it("formats how long a finished check ran", () => {
    const finished = (seconds: number) =>
      prCheckDuration({ startedAt: started, completedAt: at(seconds), status: "success" });
    expect(finished(42)).toBe("42s");
    expect(finished(192)).toBe("3m 12s");
    expect(finished(3840)).toBe("1h 4m");
  });

  it("counts a running check up to now and leaves out what it cannot know", () => {
    expect(
      prCheckDuration(
        { startedAt: started, completedAt: null, status: "pending" },
        Date.parse(at(75)),
      ),
    ).toBe("1m 15s");
    expect(
      prCheckDuration({ startedAt: started, completedAt: null, status: "failure" }),
    ).toBeNull();
    expect(prCheckDuration({ startedAt: null, completedAt: at(5), status: "success" })).toBeNull();
    expect(
      prCheckDuration({ startedAt: at(10), completedAt: started, status: "success" }),
    ).toBeNull();
  });
});

describe("prFailingChecks", () => {
  it("keeps failed and cancelled checks, failures and required ones first", () => {
    expect(
      prFailingChecks([
        run("cancelled", "cancelled"),
        run("passed", "success"),
        run("optional", "failure"),
        run("required", "failure", { required: true }),
        run("running", "pending"),
      ]).map((item) => item.name),
    ).toEqual(["required", "optional", "cancelled"]);
  });
});

describe("prCheckLogTail", () => {
  const excerpt = Array.from({ length: 40 }, (_, index) => `line ${index + 1}`);
  excerpt[29] = "##[error]the failure";
  const log = { excerpt: excerpt.join("\n"), startLine: 101, errorLine: 130 };

  it("ends a few lines after the error and drops lines from the top to fit", () => {
    const tail = prCheckLogTail(log, 120).split("\n");
    expect(tail.at(-1)).toBe("line 35");
    expect(tail).toContain("##[error]the failure");
    expect(tail[0]).not.toBe("line 1");
    expect(tail.join("\n").length).toBeLessThanOrEqual(120);
  });

  it("keeps everything that fits, and the end of a log without an error", () => {
    expect(prCheckLogTail(log, 10_000).split("\n")).toHaveLength(35);
    const plain = prCheckLogTail({ ...log, errorLine: null }, 30).split("\n");
    expect(plain.at(-1)).toBe("line 40");
    expect(prCheckLogTail({ excerpt: null, startLine: 0, errorLine: null }, 100)).toBe("");
    // One line longer than the budget is cut, not dropped.
    expect(prCheckLogTail({ excerpt: "x".repeat(500), startLine: 1, errorLine: null }, 100)).toBe(
      "x".repeat(100),
    );
  });
});

describe("prCheckLogUnavailableText", () => {
  it("explains each reason", () => {
    expect(prCheckLogUnavailableText("pending")).toContain("once the job finishes");
    expect(prCheckLogUnavailableText("expired")).toContain("no longer available");
    expect(prCheckLogUnavailableText("forbidden")).toContain("not allowed");
    expect(prCheckLogUnavailableText("unsupported")).toContain("does not publish a log");
    expect(prCheckLogUnavailableText("failed")).toContain("could not be loaded");
  });
});
