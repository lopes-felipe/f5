import { expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { DesktopKeepAwakeState } from "@t3tools/contracts";
import { KeepAwakeSettings } from "./KeepAwakeSettings";
const fixture = vi.hoisted(() => ({ state: null as DesktopKeepAwakeState | null }));
vi.mock("../../hooks/useDesktopKeepAwake", () => ({
  useDesktopKeepAwake: () => ({ state: fixture.state, bridge: {}, accept: () => {} }),
}));
it.each([null, 1] as const)(
  "renders recovery instead of Off with unresolved ownership and flag %s",
  (sleepDisabled) => {
    fixture.state = {
      revision: 1,
      mode: "off",
      closedLid: true,
      keepDisplayOn: false,
      active: false,
      displayActive: false,
      busyThreadCount: 0,
      cooldownUntil: null,
      lid: {
        supported: true,
        permission: "available",
        ruleInstalledByF5: false,
        engaged: true,
        sleepDisabled,
        pending: false,
        blockedReason: "reset-failed",
      },
    };
    const html = renderToStaticMarkup(createElement(KeepAwakeSettings));
    expect(html).toContain("Recovery required: sleep may still be disabled");
    expect(html).toContain("Could not re-enable sleep. Retrying.");
  },
);
it("uses progress and cleanup status instead of false recovery warnings", () => {
  fixture.state = {
    revision: 1,
    mode: "agents",
    closedLid: true,
    keepDisplayOn: false,
    active: true,
    displayActive: false,
    busyThreadCount: 1,
    cooldownUntil: null,
    lid: {
      supported: true,
      permission: "available",
      ruleInstalledByF5: false,
      engaged: true,
      sleepDisabled: 0,
      pending: true,
      blockedReason: null,
    },
  };
  let html = renderToStaticMarkup(createElement(KeepAwakeSettings));
  expect(html).toContain("1 agent working");
  expect(html).not.toContain("Recovery required");
  fixture.state = {
    ...fixture.state,
    active: false,
    lid: { ...fixture.state.lid, pending: false, blockedReason: "command-failed" },
  };
  html = renderToStaticMarkup(createElement(KeepAwakeSettings));
  expect(html).toContain("Sleep restored; finishing recovery");
  expect(html).not.toContain("Could not re-enable sleep");
});
it("reports whether the display is kept on", () => {
  const base: DesktopKeepAwakeState = {
    revision: 1,
    mode: "always",
    closedLid: false,
    keepDisplayOn: false,
    active: true,
    displayActive: false,
    busyThreadCount: 0,
    cooldownUntil: null,
    lid: {
      supported: true,
      permission: "unknown",
      ruleInstalledByF5: false,
      engaged: false,
      sleepDisabled: 0,
      pending: false,
      blockedReason: null,
    },
  };
  fixture.state = base;
  let html = renderToStaticMarkup(createElement(KeepAwakeSettings));
  expect(html).toContain("Keep display on");
  expect(html).toContain("The display can still turn off.");
  expect(html).not.toContain("· display");
  fixture.state = { ...base, keepDisplayOn: true, displayActive: true };
  html = renderToStaticMarkup(createElement(KeepAwakeSettings));
  expect(html).not.toContain("The display can still turn off.");
  expect(html).toContain("Awake · display on");
  fixture.state = { ...base, keepDisplayOn: true };
  html = renderToStaticMarkup(createElement(KeepAwakeSettings));
  expect(html).toContain("Awake · display may sleep");
});
