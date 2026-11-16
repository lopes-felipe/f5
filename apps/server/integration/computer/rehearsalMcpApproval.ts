import { mcpElicitationResponse } from "../../src/codex/mcpElicitation";

/** Test consent is limited to the one authenticated catalog this worker created. */
export function rehearsalMcpApproval(method: string, payload: unknown, serverName: string) {
  if (
    method !== "mcpServer/elicitation/request" ||
    !payload ||
    typeof payload !== "object" ||
    Array.isArray(payload) ||
    (payload as Record<string, unknown>).serverName !== serverName
  )
    return "decline" as const;
  return mcpElicitationResponse(payload, "accept").action === "accept"
    ? ("accept" as const)
    : ("decline" as const);
}
