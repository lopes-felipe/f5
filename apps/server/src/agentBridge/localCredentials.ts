/**
 * The local listener's connection file, `<stateDir>/agent-bridge/local.json`.
 * The STDIO shim reads it for every request. The token rotates on every
 * start and the file is removed when the listener stops.
 *
 * @module agentBridge/localCredentials
 */
import { randomUUID } from "node:crypto";
import * as FS from "node:fs/promises";
import * as Path from "node:path";

export interface AgentBridgeLocalCredentials {
  readonly port: number;
  readonly token: string;
  readonly startedAt: string;
  /** The F5 server process; the STDIO shim refuses to serve its descendants. */
  readonly serverPid?: number;
}

export const agentBridgeLocalCredentialsPath = (stateDir: string): string =>
  Path.join(stateDir, "agent-bridge", "local.json");

/**
 * Publishes only a fully written file: the temp file is created `wx` with mode
 * 0600, synced, then renamed over the destination (the ServerSecretStore pattern).
 */
export async function writeAgentBridgeLocalCredentials(
  filePath: string,
  credentials: AgentBridgeLocalCredentials,
): Promise<void> {
  await FS.mkdir(Path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tempPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    const handle = await FS.open(tempPath, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(credentials), "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await FS.chmod(tempPath, 0o600);
    await FS.rename(tempPath, filePath);
  } catch (cause) {
    await FS.rm(tempPath, { force: true }).catch(() => undefined);
    throw cause;
  }
}

/** Removes the file only while it still names this listener's token. */
export async function removeAgentBridgeLocalCredentials(
  filePath: string,
  token: string,
): Promise<void> {
  const current = await readAgentBridgeLocalCredentials(filePath);
  if (current !== null && current.token !== token) return;
  await FS.rm(filePath, { force: true });
}

export async function readAgentBridgeLocalCredentials(
  filePath: string,
): Promise<AgentBridgeLocalCredentials | null> {
  let text: string;
  try {
    text = await FS.readFile(filePath, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(text) as Partial<AgentBridgeLocalCredentials>;
    if (
      typeof parsed.port !== "number" ||
      !Number.isInteger(parsed.port) ||
      parsed.port <= 0 ||
      parsed.port > 65535 ||
      typeof parsed.token !== "string" ||
      parsed.token.length === 0 ||
      typeof parsed.startedAt !== "string"
    )
      return null;
    return {
      port: parsed.port,
      token: parsed.token,
      startedAt: parsed.startedAt,
      ...(typeof parsed.serverPid === "number" && Number.isInteger(parsed.serverPid)
        ? { serverPid: parsed.serverPid }
        : {}),
    };
  } catch {
    return null;
  }
}
