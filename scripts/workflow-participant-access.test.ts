import { globSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Workflow actors past the first two live in optional arrays beside the legacy pair fields. Code
 * that reads the pair fields directly silently ignores actors C to F, so every read goes through
 * `@t3tools/shared/workflowParticipants`. Only the record builders, the stored settings for
 * upstream port review, model preferences, migrations, demo seeds and tests may touch them.
 */
const PAIR_FIELDS = [
  "branchA",
  "branchB",
  "reviewerA",
  "reviewerB",
  "investigatorA",
  "investigatorB",
] as const;
const LEGACY_CROSS_REVIEW_FIELDS = [
  "crossReviewThreadId",
  "crossReviewStatus",
  "crossReviewTurnId",
  "crossReviewMessageId",
  "crossReviewRetryCount",
  "crossReviewDispatchCommandId",
] as const;

const ALLOWED = [
  /\.(test|browser|testUtils|testkit)\.tsx?$/,
  /\/(test|testing|fixtures|__fixtures__)\//,
  /\/persistence\/Migrations\//,
  /\/seed-demo\.ts$/,
  /^packages\/shared\/src\/workflowParticipants\.ts$/,
  /^apps\/server\/src\/orchestration\/workflowRecordBuilders\.ts$/,
  // Upstream port review settings and requests store reviewers A and B as named fields.
  /^apps\/server\/src\/upstreamPorts\/(service|admission)\.ts$/,
  /^apps\/web\/src\/components\/upstream\/(PortReviewOptions|UpstreamDialogs|UpstreamSettingsPopover)\.tsx$/,
  /^apps\/web\/src\/modelPreferencesStore\.ts$/,
];

const fields = [...PAIR_FIELDS, ...LEGACY_CROSS_REVIEW_FIELDS].join("|");
/** `x.branchA`, `x?.branchA` and `x["branchA"]`; object-literal keys are construction, not access. */
const ACCESS = new RegExp(
  `(?:\\?\\.|\\.)\\s*(?:${fields})\\b|\\[\\s*["'\`](?:${fields})["'\`]\\s*\\]`,
);

const root = fileURLToPath(new URL("..", import.meta.url));

export function participantAccessViolations(
  files: ReadonlyArray<{ readonly path: string; readonly source: string }>,
): string[] {
  const violations: string[] = [];
  for (const file of files) {
    if (ALLOWED.some((pattern) => pattern.test(file.path))) continue;
    file.source.split("\n").forEach((line, index) => {
      const code = line.replace(/\/\/.*$/, "");
      if (ACCESS.test(code)) violations.push(`${file.path}:${index + 1}: ${line.trim()}`);
    });
  }
  return violations;
}

describe("workflow participant access", () => {
  it("reads workflow actors only through the shared participant helpers", () => {
    const paths = globSync(["apps/*/src/**/*.{ts,tsx}", "packages/shared/src/**/*.{ts,tsx}"], {
      cwd: root,
    });
    expect(paths.length).toBeGreaterThan(100);
    const violations = participantAccessViolations(
      paths.map((path) => ({
        path: path.replaceAll("\\", "/"),
        source: readFileSync(new URL(path, new URL("..", import.meta.url)), "utf8"),
      })),
    );
    expect(violations).toEqual([]);
  });

  it("catches member, optional and bracket access but not object-literal keys", () => {
    const path = "apps/server/src/orchestration/example.ts";
    expect(
      participantAccessViolations([
        {
          path,
          source: [
            "const a = workflow.branchA;",
            "const b = workflow?.reviewerB?.status;",
            'const c = workflow["investigatorA"];',
            "const d = investigator.crossReviewStatus;",
            "const e = { branchA: slot, reviewerB: slot };",
            "// workflow.branchA in a comment",
            "const f = workflow.additionalBranches;",
          ].join("\n"),
        },
      ]).map((violation) => violation.split(": ")[0]),
    ).toEqual([`${path}:1`, `${path}:2`, `${path}:3`, `${path}:4`]);
    expect(
      participantAccessViolations([
        { path: "packages/shared/src/workflowParticipants.ts", source: "workflow.branchA" },
        { path: "apps/web/src/components/X.browser.tsx", source: "workflow.branchA" },
      ]),
    ).toEqual([]);
  });
});
