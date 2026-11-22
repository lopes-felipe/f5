import type { ProjectId, ProjectRepository } from "@t3tools/contracts";
import { hasSafeRelativePathShape } from "@t3tools/shared/checkedInProjectFile";
import { Data, Effect, FileSystem, Option } from "effect";
import { readdir } from "node:fs/promises";
import path from "node:path";

import { makeWorkspaceAssetAuthorizer } from "../WorkspaceAssetAuthorizer.ts";
import type { GitCoreShape } from "../git/Services/GitCore.ts";
import { makeCheckedInProjectFileService } from "./CheckedInProjectFileService.ts";
import { isInsideProjectWorkspace } from "./projectSettings.ts";
import { externalRepositoryPath } from "./worktreeRepositoryPaths.ts";

export const MAX_PROJECT_REPOSITORIES = 128;

/** Scan two levels, stopping at repository boundaries. Git files denote linked checkouts. */
export const discoverProjectRepositories = Effect.fn("discoverProjectRepositories")(function* (
  workspaceRoot: string,
  ignoreRepositories: ReadonlyArray<string> = [],
) {
  const root = path.resolve(workspaceRoot);
  const ignored = ignoreRepositories.map((entry) => path.resolve(root, entry));
  if (ignored.some((entry) => isInsideProjectWorkspace(entry, root))) return [];

  const fs = yield* FileSystem.FileSystem;
  const realRoot = yield* fs.realPath(root).pipe(Effect.orElseSucceed(() => null));
  if (realRoot === null) return [];
  const realIgnored = ignored.map((entry) => path.resolve(realRoot, path.relative(root, entry)));
  const isIgnored = (folder: string) =>
    realIgnored.some((entry) => isInsideProjectWorkspace(entry, folder));

  const children = (folder: string) =>
    Effect.tryPromise(() => readdir(folder, { withFileTypes: true })).pipe(
      Effect.orElseSucceed(() => []),
      Effect.map((entries) =>
        entries
          .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
          .map((entry) => entry.name)
          .filter((name) => !name.startsWith(".") && name !== "node_modules")
          .sort()
          .map((name) => path.join(folder, name)),
      ),
    );

  const inspect = Effect.fnUntraced(function* (folder: string) {
    if (isIgnored(folder)) return null;
    const real = yield* fs.realPath(folder).pipe(Effect.orElseSucceed(() => null));
    if (
      real === null ||
      real === realRoot ||
      !isInsideProjectWorkspace(realRoot, real) ||
      isIgnored(real)
    ) {
      return null;
    }
    const info = yield* fs.stat(real).pipe(Effect.orElseSucceed(() => null));
    if (info?.type !== "Directory") return null;
    const gitPath = path.join(real, ".git");
    const marker = yield* fs.stat(gitPath).pipe(Effect.orElseSucceed(() => null));
    if (marker === null) return { path: real, kind: "plain" } as const;
    if (marker.type !== "Directory") return null;
    if (Option.isSome(yield* fs.readLink(gitPath).pipe(Effect.option))) return null;
    return { path: real, kind: "repository" } as const;
  });

  const firstLevel = yield* Effect.forEach(yield* children(realRoot), inspect, {
    concurrency: 4,
  });
  const nested = yield* Effect.forEach(
    firstLevel.flatMap((folder) => (folder?.kind === "plain" ? [folder.path] : [])),
    children,
    { concurrency: 4 },
  );
  const secondLevel = yield* Effect.forEach(nested.flat(), inspect, { concurrency: 4 });
  const repositoryPaths = new Set(
    [...firstLevel, ...secondLevel].flatMap((folder) =>
      folder?.kind === "repository" ? [folder.path] : [],
    ),
  );
  return [...repositoryPaths]
    .sort()
    .slice(0, MAX_PROJECT_REPOSITORIES)
    .map((real) => {
      const relativePath = path.relative(realRoot, real);
      return {
        path: path.join(root, relativePath),
        relativePath: relativePath.split(path.sep).join("/"),
      };
    });
});

type RepositoryProject = { readonly id: ProjectId; readonly workspaceRoot: string };

class ProjectRepositoryConfigError extends Data.TaggedError("ProjectRepositoryConfigError")<{
  readonly message: string;
  readonly cause: unknown;
}> {}

