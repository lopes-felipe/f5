import type { ProviderKind, ComputerAutomationUnavailableReason } from "@t3tools/contracts";

export type ComputerAgentProvider = "claude" | "codex" | "cursor" | "grok" | "antigravity";
export function computerAgentProviderFor(kind: ProviderKind): ComputerAgentProvider | undefined {
  return kind === "claudeAgent"
    ? "claude"
    : kind === "opencode" || kind === "muse" || kind === "acp" || kind === "pi"
      ? undefined
      : kind;
}
export const COMPUTER_AGENT_DISPLAY: Record<
  ComputerAgentProvider,
  { label: string; accent: string }
> = {
  claude: { label: "Claude", accent: "#D97757" },
  codex: { label: "Codex", accent: "#10A37F" },
  cursor: { label: "Cursor", accent: "#8B5CF6" },
  grok: { label: "Grok", accent: "#0EA5E9" },
  antigravity: { label: "Antigravity", accent: "#4285F4" },
};
export type SupportEntry = { state: "available" | "conditional" | "unsupported"; reason?: string };
export const ACP_COMPUTER_CATALOG_VERIFIED: Readonly<
  Record<"cursor" | "grok" | "antigravity" | "acp", boolean>
> = Object.freeze({
  cursor: false,
  grok: false,
  antigravity: false,
  acp: false,
});
export const ACP_PREVIEW_CATALOG_VERIFIED: Readonly<
  Record<"cursor" | "grok" | "antigravity" | "acp", boolean>
> = Object.freeze({ cursor: false, grok: false, antigravity: false, acp: false });
export const OPENCODE_EXTERNAL_AUTOMATION_REASON =
  "External OpenCode servers can't connect to F5's session-bound tools.";
const awaitingVerification: SupportEntry = {
  state: "unsupported",
  reason: "Awaiting verification",
};
const acpPreview = (provider: "cursor" | "grok" | "antigravity"): SupportEntry =>
  ACP_PREVIEW_CATALOG_VERIFIED[provider]
    ? { state: "conditional", reason: "Requires a harness with an HTTP MCP transport" }
    : { state: "unsupported", reason: "Awaiting preview startup verification" };
const openCodeReason = "F5 can't confirm which OpenCode session made a tool call before it runs.";
const museReason = "The pinned Muse SDK's session API doesn't accept MCP configuration.";
export const AGENT_AUTOMATION_SUPPORT: Record<
  ProviderKind,
  { preview: SupportEntry; computer: SupportEntry; builtin?: string }
> = {
  claudeAgent: {
    preview: { state: "available" },
    computer: { state: "available", reason: "F5 native" },
    builtin:
      "Claude's built-in computer use needs its terminal app's consent, which F5 can't answer safely.",
  },
  codex: {
    preview: { state: "available" },
    computer: { state: "available", reason: "F5 native" },
    builtin:
      "Codex's built-in computer use has no supported isolated launch with a per-call veto yet.",
  },
  cursor: { preview: acpPreview("cursor"), computer: awaitingVerification },
  grok: { preview: acpPreview("grok"), computer: awaitingVerification },
  antigravity: { preview: acpPreview("antigravity"), computer: awaitingVerification },
  opencode: {
    preview: { state: "unsupported", reason: openCodeReason },
    computer: { state: "unsupported", reason: openCodeReason },
  },
  acp: { preview: awaitingVerification, computer: awaitingVerification },
  pi: { preview: awaitingVerification, computer: awaitingVerification },
  muse: {
    preview: { state: "unsupported", reason: museReason },
    computer: { state: "unsupported", reason: museReason },
  },
};
export const COMPUTER_UNAVAILABLE_LABEL: Record<ComputerAutomationUnavailableReason, string> = {
  "not-certified": "Awaiting safety certification for this build",
  "unsupported-platform": "Not supported on this operating system",
  "missing-permissions": "Grant the permissions below",
  disabled: "Computer use is off",
  "no-host": "Only available in the F5 desktop app",
  "helper-missing": "The computer helper is missing from this build",
  "helper-crashed": "The computer helper stopped",
  "os-too-old": "This operating system version is too old",
  "monitor-unhealthy": "The input monitor is unavailable",
  "other-instance": "Another F5 build is using computer control",
};
