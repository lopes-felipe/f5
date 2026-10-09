import type { ProviderKind, RuntimeMode } from "@t3tools/contracts";

const BASIC_MODES = new Set<RuntimeMode>(["approval-required", "full-access"]);
const EDIT_MODES = new Set<RuntimeMode>(["approval-required", "auto-accept-edits", "full-access"]);
const REVIEWED_MODES = new Set<RuntimeMode>([
  "approval-required",
  "auto-accept-edits",
  "auto",
  "full-access",
]);

export function runtimeModeCapabilities(provider: ProviderKind): ReadonlySet<RuntimeMode> {
  switch (provider) {
    case "codex":
    // Claude `auto` fails closed to asking when the model or CLI lacks it.
    case "claudeAgent":
      return REVIEWED_MODES;
    case "opencode":
      return EDIT_MODES;
    case "cursor":
    case "grok":
    case "antigravity":
      return BASIC_MODES;
  }
}

export function runtimeModeUnsupportedReason(
  provider: ProviderKind,
  runtimeMode: RuntimeMode,
): string | undefined {
  if (runtimeModeCapabilities(provider).has(runtimeMode)) return undefined;
  if (runtimeMode === "auto") {
    return `Auto review is not available for ${provider}.`;
  }
  if (runtimeMode === "auto-accept-edits") {
    return `Edit-only auto-approval is not available for ${provider}.`;
  }
  return `${runtimeMode} is not available for ${provider}.`;
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
