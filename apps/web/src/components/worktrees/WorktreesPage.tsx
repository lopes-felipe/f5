import type { ProjectId, ThreadId, WorktreeListEntry } from "@t3tools/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { GitForkIcon, RefreshCwIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { useComposerDraftStore } from "../../composerDraftStore";
import { openInPreferredEditor } from "../../editorPreferences";
import { writeTextToClipboard } from "../../hooks/useCopyToClipboard";
import { useHandleNewThread } from "../../hooks/useHandleNewThread";
import { worktreesListQueryOptions } from "../../lib/gitReactQuery";
import { switchConversationWorkspace } from "../../lib/workspaceTransitions";
import { ensureNativeApi } from "../../nativeApi";
import { useStore } from "../../store";
import { useThreadSummaries } from "../../threadSelectors";
import { useWorktreeRemovalDialogStore } from "../../worktreeRemovalDialogStore";
import type { WorktreesSearch } from "../../routes/_chat.worktrees";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { toastManager } from "../ui/toast";
import { WorktreeIgnoredFilesList } from "./WorktreeIgnoredFilesList";

const classifications = {
  projectCheckout: "Project checkout",
  managed: "Managed",
  external: "External",
  otherProfile: "Other profile",
};

function WorktreeRow({
  row,
  projectId,
  threadId,
  onNew,
  onUse,
}: {
  row: WorktreeListEntry;
  projectId: ProjectId;
  threadId: ThreadId | null;
  onNew: () => Promise<unknown>;
  onUse: () => Promise<unknown>;
}) {
  const navigate = useNavigate();
  const [details, setDetails] = useState(false);
  const [busy, setBusy] = useState(false);
  const inspection = useQuery({
    queryKey: ["worktrees", "inspect", projectId, row.canonicalPath],
    queryFn: () => ensureNativeApi().worktrees.inspect({ projectId, path: row.path }),
    enabled: details,
    staleTime: 30_000,
  });
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await action();
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Worktree action failed",
        description: String(error),
      });
    } finally {
      setBusy(false);
    }
  };
  const inspectOnly =
    row.detached ||
    row.registration?.bare === true ||
    row.classification === "external" ||
    row.classification === "otherProfile";
  return (
    <article
      className="space-y-3 border-t border-border p-4"
      aria-label={`${row.branch ?? "Detached HEAD"} ${row.path}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <GitForkIcon className="size-4 shrink-0 text-muted-foreground" />
        <span className="break-all font-medium">{row.branch ?? "Detached HEAD"}</span>
        <Badge variant="outline">{classifications[row.classification]}</Badge>
        {row.missing && <Badge variant="warning">Missing</Badge>}
        {row.hasChanges && <Badge variant="warning">Changes</Badge>}
        {!row.missing && row.hasChanges === null && (
          <Badge variant="outline">Status unavailable</Badge>
        )}
        {row.locked && <Badge variant="outline">Locked</Badge>}
        {row.detached && <Badge variant="outline">Detached</Badge>}
      </div>
      <p className="break-all whitespace-pre-wrap font-mono text-xs text-muted-foreground">
        {row.path}
      </p>
      <div className="flex flex-wrap gap-2">
        {row.linkedThreads.map((thread) => (
          <Button
            key={thread.threadId}
            variant="ghost"
            size="sm"
            onClick={() =>
              void navigate({ to: "/$threadId", params: { threadId: thread.threadId } })
            }
          >
            {thread.title}
            {thread.archived ? " (archived)" : ""}
          </Button>
        ))}
      </div>
      <div className="flex flex-wrap gap-2">
        {!inspectOnly && !row.missing && (
          <>
            <Button
              size="sm"
              variant="outline"
              disabled={busy || row.locked || !row.registration}
              onClick={() => void run(onNew)}
            >
              New conversation here
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy || !threadId || row.locked || !row.registration}
              onClick={() => void run(onUse)}
            >
              Use for this conversation
            </Button>
          </>
        )}
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void run(() => writeTextToClipboard(row.path))}
        >
          Copy path
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy || row.missing}
          onClick={() =>
            void run(() => ensureNativeApi().shell.openInEditor(row.path, "file-manager"))
          }
        >
          Reveal
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy || row.missing}
          onClick={() => void run(() => openInPreferredEditor(ensureNativeApi(), row.path))}
        >
          Open in editor
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setDetails(!details)}
          aria-expanded={details}
        >
          {details ? "Hide details" : "Inspect"}
        </Button>
        {!inspectOnly && row.classification === "managed" && (
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              void useWorktreeRemovalDialogStore.getState().request([{ projectId, path: row.path }])
            }
          >
            {row.missing ? "Remove stale entry" : "Remove…"}
          </Button>
        )}
      </div>
      {inspectOnly && (
        <p className="text-xs text-muted-foreground">
          Inspect only. Conversations can use the project checkout or this profile’s managed
          worktrees.
        </p>
      )}
      {details && (
        <div role="status" className="space-y-1 rounded bg-muted/40 p-3 text-xs">
          {inspection.isPending ? (
            "Inspecting…"
          ) : inspection.error ? (
            String(inspection.error)
          ) : (
            <>
              <p>
                {inspection.data.blockedReasons.length
                  ? inspection.data.blockedReasons.join("; ")
                  : "Safe to remove"}
              </p>
              {inspection.data.ignoredFiles && (
                <>
                  <WorktreeIgnoredFilesList files={inspection.data.ignoredFiles} />
                  {inspection.data.ignoredFiles.requiresApproval && !inspectOnly && (
                    <p>
                      Choose Remove… to review these paths and explicitly confirm their deletion.
                    </p>
                  )}
                </>
              )}
              <p>
                {inspection.data.branchDeletable
                  ? "Branch may be deleted after removal."
                  : inspection.data.branchBlockedReason}
              </p>
              {inspection.data.headSha && (
                <p className="break-all font-mono">HEAD: {inspection.data.headSha}</p>
              )}
            </>
          )}
        </div>
      )}
    </article>
  );
}

export function WorktreesPage({
  search,
  onProjectChange,
}: {
  search: WorktreesSearch;
  onProjectChange: (id: ProjectId | undefined) => void;
}) {
  const [filter, setFilter] = useState("");
  const [selectedThread, setSelectedThread] = useState<ThreadId | null>(search.threadId ?? null);
  const projects = useStore((s) => s.projects);
  const threads = useThreadSummaries();
  const drafts = useComposerDraftStore((s) => s.draftThreadsByThreadId);
  useEffect(() => setSelectedThread(search.threadId ?? null), [search.threadId]);
  const { handleNewThread } = useHandleNewThread();
  const client = useQueryClient();
  const query = useQuery(worktreesListQueryOptions(search.projectId ?? null));
  const candidateThread = selectedThread
    ? (threads.find((t) => t.id === selectedThread && !t.archivedAt) ?? drafts[selectedThread])
    : null;
  const targetThread =
    candidateThread && (!search.projectId || candidateThread.projectId === search.projectId)
      ? candidateThread
      : null;
  const confirmSharing = async (row: WorktreeListEntry, own: ThreadId | null = null) => {
    // New local drafts already share the project checkout. A transition from
    // another checkout still needs the server's explicit sharing acknowledgment.
    if (row.classification === "projectCheckout" && (!own || !targetThread?.worktreePath))
      return false;
    if (!row.linkedThreads.some((t) => t.threadId !== own)) return false;
    const confirmed = await ensureNativeApi().dialogs.confirm(
      "Other conversations use this checkout. They will share files and uncommitted changes. Continue?",
    );
    if (!confirmed) throw new Error("Workspace sharing was cancelled.");
    return true;
  };
  const useWorkspace = async (projectId: ProjectId, row: WorktreeListEntry) => {
    if (!selectedThread || targetThread?.projectId !== projectId)
      throw new Error("Choose a conversation in this project first.");
    const sharedFilesystemConfirmed = await confirmSharing(row, selectedThread);
    try {
      if (drafts[selectedThread]) {
        useComposerDraftStore.getState().setDraftThreadContext(selectedThread, {
          branch: row.branch,
          worktreePath: row.classification === "projectCheckout" ? null : row.path,
          envMode: row.classification === "projectCheckout" ? "local" : "worktree",
          sharedFilesystemConfirmed,
        });
      } else {
        await switchConversationWorkspace(selectedThread, {
          intent: "attach_existing",
          targetPath: row.path,
          ...(row.branch ? { branch: row.branch } : {}),
          sharedFilesystemConfirmed,
        });
      }
    } finally {
      await client.invalidateQueries({ queryKey: ["worktrees"] });
      await client.invalidateQueries({ queryKey: ["git"] });
    }
  };
  const needle = filter.toLocaleLowerCase();
  const groups = query.data?.projects.map((project) => ({
    ...project,
    entries: project.entries.filter((row) =>
      `${project.name}\n${row.path}\n${row.branch ?? ""}\n${row.linkedThreads.map((t) => t.title).join("\n")}`
        .toLocaleLowerCase()
        .includes(needle),
    ),
  }));
  return (
    <main className="mx-auto max-w-6xl space-y-6 p-4 sm:p-8">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">Worktrees</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Manage checkouts and the conversations that use them.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={query.isFetching}
          onClick={() => void query.refetch()}
        >
          <RefreshCwIcon className="size-4" />
          Refresh
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Input
          aria-label="Search worktrees"
          placeholder="Search branches, paths, conversations…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="min-w-48 flex-1"
        />
        <select
          aria-label="Filter by project"
          className="max-w-full rounded border bg-background p-2 text-sm"
          value={search.projectId ?? ""}
          onChange={(e) => onProjectChange(projects.find((p) => p.id === e.target.value)?.id)}
        >
          <option value="">All projects</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <select
          aria-label="Conversation to switch"
          className="max-w-full rounded border bg-background p-2 text-sm"
          value={targetThread ? (selectedThread ?? "") : ""}
          onChange={(e) => setSelectedThread((e.target.value as ThreadId) || null)}
        >
          <option value="">Choose conversation to switch</option>
          {threads
            .filter((t) => (!search.projectId || t.projectId === search.projectId) && !t.archivedAt)
            .map((t) => (
              <option key={t.id} value={t.id}>
                {t.title}
              </option>
            ))}
          {Object.entries(drafts)
            .filter(([, d]) => !search.projectId || d.projectId === search.projectId)
            .map(([id, draft]) => (
              <option key={id} value={id}>
                New draft · {projects.find((p) => p.id === draft.projectId)?.name} ·{" "}
                {draft.branch ?? "auto"} · {id.slice(-8)}
              </option>
            ))}
        </select>
      </div>
      {query.isPending && <p role="status">Loading worktrees…</p>}
      {query.error && (
        <p role="alert" className="text-destructive">
          {String(query.error)}
        </p>
      )}
      {groups?.map((project) => (
        <section key={project.projectId} className="overflow-hidden rounded-xl border bg-card">
          <div className="space-y-1 p-4">
            <h2 className="font-semibold">{project.name}</h2>
            <p className="break-all whitespace-pre-wrap text-xs text-muted-foreground">
              {project.workspaceRoot}
            </p>
          </div>
          {project.error ? (
            <p role="alert" className="p-4 text-destructive">
              {project.error}
            </p>
          ) : project.entries.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">No matching worktrees.</p>
          ) : (
            project.entries.map((row) => (
              <WorktreeRow
                key={row.canonicalPath}
                row={row}
                projectId={project.projectId}
                threadId={targetThread?.projectId === project.projectId ? selectedThread : null}
                onUse={() => useWorkspace(project.projectId, row)}
                onNew={async () => {
                  const sharedFilesystemConfirmed = await confirmSharing(row);
                  // The project may have been removed while the dialog was open.
                  const stillPresent = useStore
                    .getState()
                    .projects.some((entry) => entry.id === project.projectId);
                  if (!stillPresent) return;
                  const draft = await handleNewThread(project.projectId, {
                    branch: row.branch,
                    worktreePath: row.classification === "projectCheckout" ? null : row.path,
                    envMode: row.classification === "projectCheckout" ? "local" : "worktree",
                    forceNonDefaultEnvMode: true,
                  });
                  if (!draft) return;
                  useComposerDraftStore
                    .getState()
                    .setDraftThreadContext(draft.threadId, { sharedFilesystemConfirmed });
                }}
              />
            ))
          )}
        </section>
      ))}
      {groups?.length === 0 && (
        <p className="text-sm text-muted-foreground">No Git projects found.</p>
      )}
    </main>
  );
}
