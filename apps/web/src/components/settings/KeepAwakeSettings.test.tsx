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
      active: false,
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
    active: true,
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
