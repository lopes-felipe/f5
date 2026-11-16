import type { McpServerDefinition, McpToolSummary } from "@t3tools/contracts";

export function summarizeMcpTools(
  tools: ReadonlyArray<{ name: string; description?: string | undefined; annotations?: unknown }>,
): McpToolSummary[] {
  return tools
    .slice(0, 200)
    .filter((tool) => tool.name.length > 0 && tool.name.length <= 128)
    .map((tool) => {
      const annotations =
        tool.annotations && typeof tool.annotations === "object"
          ? (tool.annotations as Record<string, unknown>)
          : {};
      return {
        name: tool.name,
        ...(tool.description ? { description: tool.description.slice(0, 300) } : {}),
        ...(typeof annotations.readOnlyHint === "boolean"
          ? { readOnly: annotations.readOnlyHint }
          : {}),
        ...(typeof annotations.destructiveHint === "boolean"
          ? { destructive: annotations.destructiveHint }
          : {}),
      };
    });
}

export function mcpToolSwitchState(server: McpServerDefinition, name: string) {
  const excluded = !!server.enabledTools?.length && !server.enabledTools.includes(name);
  return { checked: !excluded && !server.disabledTools?.includes(name), excluded };
}

/** Switches preserve all other fields, including the original allowlist representation. */
export function setMcpToolEnabled(
  server: McpServerDefinition,
  name: string,
  enabled: boolean,
): McpServerDefinition {
  const disabled = new Set(server.disabledTools ?? []);
  if (enabled) disabled.delete(name);
  else disabled.add(name);
  return { ...server, disabledTools: [...disabled] };
}
