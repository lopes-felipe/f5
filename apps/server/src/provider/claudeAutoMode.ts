import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import type { RuntimeMode } from "@t3tools/contracts";

/**
 * Claude `auto` permission mode fails closed: it is used only when the model
 * reports `supportsAutoMode` and the CLI then reports `auto` as its effective
 * mode. Otherwise the session runs in `default` and F5 asks before actions.
 */
export const CLAUDE_AUTO_UNAVAILABLE_WARNING =
  "Auto review is unavailable here; F5 will ask before actions";

export function claudeRuntimePermissionMode(
  runtimeMode: RuntimeMode,
  supportsAutoMode: boolean | undefined,
): { readonly mode: PermissionMode; readonly autoUnavailable: boolean } {
  switch (runtimeMode) {
    case "approval-required":
      return { mode: "default", autoUnavailable: false };
    case "auto-accept-edits":
      return { mode: "acceptEdits", autoUnavailable: false };
    case "auto":
      return supportsAutoMode === true
        ? { mode: "auto", autoUnavailable: false }
        : { mode: "default", autoUnavailable: true };
    case "full-access":
      return { mode: "bypassPermissions", autoUnavailable: false };
  }
}

/**
 * Re-checks auto support after a live model change. Returns undefined when
 * nothing changes. In plan or workflow sessions only the base mode moves
 * (`setLive` is undefined) so the live plan mode is never left early.
 */
export function claudeAutoModeRecheck(input: {
  readonly autoRequested: boolean;
  readonly base: PermissionMode | undefined;
  readonly supportsAutoMode: boolean | undefined;
  readonly livePlan: boolean;
  readonly workflow: boolean;
}):
  | {
      readonly base: PermissionMode;
      readonly setLive: PermissionMode | undefined;
      readonly downgraded: boolean;
    }
  | undefined {
  // A workflow's base is plan; its runtime mode never becomes live.
  if (!input.autoRequested || input.workflow) return undefined;
  const next: PermissionMode = input.supportsAutoMode === true ? "auto" : "default";
  if (next === input.base) return undefined;
  return {
    base: next,
    setLive: input.livePlan ? undefined : next,
    downgraded: next === "default",
  };
}

/**
 * True when the CLI reports an effective mode other than the `auto` F5 asked
 * for (outside plan), so the session must fall back to `default`.
 */
export function claudeAutoModeRejected(input: {
  readonly base: PermissionMode | undefined;
  readonly reported: unknown;
  readonly workflow: boolean;
}): boolean {
  if (input.workflow || input.base !== "auto") return false;
  if (typeof input.reported !== "string") return false;
  return input.reported !== "auto" && input.reported !== "plan";
}
