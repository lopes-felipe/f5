import { expect, it } from "vitest";
import { windowsRunnerChecks } from "./windowsRunner";

const ready = { elevated: false, activeSession: true, defaultDesktop: true, sessionId: 1 };
it("requires a live unelevated desktop with the requested Windows version", () => {
  expect(Object.values(windowsRunnerChecks(ready, 19041, "windows-10")).every(Boolean)).toBe(true);
  expect(Object.values(windowsRunnerChecks(ready, 22631, "windows-11")).every(Boolean)).toBe(true);
  for (const [probe, build, version] of [
    [{ ...ready, elevated: true }, 22631, "windows-11"],
    [{ ...ready, sessionId: 0 }, 22631, "windows-11"],
    [{ ...ready, activeSession: false }, 22631, "windows-11"],
    [{ ...ready, defaultDesktop: false }, 22631, "windows-11"],
    [ready, 19040, "windows-10"],
    [ready, 19045, "windows-11"],
    [ready, 22631, "windows-10"],
    [ready, NaN, "windows-11"],
  ] as const)
    expect(Object.values(windowsRunnerChecks(probe, build, version)).every(Boolean)).toBe(false);
});
