import { expect, it } from "vitest";
import { acceptanceOnlyFiles } from "./release-source.ts";

it("identifies only acceptance-report changes as ineligible beta sources", () => {
  expect(
    acceptanceOnlyFiles([
      "docs/computer-certification/acceptance-0.1.2-codex.json",
      "docs/computer-certification/acceptance-0.1.2-claude.json",
    ]),
  ).toBe(true);
});

it.each(
  [
    [],
    ["src/main.ts"],
    ["docs/computer-certification/acceptance-0.1.2-codex.json", "src/main.ts"],
    ["docs/computer-certification/acceptance-nested/report.json"],
    ["docs/computer-certification/acceptance-report.md"],
    ["docs/computer-certification/not-acceptance.json"],
  ].map((names) => ({ names })),
)("retains other changes as potential beta sources: $names", ({ names }) => {
  expect(acceptanceOnlyFiles(names)).toBe(false);
});
