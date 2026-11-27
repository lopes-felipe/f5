/**
 * MCP prompts and resources for the composer: read from the hub servers a
 * conversation's session uses, and shaped into text the user reviews before
 * sending. Nothing here runs a tool or sends a message.
 */
import type {
  GetPromptResult,
  Prompt,
  ReadResourceResult,
  Resource,
} from "@modelcontextprotocol/sdk/types.js";
import {
  MCP_COMPOSER_RESOURCE_LIMIT,
  MCP_COMPOSER_RESOURCE_TEXT_BYTES,
  type McpComposerPrompt,
  type McpComposerResource,
  type McpComposerResourceContent,
  type McpComposerServerPrompts,
  type McpComposerServerResources,
  type McpGetComposerPromptResult,
  type McpReadComposerResourceResult,
} from "@t3tools/contracts";
import { markdownFence, mcpComposerImageMimeType, truncateUtf8 } from "@t3tools/shared/mcpComposer";

import type { McpHubComposerServer } from "./McpHub.ts";

/** A slow server must not hold up the menu for the others. */
export const MCP_COMPOSER_LIST_TIMEOUT_MS = 15_000;
/** Prompts listed per server; more pages than this are ignored. */
const PROMPT_LIMIT = 200;
const MAX_PAGES = 20;
/** Images larger than this (as base64) are left out rather than sent over the socket. */
const MAX_IMAGE_BASE64_LENGTH = 14 * 1024 * 1024;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function listSignal(signal: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(MCP_COMPOSER_LIST_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function toComposerPrompt(prompt: Prompt): McpComposerPrompt | undefined {
  const name = prompt.name.trim();
  if (!name) return undefined;
  return {
    name,
    ...(prompt.title ? { title: prompt.title } : {}),
    ...(prompt.description ? { description: prompt.description } : {}),
    arguments: (prompt.arguments ?? []).flatMap((argument) => {
      const argumentName = argument.name.trim();
      if (!argumentName) return [];
      return [
        {
          name: argumentName,
          ...(argument.description ? { description: argument.description } : {}),
          ...(argument.required !== undefined ? { required: argument.required } : {}),
        },
      ];
    }),
  };
}

function toComposerResource(resource: Resource): McpComposerResource | undefined {
  const uri = resource.uri.trim();
  if (!uri) return undefined;
  return {
    uri,
    name: resource.name,
    ...(resource.title ? { title: resource.title } : {}),
    ...(resource.description ? { description: resource.description } : {}),
    ...(resource.mimeType ? { mimeType: resource.mimeType } : {}),
  };
}

async function eachServer<T>(
  servers: ReadonlyMap<string, McpHubComposerServer>,
  run: (serverName: string, server: McpHubComposerServer) => Promise<T>,
): Promise<T[]> {
  const names = [...servers.keys()].toSorted((left, right) => left.localeCompare(right));
  return Promise.all(names.map((serverName) => run(serverName, servers.get(serverName)!)));
}

export async function listComposerPrompts(
  servers: ReadonlyMap<string, McpHubComposerServer>,
  signal?: AbortSignal,
): Promise<McpComposerServerPrompts[]> {
  return eachServer(servers, async (serverName, server) => {
    const prompts: McpComposerPrompt[] = [];
    try {
      const pageSignal = listSignal(signal);
      let cursor: string | undefined;
      for (let page = 0; page < MAX_PAGES && prompts.length < PROMPT_LIMIT; page += 1) {
        const result = await server.listPrompts(cursor ? { cursor } : undefined, pageSignal);
        for (const prompt of result.prompts) {
          const entry = toComposerPrompt(prompt);
          if (entry && prompts.length < PROMPT_LIMIT) prompts.push(entry);
        }
        cursor = result.nextCursor;
        if (!cursor) break;
      }
      return { serverName, prompts };
    } catch (error) {
      return { serverName, prompts, error: messageOf(error) };
    }
  });
}

export async function listComposerResources(
  servers: ReadonlyMap<string, McpHubComposerServer>,
  signal?: AbortSignal,
): Promise<McpComposerServerResources[]> {
  return eachServer(servers, async (serverName, server) => {
    const resources: McpComposerResource[] = [];
    let truncated = false;
    try {
      const pageSignal = listSignal(signal);
      let cursor: string | undefined;
      let page = 0;
      do {
        const result = await server.listResources(cursor ? { cursor } : undefined, pageSignal);
        for (const resource of result.resources) {
          const entry = toComposerResource(resource);
          if (!entry) continue;
          if (resources.length === MCP_COMPOSER_RESOURCE_LIMIT) truncated = true;
          else resources.push(entry);
        }
        cursor = result.nextCursor;
        page += 1;
      } while (
        cursor &&
        !truncated &&
        resources.length < MCP_COMPOSER_RESOURCE_LIMIT &&
        page < MAX_PAGES
      );
      // A further page that was never read may hold more.
      if (cursor) truncated = true;
      return { serverName, resources, truncated };
    } catch (error) {
      return { serverName, resources, truncated, error: messageOf(error) };
    }
  });
}

function fenced(label: string, text: string): string {
  const fence = markdownFence(text);
  return `${label}\n${fence}\n${text}\n${fence}`;
}

/** A prompt's messages as composer text; images, audio and binary resources are counted, not kept. */
export function flattenPrompt(result: GetPromptResult): McpGetComposerPromptResult {
  const parts: string[] = [];
  let omitted = 0;
  for (const message of result.messages) {
    const content = message.content;
    switch (content.type) {
      case "text":
        if (content.text) parts.push(content.text);
        break;
      case "resource":
        if ("text" in content.resource && typeof content.resource.text === "string")
          parts.push(fenced(content.resource.uri, content.resource.text));
        else omitted += 1;
        break;
      case "resource_link":
        parts.push(`[${content.name || content.uri}](${content.uri})`);
        break;
      default:
        omitted += 1;
    }
  }
  return { text: parts.join("\n\n"), omitted };
}

/**
 * A resource's contents for one message: text up to the shared budget, images for
 * the attachment path, and a count of other binary parts that were left out.
 */
export function shapeResourceContents(
  result: ReadResourceResult,
  textBudgetBytes: number = MCP_COMPOSER_RESOURCE_TEXT_BYTES,
): McpReadComposerResourceResult {
  const contents: McpComposerResourceContent[] = [];
  let omitted = 0;
  let remaining = textBudgetBytes;
  for (const item of result.contents) {
    if ("text" in item && typeof item.text === "string") {
      const cut = truncateUtf8(item.text, remaining);
      remaining -= new TextEncoder().encode(cut.text).length;
      contents.push({
        kind: "text",
        uri: item.uri,
        ...(item.mimeType ? { mimeType: item.mimeType } : {}),
        text: cut.text,
        truncated: cut.truncated,
      });
      continue;
    }
    const blob = "blob" in item && typeof item.blob === "string" ? item.blob : undefined;
    // Same normalization as the composer menu, so a type with parameters is still an image.
    const mimeType = mcpComposerImageMimeType(item.mimeType);
    if (blob && mimeType && blob.length <= MAX_IMAGE_BASE64_LENGTH) {
      contents.push({ kind: "image", uri: item.uri, mimeType, data: blob });
      continue;
    }
    omitted += 1;
  }
  return { contents, omitted };
}
