import { expect, it, vi } from "vitest";
import type { WindowsInspectionDependencies } from "./rehearsalWindowsDiagnostics";
import {
  diagnoseWindowsInspection,
  windowsDiagnosticFailure,
  windowsDiagnosticIdentity,
  settleWindowsFixtureInspection,
  windowsInspectionFacts,
} from "./rehearsalWindowsDiagnostics";

it("settles an incomplete fixture tree with bounded observations and stops on errors or leaks", async () => {
  const ready = {
    accessible: true,
    nodes: [
      { name: "Rehearsal press", actions: ["press"], enabled: true },
      { name: "input", actions: ["setValue"], enabled: true },
    ],
  };
  const empty = { accessible: true, nodes: [] };
  const read = vi.fn().mockResolvedValueOnce(empty).mockResolvedValue(ready);
  const wait = vi.fn(async () => {});
  expect(await settleWindowsFixtureInspection(read, wait)).toEqual({ tree: ready, attempts: 2 });
  expect(wait).toHaveBeenCalledTimes(1);
  const partial = vi.fn(async () => empty);
  expect((await settleWindowsFixtureInspection(partial, wait)).attempts).toBe(6);
  expect(partial).toHaveBeenCalledTimes(6);
  const failed = vi.fn(async () => {
    throw new Error("native-error");
  });
  await expect(settleWindowsFixtureInspection(failed, wait)).rejects.toThrow("native-error");
  expect(failed).toHaveBeenCalledTimes(1);
  const leak = vi.fn(async () => ({
    accessible: true,
    nodes: [{ name: "F5_SYNTHETIC_PASSWORD_SENTINEL", actions: [], enabled: true }],
  }));
  expect((await settleWindowsFixtureInspection(leak, wait)).attempts).toBe(1);
});
it("pins diagnostics to the suite helper unless a specific current hash is selected", () => {
  const suite = "a".repeat(64),
    current = "b".repeat(64);
  const manifest = { identity: { files: { helper: suite } } };
  expect(windowsDiagnosticIdentity(manifest, suite)).toMatchObject({
    matchesSuiteHelper: true,
    matchesSelectedHelper: true,
  });
  expect(windowsDiagnosticIdentity(manifest, current)).toMatchObject({
    suiteHelperSha256: suite,
    currentHelperSha256: current,
    matchesSuiteHelper: false,
    matchesSelectedHelper: false,
  });
  expect(windowsDiagnosticIdentity(manifest, current, current.toUpperCase())).toMatchObject({
    suiteHelperSha256: suite,
    selectedHelperSha256: current,
    matchesSuiteHelper: false,
    matchesSelectedHelper: true,
  });
  expect(windowsDiagnosticIdentity(manifest, current, "c".repeat(64)).matchesSelectedHelper).toBe(
    false,
  );
  expect(manifest.identity.files.helper).toBe(suite);
});
it("rejects missing or malformed diagnostic identity rather than skipping the hash check", () => {
  const hash = "a".repeat(64);
  for (const manifest of [
    null,
    {},
    { identity: { files: {} } },
    { identity: { files: { helper: "PRIVATE_PATH" } } },
  ]) {
    expect(() => windowsDiagnosticIdentity(manifest, hash, hash)).toThrow(
      "invalid-helper-identity",
    );
  }
  const manifest = { identity: { files: { helper: hash } } };
  expect(() => windowsDiagnosticIdentity(manifest, "PRIVATE")).toThrow("invalid-helper-identity");
  expect(() => windowsDiagnosticIdentity(manifest, hash, "")).toThrow("invalid-helper-identity");
});

