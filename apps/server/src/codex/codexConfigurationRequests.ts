import type { CodexConfigurationAction, McpResourceRouting } from "@t3tools/contracts";

export function buildCodexProviderWriteParams(
  settings: Extract<CodexConfigurationAction, { type: "write" }>["settings"],
) {
  return { settings };
}
export function buildCodexGatewayReadParams(modelProvider: string) {
  return { modelProvider };
}
export function buildCodexGatewayLoginParams(modelProvider: string, deviceAuth: boolean) {
  return { modelProvider, deviceAuth };
}
export function buildCodexResourceReadParams(
  threadId: string,
  server: string,
  uri: string,
  routing?: McpResourceRouting,
) {
  return { threadId, server, uri, ...routing };
}
