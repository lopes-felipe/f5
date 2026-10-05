import type { ProjectId } from "@t3tools/contracts";
import { ArrowUpIcon, FolderPlusIcon, WorkflowIcon } from "lucide-react";
import { useState, type FormEvent, type KeyboardEvent } from "react";

import { useCommandPaletteStore } from "../../commandPaletteStore";
import { useComposerDraftStore } from "../../composerDraftStore";
import { requestComposerFocus } from "../../composerFocusRequestStore";
import { useCreateProjectBackedDraftThread } from "../../hooks/useCreateProjectBackedDraftThread";
import { isKeyboardEventComposing } from "../../lib/keyboardComposition";
import type { Project } from "../../types";
import { useWorkflowCreateDialogStore } from "../../workflowCreateDialogStore";
import { ProjectIcon } from "../ProjectIcon";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { toastManager } from "../ui/toast";

export const QUICK_START_PLACEHOLDER = "What should we work on?";

/** Appends quick-start text to a draft without disturbing its mentions. */
export function appendQuickStartText(existingPrompt: string, text: string): string {
  if (existingPrompt.trim().length === 0) return text;
  const separator = existingPrompt.endsWith("\n") ? "" : "\n";
  return `${existingPrompt}${separator}${text}`;
}

/**
 * Home's starting point: pick a project, describe the work, and land in a new
 * thread with the text in its composer. Start only prefills and focuses; it
 * never sends.
 */
export function HomeQuickStart(props: {
  readonly greeting: string;
  readonly projects: ReadonlyArray<Project>;
  readonly defaultProjectId: ProjectId | null;
}) {
  const createProjectBackedDraftThread = useCreateProjectBackedDraftThread();
  const [selectedProjectId, setSelectedProjectId] = useState<ProjectId | null>(null);
  const [text, setText] = useState("");
  const [starting, setStarting] = useState(false);
  const projectId =
    selectedProjectId && props.projects.some((project) => project.id === selectedProjectId)
      ? selectedProjectId
      : (props.defaultProjectId ?? props.projects[0]?.id ?? null);
  const selectedProject = props.projects.find((project) => project.id === projectId);
  const projectItems = props.projects.map((project) => ({
    value: project.id,
    label: project.name,
  }));

  const start = async () => {
    if (!projectId || starting) return;
    setStarting(true);
    try {
      const { threadId } = await createProjectBackedDraftThread(projectId);
      const trimmed = text.trim();
      if (trimmed.length > 0) {
        const draftStore = useComposerDraftStore.getState();
        const existingPrompt = draftStore.draftsByThreadId[threadId]?.prompt ?? "";
        // Without explicit mentions the store reconciles the existing ones
        // against the new prompt; appending keeps every mention range intact.
        draftStore.setPrompt(threadId, appendQuickStartText(existingPrompt, trimmed));
      }
      requestComposerFocus(threadId);
      setText("");
    } catch (error) {
      // Keep the typed text so the user can retry.
      toastManager.add({
        type: "error",
        title: "Could not start thread",
        description: error instanceof Error ? error.message : "An unexpected error occurred.",
      });
    } finally {
      setStarting(false);
    }
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void start();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey || isKeyboardEventComposing(event.nativeEvent)) {
      return;
    }
    event.preventDefault();
    void start();
  };

  if (props.projects.length === 0) {
    return (
      <div className="flex flex-col gap-4">
        <h1 className="font-heading text-3xl font-semibold tracking-tight text-foreground">
          {props.greeting}
        </h1>
        <div className="flex flex-col items-start gap-3 rounded-xl border border-border bg-card p-5">
          <p className="text-sm text-muted-foreground">
            Add a project to start a thread or a workflow.
          </p>
          <Button onClick={() => useCommandPaletteStore.getState().openAddProject()}>
            <FolderPlusIcon />
            Add a project
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <h1 className="font-heading text-3xl font-semibold tracking-tight text-foreground">
        {props.greeting}
      </h1>
      <form
        onSubmit={onSubmit}
        aria-label="Quick start"
        data-slot="home-quick-start"
        className="rounded-xl border border-border bg-card shadow-lg/5 transition-colors duration-(--duration-fast) focus-within:border-ring/60"
      >
        <textarea
          aria-label={QUICK_START_PLACEHOLDER}
          placeholder={QUICK_START_PLACEHOLDER}
          value={text}
          rows={3}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
          className="block min-h-24 w-full resize-none bg-transparent px-4 pt-4 pb-2 text-sm text-foreground outline-none placeholder:text-muted-foreground"
        />
        <div className="flex flex-wrap items-center gap-1 px-2 pb-2">
          <Select
            value={projectId}
            onValueChange={(value) => setSelectedProjectId(value as ProjectId)}
            items={projectItems}
          >
            <SelectTrigger
              aria-label="Project"
              variant="ghost"
              size="sm"
              className="h-7 max-w-56 gap-1.5 text-ui text-muted-foreground hover:text-foreground"
            >
              {selectedProject ? (
                <ProjectIcon
                  projectId={selectedProject.id}
                  name={selectedProject.name}
                  icon={selectedProject.icon}
                  className="size-3.5"
                />
              ) : null}
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              {props.projects.map((project) => (
                <SelectItem key={project.id} value={project.id}>
                  <span className="inline-flex min-w-0 items-center gap-2">
                    <ProjectIcon
                      projectId={project.id}
                      name={project.name}
                      icon={project.icon}
                      className="size-3.5"
                    />
                    <span className="truncate">{project.name}</span>
                  </span>
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-muted-foreground hover:text-foreground"
            disabled={!projectId}
            onClick={() => {
              if (projectId) useWorkflowCreateDialogStore.getState().open(projectId);
            }}
          >
            <WorkflowIcon />
            New workflow
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-muted-foreground hover:text-foreground"
            onClick={() => useCommandPaletteStore.getState().openAddProject()}
          >
            <FolderPlusIcon />
            Add project
          </Button>
          <Button type="submit" size="sm" className="ms-auto" disabled={!projectId || starting}>
            Start
            <ArrowUpIcon />
          </Button>
        </div>
      </form>
    </div>
  );
}
