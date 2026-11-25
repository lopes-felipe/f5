import { describe, expect, it } from "vitest";
import {
  antigravityReadOnlySandboxCertified,
  readOnlyEnforcementSummary,
  readOnlyRuntimeCertified,
  releaseVersionSegments,
  resolveReadOnlyEnforcement,
  windowsBuildNumber,
  type ReadOnlyCertificationRow,
} from "./readOnlyEnforcement";

const FLOOR: ReadonlyArray<ReadOnlyCertificationRow> = [
  { minimumVersion: "1.5.13", target: "darwin-arm64", excludedVersions: ["1.5.14"] },
];

describe("readOnlyRuntimeCertified", () => {
  it.each([
    ["1.5.13", "darwin-arm64", true],
    ["1.5.15", "darwin-arm64", true],
    ["1.6.0", "darwin-arm64", true],
    ["2.0", "darwin-arm64", true],
    ["1.5.13-beta.1", "darwin-arm64", true],
    ["1.5.12", "darwin-arm64", false],
    ["1.5", "darwin-arm64", false],
    ["1.5.14", "darwin-arm64", false],
    ["1.5.15", "linux-x64", false],
    ["1.5.15", undefined, false],
    [null, "darwin-arm64", false],
    ["", "darwin-arm64", false],
    ["latest", "darwin-arm64", false],
  ] as const)("%s on %s is %s", (version, target, expected) => {
    expect(readOnlyRuntimeCertified(FLOOR, version, target)).toBe(expected);
  });

  it("certifies nothing without a row", () => {
    expect(readOnlyRuntimeCertified([], "9.9.9", "darwin-arm64")).toBe(false);
  });

  it("parses date-style Cursor builds", () => {
    expect(releaseVersionSegments("2026.11.22-e9042b2")).toEqual([2026, 11, 22]);
    expect(releaseVersionSegments("v1.0")).toBeUndefined();
  });
});

describe("antigravityReadOnlySandboxCertified", () => {
  const windowsRows = [{ minimumVersion: "1.5.13", target: "win32-x64" }];

  it("requires Windows build 26100 or later before trusting a Windows row", () => {
    expect(windowsBuildNumber("10.0.26100")).toBe(26100);
    expect(windowsBuildNumber("10.0")).toBeUndefined();
    expect(windowsBuildNumber(undefined)).toBeUndefined();
    expect(
      antigravityReadOnlySandboxCertified(
        "1.5.13",
        { target: "win32-x64", osRelease: "10.0.26100" },
        windowsRows,
      ),
    ).toBe(true);
    expect(
      antigravityReadOnlySandboxCertified(
        "1.5.13",
        { target: "win32-x64", osRelease: "10.0.22631" },
        windowsRows,
      ),
    ).toBe(false);
    expect(
      antigravityReadOnlySandboxCertified("1.5.13", { target: "win32-x64" }, windowsRows),
    ).toBe(false);
  });

  it("ignores the OS release off Windows", () => {
    expect(antigravityReadOnlySandboxCertified("1.5.13", { target: "darwin-arm64" }, FLOOR)).toBe(
      true,
    );
  });
});

describe("resolveReadOnlyEnforcement", () => {
  const host = { target: "darwin-arm64" };

  it("sandboxes Codex and leaves Claude, OpenCode and Pi to policy", () => {
    expect(resolveReadOnlyEnforcement("codex", undefined, host)).toBe("sandbox");
    expect(resolveReadOnlyEnforcement("claudeAgent", "2.0.0", host)).toBe("policy");
    expect(resolveReadOnlyEnforcement("opencode", "1.0.0", host)).toBe("policy");
    expect(resolveReadOnlyEnforcement("pi", "1.0.0", host)).toBe("policy");
  });

  it("never runs Grok or Muse read-only", () => {
    expect(resolveReadOnlyEnforcement("grok", "1.0.0", host)).toBeUndefined();
    expect(resolveReadOnlyEnforcement("muse", "1.0.0", host)).toBeUndefined();
  });

  it("makes Antigravity unavailable, not policy-enforced, without a certified floor", () => {
    expect(resolveReadOnlyEnforcement("antigravity", "1.5.15", host, { antigravity: FLOOR })).toBe(
      "sandbox",
    );
    expect(
      resolveReadOnlyEnforcement("antigravity", "1.5.12", host, { antigravity: FLOOR }),
    ).toBeUndefined();
    expect(
      resolveReadOnlyEnforcement(
        "antigravity",
        "1.5.15",
        { target: "win32-x64", osRelease: "10.0.22631" },
        { antigravity: [{ minimumVersion: "1.5.13", target: "win32-x64" }] },
      ),
    ).toBeUndefined();
  });

  it("falls Cursor back to policy unless the host is certified", () => {
    const cursor = [{ minimumVersion: "2026.11.22", target: "darwin-arm64" }];
    expect(resolveReadOnlyEnforcement("cursor", "2026.11.22-e9042b2", host, { cursor })).toBe(
      "sandbox",
    );
    expect(resolveReadOnlyEnforcement("cursor", "2026.11.20", host, { cursor })).toBe("policy");
    expect(
      resolveReadOnlyEnforcement(
        "cursor",
        "2026.11.22",
        { target: "win32-x64", osRelease: "10.0.26100" },
        { cursor },
      ),
    ).toBe("policy");
    expect(resolveReadOnlyEnforcement("cursor", "2026.11.22", host)).toBe("policy");
  });
});

describe("readOnlyEnforcementSummary", () => {
  it("names how the stage is kept read-only", () => {
    expect(readOnlyEnforcementSummary("sandbox", "Codex")).toBe(
      "Read-only stage: sandboxed (Codex native sandbox)",
    );
    expect(readOnlyEnforcementSummary("policy", "Claude")).toBe("Read-only stage: policy-enforced");
    expect(readOnlyEnforcementSummary("f5-sandbox", "Cursor")).toBe(
      "Read-only stage: sandboxed (F5 sandbox)",
    );
  });
});
