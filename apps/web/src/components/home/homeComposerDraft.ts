import {
  type ProviderInstanceId,
  type ProviderInteractionMode,
  type ProviderKind,
  type ProviderModelOptions,
  type RuntimeMode,
  type ThreadEnvMode,
  ThreadId,
} from "@t3tools/contracts";
import { create } from "zustand";

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

interface HomeComposerTextState {
  /** The typed text; it outlives a trip to another page. */
  readonly text: string;
  /**
   * What the box is doing with its text: starting a thread, or handing it to the full
   * composer. Kept here, not in the component, so the box is still busy when Home is left
   * and reopened before the server answered: the text on screen is the one in flight.
   */
  readonly busy: "send" | "open" | null;
}

export const useHomeComposerTextStore = create<HomeComposerTextState>(() => ({
  text: "",
  busy: null,
}));

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
  text: (): string => useHomeComposerTextStore.getState().text,
  setText: (text: string): void => {
    useHomeComposerTextStore.setState({ text });
  },
  /** Clears the box only while it still holds `sent`: text typed since was never sent. */
  clearSentText: (sent: string): void => {
    if (useHomeComposerTextStore.getState().text === sent) {
      useHomeComposerTextStore.setState({ text: "" });
    }
  },
  busy: (): HomeComposerTextState["busy"] => useHomeComposerTextStore.getState().busy,
  setBusy: (busy: HomeComposerTextState["busy"]): void => {
    useHomeComposerTextStore.setState({ busy });
  },
  resetForTests: (): void => {
    seededSelection = null;
    chosenEnvMode = null;
    useHomeComposerTextStore.setState({ text: "", busy: null });
  },
};

/** The model, effort and modes Home shows, as they were at one moment. */
export interface HomeComposerSettings {
  readonly provider: ProviderKind | null;
  readonly providerInstanceId: ProviderInstanceId | null;
  readonly model: string | null;
  /** Null when Home shows the model's defaults. */
  readonly modelOptions: ProviderModelOptions | null;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
}

/**
 * The settings on Home right now, to hand to the full composer later. `modes` are the ones
 * Home resolved and displayed, which may be a project default the Home draft never stored.
 * Null until Home's controls have loaded the settings for this selection.
 *
 * Read them before anything is awaited: Home keeps one draft for every project, so picking
 * another project while the thread draft is being created replaces what is read here.
 */
export function readHomeComposerSettings(
  selection: string,
  modes: Pick<HomeComposerSettings, "runtimeMode" | "interactionMode">,
): HomeComposerSettings | null {
  if (seededSelection !== selection) return null;
  const home = useComposerDraftStore.getState().draftsByThreadId[HOME_COMPOSER_DRAFT_ID];
  return {
    provider: home?.provider ?? null,
    providerInstanceId: home?.providerInstanceId ?? null,
    model: home?.model ?? null,
    modelOptions: home?.modelOptions ?? null,
    ...modes,
  };
}

/**
 * Gives a thread draft the settings read from Home, so the full composer opens with what
 * was on screen. The effort and both modes are always written, or a reused draft would
 * keep ones Home did not show.
 */
export function applyHomeComposerSettings(
  threadId: ThreadId,
  settings: HomeComposerSettings,
): void {
  const drafts = useComposerDraftStore.getState();
  if (settings.provider) drafts.setProvider(threadId, settings.provider);
  if (settings.providerInstanceId) {
    drafts.setProviderInstance(threadId, settings.providerInstanceId);
  }
  if (settings.model) drafts.setModel(threadId, settings.model);
  drafts.setModelOptions(threadId, settings.modelOptions);
  drafts.setRuntimeMode(threadId, settings.runtimeMode);
  drafts.setInteractionMode(threadId, settings.interactionMode);
  drafts.setDraftThreadContext(threadId, {
    runtimeMode: settings.runtimeMode,
    interactionMode: settings.interactionMode,
  });
}
