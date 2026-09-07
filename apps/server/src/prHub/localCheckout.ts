import { lstat, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { PrHubResolvedCheckout, PrRepositoryRef, ProjectId } from "@t3tools/contracts";
import { NONINTERACTIVE_GIT_ENV, parseRemoteFetchUrls } from "../git/remoteInspection.ts";
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
interface CheckoutInput {
  repository: PrRepositoryRef;
  host: string;
  projects: readonly Project[];
  baseDirectory?: string;
  selectedPath?: string;
  signal?: AbortSignal;
}

export const CHECKOUT_DISCOVERY_TIMEOUT_MS = 30000;
export const CHECKOUT_INSPECTION_LIMIT = 256;

export async function resolveLocalCheckout(input: CheckoutInput): Promise<PrHubResolvedCheckout[]> {
  const controller = new AbortController();
  const signal = input.signal
    ? AbortSignal.any([input.signal, controller.signal])
    : controller.signal;
  let rejectAbort!: (reason: unknown) => void;
  const canceled = new Promise<never>((_, reject) => {
    rejectAbort = reject;
  });
  const onAbort = () => rejectAbort(signal.reason);
  signal.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(
    () =>
      controller.abort(
        new Error("Local repository discovery timed out. Select an existing folder to continue."),
      ),
    CHECKOUT_DISCOVERY_TIMEOUT_MS,
  );
  try {
    signal.throwIfAborted();
    return await Promise.race([discover({ ...input, signal }), canceled]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
    controller.abort();
  }
}

async function discover(input: CheckoutInput): Promise<PrHubResolvedCheckout[]> {
  if (input.baseDirectory && input.selectedPath)
    throw new Error("Choose a base directory or a selected folder, not both.");
  let inspectionCount = 0;
  const inspected = new Map<string, Promise<PrHubResolvedCheckout | null>>();
  const inspect = (directory: string, project?: Project) => {
    const key = pathKey(directory);
    const pending = inspected.get(key);
    if (pending) return pending;
    input.signal?.throwIfAborted();
    if (++inspectionCount > CHECKOUT_INSPECTION_LIMIT)
      throw new Error(
        "Local repository discovery reached its inspection limit. Select an existing folder to continue.",
      );
    const result = (async () => {
      const cwd = await realpath(directory);
      input.signal?.throwIfAborted();
      const root = await runProcess("git", ["rev-parse", "--show-toplevel"], {
        cwd,
        signal: input.signal,
        env: { ...process.env, ...NONINTERACTIVE_GIT_ENV, LC_ALL: "C", LANG: "C" },
        timeoutMs: 10000,
        allowNonZeroExit: true,
      });
      input.signal?.throwIfAborted();
      if (root.timedOut) throw new Error(`Git inspection timed out at ${directory}.`);
      if (root.code !== 0) {
        if (root.stderr.toLowerCase().includes("not a git repository")) return null;
        throw new Error(`Could not inspect Git repository at ${directory}: ${root.stderr.trim()}`);
      }
      const canonical = await realpath(root.stdout.trim());
      input.signal?.throwIfAborted();
      const remotes = await runProcess("git", ["remote", "-v"], {
        cwd: canonical,
        signal: input.signal,
        env: { ...process.env, ...NONINTERACTIVE_GIT_ENV, LC_ALL: "C", LANG: "C" },
        timeoutMs: 10000,
      });
      const identities = discoverSourceControlProviderIdentities(
        [...parseRemoteFetchUrls(remotes.stdout)].map(([name, url]) => ({ name, url })),
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
  // Stale or unrelated folders must not turn a search miss into an error.
  // Explicit selections and the base directory itself retain actionable errors.
  const safelyInspect = async (
    run: () => Promise<PrHubResolvedCheckout | null>,
    onFailure?: (error: unknown) => void,
  ) => {
    try {
      return await run();
    } catch (error) {
      input.signal?.throwIfAborted();
      if (inspectionCount > CHECKOUT_INSPECTION_LIMIT) throw error;
      onFailure?.(error);
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
          input.signal?.throwIfAborted();
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
  if (input.selectedPath) {
    const selected = await inspect(expandPath(input.selectedPath.trim()));
    if (!selected)
      throw new Error(
        `The selected folder is not a Git checkout of ${input.repository.nameWithOwner} on ${input.host}.`,
      );
    // A selected repository already has verified remotes. Only compare project roots.
    for (const project of input.projects) {
      input.signal?.throwIfAborted();
      try {
        if (pathKey(await realpath(project.workspaceRoot)) === pathKey(selected.cwd)) {
          return [{ ...selected, projectId: project.projectId, projectTitle: project.title }];
        }
      } catch {
        input.signal?.throwIfAborted();
      }
    }
    return [selected];
  }
  // Explicit actions always re-read registered project remotes; polling caches cannot hide a clone.
  const registered = await collect(input.projects, (project) =>
    safelyInspect(() => inspect(project.workspaceRoot, project)),
  );
  if (registered.length) return registered;
  const base = input.baseDirectory?.trim();
  if (!base) {
    return [];
  }
  if (process.platform !== "win32" && path.win32.isAbsolute(base) && !path.posix.isAbsolute(base))
    return [];
  const directory = expandPath(base);
  const children = await readdir(directory, { withFileTypes: true });
  const name = input.repository.repo;
  const exact = children.find(
    (child) =>
      child.name === name ||
      (process.platform === "win32" && child.name.toLowerCase() === name.toLowerCase()),
  );
  let exactFailure: unknown;
  const inspectChild = (child: (typeof children)[number]) =>
    safelyInspect(
      async () => {
        if (!child.isDirectory() || child.isSymbolicLink()) return null;
        const childPath = path.join(directory, child.name);
        // Recheck links immediately before inspection, including Windows junctions.
        if ((await lstat(childPath)).isSymbolicLink()) return null;
        const candidate = await inspect(childPath);
        // A non-repository child of a Git working tree is not another clone.
        return candidate && pathKey(await realpath(childPath)) === pathKey(candidate.cwd)
          ? candidate
          : null;
      },
      child === exact
        ? (error) => {
            exactFailure = error;
          }
        : undefined,
    );
  if (exact) {
    const candidate = await inspectChild(exact);
    if (candidate) return [candidate];
  }
  const matches = await collect(
    children.filter((child) => child !== exact),
    inspectChild,
  );
  if (!matches.length && exactFailure) throw exactFailure;
  return matches;
}