function dependencies(
  result: unknown = {
    accessible: true,
    nodes: [
      { name: "Rehearsal press", enabled: true, actions: ["press"] },
      { name: "PRIVATE_FIELD_TITLE", value: "PRIVATE_VALUE", enabled: true, actions: ["setValue"] },
    ],
  },
) {
  const fixtureClose = vi.fn(async () => true);
  const helper = {
    start: vi.fn(),
    status: vi.fn(() => ({ available: true as const, passwordMaskingSupported: true })),
    capabilities: vi.fn(() => ["background-ax-v1"]),
    onEvent: vi.fn(() => () => {}),
    control: vi.fn(),
    request: vi.fn<WindowsInspectionDependencies["helper"]["request"]>(async () => result),
    closeAndWait: vi.fn(async () => true),
  };
  const deps = {
    helper,
    fixture: vi.fn(async (name: string) => ({
      executable: "C:\\PRIVATE_ROOT\\" + name + "\\ComputerControlFixture.exe",
      close: fixtureClose,
    })),
    payload: JSON.stringify,
    waitUntilReady: vi.fn(async () => {}),
  } satisfies WindowsInspectionDependencies;
  return { deps, helper, fixtureClose };
}
it("inspects synthetic fixtures without permits, resumes, input or capture, and keeps only facts", async () => {
  const { deps, helper, fixtureClose } = dependencies();
  const report = await diagnoseWindowsInspection("/PRIVATE_ROOT", deps);
  expect(report).toMatchObject({
    state: "passed",
    stage: "inspection-complete",
    fixtureCount: 3,
    inspection: {
      accessible: true,
      nodeCount: 2,
      pressButtonCount: 1,
      editableCount: 1,
      secureSentinelAbsent: true,
    },
    cleanup: { confirmed: true },
  });
  expect(helper.request).toHaveBeenCalledTimes(1);
  expect(helper.request.mock.calls[0]?.[0]).toMatchObject({ op: "inspect", maxNodes: 800 });
  expect(helper.control.mock.calls.map(([command]) => command.type)).toEqual(["grantsChanged"]);
  expect(fixtureClose).toHaveBeenCalledTimes(3);
  expect(JSON.stringify(report)).not.toContain("PRIVATE");
});
it("identifies fixture startup failures and does not start the helper or send grants", async () => {
  const { deps, helper } = dependencies();
  deps.fixture.mockRejectedValue(Object.assign(new Error("PRIVATE_PATH"), { code: "EACCES" }));
  const report = await diagnoseWindowsInspection("/PRIVATE_ROOT", deps);
  expect(report).toMatchObject({
    state: "failed",
    stage: "fixture-approved-start",
    failure: { code: "EACCES" },
    cleanup: { confirmed: false, fixtureStartupConfirmed: false },
  });
  expect(helper.start).not.toHaveBeenCalled();
  expect(helper.request).not.toHaveBeenCalled();
  expect(helper.control).not.toHaveBeenCalled();
  expect(JSON.stringify(report)).not.toContain("PRIVATE");
});
it("separates handshake failure from inspection and closes all started fixtures", async () => {
  const { deps, helper, fixtureClose } = dependencies();
  deps.waitUntilReady.mockRejectedValue(new Error("helper-handshake-timeout"));
  const report = await diagnoseWindowsInspection("/PRIVATE_ROOT", deps);
  expect(report).toMatchObject({
    stage: "helper-handshake",
    failure: { code: "helper-handshake-timeout" },
    cleanup: { confirmed: true },
  });
  expect(helper.request).not.toHaveBeenCalled();
  expect(fixtureClose).toHaveBeenCalledTimes(3);
});
it("reports unavailable UI Automation and missing patterns without exposing inspected contents", async () => {
  for (const result of [
    { accessible: false, nodes: [] },
    {
      accessible: true,
      nodes: [
        { name: "PRIVATE_CONTENT", value: "PRIVATE_CONTENT", enabled: true, actions: ["focus"] },
      ],
    },
  ]) {
    const { deps } = dependencies(result);
    const report = await diagnoseWindowsInspection("/PRIVATE_ROOT", deps);
    expect(report).toMatchObject({
      state: "failed",
      stage: "native-inspection",
      failure: { code: "inspection-incomplete" },
    });
    expect(JSON.stringify(report)).not.toContain("PRIVATE");
  }
});
it("retains native error tags and fixed kinds, never messages or arbitrary fields", async () => {
  const { deps, helper } = dependencies();
  helper.request.mockRejectedValue({
    error: { _tag: "TargetBlocked", kind: "owner-unknown", message: "PRIVATE", path: "PRIVATE" },
  });
  const report = await diagnoseWindowsInspection("/PRIVATE_ROOT", deps);
  expect(report).toMatchObject({
    state: "failed",
    stage: "native-inspection",
    failure: { code: "TargetBlocked", kind: "owner-unknown" },
  });
  expect(JSON.stringify(report)).not.toContain("PRIVATE");
  expect(windowsDiagnosticFailure(new Error("private-customer-token"))).toEqual({
    code: "diagnostic-failed",
  });
});
it("cannot pass malformed inspection, a secure sentinel leak or unconfirmed cleanup", async () => {
  expect(() => windowsInspectionFacts({ accessible: true, nodes: Array(801).fill({}) })).toThrow(
    "invalid-inspection",
  );
  const leaking = dependencies({
    accessible: true,
    nodes: [
      { name: "Rehearsal press", enabled: true, actions: ["press"] },
      {
        name: "PRIVATE_TITLE",
        enabled: true,
        actions: ["setValue"],
        value: "F5_SYNTHETIC_PASSWORD_SENTINEL",
      },
    ],
  });
  const report = await diagnoseWindowsInspection("/PRIVATE_ROOT", leaking.deps);
  expect(report.state).toBe("failed");
  expect(report.inspection?.secureSentinelAbsent).toBe(false);
  expect(JSON.stringify(report)).not.toMatch(/PRIVATE|F5_SYNTHETIC_PASSWORD_SENTINEL/);
  const closing = dependencies();
  closing.helper.closeAndWait.mockResolvedValue(false);
  expect((await diagnoseWindowsInspection("/PRIVATE_ROOT", closing.deps)).state).toBe("failed");
});
