import { useState } from "react";
import { create } from "zustand";

import { useCreateProjectBackedDraftThread } from "../hooks/useCreateProjectBackedDraftThread";
import { waitForProjectInStore } from "../lib/projectArrival";
import { ensureNativeApi } from "../nativeApi";
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

const useCreateNewDialog = create<{ open: boolean }>(() => ({ open: false }));
export function openProjectCreateNewDialog() {
  useCreateNewDialog.setState({ open: true });
}

/** "New project": an empty Git repository from just a name, opened on its first thread. */
export function ProjectCreateNewController() {
  const { open } = useCreateNewDialog();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const createThread = useCreateProjectBackedDraftThread();
  return (
    <Dialog open={open} onOpenChange={(next) => useCreateNewDialog.setState({ open: next })}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>New project</DialogTitle>
          <DialogDescription>
            Creates a folder with a README and a first commit in your projects folder, set in
            Settings.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (pending || !name.trim()) return;
              setPending(true);
              setError(null);
              void ensureNativeApi()
                .projects.createNew({ name: name.trim() })
                .then(async (result) => {
                  useCreateNewDialog.setState({ open: false });
                  setName("");
                  if (result.warning)
                    toastManager.add({
                      type: "warning",
                      title: "Project created with a problem",
                      description: result.warning,
                    });
                  await waitForProjectInStore(result.projectId);
                  // A fresh repository has nothing to branch from, so its first thread works
                  // in the main checkout.
                  await createThread(result.projectId, {
                    branch: null,
                    worktreePath: null,
                    envMode: "local",
                  });
                })
                .catch((cause: unknown) =>
                  setError(cause instanceof Error ? cause.message : String(cause)),
                )
                .finally(() => setPending(false));
            }}
          >
            <label className="block text-sm">
              Name
              <Input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="My project"
                maxLength={100}
                autoFocus
                disabled={pending}
              />
            </label>
            {error && (
              <p role="alert" className="text-sm text-destructive-foreground">
                {error}
              </p>
            )}
            <Button type="submit" disabled={pending || !name.trim()}>
              {pending ? "Creating…" : "Create project"}
            </Button>
          </form>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
