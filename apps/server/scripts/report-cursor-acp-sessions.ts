/**
 * Read-only report of Cursor CLI ACP sessions on this machine.
 *
 * Counts `~/.cursor/acp-sessions/<id>` by workspace (`meta.json` cwd) and
 * age, and whether each also has a chat store under `chats/<md5(cwd)>/<id>`.
 * Sessions with no chat store are metadata-only leftovers of `session/new`.
 *
 * It never deletes anything: F5 removes only sessions it created and
 * recorded. Usage: `bun scripts/report-cursor-acp-sessions.ts [--json]`.
 */
import * as nodeFs from "node:fs/promises";
import * as nodePath from "node:path";

import {
  cursorChatsWorkspaceKey,
  cursorConfigDir,
} from "../src/provider/cursor/CursorNativeSessions";

interface WorkspaceSummary {
  cwd: string;
  sessions: number;
  metadataOnly: number;
  olderThan30Days: number;
  oldestMs: number;
  newestMs: number;
}

const DAY_MS = 86_400_000;
const CONCURRENCY = 64;

async function readSession(configDir: string, sessionId: string, now: number) {
  const directory = nodePath.join(configDir, "acp-sessions", sessionId);
  const stat = await nodeFs.lstat(directory).catch(() => undefined);
  if (!stat?.isDirectory()) return undefined;
  const meta = await nodeFs
    .readFile(nodePath.join(directory, "meta.json"), "utf8")
    .then((text) => JSON.parse(text) as { cwd?: unknown })
    .catch(() => undefined);
  const cwd = typeof meta?.cwd === "string" ? meta.cwd : "(unknown)";
  const chatStore =
    cwd === "(unknown)"
      ? undefined
      : await nodeFs
          .lstat(nodePath.join(configDir, "chats", cursorChatsWorkspaceKey(cwd), sessionId))
          .catch(() => undefined);
  return {
    cwd,
    mtimeMs: stat.mtimeMs,
    metadataOnly: !chatStore?.isDirectory(),
    old: now - stat.mtimeMs > 30 * DAY_MS,
  };
}

async function main() {
  const json = process.argv.includes("--json");
  const configDir = cursorConfigDir();
  const now = Date.now();
  const ids = await nodeFs.readdir(nodePath.join(configDir, "acp-sessions")).catch(() => []);
  const byCwd = new Map<string, WorkspaceSummary>();
  let index = 0;
  const worker = async () => {
    while (index < ids.length) {
      const id = ids[index++]!;
      const session = await readSession(configDir, id, now);
      if (!session) continue;
      const summary = byCwd.get(session.cwd) ?? {
        cwd: session.cwd,
        sessions: 0,
        metadataOnly: 0,
        olderThan30Days: 0,
        oldestMs: session.mtimeMs,
        newestMs: session.mtimeMs,
      };
      summary.sessions++;
      if (session.metadataOnly) summary.metadataOnly++;
      if (session.old) summary.olderThan30Days++;
      summary.oldestMs = Math.min(summary.oldestMs, session.mtimeMs);
      summary.newestMs = Math.max(summary.newestMs, session.mtimeMs);
      byCwd.set(session.cwd, summary);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  const rows = [...byCwd.values()].toSorted((a, b) => b.sessions - a.sessions);
  if (json) {
    console.log(JSON.stringify({ configDir, total: ids.length, workspaces: rows }, null, 2));
    return;
  }
  console.log(`Cursor ACP sessions in ${configDir}: ${ids.length}`);
  console.log("sessions  metadata-only  >30d  oldest      newest      cwd");
  for (const row of rows) {
    const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
    console.log(
      `${String(row.sessions).padStart(8)}  ${String(row.metadataOnly).padStart(13)}  ${String(
        row.olderThan30Days,
      ).padStart(4)}  ${day(row.oldestMs)}  ${day(row.newestMs)}  ${row.cwd}`,
    );
  }
  console.log("\nNothing was deleted.");
}

await main();
