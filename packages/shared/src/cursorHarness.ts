/**
 * Cursor harness gates: the checked-in record of which Cursor behaviors have
 * passed their live gate (see `docs/reviews/read-only-live-gates.md`).
 *
 * A gate controls both UI exposure and server admission. A row that has not
 * passed disables only its own feature. Rows are added only from recorded live
 * evidence; never flip one without the matching evidence row.
 */
import type { RuntimeMode } from "@t3tools/contracts";

export type CursorHarness = "acp" | "sdk";

/** `@cursor/sdk` version the SDK harness is pinned to, unpatched. */
export const CURSOR_SDK_VERSION = "1.4.2";

/** Rows certified for the ACP harness (`agent acp`). */
export interface CursorAcpGates {
  /**
   * The `cursor/create_plan` outcome that ends the turn without executing.
   * Unset keeps the legacy `{ accepted: true }` reply.
   */
  readonly planReplyOutcome: "accepted" | "rejected" | "cancelled" | undefined;
  /** Lowest CLI version whose `--auto-review` passed. Unset keeps Auto unavailable. */
  readonly autoReviewMinimumVersion: string | undefined;
  /** `cursor/list_available_models` answers before any `session/new`. */
  readonly catalogWithoutSession: boolean;
}

export const CURSOR_ACP_GATES: CursorAcpGates = {
  planReplyOutcome: undefined,
  autoReviewMinimumVersion: undefined,
  // Observed on CLI 2026.11.22-e9042b2 (docs/reviews/read-only-live-gates.md).
  catalogWithoutSession: true,
};

export type CursorSdkGateFeature =
  /** Unmodified SDK and helpers may be redistributed, telemetry reviewed. */
  | "distribution"
  /** Worker self-check, sessions, turns and recovery on this platform. */
  | "runtime"
  | "planMode"
  | "steering"
  | "compaction"
  | "rewind"
  | "subagentInspection"
  | "autoMode"
  | "isolatedProfiles";

export interface CursorSdkGateRow {
  readonly sdkVersion: string;
  /** `${process.platform}-${process.arch}`, for example `darwin-arm64`. */
  readonly platform: string;
  readonly features: ReadonlyArray<CursorSdkGateFeature>;
  /** Evidence row in `docs/reviews/read-only-live-gates.md`. */
  readonly evidence: string;
}

/** Empty until R0 records live evidence for a platform. */
export const CURSOR_SDK_GATES: ReadonlyArray<CursorSdkGateRow> = [];

export interface CursorHostPlatform {
  readonly platform: string;
  readonly arch: string;
}

export function cursorSdkFeatureCertified(
  feature: CursorSdkGateFeature,
  host: CursorHostPlatform,
  gates: ReadonlyArray<CursorSdkGateRow> = CURSOR_SDK_GATES,
): boolean {
  const key = `${host.platform}-${host.arch}`;
  return gates.some(
    (row) =>
      row.sdkVersion === CURSOR_SDK_VERSION &&
      row.platform === key &&
      row.features.includes(feature),
  );
}

export type CursorSdkAvailability =
  | { readonly available: true }
  | { readonly available: false; readonly reason: string };

/** Host-level SDK availability: Add provider offers SDK only when this passes. */
export function cursorSdkHarnessAvailability(
  host: CursorHostPlatform,
  options: { readonly isolatedProfile?: boolean } = {},
  gates: ReadonlyArray<CursorSdkGateRow> = CURSOR_SDK_GATES,
): CursorSdkAvailability {
  if (host.platform === "win32" && host.arch === "arm64")
    return {
      available: false,
      reason: "The Cursor SDK harness is not available on Windows arm64.",
    };
  if (!cursorSdkFeatureCertified("distribution", host, gates))
    return {
      available: false,
      reason: `The Cursor SDK harness (@cursor/sdk ${CURSOR_SDK_VERSION}) has not passed its distribution gate for this build.`,
    };
  if (!cursorSdkFeatureCertified("runtime", host, gates))
    return {
      available: false,
      reason: `The Cursor SDK harness is not certified on ${host.platform}-${host.arch} yet.`,
    };
  if (options.isolatedProfile && !cursorSdkFeatureCertified("isolatedProfiles", host, gates))
    return {
      available: false,
      reason: "The Cursor SDK harness is not certified for isolated F5 profiles yet.",
    };
  return { available: true };
}

function compareVersions(left: string, right: string): number {
  const parse = (value: string) =>
    (value.match(/\d+/g) ?? []).map((part) => Number.parseInt(part, 10));
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/** Auto on ACP needs a CLI at or above the certified `--auto-review` version. */
export function cursorAcpAutoReviewSupported(
  cliVersion: string | null | undefined,
  gates: CursorAcpGates = CURSOR_ACP_GATES,
): boolean {
  const minimum = gates.autoReviewMinimumVersion;
  if (minimum === undefined) return false;
  if (!cliVersion) return false;
  return compareVersions(cliVersion, minimum) >= 0;
}

/**
 * Runtime modes a Cursor harness can enforce. ACP keeps the CLI's own
 * approvals; the SDK cannot ask, so it never offers Supervised or
 * Auto-accept edits, and Auto needs the certified sandbox.
 */
export function cursorRuntimeModes(
  harness: CursorHarness,
  input: {
    readonly cliVersion?: string | null;
    readonly host?: CursorHostPlatform;
    readonly acpGates?: CursorAcpGates;
    readonly sdkGates?: ReadonlyArray<CursorSdkGateRow>;
  } = {},
): ReadonlySet<RuntimeMode> {
  if (harness === "acp") {
    // Fails closed: without the installed CLI's version Auto is never offered,
    // so a CLI older than the certified minimum cannot be admitted to it.
    const autoCertified = cursorAcpAutoReviewSupported(
      input.cliVersion,
      input.acpGates ?? CURSOR_ACP_GATES,
    );
    return new Set<RuntimeMode>(
      autoCertified
        ? ["approval-required", "auto", "full-access"]
        : ["approval-required", "full-access"],
    );
  }
  const modes = new Set<RuntimeMode>(["full-access"]);
  if (
    input.host &&
    input.host.platform !== "win32" &&
    cursorSdkFeatureCertified("autoMode", input.host, input.sdkGates)
  )
    modes.add("auto");
  return modes;
}
