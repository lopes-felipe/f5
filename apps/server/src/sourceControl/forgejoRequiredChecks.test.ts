import { expect, it } from "vitest";
import { markRequiredForgejoChecks } from "./forgejoRequiredChecks.ts";

const checks = [
  { name: "ci/build", status: "success" as const, description: null, url: null },
  { name: "optional", status: "failure" as const, description: null, url: null },
];

it("handles many wildcards, Unicode, newlines and literal stars without regex backtracking", () => {
  const names = ["a".repeat(200), "a".repeat(199) + "b", "x?y\nz", "*build", "ci/*lint", "ci/😀"];
  const result = markRequiredForgejoChecks(
    names.map((name) => ({ name, status: "success" as const, description: null, url: null })),
    {
      enable_status_check: true,
      status_check_contexts: ["*a".repeat(12) + "b", "x*?y?z", "*build", "ci/*", "ci/?"],
    },
  );
  expect(result.map((check) => check.required)).toEqual([undefined, true, true, true, true, true]);
});

it("matches slash-spanning wildcards and keeps missing patterns pending", () => {
  expect(
    markRequiredForgejoChecks(checks, {
      enable_status_check: true,
      status_check_contexts: ["ci?*", "test-*", "test-*"],
    }),
  ).toEqual([
    { ...checks[0], required: true },
    checks[1],
    { name: "test-*", status: "pending", required: true, description: null, url: null },
  ]);
});

it("keeps all checks gating for unsupported patterns", () => {
  const result = markRequiredForgejoChecks(checks, {
    enable_status_check: true,
    status_check_contexts: ["ci/*", "ci/[ab]"],
  });
  expect(result.slice(0, 2)).toEqual(checks);
  expect(result[2]).toMatchObject({
    status: "pending",
    description: "Required check pattern cannot be evaluated.",
  });
  expect(result[2]?.required).toBeUndefined();
});

it.each([{}, { enable_status_check: false, status_check_contexts: ["ci/*"] }])(
  "keeps all checks gating when policy is unavailable or disabled",
  (branch) => expect(markRequiredForgejoChecks(checks, branch)).toBe(checks),
);
