/**
 * Read-only workflow enforcement: which providers keep a read-only stage read-only with an OS
 * sandbox, which rely on per-operation policy, and which certified runtimes a sandbox needs.
 *
 * Certification rows are floors: a row covers its `minimumVersion` and every later release on
 * the same build target, except the releases a later live run failed (`excludedVersions`). Add a
 * row only with the live-gate evidence the provider's doc describes.
 */
import type { ReadOnlyEnforcement } from "@t3tools/contracts";

export interface ReadOnlyCertificationRow {
  /**
   * Lowest release the live certification passed on, exactly as the run printed it (with any
   * build suffix, such as `2026.11.22-e9042b2`). Later releases are covered too.
   */
  readonly minimumVersion: string;
  /** `<platform>-<arch>`, such as `darwin-arm64`: each build is certified separately. */
  readonly target: string;
  /** Releases at or above the floor that a later live run failed. */
  readonly excludedVersions?: ReadonlyArray<string>;
}

/**
 * Numeric segments of a release's core version (`1.5.13`, or `2026.11.22` from
 * `2026.11.22-e9042b2`), or undefined when it has no parseable core. Unparseable versions are
 * never certified.
 */
export function releaseVersionSegments(version: string | null | undefined): number[] | undefined {
  const core = version?.trim().split(/[-+]/, 1)[0];
  if (!core || !/^\d+(?:\.\d+)*$/.test(core)) return undefined;
  return core.split(".").map((part) => Number.parseInt(part, 10));
}

