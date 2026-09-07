import { lstat, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { PrHubResolvedCheckout, PrRepositoryRef, ProjectId } from "@t3tools/contracts";
import { runProcess } from "../processRunner.ts";
import { discoverSourceControlProviderIdentities } from "../sourceControl/discovery.ts";

interface Project {
  projectId: ProjectId;
  title: string;
  workspaceRoot: string;
}
const pathKey = (value: string) => (process.platform === "win32" ? value.toLowerCase() : value);
const expandPath = (value: string) => path.resolve(value.replace(/^~(?=$|[\\/])/, homedir()));

/** A shallow, read-only search. Only explicit selections may follow directory links. */
export async function resolveLocalCheckout(input: {
  repository: PrRepositoryRef;
  host: string;
  projects: readonly Project[];
  baseDirectory?: string;
  selectedPath?: string;
  signal?: AbortSignal;
}): Promise<PrHubResolvedCheckout[]> {
  if (input.baseDirectory && input.selectedPath)
    throw new Error("Choose a base directory or a selected folder, not both.");
  const failures: string[] = [];
  const inspected = new Map<string, Promise<PrHubResolvedCheckout | null>>();
  const inspect = (directory: string, project?: Project) => {
    const key = pathKey(directory);
    const pending = inspected.get(key);
    if (pending) return pending;
    const result = (async () => {
      const cwd = await realpath(directory);
      const root = await runProcess("git", ["rev-parse", "--show-toplevel"], {
        cwd,
        signal: input.signal,
        timeoutMs: 10000,
        allowNonZeroExit: true,
      });
      if (root.code !== 0) {
        if (root.stderr.includes("not a git repository")) return null;
        throw new Error(`Could not inspect Git repository at ${directory}: ${root.stderr.trim()}`);
      }
      const canonical = await realpath(root.stdout.trim());
      const remotes = await runProcess("git", ["remote", "-v"], {
        cwd: canonical,
        signal: input.signal,
        timeoutMs: 10000,
      });
      const identities = discoverSourceControlProviderIdentities(
        remotes.stdout.split(/\r?\n/).flatMap((line) => {
          const match = /^(\S+)\s+(\S+)\s+\(fetch\)$/.exec(line);
          return match ? [{ name: match[1]!, url: match[2]! }] : [];
        }),
        { githubHosts: [input.host] },
      );
      if (
        !identities.some(
          (identity) =>
            identity.kind === "github" &&
            identity.host?.toLowerCase() === input.host.toLowerCase() &&
            `${identity.owner}/${identity.repository}`.toLowerCase() ===
              input.repository.nameWithOwner.toLowerCase(),
        )
      )
        return null;
      return {
        cwd: canonical,
        projectId: project?.projectId ?? null,
        projectTitle: project?.title ?? path.basename(canonical),
        repository: input.repository,
      };
    })();
    inspected.set(key, result);
    return result;
  };
  const safelyInspect = async (directory: string, project?: Project) => {
    try {
      return await inspect(directory, project);
    } catch (error) {
      if (input.signal?.aborted) throw error;
      failures.push(
        `Could not inspect ${directory}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  };
  const collect = async <T>(
    items: readonly T[],
    run: (item: T) => Promise<PrHubResolvedCheckout | null>,
  ) => {
    let cursor = 0;
    const results: PrHubResolvedCheckout[] = [];
    await Promise.all(
      Array.from({ length: Math.min(4, items.length) }, async () => {
        while (cursor < items.length) {
          const item = items[cursor++]!;
          const candidate = await run(item);
          if (candidate) results.push(candidate);
        }
      }),
    );
    return [
      ...new Map(results.map((candidate) => [pathKey(candidate.cwd), candidate])).values(),
    ].sort((a, b) => a.cwd.localeCompare(b.cwd));
  };
  // Explicit actions always re-read registered project remotes; polling caches cannot hide a clone.
  const registered = await collect(input.projects, (project) =>
    safelyInspect(project.workspaceRoot, project),
  );
  if (input.selectedPath) {
    const selected = await inspect(expandPath(input.selectedPath));
    if (!selected)
      throw new Error(
        `The selected folder is not a Git checkout of ${input.repository.nameWithOwner} on ${input.host}.`,
      );
    return [
      registered.find((candidate) => pathKey(candidate.cwd) === pathKey(selected.cwd)) ?? selected,
    ];
  }
  if (registered.length) return registered;
  const base = input.baseDirectory?.trim();
  if (!base) {
    if (failures.length) throw new Error(failures.join("\n"));
    return [];
  }
  const directory = expandPath(base);
  const children = await readdir(directory, { withFileTypes: true });
  const name = input.repository.nameWithOwner.split("/").at(-1)!;
  const exact = children.find(
    (child) =>
      child.name === name ||
      (process.platform === "win32" && child.name.toLowerCase() === name.toLowerCase()),
  );
  const inspectChild = async (child: (typeof children)[number]) => {
    if (!child.isDirectory() || child.isSymbolicLink()) return null;
    const childPath = path.join(directory, child.name);
    // Recheck links immediately before inspection, including Windows junctions.
    if ((await lstat(childPath)).isSymbolicLink()) return null;
    const candidate = await safelyInspect(childPath);
    // A non-repository child of a Git working tree is not another clone.
    return candidate && pathKey(await realpath(childPath)) === pathKey(candidate.cwd)
      ? candidate
      : null;
  };
  if (exact) {
    const candidate = await inspectChild(exact);
    if (candidate) return [candidate];
  }
  const matches = await collect(
    children.filter((child) => child !== exact),
    inspectChild,
  );
  if (!matches.length && failures.length) throw new Error(failures.join("\n"));
  return matches;
}
