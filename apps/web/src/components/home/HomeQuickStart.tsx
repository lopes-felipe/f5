import { ArrowUpIcon, FolderPlusIcon, Maximize2Icon, WorkflowIcon } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import {
  lazy,
  Suspense,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type Ref,
} from "react";

import { useCommandPaletteStore } from "../../commandPaletteStore";
import { useComposerDraftStore } from "../../composerDraftStore";
import { requestComposerFocus } from "../../composerFocusRequestStore";
import { useCreateProjectBackedDraftThread } from "../../hooks/useCreateProjectBackedDraftThread";
import { useStartScratchThread } from "../../hooks/useStartScratchThread";
import { isKeyboardEventComposing } from "../../lib/keyboardComposition";
import { waitForThreadInStore } from "../../lib/threadArrival";
import { isMacPlatform } from "../../lib/utils";
import type { Project } from "../../types";
import { useWorkflowCreateDialogStore } from "../../workflowCreateDialogStore";
import { useServerMutationsAvailable } from "../../wsConnectionState";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { HomeComposerHandle } from "./HomeComposerControls";
import {
  applyHomeComposerSettings,
  homeComposerDraft,
  homeSelectionKey,
} from "./homeComposerDraft";
import {
  HomeProjectPickerPlaceholder,
  type HomeProjectSelection,
  type HomeProjectTarget,
} from "./HomeProjectPickerPlaceholder";

// Home renders at startup; the pickers it needs would otherwise push the initial bundle
// past its budget.
const HomeProjectPicker = lazy(() => import("./HomeProjectPicker"));
const HomeComposerControls = lazy(() => import("./HomeComposerControls"));

export const QUICK_START_PLACEHOLDER = "What should we work on?";

/** A leading `/command` or `$skill`. The thread composer resolves those; Home does not. */
const LEADING_COMMAND_PATTERN = /^[/$][^\s/$]+(?=\s|$)/;

/** Appends quick-start text to a draft without disturbing its mentions. */
export function appendQuickStartText(existingPrompt: string, text: string): string {
  if (existingPrompt.trim().length === 0) return text;
  const separator = existingPrompt.endsWith("\n") ? "" : "\n";
  return `${existingPrompt}${separator}${text}`;
}

/** Whether Home sends this text itself or hands it to the thread composer. */
export function quickStartNeedsFullComposer(text: string): boolean {
  return LEADING_COMMAND_PATTERN.test(text.trim());
}

/**
 * Home's starting point, above the queue: pick a project, a model and how the agent
 * works, describe the task, and the thread starts in the background while Home stays
 * open. Mod+Enter also opens the thread. Attachments, mentions, commands and skills
 * belong to the full composer, which opens with the text typed here.
 */
