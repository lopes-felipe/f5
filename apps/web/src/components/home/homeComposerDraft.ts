import { type ThreadEnvMode, ThreadId } from "@t3tools/contracts";

import { useComposerDraftStore } from "../../composerDraftStore";
import type { HomeProjectSelection } from "./HomeProjectPickerPlaceholder";

/**
 * Where Home keeps the model, effort and modes for the thread it will start. It is a
 * composer draft with no thread behind it, so nothing shows in the sidebar until a
 * message is sent.
 */
export const HOME_COMPOSER_DRAFT_ID = ThreadId.makeUnsafe("home-composer");

export function homeSelectionKey(selection: HomeProjectSelection): string {
  return selection.kind === "none" ? "none" : selection.projectId;
}

/**
 * The selection the draft's settings were last taken from. Switching projects starts from
 * that project's new-thread defaults, as a new thread there would; a reload does too.
 */
let seededSelection: string | null = null;
let chosenEnvMode: { readonly selection: string; readonly mode: ThreadEnvMode } | null = null;
let text = "";

export const homeComposerDraft = {
  seededFor: (): string | null => seededSelection,
  markSeeded: (selection: string): void => {
    seededSelection = selection;
  },
  /** The workspace picked on Home for this selection; null follows the project's default. */
  envMode: (selection: string): ThreadEnvMode | null =>
    chosenEnvMode?.selection === selection ? chosenEnvMode.mode : null,
  setEnvMode: (selection: string, mode: ThreadEnvMode): void => {
    chosenEnvMode = { selection, mode };
  },
  /** The typed text outlives a trip to another page. */
  text: (): string => text,
  setText: (next: string): void => {
    text = next;
  },
  resetForTests: (): void => {
    seededSelection = null;
    chosenEnvMode = null;
    text = "";
  },
};

/**
 * Gives a thread draft the model, effort and modes shown on Home, so the full composer
 * opens with what was on screen. Does nothing until Home's controls have loaded them
 * for this selection.
 */
export function applyHomeComposerSettings(threadId: ThreadId, selection: string): void {
  if (seededSelection !== selection) return;
  const drafts = useComposerDraftStore.getState();
  const home = drafts.draftsByThreadId[HOME_COMPOSER_DRAFT_ID];
  if (!home) return;
  if (home.provider) drafts.setProvider(threadId, home.provider);
  if (home.providerInstanceId) drafts.setProviderInstance(threadId, home.providerInstanceId);
  if (home.model) drafts.setModel(threadId, home.model);
  if (home.modelOptions) drafts.setModelOptions(threadId, home.modelOptions);
  if (home.runtimeMode) {
    drafts.setRuntimeMode(threadId, home.runtimeMode);
    drafts.setDraftThreadContext(threadId, { runtimeMode: home.runtimeMode });
  }
  if (home.interactionMode) {
    drafts.setInteractionMode(threadId, home.interactionMode);
    drafts.setDraftThreadContext(threadId, { interactionMode: home.interactionMode });
  }
}