/** Negative, zero or positive as `left` is below, equal to or above `right`. */
export function compareReleaseVersions(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

const hasVersionSuffix = (version: string) => /[-+]/.test(version);

/**
 * Whether a certification row covers this release:
 *
 * - its core version is above the floor's; a suffixed build (`1.6.0-beta.1`) counts, since it
 *   comes after every release of a lower core;
 * - or its core equals the floor's and it carries no suffix, or it is exactly the version the
 *   row names (`2026.11.22-e9042b2`). A pre-release or other build of the floor's own core
 *   (`1.5.15-beta.1`, `1.5.15+local`) was never vetted, so it isn't covered;
 * - and no exclusion names it. An exclusion without a suffix (`1.5.14`) also covers every build
 *   of that core (`1.5.14-hotfix`, `1.5.14+build`).
 */
export function readOnlyRuntimeCertified(
  rows: ReadonlyArray<ReadOnlyCertificationRow>,
  version: string | null | undefined,
  target: string | undefined,
): boolean {
  const segments = releaseVersionSegments(version);
  if (!segments || !target) return false;
  const trimmed = version!.trim();
  return rows.some((row) => {
    if (row.target !== target) return false;
    const floor = releaseVersionSegments(row.minimumVersion);
    if (!floor) return false;
    const comparison = compareReleaseVersions(segments, floor);
    if (comparison < 0) return false;
    if (comparison === 0 && hasVersionSuffix(trimmed) && trimmed !== row.minimumVersion.trim())
      return false;
    return !row.excludedVersions?.some((excluded) => {
      const entry = excluded.trim();
      if (entry === trimmed) return true;
      const excludedCore = releaseVersionSegments(entry);
      return (
        !hasVersionSuffix(entry) &&
        excludedCore !== undefined &&
        compareReleaseVersions(segments, excludedCore) === 0
      );
    });
  });
}

/**
 * The Windows build (`10.0.26100` → 26100) from `os.release()`, or undefined. Antigravity's
 * AppContainer sandbox needs Windows 11 24H2 (build 26100) or later and silently does nothing
 * on older builds.
 */
export function windowsBuildNumber(osRelease: string | undefined): number | undefined {
  const build = osRelease?.trim().split(".")[2];
  if (!build || !/^\d+$/.test(build)) return undefined;
  return Number.parseInt(build, 10);
}

export const ANTIGRAVITY_WINDOWS_SANDBOX_MINIMUM_BUILD = 26_100;

/**
 * Antigravity runtimes whose sandboxed read-only workflow launch passed the live certification
 * in `docs/providers/antigravity.md`.
 */
export const ANTIGRAVITY_READ_ONLY_WORKFLOW_CERTIFIED_RUNTIMES: ReadonlyArray<ReadOnlyCertificationRow> =
  [
    // Live run 2026-11-25 on the F5-managed build: both rounds refused `npm --version`, the
    // `read_project_status` MCP trap and a BypassSandbox retry; the sandboxed shell had no network.
    { minimumVersion: "1.5.15", target: "darwin-arm64" },
  ];

/**
 * Cursor CLI builds whose native read-only sandbox (`--sandbox enabled` with a
 * `workspace_readonly` sandbox.json) passed gates C1-C3 in `docs/reviews/read-only-live-gates.md`.
 * Until a row exists Cursor read-only stages use F5's command policy.
 */
export const CURSOR_READ_ONLY_SANDBOX_CERTIFIED_RUNTIMES: ReadonlyArray<ReadOnlyCertificationRow> =
  [];

export interface ReadOnlyEnforcementHost {
  /** `<platform>-<arch>` of the machine the provider runs on. */
  readonly target: string | undefined;
  /** `os.release()` of that machine; needed to trust a Windows certification. */
  readonly osRelease?: string | undefined;
  /**
   * False when the provider can't start its OS sandbox from this process. F5's macOS desktop
   * backend already runs inside a Seatbelt sandbox, and macOS refuses to start a second one
   * inside it (`sandbox_apply: Operation not permitted`), so Codex's and Antigravity's sandboxes
   * fail every command there. Undefined means not checked, and is treated as available.
   */
  readonly nestedSandbox?: boolean | undefined;
}

export interface ReadOnlyEnforcementTables {
  readonly antigravity?: ReadonlyArray<ReadOnlyCertificationRow>;
  readonly cursor?: ReadonlyArray<ReadOnlyCertificationRow>;
}

export function antigravityReadOnlySandboxCertified(
  version: string | null | undefined,
  host: ReadOnlyEnforcementHost,
  rows: ReadonlyArray<ReadOnlyCertificationRow> = ANTIGRAVITY_READ_ONLY_WORKFLOW_CERTIFIED_RUNTIMES,
): boolean {
  if (!readOnlyRuntimeCertified(rows, version, host.target)) return false;
  if (!host.target?.startsWith("win32-")) return true;
  const build = windowsBuildNumber(host.osRelease);
  return build !== undefined && build >= ANTIGRAVITY_WINDOWS_SANDBOX_MINIMUM_BUILD;
}

/** Drivers that can never confine a turn to read-only work. */
export const READ_ONLY_UNSUPPORTED_DRIVERS: ReadonlySet<string> = new Set(["grok", "muse"]);

/**
 * How a read-only workflow stage on `driver` is enforced on this host, or undefined when the
 * driver can't run read-only stages here. Codex runs in its read-only sandbox. Cursor uses its
 * native sandbox once certified for the host and F5's command policy otherwise. Antigravity
 * needs a certified runtime: its certification also proves every write reaches F5 as a request,
 * so an uncertified one can't fall back to policy. Claude, OpenCode, Pi and any other driver
 * are policy-enforced.
 *
 * Where a provider sandbox can't start (`host.nestedSandbox === false`), Codex, a certified
 * Antigravity and Cursor run without it and F5's command policy decides each command instead.
 */
export function resolveReadOnlyEnforcement(
  driver: string,
  version: string | null | undefined,
  host: ReadOnlyEnforcementHost,
  tables: ReadOnlyEnforcementTables = {},
): ReadOnlyEnforcement | undefined {
  if (READ_ONLY_UNSUPPORTED_DRIVERS.has(driver)) return undefined;
  const sandboxOr = (fallback: ReadOnlyEnforcement) =>
    host.nestedSandbox === false ? fallback : "sandbox";
  switch (driver) {
    case "codex":
      return sandboxOr("policy");
    case "antigravity":
      return antigravityReadOnlySandboxCertified(version, host, tables.antigravity)
        ? sandboxOr("policy")
        : undefined;
    case "cursor":
      return readOnlyRuntimeCertified(
        tables.cursor ?? CURSOR_READ_ONLY_SANDBOX_CERTIFIED_RUNTIMES,
        version,
        host.target,
      )
        ? sandboxOr("policy")
        : "policy";
    default:
      return "policy";
  }
}

/** `session.configured` config keys the provider service records for a read-only stage. */
export const READ_ONLY_ENFORCEMENT_CONFIG_KEY = "f5ReadOnlyEnforcement";
export const READ_ONLY_ENFORCEMENT_SUMMARY_CONFIG_KEY = "f5ReadOnlyEnforcementSummary";

/** The one-line description recorded on the stage's session. */
export function readOnlyEnforcementSummary(
  enforcement: ReadOnlyEnforcement,
  providerName: string,
): string {
  switch (enforcement) {
    case "sandbox":
      return `Read-only stage: sandboxed (${providerName} native sandbox)`;
    case "f5-sandbox":
      return "Read-only stage: sandboxed (F5 sandbox)";
    case "policy":
      return "Read-only stage: policy-enforced";
  }
}
