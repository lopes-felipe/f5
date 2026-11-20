import { PinIcon } from "lucide-react";
import { useState } from "react";
import type { Project } from "../types";
import { ensureNativeApi } from "../nativeApi";
import { newCommandId } from "../lib/utils";
import { toastManager } from "./ui/toast";

export async function updateProjectVisibility(
  projectId: Project["id"],
  patch: { pinned?: boolean; archived?: boolean },
) {
  await ensureNativeApi().orchestration.dispatchCommand({
    type: "project.meta.update",
    commandId: newCommandId(),
    projectId,
    ...patch,
  });
}

export function ProjectPinButton({ project }: { project: Project }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      aria-label={`${project.pinned ? "Unpin" : "Pin"} ${project.name}`}
      aria-pressed={Boolean(project.pinned)}
      disabled={busy}
      className="inline-flex size-6 shrink-0 items-center justify-center rounded hover:bg-accent disabled:opacity-50"
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (busy) return;
        setBusy(true);
        void updateProjectVisibility(project.id, { pinned: !project.pinned })
          .catch((error) => {
            toastManager.add({
              type: "error",
              title: "Could not update project pin",
              description: String(error),
            });
          })
          .finally(() => setBusy(false));
      }}
    >
      <PinIcon
        aria-hidden
        className={project.pinned ? "size-3.5 fill-current" : "size-3.5 opacity-50"}
      />
    </button>
  );
}

export function ProjectArchiveButton({ project }: { project: Project }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      disabled={busy}
      className="rounded border border-border px-2 py-1 text-xs hover:bg-accent disabled:opacity-50"
      aria-label={`${project.archived ? "Restore" : "Archive"} project ${project.name}`}
      onClick={() => {
        if (busy) return;
        setBusy(true);
        void updateProjectVisibility(project.id, { archived: !project.archived })
          .catch((error) => {
            toastManager.add({
              type: "error",
              title: "Could not update project archive",
              description: String(error),
            });
          })
          .finally(() => setBusy(false));
      }}
    >
      {project.archived ? "Restore" : "Archive"}
    </button>
  );
}
