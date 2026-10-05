import { useEffect, useRef, useState } from "react";
import { create } from "zustand";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ensureNativeApi } from "../nativeApi";
import { useCreateProjectBackedDraftThread } from "../hooks/useCreateProjectBackedDraftThread";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { toastManager } from "./ui/toast";

const useCloneDialog = create<{ open: boolean; parentPath: string }>(() => ({
  open: false,
  parentPath: "",
}));
export function openProjectCloneDialog(parentPath = "") {
  useCloneDialog.setState({ open: true, parentPath });
}
const queryKey = ["project-clones"] as const;
export function cloneDirectoryName(url: string): string {
  return (
    url
      .trim()
      .replace(/[?#].*$/, "")
      .replace(/\/+$/, "")
      .split(/[/:]/)
      .at(-1)
      ?.replace(/\.git$/, "") ?? ""
  );
}
export function ProjectCloneController() {
  const { open, parentPath } = useCloneDialog();
  const [url, setUrl] = useState("");
  const [directoryName, setDirectoryName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const operation = useRef<{ key: string; id: string } | null>(null);
  const client = useQueryClient();
  const createThread = useCreateProjectBackedDraftThread();
  const jobs = useQuery({
    queryKey,
    queryFn: () => ensureNativeApi().projects.cloneList(),
    refetchInterval: (query) =>
      query.state.data?.some((job) => job.status === "queued" || job.status === "cloning")
        ? 1000
        : 10_000,
  });
  const announced = useRef(new Map<string, string>());
  const initialized = useRef(false);
  useEffect(() => {
    if (!jobs.data) return;
    for (const job of jobs.data) {
      const active = job.status === "queued" || job.status === "cloning";
      const previous = announced.current.get(job.operationId);
      const signature = `${job.status}:${job.progress}`;
      if (!initialized.current && !active) {
        announced.current.set(job.operationId, signature);
        continue;
      }
      if (previous === signature) continue;
      const id = `clone:${job.operationId}`;
      const cancel = async () => {
        try {
          await ensureNativeApi().projects.cloneCancel({ operationId: job.operationId });
          await client.invalidateQueries({ queryKey });
        } catch (cause) {
          toastManager.add({
            type: "error",
            title: "Could not cancel clone",
            description: String(cause),
          });
        }
      };
      const toast = {
        id,
        type: active ? "loading" : job.status === "complete" ? "success" : "warning",
        title: `${job.directoryName}: ${active ? job.progress : job.status === "complete" ? "Project ready" : job.status}`,
        description: job.error ?? job.destination,
        timeout: active ? 0 : 10_000,
        actionProps: {
          children: active ? "Cancel" : job.status === "complete" ? "New thread" : "Details",
          onClick: () => {
            if (active) void cancel();
            else if (job.status === "complete") void createThread(job.projectId);
            else openProjectCloneDialog(job.parentPath);
          },
        },
      };
      if (previous) toastManager.update(id, toast);
      else toastManager.add(toast);
      announced.current.set(job.operationId, signature);
    }
    initialized.current = true;
  }, [jobs.data, client, createThread]);
  return (
    <Dialog open={open} onOpenChange={(next) => useCloneDialog.setState({ open: next })}>
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Clone repository</DialogTitle>
          <DialogDescription>
            Clone in the background and add the finished repository as a project.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (pending) return;
              const key = JSON.stringify([url.trim(), parentPath.trim(), directoryName.trim()]);
              if (operation.current?.key !== key)
                operation.current = { key, id: crypto.randomUUID() };
              setPending(true);
              setError(null);
              void ensureNativeApi()
                .projects.clone({
                  operationId: operation.current.id,
                  url,
                  parentPath,
                  directoryName,
                })
                .then((job) => {
                  client.setQueryData(queryKey, (previous: typeof jobs.data) => [
                    ...(previous ?? []).filter((entry) => entry.operationId !== job.operationId),
                    job,
                  ]);
                  useCloneDialog.setState({ open: false });
                })
                .catch((cause: unknown) =>
                  setError(cause instanceof Error ? cause.message : String(cause)),
                )
                .finally(() => setPending(false));
            }}
          >
            <label className="block text-sm">
              Repository URL or owner/repository
              <Input
                value={url}
                onChange={(event) => {
                  setUrl(event.target.value);
                  setDirectoryName(cloneDirectoryName(event.target.value));
                }}
                placeholder="https://github.com/owner/repository"
                disabled={pending}
              />
            </label>
            <label className="block text-sm">
              Parent folder
              <div className="flex gap-2">
                <Input
                  value={parentPath}
                  onChange={(event) => useCloneDialog.setState({ parentPath: event.target.value })}
                  disabled={pending}
                />
                <Button
                  type="button"
                  variant="outline"
                  disabled={pending}
                  onClick={() => {
                    void ensureNativeApi()
                      .dialogs.pickFolder()
                      .then((folder) => {
                        if (folder) useCloneDialog.setState({ parentPath: folder });
                      })
                      .catch((cause: unknown) => setError(String(cause)));
                  }}
                >
                  Browse
                </Button>
              </div>
            </label>
            <label className="block text-sm">
              New folder name
              <Input
                value={directoryName}
                onChange={(event) => setDirectoryName(event.target.value)}
                disabled={pending}
              />
            </label>
            <p className="text-xs text-muted-foreground">
              The destination must not exist. Cancelling keeps any downloaded files.
            </p>
            {error && (
              <p role="alert" className="text-sm text-destructive-foreground">
                {error}
              </p>
            )}
            <Button
              type="submit"
              disabled={pending || !url.trim() || !parentPath.trim() || !directoryName.trim()}
            >
              {pending ? "Starting…" : "Clone in background"}
            </Button>
          </form>
          {jobs.data && jobs.data.length > 0 && (
            <details className="mt-4 text-xs">
              <summary>Recent clones</summary>
              <ul className="mt-2 max-h-40 space-y-2 overflow-auto">
                {jobs.data
                  .slice(-10)
                  .reverse()
                  .map((job) => (
                    <li key={job.operationId}>
                      <strong>{job.directoryName}</strong>: {job.status}
                      <p className="break-all text-muted-foreground">
                        {job.error ?? job.destination}
                      </p>
                    </li>
                  ))}
              </ul>
            </details>
          )}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
