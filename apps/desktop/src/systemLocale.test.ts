import { expect, it } from "vitest";
import { systemLocale, toSystemLocaleTag } from "./systemLocale";

it("preserves macOS region and hour cycle overrides", () => {
  expect(toSystemLocaleTag("en_US@rg=nlzzzz", "h12")).toBe("en-NL-u-hc-h12");
  expect(toSystemLocaleTag("de_DE@calendar=buddhist")).toBe("de-DE");
  for (const [key, cycle] of [
    ["AppleICUForce12HourTime", "h12"],
    ["AppleICUForce24HourTime", "h23"],
  ]) {
    const locale = systemLocale("en_US@rg=nlzzzz", "darwin", {}, (k) => k === key);
    expect(locale).toBe("en-NL-u-hc-" + cycle);
    expect(
      new Intl.DateTimeFormat(locale, { hour: "numeric", hour12: true }).resolvedOptions().hour12,
    ).toBe(true);
  }
});

it("uses Linux time locale precedence and falls back for C/POSIX", () => {
  const resolve = (env: NodeJS.ProcessEnv) => systemLocale("fr-FR", "linux", env, () => false);
  expect(resolve({ LANG: "en_US.UTF-8", LC_TIME: "de_DE.UTF-8" })).toBe("de-DE");
  expect(resolve({ LC_ALL: "it_IT.UTF-8", LC_TIME: "de_DE.UTF-8" })).toBe("it-IT");
  expect(resolve({ LANG: "C.UTF-8" })).toBe("fr-FR");
  expect(resolve({ LC_ALL: "POSIX" })).toBe("fr-FR");
});
