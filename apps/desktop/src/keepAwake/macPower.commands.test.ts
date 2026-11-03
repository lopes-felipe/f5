import { beforeEach, expect, it, vi } from "vitest";
import { createMacPower } from "./macPower";
import { processStart } from "./lidOwnership";
const mocks = vi.hoisted(() => ({ exec: vi.fn() }));
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  execFile: mocks.exec,
}));
beforeEach(() => mocks.exec.mockReset());
function reply(output: string, error = "", failed = false) {
  mocks.exec.mockImplementationOnce((_file, _args, _options, callback) => {
    callback(failed ? new Error("failure") : null, output, error);
  });
}
it("verifies each write using a separate read and never writes from probes", async () => {
  const power = createMacPower();
  reply("");
  reply("System-wide power settings:\n SleepDisabled 1\n");
  expect(await power.setSleepDisabled(1)).toBe("ok");
  expect(mocks.exec.mock.calls.map((call) => call.slice(0, 2))).toEqual([
    ["/usr/bin/sudo", ["-n", "/usr/bin/pmset", "-a", "disablesleep", "1"]],
    ["/usr/bin/pmset", ["-g"]],
  ]);
});
it("treats timeout, readback mismatch and failed reads as unknown", async () => {
  const power = createMacPower();
  reply("", "timeout", true);
  reply("System-wide power settings:\n SleepDisabled 1\n");
  expect(await power.setSleepDisabled(1)).toBe("unknown");
  reply("");
  reply("System-wide power settings:\n SleepDisabled 0\n");
  expect(await power.setSleepDisabled(1)).toBe("unknown");
  reply("");
  reply("", "", true);
  expect(await power.setSleepDisabled(1)).toBe("unknown");
  reply("", "", true);
  expect(await power.readSleepDisabled()).toBeNull();
});
it("distinguishes permission denial and cancelled administrator prompts", async () => {
  const power = createMacPower();
  reply("", "sudo: a password is required", true);
  reply("System-wide power settings:\n SleepDisabled 0\n");
  expect(await power.setSleepDisabled(1)).toBe("denied");
  reply("", "execution error: User canceled. (-128)", true);
  expect(await power.installRule()).toBe("cancelled");
  expect(mocks.exec.mock.calls.at(-1)?.[1]).toContain("on run argv");
});
it("returns unknown hardware on process execution failure", async () => {
  reply("", "EPERM", true);
  expect(await createMacPower().lidHardware()).toBe("unknown");
});
it("requires both enable and reset permission before accepting an existing rule", async () => {
  reply("", "not permitted", true); // reset denied
  reply(""); // enabling allowed
  expect(await createMacPower().sudoRuleAvailable()).toBe(false);
  expect(mocks.exec.mock.calls.map((call) => call[1].at(-1))).toEqual(["0", "1"]);
});
it("pins process identity to UTC regardless of the host timezone", async () => {
  const original = process.env.TZ;
  try {
    for (const timezone of ["Pacific/Honolulu", "Europe/Berlin"]) {
      process.env.TZ = timezone;
      reply("Tue Nov  3 10:00:00 2026\n");
      expect(await processStart(123)).toBe("Tue Nov  3 10:00:00 2026");
      expect(mocks.exec.mock.calls.at(-1)?.[2].env).toMatchObject({ TZ: "UTC", LC_ALL: "C" });
    }
  } finally {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  }
});
