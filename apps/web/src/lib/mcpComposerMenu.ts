import type {
  McpComposerServerPrompts,
  McpComposerServerResources,
  McpReadComposerResourceResult,
} from "@t3tools/contracts";
import type { McpResourceContextPart } from "@t3tools/shared/mcpComposer";
import type { ComposerCommandItem } from "../components/chat/ComposerCommandMenu";

/** Most MCP entries one menu shows; typing narrows the rest. */
export const MCP_MENU_ITEM_LIMIT = 50;

type McpPromptItem = Extract<ComposerCommandItem, { type: "mcp-prompt" }>;
type McpResourceItem = Extract<ComposerCommandItem, { type: "mcp-resource" }>;

function matches(query: string, ...fields: ReadonlyArray<string | undefined>): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return fields.some((field) => field?.toLowerCase().includes(needle));
}

/** `/<server>:<prompt>` entries for the command menu, under "MCP prompts". */
export function mcpPromptMenuItems(
  servers: ReadonlyArray<McpComposerServerPrompts> | undefined,
  query: string,
): McpPromptItem[] {
  const items: McpPromptItem[] = [];
  for (const server of servers ?? []) {
    for (const prompt of server.prompts) {
      const command = `${server.serverName}:${prompt.name}`;
      if (!matches(query, command, prompt.title)) continue;
      const needsInput = prompt.arguments.length > 0;
      const summary = prompt.title || prompt.description || "MCP prompt";
      items.push({
        id: `mcp-prompt:${server.serverName}:${prompt.name}`,
        type: "mcp-prompt",
        serverName: server.serverName,
        prompt,
        label: `/${command}`,
        description: needsInput ? `${summary} (asks for input)` : summary,
      });
      if (items.length === MCP_MENU_ITEM_LIMIT) return items;
    }
  }
  return items;
}

/** Resources for the `@` menu, matched on name, title, URI and server. */
export function mcpResourceMenuItems(
  servers: ReadonlyArray<McpComposerServerResources> | undefined,
  query: string,
): McpResourceItem[] {
  const items: McpResourceItem[] = [];
  for (const server of servers ?? []) {
    for (const resource of server.resources) {
      if (!matches(query, resource.name, resource.title, resource.uri, server.serverName)) continue;
      items.push({
        id: `mcp-resource:${server.serverName}:${resource.uri}`,
        type: "mcp-resource",
        serverName: server.serverName,
        resource,
        label: resource.title || resource.name || resource.uri,
        description: `${server.serverName} · ${resource.uri}`,
      });
      if (items.length === MCP_MENU_ITEM_LIMIT) return items;
    }
  }
  return items;
}

/** Images are attached through the image path as soon as they are chosen. */
export function isMcpImageResource(item: McpResourceItem): boolean {
  return item.resource.mimeType?.toLowerCase().startsWith("image/") ?? false;
}

/** Turns a resource's images into files for the composer's image attachments. */
export function mcpResourceImageFiles(
  read: McpReadComposerResourceResult,
  fallbackName: string,
): File[] {
  const images = read.contents.filter((content) => content.kind === "image");
  return images.map((content, index) => {
    const binary = atob(content.data);
    const bytes = new Uint8Array(binary.length);
    for (let offset = 0; offset < binary.length; offset += 1)
      bytes[offset] = binary.charCodeAt(offset);
    const extension = content.mimeType.split("/")[1] ?? "png";
    const base = (content.uri.split(/[/\\]/).pop() || fallbackName).replace(/[^\w.-]+/g, "_");
    const name = /\.\w+$/.test(base)
      ? base
      : `${base || "resource"}${index > 0 ? `-${index}` : ""}.${extension}`;
    return new File([bytes], name, { type: content.mimeType });
  });
}

/** The text parts of one read, for the context appended on send; images there are counted. */
export function mcpResourceTextParts(
  serverName: string,
  read: McpReadComposerResourceResult,
): { parts: McpResourceContextPart[]; omitted: number } {
  const parts: McpResourceContextPart[] = [];
  let omitted = read.omitted;
  for (const content of read.contents) {
    if (content.kind === "text")
      parts.push({
        serverName,
        uri: content.uri,
        mimeType: content.mimeType,
        text: content.text,
        truncated: content.truncated,
      });
    else omitted += 1;
  }
  return { parts, omitted };
}
