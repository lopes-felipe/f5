/** The Dock tile plug-in's bundle, in the app's `Contents/PlugIns`. */
export const DOCK_TILE_PLUGIN = "F5DockTile.docktileplugin";
export const DOCK_TILE_EXECUTABLE = "F5DockTile";

/**
 * Info.plist additions: the usage strings macOS shows when F5 first needs each permission,
 * and the plug-in the Dock loads to draw F5's tile while F5 is not running.
 */
export const DESKTOP_MAC_EXTEND_INFO = {
  NSAutoFillRequiresTextContentTypeForOneTimeCodeOnMac: true,
  NSAppleEventsUsageDescription: "F5 uses Apple Events to inspect applications for computer use.",
  // macOS 15 asks before an app's processes reach local network hosts and shows this reason.
  NSLocalNetworkUsageDescription:
    "F5 connects to devices on your local network for commands run by terminals and coding agents.",
  NSDockTilePlugIn: DOCK_TILE_PLUGIN,
} as const;
