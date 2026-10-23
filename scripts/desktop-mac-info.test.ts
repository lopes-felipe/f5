import { expect, it } from "vitest";

import { DESKTOP_MAC_EXTEND_INFO } from "./lib/desktop-mac-info.ts";

it("explains every macOS privacy prompt the packaged app can raise", () => {
  expect(DESKTOP_MAC_EXTEND_INFO).toEqual({
    NSAppleEventsUsageDescription: expect.stringContaining("computer use"),
    NSLocalNetworkUsageDescription: expect.stringContaining("local network"),
  });
});
