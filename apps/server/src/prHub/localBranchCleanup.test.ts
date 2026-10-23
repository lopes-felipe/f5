import { beforeEach, expect, it, vi } from "vitest";
import { Effect, Layer } from "effect";
import { ProjectId } from "@t3tools/contracts";
import { GitCore } from "../git/Services/GitCore.ts";
import { ProjectionProjectRepository } from "../persistence/Services/ProjectionProjects.ts";
import { resolveLocalCheckout } from "./localCheckout.ts";
import { cleanupLocalPrBranch } from "./localBranchCleanup.ts";
vi.mock("./localCheckout.ts", () => ({ resolveLocalCheckout: vi.fn() }));
const source = {
  host: "github.com",
  repository: "fork/repo",
  branch: "topic",
  headOid: "a".repeat(40),
  absent: true,
};
const project = {
  projectId: ProjectId.makeUnsafe("p1"),
  title: "Repo",
  workspaceRoot: "/registered",
  defaultModel: null,
  defaultModelSelection: null,
  defaultEnvMode: null,
  icon: null,
  scripts: [],
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-01T00:00:00Z",
  deletedAt: null,
};
const candidate = {
  cwd: "/verified-source-clone",
  projectId: project.projectId,
  projectTitle: "Repo",
  repository: { owner: "fork", repo: "repo", nameWithOwner: "fork/repo" },
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(resolveLocalCheckout).mockResolvedValue([candidate]);
});
function fixture(
  flags: { current?: boolean; isDefault?: boolean; worktreePath?: string } = {},
  removed = true,
) {
  const remove = vi.fn(() => Effect.succeed(removed));
  const layer = Layer.mergeAll(
    Layer.mock(GitCore)({
      listBranches: () =>
        Effect.succeed({
          branches: [
            { name: "topic", current: false, isDefault: false, worktreePath: null, ...flags },
          ],
          isRepo: true,
          hasOriginRemote: true,
        }),
      deleteBranchIfAt: remove,
    }),
    Layer.mock(ProjectionProjectRepository)({
      listAll: () =>
        Effect.succeed([
          project,
          {
            ...project,
            projectId: ProjectId.makeUnsafe("deleted"),
            deletedAt: "2026-10-02T00:00:00Z",
          },
        ]),
    }),
  );
  return {
    remove,
    run: (absent = true) =>
      Effect.runPromise(cleanupLocalPrBranch({ ...source, absent }).pipe(Effect.provide(layer))),
  };
}
it("limits discovery to registered nondeleted projects and atomically removes only the reviewed unused branch", async () => {
  const f = fixture();
  expect(await f.run()).toBeUndefined();
  expect(resolveLocalCheckout).toHaveBeenCalledWith(
    expect.objectContaining({
      provider: "github",
      host: "github.com",
      repository: candidate.repository,
      projects: [{ projectId: project.projectId, title: "Repo", workspaceRoot: "/registered" }],
      signal: expect.any(AbortSignal),
    }),
  );
  expect(f.remove).toHaveBeenCalledExactlyOnceWith({
    cwd: candidate.cwd,
    branch: "topic",
    expectedSha: source.headOid,
    onlyIfUnused: true,
  });
});
it.each([{ current: true }, { isDefault: true }, { worktreePath: "/active-worktree" }])(
  "keeps branches protected by %j",
  async (flags) => {
    const f = fixture(flags);
    expect(await f.run()).toContain("were kept");
    expect(f.remove).not.toHaveBeenCalled();
  },
);
it("keeps a branch moved or claimed after inspection", async () => {
  const f = fixture({}, false);
  expect(await f.run()).toContain("were kept");
  expect(f.remove).toHaveBeenCalledTimes(1);
});
it("never touches local repositories without remote absence proof", async () => {
  const f = fixture();
  expect(await f.run(false)).toContain("not confirmed");
  expect(resolveLocalCheckout).not.toHaveBeenCalled();
  expect(f.remove).not.toHaveBeenCalled();
});
it("reports discovery failures separately from the confirmed remote result", async () => {
  vi.mocked(resolveLocalCheckout).mockRejectedValue(new Error("inspection failed"));
  const f = fixture();
  expect(await f.run()).toContain("local cleanup could not be confirmed");
  expect(f.remove).not.toHaveBeenCalled();
});
it("reports unavailable local services without replaying the remote action", async () => {
  expect(await Effect.runPromise(cleanupLocalPrBranch(source))).toContain("unavailable");
});
