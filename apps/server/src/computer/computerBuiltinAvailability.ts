import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { join } from "node:path";

const readSmallFile = async (path: string): Promise<string> => {
  const file = await open(path, "r");
  try {
    const buffer = Buffer.alloc(1024 * 1024 + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 1024 * 1024) throw new Error("Plugin manifest exceeds the size limit.");
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await file.close();
  }
};
export interface BuiltinAvailability {
  readonly available: false;
  readonly reason: string;
  readonly version?: string;
  readonly manifestHash?: string;
}

/** Read-only compatibility probe. A bundled plugin's presence is not certification,
 * and it never enables plugins or imports a user's global provider home. */
export async function probeComputerBuiltin(input: {
  provider: "claude" | "codex";
  platform: string;
  chatGptResources?: string;
  read?: (path: string) => Promise<string>;
}): Promise<BuiltinAvailability> {
  if (input.platform !== "darwin")
    return {
      available: false,
      reason: "Provider built-in computer control is unsupported on this platform",
    };
  if (input.provider === "claude")
    return {
      available: false,
      reason:
        "Claude's built-in computer use requires an interactive CLI session; the Agent SDK uses non-interactive mode",
    };
  const read = input.read ?? readSmallFile;
  const resources = input.chatGptResources ?? "/Applications/ChatGPT.app/Contents/Resources";
  try {
    const root = join(resources, "plugins", "openai-bundled", "plugins", "unified-computer-use");
    const [pluginBytes, mcpBytes] = await Promise.all([
      read(join(root, ".codex-plugin", "plugin.json")),
      read(join(root, ".mcp.json")),
    ]);
    const plugin = JSON.parse(pluginBytes) as { name?: unknown; version?: unknown };
    const mcp = JSON.parse(mcpBytes) as {
      mcpServers?: { cua_repl?: { enabled?: unknown; command?: unknown; args?: unknown } };
    };
    if (
      plugin.name !== "unified-computer-use" ||
      typeof plugin.version !== "string" ||
      !mcp.mcpServers?.cua_repl
    )
      throw new Error("Malformed bundled plugin.");
    const server = mcp.mcpServers.cua_repl;
    const placeholder =
      server.enabled === false ||
      (server.command === "node" && Array.isArray(server.args) && !server.args.length);
    return {
      available: false,
      version: plugin.version,
      manifestHash: createHash("sha256")
        .update(pluginBytes)
        .update("\0")
        .update(mcpBytes)
        .digest("hex"),
      reason: placeholder
        ? "The bundled computer-use plugin requires ChatGPT's runtime configuration; its launch and F5 veto/profile-isolation bridge are not certified"
        : "The installed computer-use plugin's F5 veto and profile isolation are not certified",
    };
  } catch (error) {
    return {
      available: false,
      reason:
        (error as NodeJS.ErrnoException).code === "ENOENT"
          ? "ChatGPT's bundled computer-use plugin is not installed"
          : "ChatGPT's bundled computer-use plugin could not be verified",
    };
  }
}
