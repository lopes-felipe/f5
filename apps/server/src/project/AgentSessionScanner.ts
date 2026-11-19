import { constants } from "node:fs";
import { open, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import type {
  AgentSessionProjectCandidate,
  AgentSessionScanResult,
  AgentSessionSource,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { parseAgentSessionTranscript } from "./agentSessionTranscript";
import { isUuid } from "../provider/claudeResumeState";

export interface AgentSessionHome {
  readonly provider: AgentSessionSource;
  readonly instanceId: ProviderInstanceId;
  readonly home: string;
}
interface Transcript {
  root: string;
  rootRelative: string;
  file: string;
  size: number;
  mtimeMs: number;
  source: AgentSessionHome;
  sessionId: string;
}
export interface SessionCandidate {
  summary: AgentSessionProjectCandidate;
  transcripts: Transcript[];
}
const id = (value: string) => createHash("sha256").update(value).digest("hex");
const inside = (root: string, value: string) => {
  const relative = path.relative(root, value);
  return (
    relative === "" ||
    (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative))
  );
};
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

function metadata(text: string, provider: AgentSessionSource, fallback: string) {
  for (const line of text.split("\n", 1000)) {
    try {
      const raw = record(JSON.parse(line));
      if (!raw || raw.isSidechain === true) continue;
      const payload = record(raw.payload);
      const cwd = typeof raw.cwd === "string" ? raw.cwd : payload?.cwd;
      const sessionId =
        provider === "codex"
          ? (payload?.id ?? payload?.session_id)
          : isUuid(fallback)
            ? fallback
            : raw.sessionId;
      if (
        typeof cwd === "string" &&
        path.isAbsolute(cwd) &&
        typeof sessionId === "string" &&
        isUuid(sessionId)
      )
        return { cwd, sessionId };
    } catch {
      /* JSONL can end with a partial record while the CLI is writing. */
    }
  }
  return undefined;
}

async function readBounded(file: string, maximum: number, expected?: Transcript) {
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > 16 * 1024 * 1024)
      throw new Error("Session transcript is too large.");
    if (expected && (info.size !== expected.size || info.mtimeMs !== expected.mtimeMs))
      throw new Error("The CLI session changed. Scan for projects again.");
    const buffer = Buffer.alloc(Math.min(maximum, info.size));
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (after.size !== info.size || after.mtimeMs !== info.mtimeMs)
      throw new Error("The CLI session changed. Scan for projects again.");
    return { text: buffer.subarray(0, offset).toString("utf8"), info };
  } finally {
    await handle.close();
  }
}

/** The cache is per backend/profile. Clients never provide transcript paths. */
export class AgentSessionScanner {
  private candidates = new Map<string, SessionCandidate>();
  private scannedAt = 0;

  get(candidateId: string, expectedRoot: string): SessionCandidate {
    const candidate = this.candidates.get(candidateId);
    if (
      !candidate ||
      Date.now() - this.scannedAt > 10 * 60_000 ||
      candidate.summary.path !== expectedRoot
    )
      throw new Error("Scan for projects again before importing this history.");
    return candidate;
  }

