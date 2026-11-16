import { describe, expect, it } from "vitest";
import { ProjectEntry } from "./project";
import { Schema } from "effect";
import { FilesystemPath } from "./baseSchemas";
import { GitRemoveWorktreeInput } from "./git";
import {
  WorktreesListInput,
  WorktreesListResult,
  WorktreesInspectInput,
  WorktreesRemoveInput,
  WorktreesRecoverInput,
  WorktreesSwitchWorkspaceInput,
  WorktreesResolveTransitionInput,
} from "./worktrees";
describe("worktree safety wire contracts", () => {
  it("bounds approval lists while preserving exact ignored paths", () => {
    const input = { projectId: "p", path: "/worktree", expectedHead: null, deleteBranch: false };
    const decode = Schema.decodeUnknownSync(WorktreesRemoveInput);
    const approvedIgnoredEntries = ["node_modules/", " .env\n "];
    expect(decode({ ...input, approvedIgnoredEntries }).approvedIgnoredEntries).toEqual(
      approvedIgnoredEntries,
    );
    expect(() =>
      decode({ ...input, approvedIgnoredEntries: Array(32_769).fill(".env") }),
    ).toThrow();
    expect(() => decode({ ...input, approvedIgnoredEntries: ["x".repeat(65_536)] })).toThrow();
  });
  it("preserves paths including leading, trailing and newline whitespace", () => {
    const path = " /tmp/worktree\n ";
    expect(
      Schema.decodeUnknownSync(ProjectEntry)({
        path: `${path}/child`,
        kind: "file",
        parentPath: path,
      }).parentPath,
    ).toBe(path);
    expect(Schema.decodeUnknownSync(FilesystemPath)(path)).toBe(path);
    expect(Schema.decodeUnknownSync(GitRemoveWorktreeInput)({ cwd: path, path })).toEqual({
      cwd: path,
      path,
    });
    expect(Schema.decodeUnknownSync(WorktreesInspectInput)({ projectId: "p", path }).path).toBe(
      path,
    );
  });
  it("rejects empty and NUL paths", () => {
    for (const path of ["", "/tmp/\0bad"])
      expect(() => Schema.decodeUnknownSync(FilesystemPath)(path)).toThrow();
  });
  it("does not expose force and requires a recovery revision", () => {
    expect(Object.keys(GitRemoveWorktreeInput.fields)).toEqual(["cwd", "path"]);
    expect(() =>
      Schema.decodeUnknownSync(WorktreesRecoverInput)({
        threadId: "t",
        action: "useProjectCheckout",
      }),
    ).toThrow();
  });
  it("requires operation identity, expected workspace context, and versioned recovery acceptance", () => {
    const request = {
      operationId: "switch",
      threadId: "thread",
      intent: "attach_existing",
      targetPath: " /tmp/topic\n ",
      expected: { branch: "main", worktreePath: null, sessionUpdatedAt: null },
    };
    expect(Schema.decodeUnknownSync(WorktreesSwitchWorkspaceInput)(request).targetPath).toBe(
      request.targetPath,
    );
    expect(() =>
      Schema.decodeUnknownSync(WorktreesSwitchWorkspaceInput)({ ...request, expected: undefined }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(WorktreesResolveTransitionInput)({
        operationId: "switch",
        version: 2,
        action: "retry",
      }),
    ).toThrow();
  });
});

it("decodes optional inventory filters, unknown dirty state and exact paths", () => {
  expect(Schema.decodeUnknownSync(WorktreesListInput)({})).toEqual({});
  const path = "/managed/line\ntrailing ";
  const decoded = Schema.decodeUnknownSync(WorktreesListResult)({
    projects: [
      {
        projectId: "p",
        name: "Repository",
        workspaceRoot: "/repo",
        error: null,
        entries: [
          {
            path,
            canonicalPath: path,
            registration: null,
            branch: "topic",
            classification: "managed",
            missing: true,
            locked: false,
            detached: false,
            hasChanges: null,
            linkedThreads: [{ threadId: "t", title: "Archived", archived: true }],
          },
        ],
      },
    ],
  });
  expect(decoded.projects[0]?.entries[0]?.path).toBe(path);
  expect(decoded.projects[0]?.entries[0]?.hasChanges).toBeNull();
});

it("decodes move and discard RPCs without trimming paths", async () => {
  const { WorktreesMoveThreadInput, WorktreesMoveThreadResult, WorktreesDiscardMovedChangesInput } =
    await import("./worktrees");
  const input = { threadId: "thread", branch: "feature/copied" };
  expect(Schema.decodeUnknownSync(WorktreesMoveThreadInput)(input)).toEqual(input);
  const result = {
    operationId: "move",
    branch: "feature/copied",
    worktreePath: "/managed/trailing ",
    copiedFileCount: 4,
  };
  expect(Schema.decodeUnknownSync(WorktreesMoveThreadResult)(result)).toEqual(result);
  expect(
    Schema.decodeUnknownSync(WorktreesDiscardMovedChangesInput)({
      threadId: "thread",
      operationId: "move",
    }).operationId,
  ).toBe("move");
});
