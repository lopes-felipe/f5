import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import {
  installScript,
  parseBatteryPercent,
  parseLid,
  parseSleepDisabled,
  sudoersText,
} from "./macPower";
import { WATCHDOG } from "./lidOwnership";

describe("macOS power parsers", () => {
  it.each([
    ["System-wide power settings:\n SleepDisabled\t\t0\nCurrently in use:\n", 0],
    ["System-wide power settings:\n SleepDisabled\t\t1\n", 1],
    ["System-wide power settings:\n VACTDisabled 0\nCurrently in use:\n SleepDisabled 1\n", 0],
    ["System-wide power settings:\n SleepDisabled 1\n SleepDisabled 0\n", null],
    ["System-wide power settings:\n SleepDisabled true\n", null],
    ["Currently in use:\n SleepDisabled 1\n", null],
  ])("parses sleep settings defensively", (text, expected) => {
    expect(parseSleepDisabled(String(text))).toBe(expected);
  });
  it("parses battery and lid fixtures", () => {
    expect(
      parseBatteryPercent(
        "Now drawing from 'Battery Power'\n -InternalBattery-0 19%; discharging;",
      ),
    ).toBe(19);
    expect(
      parseBatteryPercent("Now drawing from 'AC Power'\n -InternalBattery-0 100%; charged;"),
    ).toBe(100);
    expect(parseBatteryPercent("Now drawing from 'AC Power'")).toBeNull();
    expect(parseLid('"AppleClamshellState" = Yes')).toBe(true);
    expect(parseLid('"AppleClamshellState" = No')).toBe(false);
    expect(parseLid("")).toBeNull();
  });
  it("validates usernames and shell syntax", () => {
    expect(() => sudoersText("bad;name")).toThrow();
    expect(sudoersText("test_user")).toContain("test_user ALL=(root) NOPASSWD:");
    for (const script of [installScript("test_user"), WATCHDOG])
      expect(spawnSync("/bin/sh", ["-n"], { input: script }).status).toBe(0);
  });
});
