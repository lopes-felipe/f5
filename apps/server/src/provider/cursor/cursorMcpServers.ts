/**
 * MCP servers F5 passes to a Cursor session.
 *
 * Precedence: F5's automation servers (reserved names) first, then the
 * project's F5 MCP servers, served through F5's MCP hub so stdio servers work
 * too. Cursor's own `mcp.json` files are left to Cursor,
 * which applies its own approval to them; F5 never passes `--approve-mcps`
 * and never writes Cursor's config. Every omitted project server is reported
 * once, so a missing tool is never silent.
 */
import { constants as fsConstants } from "node:fs";
import * as nodeFs from "node:fs/promises";
import * as nodePath from "node:path";

import type { McpProjectServersConfig } from "@t3tools/contracts";
import { filterEnabledMcpServers } from "@t3tools/shared/mcpTranslation";
import type * as EffectAcpSchema from "effect-acp/schema";

import { hubEndpointsToAcpServers } from "../../mcp/hub/acpHubServers.ts";
import type { McpHubAttachment } from "../../mcp/hub/McpHub.ts";
import type { McpSessionStdioLaunch } from "../../mcp/sessionStdioShim.ts";

export interface CursorMcpOmission {
  readonly name: string;
  readonly reason: string;
}

export interface ResolvedCursorMcpServers {
  readonly servers: ReadonlyArray<EffectAcpSchema.McpServer>;
  readonly omitted: ReadonlyArray<CursorMcpOmission>;
  /** Project servers F5 passed and therefore owns; reattached in full on resume. */
  readonly ownedNames: ReadonlyArray<string>;
  /** Revokes hub endpoints issued for this session. */
  readonly dispose?: () => Promise<void>;
}

const RESERVED_PREFIX = "f5_";

export function resolveCursorMcpServers(input: {
  readonly automationServers: ReadonlyArray<EffectAcpSchema.McpServer>;
  readonly projectServers: McpProjectServersConfig | null | undefined;
  /** Server names already defined in Cursor's own user or project `mcp.json`. */
  readonly cursorConfigNames: ReadonlySet<string>;
  readonly capabilities: { readonly http: boolean; readonly sse: boolean };
  /**
   * F5's MCP hub, which serves project servers (stdio included) as endpoints.
   * Without it no project server reaches Cursor, and each is reported omitted.
   */
  readonly attachHub?: (servers: McpProjectServersConfig) => McpHubAttachment;
  readonly stdioLaunch?: McpSessionStdioLaunch | undefined;
}): ResolvedCursorMcpServers {
  const servers: EffectAcpSchema.McpServer[] = [...input.automationServers];
  const reserved = new Set(input.automationServers.map((server) => server.name));
  const omitted: CursorMcpOmission[] = [];
  const ownedNames: string[] = [];
  const forHub: Record<string, McpProjectServersConfig[string]> = {};
  for (const [name, definition] of Object.entries(
    filterEnabledMcpServers(input.projectServers, "cursor"),
  )) {
    if (reserved.has(name) || name.toLowerCase().startsWith(RESERVED_PREFIX)) {
      omitted.push({ name, reason: "uses a name reserved for F5's own tools" });
      continue;
    }
    if (input.cursorConfigNames.has(name)) {
      omitted.push({
        name,
        reason: "is already defined in Cursor's mcp.json, which Cursor applies",
      });
      continue;
    }
    if (!input.attachHub) {
      omitted.push({ name, reason: "needs F5's MCP hub, which is unavailable in this runtime" });
      continue;
    }
    forHub[name] = definition;
  }
  if (!input.attachHub || Object.keys(forHub).length === 0) return { servers, omitted, ownedNames };
  const attachment = input.attachHub(forHub);
  const translated = hubEndpointsToAcpServers(attachment.endpoints, {
    http: input.capabilities.http,
    stdioLaunch: input.stdioLaunch,
  });
  servers.push(...translated.servers);
  ownedNames.push(...translated.servers.map((server) => server.name));
  for (const entry of [...attachment.omitted, ...translated.omitted])
    omitted.push({
      name: entry.serverName,
      reason:
        entry.reason === "needs HTTP MCP, which this agent does not offer"
          ? "needs HTTP MCP, which this Cursor CLI does not offer"
          : entry.reason,
    });
  return { servers, omitted, ownedNames, dispose: attachment.dispose };
}

