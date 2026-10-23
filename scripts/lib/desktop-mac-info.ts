/** Info.plist usage strings macOS shows when F5 first needs each permission. */
export const DESKTOP_MAC_EXTEND_INFO = {
  NSAppleEventsUsageDescription: "F5 uses Apple Events to inspect applications for computer use.",
  // macOS 15 asks before an app's processes reach local network hosts and shows this reason.
  NSLocalNetworkUsageDescription:
    "F5 connects to devices on your local network for commands run by terminals and coding agents.",
} as const;
