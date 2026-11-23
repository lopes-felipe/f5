import * as nodeFs from "node:fs/promises";
import * as nodeOs from "node:os";
import * as nodePath from "node:path";

import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import {
  cursorAcpSessionPaths,
  cursorChatsWorkspaceKey,
  deleteCursorAcpSession,
} from "./CursorNativeSessions.ts";

const roots: string[] = [];

async function makeStore() {
  const root = await nodeFs.realpath(
    await nodeFs.mkdtemp(nodePath.join(nodeOs.tmpdir(), "cursor-native-sessions-")),
  );
  roots.push(root);
  return root;
}

async function seedSession(configDir: string, sessionId: string, cwd: string) {
  const meta = nodePath.join(configDir, "acp-sessions", sessionId);
  const chats = nodePath.join(configDir, "chats", cursorChatsWorkspaceKey(cwd), sessionId);
  await nodeFs.mkdir(meta, { recursive: true });
  await nodeFs.mkdir(chats, { recursive: true });
  await nodeFs.writeFile(nodePath.join(meta, "meta.json"), JSON.stringify({ cwd }));
  await nodeFs.writeFile(nodePath.join(chats, "store.db"), "");
  return { meta, chats };
}

/** A directory link: a junction on Windows (no symlink privilege needed), a symlink elsewhere. */
const linkDirectory = (target: string, path: string) => nodeFs.symlink(target, path, "junction");

const exists = (target: string) =>
  nodeFs.lstat(target).then(
    () => true,
    () => false,
  );

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => nodeFs.rm(root, { recursive: true })));
});

describe("CursorNativeSessions", () => {
  it("derives the chat store key from the workspace path", () => {
    expect(cursorChatsWorkspaceKey("/Users/example/dev/project")).toMatch(/^[0-9a-f]{32}$/);
    expect(cursorAcpSessionPaths({ configDir: "/c", sessionId: "../escape", cwd: "/w" })).toEqual(
      [],
    );
  });

  it("deletes only the recorded paths of one session", async () => {
    const configDir = await makeStore();
    // The CLI hashes the resolved workspace path (a drive-letter path on Windows).
    const cwd = nodePath.resolve("/work/project");
    const owned = await seedSession(configDir, "owned-1", cwd);
    const other = await seedSession(configDir, "other-2", cwd);

    const removed = await Effect.runPromise(
      deleteCursorAcpSession({ configDir, sessionId: "owned-1", cwd }),
    );

    expect(removed).toBe(2);
    expect(await exists(owned.meta)).toBe(false);
    expect(await exists(owned.chats)).toBe(false);
    expect(await exists(other.meta)).toBe(true);
    expect(await exists(other.chats)).toBe(true);
  });

  it("refuses to follow a symlinked session directory", async () => {
    const configDir = await makeStore();
    const outside = await makeStore();
    const victim = nodePath.join(outside, "keep.txt");
    await nodeFs.writeFile(victim, "keep");
    await nodeFs.mkdir(nodePath.join(configDir, "acp-sessions"), { recursive: true });
    await linkDirectory(outside, nodePath.join(configDir, "acp-sessions", "linked-1"));

    const removed = await Effect.runPromise(
      deleteCursorAcpSession({ configDir, sessionId: "linked-1", cwd: "/work" }),
    );

    expect(removed).toBe(0);
    expect(await exists(victim)).toBe(true);
  });

  it("refuses a symlinked directory between the store root and the session", async () => {
    const configDir = await makeStore();
    const outside = await makeStore();
    const victim = nodePath.join(outside, "linked-1");
    await nodeFs.mkdir(victim);
    await nodeFs.writeFile(nodePath.join(victim, "keep.txt"), "keep");
    await linkDirectory(outside, nodePath.join(configDir, "acp-sessions"));

    const removed = await Effect.runPromise(
      deleteCursorAcpSession({ configDir, sessionId: "linked-1", cwd: "/work" }),
    );

    expect(removed).toBe(0);
    expect(await exists(nodePath.join(victim, "keep.txt"))).toBe(true);
  });

  it("follows a symlinked store root once and deletes only inside it", async () => {
    const realStore = await makeStore();
    const linkParent = await makeStore();
    const configDir = nodePath.join(linkParent, ".cursor");
    await linkDirectory(realStore, configDir);
    const cwd = nodePath.resolve("/work/project");
    const owned = await seedSession(realStore, "owned-1", cwd);

    const removed = await Effect.runPromise(
      deleteCursorAcpSession({ configDir, sessionId: "owned-1", cwd }),
    );

    expect(removed).toBe(2);
    expect(await exists(owned.meta)).toBe(false);
    expect(await exists(owned.chats)).toBe(false);
    expect(await exists(configDir)).toBe(true);
  });

  it("also deletes a chat store keyed by the workspace's real path", async () => {
    const configDir = await makeStore();
    const realWorkspace = await makeStore();
    const linkParent = await makeStore();
    const linkedWorkspace = nodePath.join(linkParent, "workspace");
    await linkDirectory(realWorkspace, linkedWorkspace);
    const owned = await seedSession(configDir, "owned-1", realWorkspace);

    const removed = await Effect.runPromise(
      deleteCursorAcpSession({ configDir, sessionId: "owned-1", cwd: linkedWorkspace }),
    );

    expect(removed).toBe(2);
    expect(await exists(owned.chats)).toBe(false);
    // No tombstone is left behind.
    expect(
      (await nodeFs.readdir(nodePath.dirname(owned.meta))).filter((entry) =>
        entry.startsWith(".f5-delete-"),
      ),
    ).toEqual([]);
  });
});
