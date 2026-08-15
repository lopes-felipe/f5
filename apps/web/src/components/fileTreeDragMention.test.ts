import { ProjectId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  F5_FILE_MENTION_MIME,
  authorizeFileTreeMention,
  composerFileMention,
  dataTransferHasFileTreeMention,
  normalizeFileMentionRelativePath,
  parseFileTreeDragMentionPayload,
  serializeFileTreeDragMentionPayload,
  workspaceIdentityForRoot,
  writeFileTreeDragMention,
} from "./fileTreeDragMention";

const PROJECT_ID = ProjectId.makeUnsafe("project-drag-test");
const WORKSPACE_ROOT = "/repo/project";
const WORKSPACE_IDENTITY = workspaceIdentityForRoot(PROJECT_ID, WORKSPACE_ROOT);

describe("fileTreeDragMention", () => {
  it("round-trips a versioned relative-only payload", () => {
    const serialized = serializeFileTreeDragMentionPayload({
      projectId: PROJECT_ID,
      workspaceIdentity: WORKSPACE_IDENTITY,
      relativePath: "docs/My File.md",
    });
    expect(parseFileTreeDragMentionPayload(serialized ?? "")).toEqual({
      version: 1,
      projectId: PROJECT_ID,
      workspaceIdentity: WORKSPACE_IDENTITY,
      relativePath: "docs/My File.md",
    });
    expect(serialized).not.toContain(WORKSPACE_ROOT);
  });

  it("rejects absolute paths, traversal, backslashes, and unsupported versions", () => {
    for (const path of ["/etc/passwd", "../secret", "docs/../secret", "C:\\secret", "a\\b"]) {
      expect(normalizeFileMentionRelativePath(path)).toBeNull();
    }
    expect(
      parseFileTreeDragMentionPayload(
        JSON.stringify({
          version: 2,
          projectId: PROJECT_ID,
          workspaceIdentity: WORKSPACE_IDENTITY,
          relativePath: "docs/index.md",
        }),
      ),
    ).toBeNull();
  });

  it("writes the f5 MIME payload and a serialized mention fallback", () => {
    const values = new Map<string, string>();
    const transfer = {
      effectAllowed: "none",
      setData: (format: string, value: string) => values.set(format, value),
    };
    expect(
      writeFileTreeDragMention(transfer, {
        projectId: PROJECT_ID,
        workspaceIdentity: WORKSPACE_IDENTITY,
        relativePath: "docs/My File.md",
      }),
    ).toBe(true);
    expect(transfer.effectAllowed).toBe("copy");
    expect(dataTransferHasFileTreeMention([...values.keys()])).toBe(true);
    expect(values.get("text/plain")).toBe('@"docs/My File.md" ');
    expect(values.has(F5_FILE_MENTION_MIME)).toBe(true);
    expect(composerFileMention("docs/index.md")).toBe("@docs/index.md");
  });

  it("rejects cross-project payloads before calling the server", async () => {
    const authorizeEntry = vi.fn();
    const payload = parseFileTreeDragMentionPayload(
      serializeFileTreeDragMentionPayload({
        projectId: PROJECT_ID,
        workspaceIdentity: WORKSPACE_IDENTITY,
        relativePath: "docs/index.md",
      }) ?? "",
    );
    expect(payload).not.toBeNull();
    await expect(
      authorizeFileTreeMention({
        api: { projects: { authorizeEntry } } as never,
        payload: payload!,
        expectedProjectId: "another-project",
        expectedWorkspaceIdentity: WORKSPACE_IDENTITY,
        workspaceRoot: WORKSPACE_ROOT,
      }),
    ).rejects.toThrow("different project or workspace");
    expect(authorizeEntry).not.toHaveBeenCalled();
  });

  it("reauthorizes the current relative path as a file", async () => {
    const authorizeEntry = vi.fn().mockResolvedValue({
      relativePath: "docs/index.md",
      kind: "file",
    });
    const payload = parseFileTreeDragMentionPayload(
      serializeFileTreeDragMentionPayload({
        projectId: PROJECT_ID,
        workspaceIdentity: WORKSPACE_IDENTITY,
        relativePath: "docs/index.md",
      }) ?? "",
    );
    await expect(
      authorizeFileTreeMention({
        api: { projects: { authorizeEntry } } as never,
        payload: payload!,
        expectedProjectId: PROJECT_ID,
        expectedWorkspaceIdentity: WORKSPACE_IDENTITY,
        workspaceRoot: WORKSPACE_ROOT,
      }),
    ).resolves.toBe("docs/index.md");
    expect(authorizeEntry).toHaveBeenCalledWith({
      cwd: WORKSPACE_ROOT,
      relativePath: "docs/index.md",
      kind: "file",
    });
  });
});
