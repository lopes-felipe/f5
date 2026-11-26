import type { McpServerDefinition, McpToolPolicy, McpToolSummary } from "@t3tools/contracts";

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

/** A tool's effective policy in F5's hub: Block is `disabledTools` (or the allowlist). */
export type McpToolPolicyChoice = McpToolPolicy | "block";

/** Allow or Ask for a tool the server lets through; the tool's own entry wins. */
export function mcpToolPolicy(server: McpServerDefinition, name: string): McpToolPolicy {
  // Own entries only: `constructor` or `toString` must not resolve to Object.prototype.
  const own =
    server.toolPolicy && Object.hasOwn(server.toolPolicy, name)
      ? server.toolPolicy[name]
      : undefined;
  return own ?? server.defaultToolPolicy ?? "allow";
}

export function mcpToolPolicyChoice(
  server: McpServerDefinition,
  name: string,
): McpToolPolicyChoice {
  return mcpToolSwitchState(server, name).checked ? mcpToolPolicy(server, name) : "block";
}

/**
 * Sets one tool to Allow, Ask or Block. A tool matching the server default keeps no
 * entry of its own, so changing the default moves it too. Every other field is kept.
 */
export function setMcpToolPolicy(
  server: McpServerDefinition,
  name: string,
  choice: McpToolPolicyChoice,
): McpServerDefinition {
  const next = setMcpToolEnabled(server, name, choice !== "block");
  const { [name]: _previous, ...others } = next.toolPolicy ?? {};
  const toolPolicy: Record<string, McpToolPolicy> =
    choice !== "block" && choice !== (next.defaultToolPolicy ?? "allow")
      ? { ...others, [name]: choice }
      : others;
  const { toolPolicy: _toolPolicy, disabledTools, ...rest } = next;
  return {
    ...rest,
    ...(disabledTools?.length ? { disabledTools } : {}),
    ...(Object.keys(toolPolicy).length ? { toolPolicy } : {}),
  } as McpServerDefinition;
}

/** Sets the policy for tools without their own entry; `allow` is stored as no field. */
export function setMcpDefaultToolPolicy(
  server: McpServerDefinition,
  policy: McpToolPolicy,
): McpServerDefinition {
  const { defaultToolPolicy: _previous, toolPolicy, ...rest } = server;
  // Entries that now equal the default are redundant.
  const kept = Object.entries(toolPolicy ?? {}).filter(([, value]) => value !== policy);
  return {
    ...rest,
    ...(policy === "ask" ? { defaultToolPolicy: policy } : {}),
    ...(kept.length ? { toolPolicy: Object.fromEntries(kept) } : {}),
  } as McpServerDefinition;
}
