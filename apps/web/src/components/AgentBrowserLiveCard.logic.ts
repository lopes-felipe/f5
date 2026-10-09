import type { CompactRuntimeConfiguredActivityPayload } from "@t3tools/contracts";

export type RuntimeAgentBrowser = NonNullable<
  CompactRuntimeConfiguredActivityPayload["agentBrowser"]
>;

export interface BrowserCapabilityItem {
  readonly key: "preview" | "chrome" | "computerUse";
  readonly label: string;
  readonly tone: "ok" | "pending" | "warning" | "off";
  readonly detail?: string;
}

function stateTone(state: string): BrowserCapabilityItem["tone"] {
  switch (state) {
    case "connected":
      return "ok";
    case "pending":
      return "pending";
    case "failed":
    case "unavailable":
      return "warning";
    default:
      return "off";
  }
}

const STATE_LABEL: Record<string, string> = {
  connected: "on",
  pending: "connecting",
  failed: "failed",
  unavailable: "unavailable in F5",
  off: "off",
};

/**
 * Live facts the session payload cannot know: whether access is turned on right now (tools
 * stay installed when it is off) and whether this client can host a preview.
 */
export interface AgentBrowserAccess {
  readonly previewEnabled: boolean;
  readonly previewHostAvailable: boolean;
}

function describePreview(
  preview: NonNullable<RuntimeAgentBrowser["preview"]>,
  access: AgentBrowserAccess,
): BrowserCapabilityItem {
  if (!access.previewEnabled) {
    return {
      key: "preview",
      label: "F5 preview off",
      tone: "off",
      detail: "Agent browser access is turned off in settings; the tools stay installed.",
    };
  }
  if (preview.verified === false) {
    return {
      key: "preview",
      label: "F5 preview unverified",
      tone: "warning",
      detail: "F5 could not verify its preview tools in this session.",
    };
  }
  if (!access.previewHostAvailable) {
    return {
      key: "preview",
      label: "F5 preview unavailable",
      tone: "warning",
      detail: "Open this thread in the F5 desktop app so agents can use the preview.",
    };
  }
  return preview.verified === undefined
    ? { key: "preview", label: "F5 preview connecting", tone: "pending" }
    : { key: "preview", label: "F5 preview ready", tone: "ok" };
}

/** What the session can reach, in the order the chip shows it. Off capabilities are omitted. */
export function describeAgentBrowserCapabilities(
  agentBrowser: RuntimeAgentBrowser | undefined,
  access: AgentBrowserAccess = { previewEnabled: true, previewHostAvailable: true },
): BrowserCapabilityItem[] {
  if (!agentBrowser) return [];
  const items: BrowserCapabilityItem[] = [];
  if (agentBrowser.preview?.installed) {
    items.push(describePreview(agentBrowser.preview, access));
  }
  if (agentBrowser.chrome && agentBrowser.chrome.state !== "off") {
    items.push({
      key: "chrome",
      label: `Chrome ${STATE_LABEL[agentBrowser.chrome.state] ?? agentBrowser.chrome.state}`,
      tone: stateTone(agentBrowser.chrome.state),
      ...(agentBrowser.chrome.detail ? { detail: agentBrowser.chrome.detail } : {}),
    });
  }
  if (agentBrowser.computerUse && agentBrowser.computerUse.state !== "off") {
    items.push({
      key: "computerUse",
      label: `Computer use ${STATE_LABEL[agentBrowser.computerUse.state] ?? agentBrowser.computerUse.state}`,
      tone: stateTone(agentBrowser.computerUse.state),
      ...(agentBrowser.computerUse.detail ? { detail: agentBrowser.computerUse.detail } : {}),
    });
  }
  return items;
}

export function summarizeAgentBrowserCapabilities(
  agentBrowser: RuntimeAgentBrowser | undefined,
  access?: AgentBrowserAccess,
): string | null {
  const items = describeAgentBrowserCapabilities(agentBrowser, access);
  return items.length > 0 ? items.map((item) => item.label).join(" · ") : null;
}
