import { describe, expect, it, vi } from "vitest";

import { resolveLinuxDisableFeaturesSwitch } from "./linuxColorManager";

const hyprland = { XDG_CURRENT_DESKTOP: "Hyprland", XDG_SESSION_TYPE: "wayland" };
const releaseCommits: Record<string, string> = {
  "0.48.0": "5ee35f914f921e5696030698e74fb5566a804768",
  "0.48.1": "29e2e59fdbab8ed2cc23a20e3c6043d5decb5cdc",
  "0.49.0": "9958d297641b5c84dcff93f9039d80a5ad37ab00",
  "0.50.0": "c4a4c341568944bd4fb9cd503558b2de602c0213",
  "0.50.1": "4e242d086e20b32951fdc0ebcbfb4d41b5be8dcc",
};
// Shape of `hyprctl version -j` from a release tarball, trimmed to the fields we read.
const hyprctlVersion =
  (version: string, overrides: Record<string, unknown> = {}) =>
  () =>
    JSON.stringify({
      commit: releaseCommits[version] ?? "0123456789abcdef0123456789abcdef01234567",
      version,
      dirty: false,
      tag: `v${version}`,
      flags: [],
      ...overrides,
    });
const brokenHyprland = {
  env: hyprland,
  ozonePlatform: "wayland",
  enableFeatures: null,
  disableFeatures: null,
  readHyprctlVersionJson: hyprctlVersion("0.48.1"),
};

describe("resolveLinuxDisableFeaturesSwitch", () => {
  it.each(["0.48.0", "0.48.1", "0.49.0", "0.50.0", "0.50.1"])(
    "disables the color manager on Hyprland %s",
    (version) => {
      expect(
        resolveLinuxDisableFeaturesSwitch({
          ...brokenHyprland,
          readHyprctlVersionJson: hyprctlVersion(version),
        }),
      ).toBe("WaylandWpColorManagerV1");
    },
  );

  it.each([
    { label: "case-insensitive desktop tokens", env: { XDG_CURRENT_DESKTOP: "foo:HYPRLAND" } },
    {
      label: "XDG_SESSION_DESKTOP when XDG_CURRENT_DESKTOP is unset",
      env: { XDG_SESSION_DESKTOP: "hyprland" },
    },
  ])("detects Hyprland via $label", ({ env }) => {
    expect(resolveLinuxDisableFeaturesSwitch({ ...brokenHyprland, env })).toBe(
      "WaylandWpColorManagerV1",
    );
  });

  it("keeps existing disabled features", () => {
    expect(
      resolveLinuxDisableFeaturesSwitch({
        ...brokenHyprland,
        disableFeatures: "Vulkan,WaylandWpColorManagerV1Extra",
      }),
    ).toBe("Vulkan,WaylandWpColorManagerV1Extra,WaylandWpColorManagerV1");
  });

  it.each([
    { label: "Hyprland 0.47.2", readHyprctlVersionJson: hyprctlVersion("0.47.2") },
    { label: "Hyprland 0.51.0", readHyprctlVersionJson: hyprctlVersion("0.51.0") },
    { label: "an unrecognized version", readHyprctlVersionJson: hyprctlVersion("1.0.0") },
    { label: "a prerelease version", readHyprctlVersionJson: hyprctlVersion("0.49.0-rc1") },
    {
      label: "a development build after an affected release",
      readHyprctlVersionJson: hyprctlVersion("0.50.1", { tag: "v0.50.1-87-g4e8875b5" }),
    },
    {
      label: "a later Nix build reporting an affected release tag",
      readHyprctlVersionJson: hyprctlVersion("0.50.1", {
        commit: "4e8875b5e9700c81ca4e169dc7b85bb5b3c8cb7a",
      }),
    },
    {
      label: "an affected version with another release's commit",
      readHyprctlVersionJson: hyprctlVersion("0.48.0", { commit: releaseCommits["0.48.1"] }),
    },
    {
      label: "missing commit metadata",
      readHyprctlVersionJson: () =>
        JSON.stringify({ version: "0.48.1", tag: "v0.48.1", dirty: false }),
    },
    { label: "a dirty build", readHyprctlVersionJson: hyprctlVersion("0.48.1", { dirty: true }) },
    {
      label: "output without build metadata",
      readHyprctlVersionJson: () => JSON.stringify({ version: "0.48.1" }),
    },
    { label: "non-object JSON", readHyprctlVersionJson: () => "null" },
    { label: "unparseable hyprctl output", readHyprctlVersionJson: () => "ok" },
    {
      label: "a missing hyprctl",
      readHyprctlVersionJson: () => {
        throw new Error("spawnSync hyprctl ENOENT");
      },
    },
  ])("preserves color management for $label", (overrides) => {
    expect(resolveLinuxDisableFeaturesSwitch({ ...brokenHyprland, ...overrides })).toBeNull();
  });

  it.each([
    {
      label: "a stale Hyprland signature in KDE",
      env: { XDG_CURRENT_DESKTOP: "KDE", HYPRLAND_INSTANCE_SIGNATURE: "abc_123" },
    },
    {
      label: "resolved X11 in a Wayland session",
      ozonePlatform: "x11",
      env: { ...hyprland, WAYLAND_DISPLAY: "wayland-1" },
    },
    { label: "a missing platform", ozonePlatform: null },
    { label: "already disabled features", disableFeatures: "Vulkan, WaylandWpColorManagerV1" },
    { label: "an explicitly enabled feature", enableFeatures: "Vulkan,WaylandWpColorManagerV1" },
    {
      label: "a feature enabled with trial parameters",
      enableFeatures: "*WaylandWpColorManagerV1<Study.Group:mode/strict",
    },
  ])("skips the Hyprland probe for $label", (overrides) => {
    const readHyprctlVersionJson = vi.fn(hyprctlVersion("0.48.1"));
    expect(
      resolveLinuxDisableFeaturesSwitch({
        ...brokenHyprland,
        ...overrides,
        readHyprctlVersionJson,
      }),
    ).toBeNull();
    expect(readHyprctlVersionJson).not.toHaveBeenCalled();
  });
});