export function HomeQuickStart(props: {
  readonly projects: ReadonlyArray<Project>;
  readonly defaultSelection: HomeProjectSelection;
  /** The text field, so Home's "/" key can focus it. */
  readonly inputRef?: Ref<HTMLTextAreaElement> | undefined;
}) {
  const createProjectBackedDraftThread = useCreateProjectBackedDraftThread();
  const navigate = useNavigate();
  const startScratchThread = useStartScratchThread();
  const mutationsAvailable = useServerMutationsAvailable();
  const [selected, setSelected] = useState<HomeProjectSelection | null>(null);
  const liveRef = useRef(true);
  useEffect(() => {
    liveRef.current = true;
    return () => {
      liveRef.current = false;
    };
  }, []);
  const [text, setTextState] = useState(homeComposerDraft.text);
  const setText = (next: string) => {
    homeComposerDraft.setText(next);
    setTextState(next);
  };
  const [busy, setBusy] = useState<"send" | "open" | null>(null);
  // Set once the controls have loaded: they hold the settings a send goes out with.
  const [controls, setControls] = useState<HomeComposerHandle | null>(null);
  const selection: HomeProjectSelection =
    selected?.kind === "project" &&
    !props.projects.some((project) => project.id === selected.projectId)
      ? { kind: "none" }
      : (selected ?? props.defaultSelection);
  const projectId = selection.kind === "project" ? selection.projectId : null;
  const selectedProject = props.projects.find((project) => project.id === projectId);
  const target: HomeProjectTarget =
    selection.kind === "none" ? { kind: "none" } : { kind: "project", project: selectedProject };
  const trimmed = text.trim();

  const openFullComposer = async () => {
    if (busy) return;
    setBusy("open");
    try {
      // Home must prefill before navigating: navigation itself unmounts this form.
      // Keep draft creation reusable when the user leaves while creation is pending.
      const selectionKey = homeSelectionKey(selection);
      const envMode = homeComposerDraft.envMode(selectionKey);
      const options = { canNavigate: () => false, ...(envMode ? { envMode } : {}) };
      const result =
        selection.kind === "none"
          ? await startScratchThread({ canNavigate: () => false })
          : await createProjectBackedDraftThread(selection.projectId, options);
      if (!result) return;
      const { threadId } = result;
      const draftStore = useComposerDraftStore.getState();
      const existingPrompt = draftStore.draftsByThreadId[threadId]?.prompt ?? "";
      // A draft that already holds text keeps the model it was written for.
      if (existingPrompt.trim().length === 0) applyHomeComposerSettings(threadId, selectionKey);
      if (trimmed.length > 0) {
        // Without explicit mentions the store reconciles the existing ones
        // against the new prompt; appending keeps every mention range intact.
        draftStore.setPrompt(threadId, appendQuickStartText(existingPrompt, trimmed));
      }
      if (!liveRef.current) return;
      requestComposerFocus(threadId);
      setText("");
      await navigate({ to: "/$threadId", params: { threadId } });
    } catch (error) {
      // Keep the typed text so the user can retry.
      toastManager.add({
        type: "error",
        title: "Could not start thread",
        description: error instanceof Error ? error.message : "An unexpected error occurred.",
      });
    } finally {
      if (liveRef.current) setBusy(null);
    }
  };

  const send = async (open: boolean) => {
    if (busy || trimmed.length === 0) return;
    if (quickStartNeedsFullComposer(trimmed)) {
      await openFullComposer();
      return;
    }
    // Nothing is sent before the settings it goes out with are on screen.
    if (!controls) return;
    if (!mutationsAvailable) {
      toastManager.add({
        type: "info",
        title: "Waiting for connection",
        description: "Your text is kept. Send once F5 has reconnected.",
      });
      return;
    }
    setBusy("send");
    try {
      const { threadId, outcome } = await controls.start(trimmed);
      homeComposerDraft.setText("");
      if (liveRef.current) setTextState("");
      const openThread = () => void navigate({ to: "/$threadId", params: { threadId } });
      // The thread route sends an unknown thread back to Home, so wait for it to arrive.
      if (open && (await waitForThreadInStore(threadId)) && liveRef.current) {
        openThread();
        return;
      }
      toastManager.add({
        type: "success",
        title: outcome === "queued" ? "Thread created, preparing its worktree" : "Thread started",
        actionProps: { children: "Open", onClick: openThread },
      });
    } catch (error) {
      // Keep the typed text so the user can retry.
      toastManager.add({
        type: "error",
        title: "Could not start thread",
        description: error instanceof Error ? error.message : "An unexpected error occurred.",
      });
    } finally {
      if (liveRef.current) setBusy(null);
    }
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void send(false);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey || isKeyboardEventComposing(event.nativeEvent)) {
      return;
    }
    event.preventDefault();
    void send(event.metaKey || event.ctrlKey);
  };

  const modKey = isMacPlatform(navigator.platform) ? "⌘" : "Ctrl";

  return (
    <form
      onSubmit={onSubmit}
      aria-label="Quick start"
      data-slot="home-quick-start"
      className="flex flex-col gap-1 rounded-xl border border-border bg-card p-1.5 shadow-lg/5 transition-colors duration-(--duration-fast) focus-within:border-ring/60"
    >
      <textarea
        ref={props.inputRef}
        aria-label={QUICK_START_PLACEHOLDER}
        placeholder={QUICK_START_PLACEHOLDER}
        value={text}
        rows={1}
        readOnly={busy !== null}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
        // One line that grows with its text, so the queue below keeps its room.
        className="field-sizing-content block max-h-40 min-h-7 w-full resize-none bg-transparent px-2 py-1 text-sm text-foreground outline-none placeholder:text-muted-foreground"
      />
      {/* The chips show their labels by the composer footer's width rule. When the bar is
          too narrow for one row, the buttons take the line below the chips. */}
      <div className="@container/composer-footer flex flex-wrap items-end gap-1">
        <div className="flex min-w-0 flex-1 basis-full flex-wrap items-center gap-0.5 @lg/composer-footer:basis-0">
          <Suspense fallback={<HomeProjectPickerPlaceholder target={target} />}>
            <HomeProjectPicker
              projects={props.projects}
              selection={selection}
              onSelect={setSelected}
            />
          </Suspense>
          <Suspense fallback={null}>
            <HomeComposerControls
              selection={selection}
              project={selectedProject}
              disabled={busy !== null}
              handleRef={setControls}
            />
          </Suspense>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="New workflow"
                  className="text-muted-foreground hover:text-foreground"
                  disabled={!projectId}
                  onClick={() => {
                    if (projectId) useWorkflowCreateDialogStore.getState().open(projectId);
                  }}
                />
              }
            >
              <WorkflowIcon />
            </TooltipTrigger>
            <TooltipPopup side="bottom">New workflow</TooltipPopup>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Add project"
                  className="text-muted-foreground hover:text-foreground"
                  onClick={() => useCommandPaletteStore.getState().openAddProject()}
                />
              }
            >
              <FolderPlusIcon />
            </TooltipTrigger>
            <TooltipPopup side="bottom">Add project</TooltipPopup>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Open full composer"
                  className="text-muted-foreground hover:text-foreground"
                  disabled={busy !== null}
                  onClick={() => void openFullComposer()}
                />
              }
            >
              <Maximize2Icon />
            </TooltipTrigger>
            <TooltipPopup side="bottom">
              Open the full composer for attachments, mentions and commands
            </TooltipPopup>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="submit"
                  size="sm"
                  disabled={busy !== null || trimmed.length === 0 || controls === null}
                />
              }
            >
              Send
              <ArrowUpIcon />
            </TooltipTrigger>
            <TooltipPopup side="bottom">
              Enter starts the thread and stays here. {modKey}+Enter also opens it.
            </TooltipPopup>
          </Tooltip>
        </div>
      </div>
    </form>
  );
}
