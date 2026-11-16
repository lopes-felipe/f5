import type { ServerSettings } from "@t3tools/contracts";

const GLOBAL_KEYS = [
  "enableAgentComputerUse",
  "computerUseExecutionMode",
  "computerUsePasswordMasking",
  "computerUseBackend",
  "enableAgentBrowserAccess",
] as const;
/** Project overrides that change a project's computer policy. */
const PROJECT_KEYS = ["enableAgentComputerUse", "enableAgentBrowserAccess"] as const;

export interface ComputerSettingsPatch {
  readonly enableAgentComputerUse?: unknown;
  readonly computerUseExecutionMode?: unknown;
  readonly computerUsePasswordMasking?: unknown;
  readonly computerUseBackend?: unknown;
  readonly enableAgentBrowserAccess?: unknown;
  readonly projectSettingsOverrides?: Readonly<Record<string, unknown>> | undefined;
}

/**
 * Which part of the computer policy a settings patch changes: `global` for every thread,
 * otherwise the project IDs whose effective policy may change. `null` when the patch leaves
 * computer policy untouched, so unrelated edits never interrupt running agents.
 */
export function computerPolicyChange(
  current: ServerSettings,
  patch: ComputerSettingsPatch,
): { readonly global: true } | { readonly global: false; readonly projects: Set<string> } | null {
  if (GLOBAL_KEYS.some((key) => patch[key] !== undefined && patch[key] !== current[key]))
    return { global: true };
  const projects = new Set<string>();
  for (const [projectId, next] of Object.entries(patch.projectSettingsOverrides ?? {})) {
    const previous = current.projectSettingsOverrides[
      projectId as keyof ServerSettings["projectSettingsOverrides"]
    ] as Readonly<Record<string, unknown>> | undefined;
    const value = (next ?? undefined) as Readonly<Record<string, unknown>> | undefined;
    // Conservative: a key the patch omits counts as a change when it was set before.
    if (PROJECT_KEYS.some((key) => previous?.[key] !== value?.[key])) projects.add(projectId);
  }
  return projects.size ? { global: false, projects } : null;
}