/**
 * Values a forwarded project server carries that must never reach logs or
 * durable diagnostics: every header value, URL userinfo, and the query and
 * fragment (as a whole and per value), plus the raw URL when it has any of
 * those. Header values and per-parameter values shorter than 8 characters are
 * left to the structural redactors, so ordinary words are not masked
 * everywhere; the raw URL and its query string are always registered.
 */
export function cursorMcpServerSecrets(
  servers: ReadonlyArray<EffectAcpSchema.McpServer>,
  ownedNames: ReadonlyArray<string>,
): ReadonlyArray<string> {
  const owned = new Set(ownedNames);
  const secrets = new Set<string>();
  const add = (value: string, minimum = 8) => {
    if (value.length >= minimum) secrets.add(value);
  };
  for (const server of servers) {
    // Only remote (http/sse) servers are forwarded; stdio entries have no URL.
    if (!owned.has(server.name) || !("url" in server)) continue;
    for (const header of server.headers) {
      // An authentication header is an explicit credential however short; other header
      // values keep the length threshold.
      const minimum = /^(proxy-)?authorization$/i.test(header.name) ? 1 : 8;
      add(header.value, minimum);
      // An agent can echo just the token of `<scheme> <token>` (`Bearer abc…`).
      const token = /^[A-Za-z][\w.-]*\s+(\S.*)$/.exec(header.value)?.[1];
      if (token) add(token, minimum);
    }
    try {
      const url = new URL(server.url);
      const sensitive = Boolean(url.username || url.password || url.search || url.hash);
      if (sensitive) add(server.url, 1);
      if (url.search) add(url.search, 2);
      if (url.hash) add(url.hash, 2);
      if (url.username) add(decodeURIComponent(url.username), 4);
      if (url.password) add(decodeURIComponent(url.password), 4);
      for (const value of url.searchParams.values()) add(value);
    } catch {
      add(server.url, 1);
    }
  }
  return [...secrets];
}

export function describeCursorMcpOmissions(
  omitted: ReadonlyArray<CursorMcpOmission>,
): { readonly summary: string; readonly details: string } | undefined {
  if (omitted.length === 0) return undefined;
  return {
    summary:
      omitted.length === 1
        ? `F5 did not pass MCP server ${omitted[0]!.name} to Cursor.`
        : `F5 did not pass ${omitted.length} MCP servers to Cursor.`,
    details: omitted.map((entry) => `${entry.name} ${entry.reason}.`).join("\n"),
  };
}

const MAX_CURSOR_MCP_CONFIG_BYTES = 1_000_000;

/**
 * Reads server names from one `mcp.json`. Only a regular file within the size
 * limit is read, through a non-blocking open, so a FIFO, device or oversized
 * file cannot stall or exhaust a session start.
 */
async function readServerNames(file: string): Promise<ReadonlyArray<string>> {
  let handle: nodeFs.FileHandle | undefined;
  try {
    handle = await nodeFs.open(file, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_CURSOR_MCP_CONFIG_BYTES) return [];
    const buffer = Buffer.alloc(stat.size);
    const { bytesRead } = await handle.read(buffer, 0, stat.size, 0);
    const parsed = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8")) as {
      mcpServers?: unknown;
    };
    return parsed.mcpServers && typeof parsed.mcpServers === "object"
      ? Object.keys(parsed.mcpServers)
      : [];
  } catch {
    return [];
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** Names in Cursor's user (`~/.cursor/mcp.json`) and project (`.cursor/mcp.json`) config. */
export async function readCursorMcpConfigNames(input: {
  readonly configDir: string;
  readonly cwd: string;
}): Promise<ReadonlySet<string>> {
  const [user, project] = await Promise.all([
    readServerNames(nodePath.join(input.configDir, "mcp.json")),
    readServerNames(nodePath.join(input.cwd, ".cursor", "mcp.json")),
  ]);
  return new Set([...user, ...project]);
}