  async scan(
    homes: ReadonlyArray<AgentSessionHome>,
    existingPaths: ReadonlyArray<string>,
    worktreesDir: string,
    signal: AbortSignal,
  ): Promise<AgentSessionScanResult> {
    let operations = 0;
    let bytes = 0;
    let truncated = false;
    const files: Array<{
      file: string;
      root: string;
      rootRelative: string;
      source: AgentSessionHome;
      size: number;
      mtimeMs: number;
    }> = [];
    const roots = new Set<string>();
    for (const source of homes) {
      for (const relative of source.provider === "codex"
        ? ["sessions", "archived_sessions"]
        : ["projects"]) {
        let root: string;
        try {
          root = await realpath(path.join(source.home, relative));
        } catch {
          continue;
        }
        const rootKey = source.provider + ":" + root;
        if (roots.has(rootKey)) continue;
        roots.add(rootKey);
        const walk = async (directory: string, depth: number): Promise<void> => {
          signal.throwIfAborted();
          if (++operations > 20_000) {
            truncated = true;
            return;
          }
          let entries;
          try {
            entries = await readdir(directory, { withFileTypes: true });
          } catch {
            return;
          }
          for (const entry of entries.toSorted((a, b) => b.name.localeCompare(a.name))) {
            signal.throwIfAborted();
            if (++operations > 20_000) {
              truncated = true;
              return;
            }
            if (
              entry.isSymbolicLink() ||
              ["subagents", ".git", "node_modules"].includes(entry.name)
            )
              continue;
            const file = path.join(directory, entry.name);
            if (entry.isDirectory() && depth < 5) await walk(file, depth + 1);
            else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
              try {
                const info = await stat(file);
                if (info.size <= 16 * 1024 * 1024)
                  files.push({
                    file,
                    root,
                    rootRelative: relative,
                    source,
                    size: info.size,
                    mtimeMs: info.mtimeMs,
                  });
                else truncated = true;
              } catch {
                /* A removed session is no longer discoverable. */
              }
            }
          }
        };
        await walk(root, 0);
      }
    }
    const candidates = new Map<string, SessionCandidate>();
    const sessions = new Set<string>();
    const existing = new Set(
      await Promise.all(existingPaths.map((value) => realpath(value).catch(() => value))),
    );
    const excluded = await realpath(worktreesDir).catch(() => worktreesDir);
    for (const file of files.toSorted((a, b) => b.mtimeMs - a.mtimeMs).slice(0, 5000)) {
      signal.throwIfAborted();
      if (bytes >= 64 * 1024 * 1024) {
        truncated = true;
        break;
      }
      try {
        const { text } = await readBounded(file.file, 128 * 1024);
        bytes += Buffer.byteLength(text);
        const meta = metadata(text, file.source.provider, path.basename(file.file, ".jsonl"));
        if (!meta) continue;
        const cwd = await realpath(meta.cwd);
        if (
          !(await stat(cwd)).isDirectory() ||
          inside(excluded, cwd) ||
          /[\\/]\.(?:t3|f5)[\\/]worktrees[\\/]/i.test(cwd)
        )
          continue;
        const sessionKey = file.source.provider + ":" + file.source.home + ":" + meta.sessionId;
        if (sessions.has(sessionKey)) continue;
        sessions.add(sessionKey);
        const candidateId = id(cwd);
        const transcript = { ...file, sessionId: meta.sessionId };
        let candidate = candidates.get(candidateId);
        if (!candidate) {
          candidate = {
            summary: {
              id: candidateId,
              path: cwd,
              title: path.basename(cwd).trim() || "Imported project",
              sources: [],
              threadCount: 0,
              lastActiveAt: new Date(file.mtimeMs).toISOString(),
              alreadyImported: existing.has(cwd),
            },
            transcripts: [],
          };
          candidates.set(candidateId, candidate);
        }
        if (!candidate.summary.sources.includes(file.source.provider))
          candidate.summary = {
            ...candidate.summary,
            sources: [...candidate.summary.sources, file.source.provider],
          };
        // Project discovery includes old history; thread import is recent and bounded.
        if (file.mtimeMs >= Date.now() - 30 * 24 * 60 * 60_000) {
          candidate.transcripts.push(transcript);
          candidate.summary = { ...candidate.summary, threadCount: candidate.transcripts.length };
        }
      } catch {
        /* An unreadable/malformed source cannot prevent other projects from appearing. */
      }
    }
    if (files.length > 5000) truncated = true;
    signal.throwIfAborted();
    this.candidates = candidates;
    this.scannedAt = Date.now();
    return {
      candidates: [...candidates.values()].map((entry) => entry.summary),
      scannedAt: new Date(this.scannedAt).toISOString(),
      truncated,
    };
  }

  async read(transcript: Transcript, expectedRoot: string, signal: AbortSignal) {
    signal.throwIfAborted();
    if ((await realpath(transcript.file)) !== transcript.file)
      throw new Error("The session path changed. Scan for projects again.");
    if (
      (await realpath(path.join(transcript.source.home, transcript.rootRelative))) !==
      transcript.root
    )
      throw new Error("The agent home changed. Scan for projects again.");
    const { text } = await readBounded(transcript.file, 16 * 1024 * 1024, transcript);
    const meta = metadata(text, transcript.source.provider, transcript.sessionId);
    if (
      !meta ||
      (await realpath(meta.cwd)) !== expectedRoot ||
      meta.sessionId !== transcript.sessionId
    )
      throw new Error("The session's project changed. Scan for projects again.");
    signal.throwIfAborted();
    return parseAgentSessionTranscript({
      contents: text,
      source: transcript.source.provider,
      providerInstanceId: transcript.source.instanceId,
      fallbackSessionId: transcript.sessionId,
      lastActiveAtMs: transcript.mtimeMs,
    });
  }
}
