import { describe, expect, it } from "vitest";

import {
  describeAgentBrowserCapabilities,
  summarizeAgentBrowserCapabilities,
} from "./AgentBrowserLiveCard.logic";

describe("agent browser capability chip", () => {
  it("lists reachable capabilities and omits ones that are off", () => {
    expect(
      describeAgentBrowserCapabilities({
        preview: { serverName: "f5_preview", installed: true, verified: true },
        chrome: { state: "pending" },
        computerUse: { state: "off" },
      }).map((item) => [item.key, item.tone]),
    ).toEqual([
      ["preview", "ok"],
      ["chrome", "pending"],
    ]);
  });

  it("separates installed tools from working access", () => {
    const installed = { preview: { serverName: "f5_preview", installed: true, verified: true } };
    const label = (access: { previewEnabled: boolean; previewHostAvailable: boolean }) =>
      describeAgentBrowserCapabilities(installed, access).map((item) => [item.label, item.tone]);
    expect(label({ previewEnabled: false, previewHostAvailable: true })).toEqual([
      ["F5 preview off", "off"],
    ]);
    expect(label({ previewEnabled: true, previewHostAvailable: false })).toEqual([
      ["F5 preview unavailable", "warning"],
    ]);
    expect(label({ previewEnabled: true, previewHostAvailable: true })).toEqual([
      ["F5 preview ready", "ok"],
    ]);
    expect(
      describeAgentBrowserCapabilities(
        { preview: { serverName: "f5_preview", installed: true, verified: false } },
        { previewEnabled: true, previewHostAvailable: true },
      )[0]?.tone,
    ).toBe("warning");
  });

  it("explains blocked capabilities instead of hiding them", () => {
    expect(
      summarizeAgentBrowserCapabilities({
        computerUse: { state: "unavailable", detail: "Needs the native backend." },
      }),
    ).toBe("Computer use unavailable in F5");
    expect(summarizeAgentBrowserCapabilities(undefined)).toBeNull();
  });
});
