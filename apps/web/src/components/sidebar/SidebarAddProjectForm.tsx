import type { ProjectId } from "@t3tools/contracts";
import { FolderIcon } from "lucide-react";
import { useCallback, useRef, useState } from "react";

import { isElectron } from "../../env";
import { registerProjectFromPath } from "../../lib/registerProject";
import { readNativeApi } from "../../nativeApi";
import type { Project } from "../../types";
import { toastManager } from "../ui/toast";

/**
 * Add-project flow. Electron opens the folder picker immediately; the web
 * build shows an inline path field. An existing path focuses that project's
 * latest thread instead of registering a duplicate.
 */
export function useAddProject(input: {
  projects: ReadonlyArray<Project>;
  onProjectAdded: (projectId: ProjectId) => Promise<unknown>;
  onExistingProject: (projectId: ProjectId) => void;
}) {
  const { projects, onProjectAdded, onExistingProject } = input;
  const [addingProject, setAddingProject] = useState(false);
  const [newCwd, setNewCwd] = useState("");
  const [isPickingFolder, setIsPickingFolder] = useState(false);
  const [isAddingProject, setIsAddingProject] = useState(false);
  const [addProjectError, setAddProjectError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const shouldBrowseForProjectImmediately = isElectron;
  const showPathEntry = addingProject && !shouldBrowseForProjectImmediately;

  const addProjectFromPath = useCallback(
    async (rawCwd: string) => {
      const cwd = rawCwd.trim();
      if (!cwd || isAddingProject) return;
      const api = readNativeApi();
      if (!api) return;

      setIsAddingProject(true);
      const finishAddingProject = () => {
        setIsAddingProject(false);
        setNewCwd("");
        setAddProjectError(null);
        setAddingProject(false);
      };

      const existing = projects.find((project) => project.cwd === cwd);
      if (existing) {
        onExistingProject(existing.id);
        finishAddingProject();
        return;
      }

      try {
        const project = await registerProjectFromPath(cwd);
        const projectId = project.id;
        await onProjectAdded(projectId).catch((error) => {
          console.warn("Failed to open the new thread after creating a project", error);
        });
      } catch (error) {
        const description =
          error instanceof Error ? error.message : "An error occurred while adding the project.";
        setIsAddingProject(false);
        if (shouldBrowseForProjectImmediately) {
          toastManager.add({
            type: "error",
            title: "Failed to add project",
            description,
          });
        } else {
          setAddProjectError(description);
        }
        return;
      }
      finishAddingProject();
    },
    [
      isAddingProject,
      onExistingProject,
      onProjectAdded,
      projects,
      shouldBrowseForProjectImmediately,
    ],
  );

  const handleAddProject = () => {
    void addProjectFromPath(newCwd);
  };

  const canAddProject = newCwd.trim().length > 0 && !isAddingProject;

  const handlePickFolder = async () => {
    const api = readNativeApi();
    if (!api || isPickingFolder) return;
    setIsPickingFolder(true);
    let pickedPath: string | null = null;
    try {
      pickedPath = await api.dialogs.pickFolder();
    } catch {
      // Ignore picker failures and leave the current thread selection unchanged.
    }
    if (pickedPath) {
      await addProjectFromPath(pickedPath);
    } else if (!shouldBrowseForProjectImmediately) {
      inputRef.current?.focus();
    }
    setIsPickingFolder(false);
  };

  const handleStartAddProject = () => {
    setAddProjectError(null);
    if (shouldBrowseForProjectImmediately) {
      void handlePickFolder();
      return;
    }
    setAddingProject((prev) => !prev);
  };

  const cancel = () => {
    setAddingProject(false);
    setAddProjectError(null);
  };

  return {
    showPathEntry,
    newCwd,
    setNewCwd: (value: string) => {
      setNewCwd(value);
      setAddProjectError(null);
    },
    isPickingFolder,
    isAddingProject,
    addProjectError,
    canAddProject,
    inputRef,
    handleAddProject,
    handlePickFolder,
    handleStartAddProject,
    cancel,
  };
}

export type AddProjectController = ReturnType<typeof useAddProject>;

export function SidebarAddProjectForm({ controller }: { controller: AddProjectController }) {
  return (
    <div className="mb-2 px-1">
      {isElectron && (
        <button
          type="button"
          className="mb-1.5 flex w-full items-center justify-center gap-2 rounded-md border border-border bg-secondary py-1.5 text-xs text-foreground transition-colors duration-150 hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
          onClick={() => void controller.handlePickFolder()}
          disabled={controller.isPickingFolder || controller.isAddingProject}
        >
          <FolderIcon className="size-3.5" />
          {controller.isPickingFolder ? "Picking folder..." : "Browse for folder"}
        </button>
      )}
      <div className="flex gap-1.5">
        <input
          ref={controller.inputRef}
          className={`min-w-0 flex-1 rounded-md border bg-secondary px-2 py-1 font-mono text-base text-foreground placeholder:text-muted-foreground focus:outline-none sm:text-xs ${
            controller.addProjectError
              ? "border-destructive/70 focus:border-destructive"
              : "border-border focus:border-ring"
          }`}
          placeholder="/path/to/project"
          value={controller.newCwd}
          onChange={(event) => {
            controller.setNewCwd(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") controller.handleAddProject();
            if (event.key === "Escape") {
              controller.cancel();
            }
          }}
          autoFocus
        />
        <button
          type="button"
          className="shrink-0 rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground transition-colors duration-150 hover:bg-primary/90 disabled:opacity-60"
          onClick={controller.handleAddProject}
          disabled={!controller.canAddProject}
        >
          {controller.isAddingProject ? "Adding..." : "Add"}
        </button>
      </div>
      {controller.addProjectError && (
        <p className="mt-1 px-0.5 text-2xs leading-tight text-destructive-foreground">
          {controller.addProjectError}
        </p>
      )}
      <div className="mt-1.5 px-0.5">
        <button
          type="button"
          className="text-2xs text-muted-foreground transition-colors hover:text-foreground"
          onClick={controller.cancel}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