const readRepositoryConfig = (project: RepositoryProject) => {
  const service = makeCheckedInProjectFileService(
    makeWorkspaceAssetAuthorizer({
      resolveProjectWorkspaceRoot: async (id) => (id === project.id ? project.workspaceRoot : null),
    }),
  );
  return Effect.tryPromise({
    try: () => service.load(project.id),
    catch: (cause) =>
      new ProjectRepositoryConfigError({
        message: "Could not load project repository configuration.",
        cause,
      }),
  });
};

const listExternalRepositories = (
  project: RepositoryProject,
  git?: Pick<GitCoreShape, "listProjectRepositoryRoots">,
) =>
  git?.listProjectRepositoryRoots?.(project.id).pipe(
    Effect.map((paths) =>
      paths.map((path) => ({
        path,
        relativePath: externalRepositoryPath(path),
        externalSource: path,
      })),
    ),
    Effect.orElseSucceed(() => []),
  ) ?? Effect.succeed([]);

export const discoverConfiguredProjectRepositories = (
  project: RepositoryProject,
  git?: Pick<GitCoreShape, "listProjectRepositoryRoots">,
) =>
  Effect.gen(function* () {
    const { ignoreRepositories } = yield* readRepositoryConfig(project);
    const nested = yield* discoverProjectRepositories(project.workspaceRoot, ignoreRepositories);
    const external = yield* listExternalRepositories(project, git);
    return [
      ...nested.slice(0, Math.max(0, MAX_PROJECT_REPOSITORIES - external.length)),
      ...external,
    ];
  });

