import type { ProjectId, ThreadId, ProjectIssueAssetUrlInput } from "@t3tools/contracts";
export function resolveChatAssetTarget(
  src: string,
  cwd: string | undefined,
  projects: ReadonlyArray<{ id: ProjectId; cwd: string }>,
  threads: ReadonlyArray<{ id: ThreadId; worktreePath: string | null }>,
): { identity: ProjectIssueAssetUrlInput["identity"]; path: string } | undefined {
  if (
    !cwd ||
    src.startsWith("//") ||
    (/^[a-z]+:/iu.test(src) && !/^file:/iu.test(src) && !/^[a-z]:[\\/]/iu.test(src))
  )
    return;
  const normalize = (value: string) => value.replaceAll("\\", "/").replace(/\/$/u, "");
  try {
    const base = normalize(cwd);
    const url = new URL(
      normalize(src).replace(/^([a-z]):\//iu, "file:///$1:/"),
      `file://${base.startsWith("/") ? "" : "/"}${base}/`,
    );
    if (url.protocol !== "file:" || (url.hostname && url.hostname !== "localhost")) return;
    const absolute = decodeURIComponent(url.pathname).replace(/^\/([a-z]:\/)/iu, "$1");
    const roots = [
      ...threads.flatMap((thread) =>
        thread.worktreePath
          ? [
              {
                root: normalize(thread.worktreePath),
                identity: { kind: "thread" as const, threadId: thread.id },
              },
            ]
          : [],
      ),
      ...projects.map((project) => ({
        root: normalize(project.cwd),
        identity: { kind: "project" as const, projectId: project.id },
      })),
    ].sort((a, b) => b.root.length - a.root.length);
    const target = roots.find(({ root }) =>
      /^[a-z]:/iu.test(root)
        ? absolute.toLowerCase().startsWith(`${root.toLowerCase()}/`)
        : absolute.startsWith(`${root}/`),
    );
    if (target) return { identity: target.identity, path: absolute.slice(target.root.length + 1) };
    // Provider attachment context contains saved absolute paths. Only opaque attachment
    // filenames are eligible for this fallback; the server still confines the read.
    const attachment = absolute.match(
      /\/attachments\/([^/]+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]+)$/iu,
    );
    if (attachment?.[1]) return { identity: { kind: "attachments" }, path: attachment[1] };
  } catch {
    /* Invalid or remote paths have no local capability. */
  }
}
