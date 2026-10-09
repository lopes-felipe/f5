import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { join } from "node:path";

async function readBoundedPluginFile(path: string): Promise<string> {
  const file = await open(path, "r");
  try {
    const buffer = Buffer.alloc(1024 * 1024 + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 1024 * 1024) throw new Error("Plugin manifest exceeds the size limit.");
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await file.close();
  }
}

export interface CodexBundledRuntimeReadiness {
  readonly available: false;
  readonly state:
    | "unsupported-platform"
    | "not-installed"
    | "unreadable"
    | "host-managed"
    | "uncertified";
  readonly reason: string;
  readonly version?: string;
  readonly manifestHash?: string;
}

/** A manifest is not a launch contract. This observes only bundled metadata and
 * never enables a plugin, starts a runtime, or imports the global Codex home. */
export async function probeCodexBundledRuntime(input: {
  capability: "computer" | "chrome";
  platform: string;
  chatGptResources?: string;
  read?: (path: string) => Promise<string>;
}): Promise<CodexBundledRuntimeReadiness> {
  if (input.platform !== "darwin")
    return {
      available: false,
      state: "unsupported-platform",
      reason: "Provider built-in computer/browser control is unsupported on this platform",
    };
  const read = input.read ?? readBoundedPluginFile;
  const name = input.capability === "computer" ? "unified-computer-use" : "chrome";
  const root = join(
    input.chatGptResources ?? "/Applications/ChatGPT.app/Contents/Resources",
    "plugins",
    "openai-bundled",
    "plugins",
    name,
  );
  let pluginBytes: string;
  try {
    pluginBytes = await read(join(root, ".codex-plugin", "plugin.json"));
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
    return {
      available: false,
      state: missing ? "not-installed" : "unreadable",
      reason: missing
        ? `ChatGPT's bundled ${name} plugin is not installed`
        : `ChatGPT's bundled ${name} plugin could not be verified`,
    };
  }
  try {
    const plugin = JSON.parse(pluginBytes) as {
      name?: unknown;
      version?: unknown;
      mcpServers?: unknown;
    };
    if (plugin.name !== name || typeof plugin.version !== "string")
      throw new Error("Malformed bundled plugin.");
    let mcpBytes: string | undefined;
    try {
      mcpBytes = await read(join(root, ".mcp.json"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // A declared missing file is a broken installation, not a host-managed runtime.
      if (plugin.mcpServers !== undefined) throw error;
    }
    const metadata = {
      version: plugin.version,
      manifestHash: createHash("sha256")
        .update(pluginBytes)
        .update("\0")
        .update(mcpBytes ?? "")
        .digest("hex"),
    };
    if (mcpBytes === undefined)
      return {
        ...metadata,
        available: false,
        state: "host-managed",
        reason: `The bundled ${name} plugin has no standalone MCP launch metadata; it requires a host-provided runtime`,
      };
    const mcp = JSON.parse(mcpBytes) as {
      mcpServers?: Record<string, { enabled?: unknown; command?: unknown; args?: unknown }>;
    };
    const server = mcp.mcpServers?.[input.capability === "computer" ? "cua_repl" : "node_repl"];
    if (!server || typeof server.command !== "string" || !Array.isArray(server.args))
      throw new Error("Malformed bundled MCP configuration.");
    const placeholder = server.enabled === false || !server.args.length;
    return {
      ...metadata,
      available: false,
      state: placeholder ? "host-managed" : "uncertified",
      reason: placeholder
        ? `The bundled ${name} plugin requires ChatGPT's runtime configuration; its launch and F5 veto/profile-isolation bridge are not certified`
        : `The installed ${name} plugin's F5 veto and profile isolation are not certified`,
    };
  } catch {
    return {
      available: false,
      state: "unreadable",
      reason: `ChatGPT's bundled ${name} plugin could not be verified`,
    };
  }
}
