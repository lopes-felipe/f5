import { expect, it, vi } from "vitest";
import { probeFixtureProtocols } from "./fixtures";
import { join } from "node:path";

type ExecuteFile = NonNullable<Parameters<typeof probeFixtureProtocols>[1]>;
const processStatus = {
  "com.apple.Terminal": [],
  "com.google.Chrome": [],
  "com.apple.TextEdit": [123],
  "com.apple.calculator": [],
};
const appStatus = { textEditRunning: true, calculatorRunning: false };

it("uses the native verifiers' read-only status protocol before readiness", async () => {
  const execute = vi
    .fn<ExecuteFile>()
    .mockResolvedValueOnce({ stdout: JSON.stringify(processStatus) })
    .mockResolvedValueOnce({ stdout: JSON.stringify(appStatus) });
  expect(await probeFixtureProtocols("/fixtures", execute)).toBe(true);
  expect(execute.mock.calls.map(([binary, args]) => [binary, args])).toEqual([
    [join("/fixtures", "ProtectionAppVerifier"), ["--status"]],
    [join("/fixtures", "RealAppVerifier"), ["--status"]],
  ]);
});

it.each([
  { error: "invalid-operation" },
  { ...processStatus, "com.apple.TextEdit": [-1] },
  { ...processStatus, "com.apple.TextEdit": ["PRIVATE_SENTINEL"] },
])("refuses malformed process identities without exposing their contents", async (status) => {
  const execute = vi
    .fn<ExecuteFile>()
    .mockResolvedValueOnce({ stdout: JSON.stringify(status) })
    .mockResolvedValueOnce({ stdout: JSON.stringify(appStatus) });
  expect(await probeFixtureProtocols("/fixtures", execute)).toBe(false);
});

it("refuses malformed app state or failed protocol commands", async () => {
  const execute = vi
    .fn<ExecuteFile>()
    .mockResolvedValueOnce({ stdout: JSON.stringify(processStatus) })
    .mockResolvedValueOnce({ stdout: JSON.stringify({ ...appStatus, textEditRunning: "yes" }) });
  expect(await probeFixtureProtocols("/fixtures", execute)).toBe(false);
  execute.mockRejectedValue(new Error("PRIVATE_SENTINEL"));
  expect(await probeFixtureProtocols("/fixtures", execute)).toBe(false);
});
