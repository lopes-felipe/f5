import type { ProviderKind, RuntimeMode } from "@t3tools/contracts";
import { cursorRuntimeModes } from "./cursorHarness";

const BASIC_MODES = new Set<RuntimeMode>(["approval-required", "full-access"]);
const EDIT_MODES = new Set<RuntimeMode>(["approval-required", "auto-accept-edits", "full-access"]);
// Muse auto-approves in-workspace edits in every approval mode, so F5 never
// claims `approval-required` for it.
const MUSE_MODES = new Set<RuntimeMode>(["auto-accept-edits", "full-access"]);
const REVIEWED_MODES = new Set<RuntimeMode>([
  "approval-required",
  "auto-accept-edits",
  "auto",
  "full-access",
]);

/**
 * Runtime modes a provider supports. An instance's `availableRuntimeModes` (from its status
 * snapshot) replaces the per-kind default table, so per-instance support such as native
 * Antigravity Auto is enforced everywhere the table is. The snapshot list is security policy,
 * so it is intersected with the modes each kind may ever offer: a snapshot can narrow its kind's
 * table, and widen it only where the kind allows (Antigravity's native Auto).
 */
export function runtimeModeCapabilities(
  provider: ProviderKind,
  available?: ReadonlyArray<RuntimeMode> | null,
): ReadonlySet<RuntimeMode> {
  const table = defaultRuntimeModes(provider);
  if (available && available.length > 0) {
    const ceiling = provider === "antigravity" ? REVIEWED_MODES : table;
    const allowed = new Set(available.filter((mode) => ceiling.has(mode)));
    if (allowed.size > 0) return allowed;
  }
  return table;
}

function defaultRuntimeModes(provider: ProviderKind): ReadonlySet<RuntimeMode> {
  switch (provider) {
    case "codex":
    // Claude `auto` fails closed to asking when the model or CLI lacks it.
    case "claudeAgent":
      return REVIEWED_MODES;
    case "opencode":
    case "pi":
    // F5 enforces Auto-accept edits on Antigravity's native default mode; native Auto is
    // offered per instance once a session advertises it.
    case "antigravity":
      return EDIT_MODES;
    // Driver-level ceiling for the ACP harness; Auto appears only once its
    // live gate passes. Instance policy narrows this further per harness.
    case "cursor":
      return cursorRuntimeModes("acp");
    case "grok":
    case "acp":
      return BASIC_MODES;
    case "muse":
      return MUSE_MODES;
  }
}

export function runtimeModeUnsupportedReason(
  provider: ProviderKind,
  runtimeMode: RuntimeMode,
  available?: ReadonlyArray<RuntimeMode> | null,
): string | undefined {
  if (runtimeModeCapabilities(provider, available).has(runtimeMode)) return undefined;
  if (runtimeMode === "auto") {
    return `Auto review is not available for ${provider}.`;
  }
  if (runtimeMode === "auto-accept-edits") {
    return `Edit-only auto-approval is not available for ${provider}.`;
  }
  return `${runtimeMode} is not available for ${provider}.`;
}

/**
 * For a saved selection (recovering a thread, a scheduled run): like
 * `runtimeModeUnsupportedReason`, except that Antigravity Auto may resume even when the current
 * snapshot doesn't offer it (an update or a pending discovery). Its adapter checks the live
 * session and falls back to Supervised, with a warning, when native Auto is missing. New
 * selections keep the strict check.
 */
export function savedRuntimeModeUnsupportedReason(
  provider: ProviderKind,
  runtimeMode: RuntimeMode,
  available?: ReadonlyArray<RuntimeMode> | null,
): string | undefined {
  if (provider === "antigravity" && runtimeMode === "auto") return undefined;
  return runtimeModeUnsupportedReason(provider, runtimeMode, available);
}

/** Runtime modes from least to most autonomous. */
const RUNTIME_MODES_BY_AUTONOMY: ReadonlyArray<RuntimeMode> = [
  "approval-required",
  "auto-accept-edits",
  "auto",
  "full-access",
];

/**
 * `preferred` when supported, otherwise the most autonomous supported mode that is still
 * narrower than `preferred`. `undefined` when every supported mode is wider: switching provider
 * never widens access on the user's behalf, so the caller must ask the user to choose.
 */
export function supportedRuntimeModeAtOrBelow(
  capabilities: ReadonlySet<RuntimeMode>,
  preferred: RuntimeMode,
): RuntimeMode | undefined {
  const ceiling = RUNTIME_MODES_BY_AUTONOMY.indexOf(preferred);
  return RUNTIME_MODES_BY_AUTONOMY.slice(0, ceiling + 1)
    .toReversed()
    .find((mode) => capabilities.has(mode));
}

export function runtimeModeGloss(runtimeMode: RuntimeMode): string {
  switch (runtimeMode) {
    case "approval-required":
      return "ask before edits and commands";
    case "auto-accept-edits":
      return "approve file edits automatically but ask before other actions";
    case "auto":
      return "use an AI reviewer for routine approvals and ask the user about risky actions";
    case "full-access":
      return "allow commands and edits without approval prompts";
  }
}
