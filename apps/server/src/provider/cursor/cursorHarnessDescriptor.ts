/**
 * Cursor harness descriptor: which harness a provider instance runs and
 * whether this host can run it. The driver, registry, settings write path and
 * `server.getConfig` all read it, so they cannot disagree.
 */
import type { CursorHarness } from "@t3tools/contracts";
import {
  type CursorSdkAvailability,
  cursorSdkHarnessAvailability,
} from "@t3tools/shared/cursorHarness";

/** Harness stored in a Cursor instance config; absent decodes to ACP. */
export function cursorInstanceHarness(config: unknown): CursorHarness {
  return config !== null &&
    typeof config === "object" &&
    "harness" in config &&
    config.harness === "sdk"
    ? "sdk"
    : "acp";
}

/** Whether `config` names a harness explicitly (pinned) rather than by default. */
export function cursorInstanceHarnessIsExplicit(config: unknown): boolean {
  return (
    config !== null &&
    typeof config === "object" &&
    "harness" in config &&
    (config.harness === "acp" || config.harness === "sdk")
  );
}

export function cursorSdkHarnessHostAvailability(input: {
  readonly profile?: { readonly isDefault: boolean } | undefined;
}): CursorSdkAvailability {
  return cursorSdkHarnessAvailability(
    { platform: process.platform, arch: process.arch },
    { isolatedProfile: input.profile?.isDefault === false },
  );
}
