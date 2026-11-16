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

import { type AppSettings, useAppSettingsSelector } from "../../appSettings";
import { useCommandPaletteStore } from "../../commandPaletteStore";
import { useComposerDraftStore } from "../../composerDraftStore";
import { requestComposerFocus } from "../../composerFocusRequestStore";
import { useCreateProjectBackedDraftThread } from "../../hooks/useCreateProjectBackedDraftThread";
import { useStartScratchThread } from "../../hooks/useStartScratchThread";
import { isKeyboardEventComposing } from "../../lib/keyboardComposition";
import { replyNeedsComposer } from "../../lib/sendThreadReply";
import { waitForThreadInStore } from "../../lib/threadArrival";
import { isMacPlatform } from "../../lib/utils";
import type { Project } from "../../types";
import { useWorkflowCreateDialogStore } from "../../workflowCreateDialogStore";
import { useServerMutationsAvailable } from "../../wsConnectionState";
import { composerSendShortcutLabel, shouldSubmitComposer } from "../chat/composer/sendShortcut";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { HomeComposerHandle } from "./HomeComposerControls";
import {
  applyHomeComposerSettings,
  homeComposerDraft,
  homeSelectionKey,
  useHomeComposerTextStore,
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

/** Appends quick-start text to a draft without disturbing its mentions. */
export function appendQuickStartText(existingPrompt: string, text: string): string {
  if (existingPrompt.trim().length === 0) return text;
  const separator = existingPrompt.endsWith("\n") ? "" : "\n";
  return `${existingPrompt}${separator}${text}`;
}

/**
 * Whether Home sends this text itself or hands it to the thread composer, which resolves
 * a leading `/command` or `$skill`.
 */
export function quickStartNeedsFullComposer(text: string): boolean {
  return replyNeedsComposer(text);
}

/** What Enter does in Home's box. */
export type QuickStartEnterAction = "send" | "send-and-open" | "newline";

/**
 * Home follows the send shortcut setting, as the thread composer does: with a setting that
 * asks for the modifier, a plain Enter is a new line and never starts an agent. Mod+Enter
 * is the other way to send only with the plain Enter setting, the rule the new-thread
 * composer has for its background send: there it sends and stays, here it sends and opens.
 */
export function quickStartEnterAction(input: {
  readonly shortcut: AppSettings["sendShortcut"];
  readonly text: string;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly modifierKey: boolean;
}): QuickStartEnterAction {
  if (input.shortcut === "enter" && input.modifierKey && !input.shiftKey && !input.altKey) {
    return "send-and-open";
  }
  return shouldSubmitComposer({ ...input, prompt: input.text }) ? "send" : "newline";
}

/**
 * Home's starting point, above the queue: pick a project, a model and how the agent
 * works, describe the task, and the thread starts in the background while Home stays
 * open. With the plain Enter send shortcut, Mod+Enter also opens the thread. Attachments,
 * mentions, commands and skills belong to the full composer, which opens with the text
 * typed here.
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
  const sendShortcut = useAppSettingsSelector((settings) => settings.sendShortcut);
  const [selected, setSelected] = useState<HomeProjectSelection | null>(null);
  const liveRef = useRef(true);
  useEffect(() => {
    liveRef.current = true;
    return () => {
      liveRef.current = false;
    };
  }, []);
  // Both live outside the component: leaving Home and coming back while a send is still
  // in flight finds the same text, still busy, and sees it cleared when the answer arrives.
  const text = useHomeComposerTextStore((state) => state.text);
  const busy = useHomeComposerTextStore((state) => state.busy);
  const { setText, setBusy } = homeComposerDraft;
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
    if (homeComposerDraft.busy()) return;
    const handedText = text;
    // Taken now: another project can be picked while the draft is being created, and Home
    // then shows that project's settings, not the ones this text was written with.
    const settings = controls?.settings() ?? null;
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
      // A draft that already holds text keeps the model and modes it was written for. An
      // empty one takes what Home showed, if Home's controls had loaded it.
      if (existingPrompt.trim().length === 0 && settings) {
        applyHomeComposerSettings(threadId, settings);
      }
      if (trimmed.length > 0) {
        // Without explicit mentions the store reconciles the existing ones
        // against the new prompt; appending keeps every mention range intact.
        draftStore.setPrompt(threadId, appendQuickStartText(existingPrompt, trimmed));
      }
      // The draft has the text now. Clear the box even when Home was left meanwhile, or
      // the same task would wait in both places.
      homeComposerDraft.clearSentText(handedText);
      if (!liveRef.current) return;
      requestComposerFocus(threadId);
      await navigate({ to: "/$threadId", params: { threadId } });
    } catch (error) {
      // Keep the typed text so the user can retry.
      toastManager.add({
        type: "error",
        title: "Could not start thread",
        description: error instanceof Error ? error.message : "An unexpected error occurred.",
      });
    } finally {
      setBusy(null);
    }
  };

  const send = async (open: boolean) => {
    if (homeComposerDraft.busy() || trimmed.length === 0) return;
    if (quickStartNeedsFullComposer(trimmed)) {
      await openFullComposer();
      return;
    }
    // Nothing is sent before the settings it goes out with are on screen.
    if (!controls) {
      toastManager.add({
        type: "info",
        title: "Still loading",
        description: "Your text is kept. Send once the model and access controls are shown.",
      });
      return;
    }
    if (!mutationsAvailable) {
      toastManager.add({
        type: "info",
        title: "Waiting for connection",
        description: "Your text is kept. Send once F5 has reconnected.",
      });
      return;
    }
    const sentText = text;
    setBusy("send");
    try {
      const { threadId, outcome } = await controls.start(trimmed);
      // Only what was sent: Home may have been left and reopened, and new text typed.
      homeComposerDraft.clearSentText(sentText);
      // The thread route sends an unknown thread back to Home, and the thread's creation
      // event can land after the answer that named it: every way to open it waits for it.
      const arrived = () => waitForThreadInStore(threadId);
      const openThread = () => navigate({ to: "/$threadId", params: { threadId } });
      if (open && (await arrived()) && liveRef.current) {
        await openThread();
        return;
      }
      toastManager.add({
        type: "success",
        title: outcome === "queued" ? "Thread created, preparing its worktree" : "Thread started",
        actionProps: {
          children: "Open",
          onClick: async () => {
            if (await arrived()) {
              await openThread();
              return;
            }
            toastManager.add({
              type: "info",
              title: "The thread is not ready yet",
              description: "It shows up under Running once it has been created.",
            });
          },
        },
      });
    } catch (error) {
      // Keep the typed text so the user can retry.
      toastManager.add({
        type: "error",
        title: "Could not start thread",
        description: error instanceof Error ? error.message : "An unexpected error occurred.",
      });
    } finally {
      setBusy(null);
    }
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void send(false);
  };

  const isMac = isMacPlatform(navigator.platform);
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || isKeyboardEventComposing(event.nativeEvent)) return;
    const action = quickStartEnterAction({
      shortcut: sendShortcut,
      text,
      shiftKey: event.shiftKey,
      altKey: event.altKey,
      modifierKey: isMac ? event.metaKey : event.ctrlKey,
    });
    // The text box adds the line itself.
    if (action === "newline") return;
    event.preventDefault();
    void send(action === "send-and-open");
  };

  const sendKeyLabel = composerSendShortcutLabel(sendShortcut, text, isMac);
  const sendTooltip =
    sendShortcut === "enter"
      ? `Enter starts the thread and stays here. ${isMac ? "⌘" : "Ctrl+"}Enter also opens it.`
      : `${sendKeyLabel} starts the thread and stays here.`;

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
            <TooltipPopup side="bottom">{sendTooltip}</TooltipPopup>
          </Tooltip>
        </div>
      </div>
    </form>
  );
}
