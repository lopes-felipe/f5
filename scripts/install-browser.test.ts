import { expect, it } from "vitest";
import { browserInstallArgs } from "./install-browser";

it("uses hosted Linux libraries without making browser setup depend on APT mirrors", () => {
  expect(browserInstallArgs({ GITHUB_ACTIONS: "true", RUNNER_OS: "Linux" })).toEqual([
    "install",
    "chromium",
  ]);
});

it.each([
  {},
  { CI: "true", RUNNER_OS: "Linux" },
  { GITHUB_ACTIONS: "true", RUNNER_OS: "Windows" },
  { GITHUB_ACTIONS: "true", RUNNER_OS: "macOS" },
])("retains OS dependency installation outside hosted Linux: %j", (environment) => {
  expect(browserInstallArgs(environment)).toEqual(["install", "--with-deps", "chromium"]);
});