export const listWorkspaceRepositories = Effect.fn("listWorkspaceRepositories")(function* (
  project: RepositoryProject,
  workspaceRoot: string = project.workspaceRoot,
  git?: Pick<
    GitCoreShape,
    "inspectCheckoutIdentity" | "readWorktreeGroup" | "listProjectRepositoryRoots"
  >,
) {
  const fs = yield* FileSystem.FileSystem;
  const { ignoreRepositories } = yield* readRepositoryConfig(project);
  const group =
    workspaceRoot !== project.workspaceRoot && git?.readWorktreeGroup
      ? yield* git.readWorktreeGroup(workspaceRoot).pipe(Effect.orElseSucceed(() => null))
      : null;
  if (group && group.projectId !== project.id) return [];
  const nested = group
    ? []
    : yield* discoverProjectRepositories(project.workspaceRoot, ignoreRepositories);
  const external =
    workspaceRoot === project.workspaceRoot ? yield* listExternalRepositories(project, git) : [];
  const gitMarker = (cwd: string) =>
    fs.stat(path.join(cwd, ".git")).pipe(
      Effect.map((info) => info.type === "Directory" || info.type === "File"),
      Effect.orElseSucceed(() => false),
    );
  const root: ReadonlyArray<ProjectRepository> = (yield* gitMarker(workspaceRoot))
    ? [{ path: workspaceRoot, relativePath: "." }]
    : [];
  const canonical = yield* fs.realPath(workspaceRoot).pipe(Effect.orElseSucceed(() => null));
  if (canonical === null) return root;
  const checkRepository = (relativePath: string) =>
    Effect.gen(function* () {
      const cwd = path.join(workspaceRoot, relativePath);
      const real = yield* fs.realPath(cwd).pipe(Effect.orElseSucceed(() => null));
      if (real !== path.join(canonical, relativePath) || !(yield* gitMarker(cwd))) {
        return null;
      }
      return { relativePath, path: cwd };
    });
  const mapped =
    group && git
      ? (yield* Effect.forEach(
          group.members,
          (member) =>
            git.inspectCheckoutIdentity(member.path).pipe(
              Effect.map((identity) =>
                identity.canonicalRoot === member.path && identity.commonDir === member.identity
                  ? {
                      relativePath: path
                        .relative(group.path, member.path)
                        .split(path.sep)
                        .join("/"),
                      path: member.path,
                      ...(!isInsideProjectWorkspace(group.projectRoot, member.source)
                        ? { externalSource: member.source }
                        : {}),
                    }
                  : null,
              ),
              Effect.orElseSucceed(() => null),
            ),
          { concurrency: 4 },
        )).filter((repository) => repository !== null)
      : workspaceRoot === project.workspaceRoot
        ? nested
        : !git
          ? []
          : (yield* Effect.forEach(
              nested,
              Effect.fnUntraced(function* (repository) {
                const checkout = yield* checkRepository(repository.relativePath);
                if (!checkout) return null;
                const [source, target] = yield* Effect.all(
                  [
                    git.inspectCheckoutIdentity(repository.path),
                    git.inspectCheckoutIdentity(checkout.path),
                  ],
                  { concurrency: 2 },
                ).pipe(Effect.orElseSucceed(() => [null, null] as const));
                if (
                  !source ||
                  !target ||
                  source.commonDir !== target.commonDir ||
                  target.canonicalRoot !== path.join(canonical, repository.relativePath)
                )
                  return null;
                return checkout;
              }),
              { concurrency: 4 },
            )).filter((repository) => repository !== null);

  const ignored = (ignoreRepositories ?? []).map((entry) => path.resolve(workspaceRoot, entry));
  const repositories = new Map<string, ProjectRepository>(
    [
      ...root,
      ...mapped.slice(0, Math.max(0, MAX_PROJECT_REPOSITORIES - external.length)),
      ...external,
    ].map((repository) => [repository.path, repository]),
  );
  const limit = MAX_PROJECT_REPOSITORIES + root.length;
  let frontier = [...repositories.values()];
  while (frontier.length > 0 && repositories.size < limit) {
    const children = yield* Effect.forEach(
      frontier,
      Effect.fnUntraced(function* (repository) {
        const configPath = path.join(repository.path, ".gitmodules");
        const real = yield* fs.realPath(configPath).pipe(Effect.orElseSucceed(() => null));
        if (real !== path.join(canonical, repository.relativePath, ".gitmodules")) return [];
        const stat = yield* fs.stat(configPath).pipe(Effect.orElseSucceed(() => null));
        if (stat?.type !== "File" || Number(stat.size) > 64 * 1024) return [];
        const contents = yield* fs.readFileString(configPath).pipe(Effect.orElseSucceed(() => ""));
        return contents.split(/\r?\n/u).flatMap((line) => {
          const entry = /^\s*path\s*=\s*(.*?)\s*$/u.exec(line)?.[1]?.replace(/^"(.*)"$/u, "$1");
          if (!entry || !hasSafeRelativePathShape(entry)) return [];
          const child = path.resolve(repository.path, entry);
          if (
            child === repository.path ||
            ignored.some((directory) => isInsideProjectWorkspace(directory, child))
          )
            return [];
          return [path.relative(workspaceRoot, child).split(path.sep).join("/")];
        });
      }),
      { concurrency: 4 },
    );
    const candidates = [...new Set(children.flat())].filter(
      (child) => !repositories.has(path.join(workspaceRoot, child)),
    );
    frontier = (yield* Effect.forEach(candidates, checkRepository, { concurrency: 4 }))
      .filter((repository) => repository !== null)
      .slice(0, limit - repositories.size);
    for (const repository of frontier)
      repositories.set(repository.path, { ...repository, submodule: true });
  }
  return [...repositories.values()];
});

/** Cache read-side discovery only. Rewind and Git mutations validate fresh scopes. */
export function makeWorkspaceRepositoryReadCache() {
  let generation = 0;
  const entries = new Map<
    string,
    { expiresAt: number; repositories: ReadonlyArray<ProjectRepository> }
  >();
  return {
    clear: () => {
      generation++;
      entries.clear();
    },
    list: (...args: Parameters<typeof listWorkspaceRepositories>) =>
      Effect.gen(function* () {
        const [project, workspace] = args;
        const key = JSON.stringify([project.id, project.workspaceRoot, workspace]);
        const cached = entries.get(key);
        if (cached && cached.expiresAt > Date.now()) return cached.repositories;
        const readGeneration = generation;
        const repositories = yield* listWorkspaceRepositories(...args);
        if (readGeneration !== generation) return repositories;
        entries.delete(key);
        entries.set(key, { expiresAt: Date.now() + 5_000, repositories });
        if (entries.size > 64) entries.delete(entries.keys().next().value!);
        return repositories;
      }),
  };
}
