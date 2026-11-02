const WAYLAND_COLOR_MANAGER_FEATURE = "WaylandWpColorManagerV1";

// Chromium feature entries look like `*Name<Trial.Group:param/value`.
const featureListNames = (value: string | null): ReadonlyArray<string> =>
  (value ?? "").split(",").flatMap((entry) => entry.trim().match(/^\*?([^<:]+)/)?.[1] ?? []);

const trimNonEmpty = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

// A stale HYPRLAND_INSTANCE_SIGNATURE is often inherited into other desktops, so only
// trust the session's desktop names.
const isHyprlandSession = (env: NodeJS.ProcessEnv): boolean =>
  (trimNonEmpty(env.XDG_CURRENT_DESKTOP) ?? trimNonEmpty(env.XDG_SESSION_DESKTOP) ?? "")
    .split(":")
    .some((name) => name.trim().toLowerCase() === "hyprland");

// Hyprland 0.48.0 added wp-color-manager-v1 (hyprwm/Hyprland#9444) advertising
// FEATURE_SET_PRIMARIES while rejecting set_primaries outside debug mode, which Chromium
// treats as a fatal protocol error. 0.51.0 accepts them (hyprwm/Hyprland#11499).
// Only stock builds of these releases count. Matching the commit as well as the tag
// keeps later development builds that still report an old VERSION and tag (Nix
// synthesizes `v${VERSION}`) on the default.
const AFFECTED_HYPRLAND_RELEASE_COMMITS: ReadonlyMap<string, string> = new Map([
  ["0.48.0", "5ee35f914f921e5696030698e74fb5566a804768"],
  ["0.48.1", "29e2e59fdbab8ed2cc23a20e3c6043d5decb5cdc"],
  ["0.49.0", "9958d297641b5c84dcff93f9039d80a5ad37ab00"],
  ["0.50.0", "c4a4c341568944bd4fb9cd503558b2de602c0213"],
  ["0.50.1", "4e242d086e20b32951fdc0ebcbfb4d41b5be8dcc"],
]);

const hasBrokenColorManager = (readHyprctlVersionJson: () => string): boolean => {
  try {
    const parsed: unknown = JSON.parse(readHyprctlVersionJson());
    if (typeof parsed !== "object" || parsed === null) return false;
    const { version, tag, commit, dirty } = parsed as Record<string, unknown>;
    return (
      typeof version === "string" &&
      AFFECTED_HYPRLAND_RELEASE_COMMITS.get(version) === commit &&
      tag === `v${version}` &&
      dirty === false
    );
  } catch {
    return false;
  }
};

/**
 * Returns the merged `--disable-features` value to apply before Electron is ready,
 * or null to leave the command line alone. `ozonePlatform` is the resolved
 * `--ozone-platform` value; Electron fills it in before app code runs.
 *
 * Color management stays on unless `hyprctl version -j` identifies a stock Hyprland
 * release known to kill the native Wayland connection right after the first window
 * opens ("Custom primaries aren't supported"). An explicit feature override wins.
 */
export function resolveLinuxDisableFeaturesSwitch(input: {
  readonly env: NodeJS.ProcessEnv;
  readonly ozonePlatform: string | null;
  readonly enableFeatures: string | null;
  readonly disableFeatures: string | null;
  readonly readHyprctlVersionJson: () => string;
}): string | null {
  if (input.ozonePlatform !== "wayland" || !isHyprlandSession(input.env)) return null;
  if (featureListNames(input.enableFeatures).includes(WAYLAND_COLOR_MANAGER_FEATURE)) return null;
  if (featureListNames(input.disableFeatures).includes(WAYLAND_COLOR_MANAGER_FEATURE)) return null;
  if (!hasBrokenColorManager(input.readHyprctlVersionJson)) return null;
  return input.disableFeatures === null
    ? WAYLAND_COLOR_MANAGER_FEATURE
    : `${input.disableFeatures},${WAYLAND_COLOR_MANAGER_FEATURE}`;
}
