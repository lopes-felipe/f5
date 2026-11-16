import {
  DEFAULT_CLIENT_SETTINGS,
  DEFAULT_MODEL_BY_PROVIDER,
  isKnownProviderKind,
  ProviderInstanceId,
  type ProviderKind,
  type ServerProvider,
  type ThreadId,
} from "@t3tools/contracts";
import type { LinkedPrompt } from "@t3tools/shared/promptLinks";
import { Schema } from "effect";
import { resolveProjectProviderInstanceEnabled } from "@t3tools/shared/serverSettings";

import { useComposerDraftStore } from "~/composerDraftStore";
import { cachedGlobalDraftSettings } from "~/lib/draftSettingsDefaults";
import { getAppModelOptionsForInstance } from "~/modelSelection";
import { deriveProviderInstanceEntries } from "~/providerInstances";

import { toastManager } from "../ui/toast";

export function warnAboutHiddenCharacters(prompt: LinkedPrompt): void {
  if (prompt.hiddenCharacters === 0) return;
  toastManager.add({
    type: "warning",
    title: "This prompt had hidden characters, it may be malicious",
    description: `F5 removed ${prompt.hiddenCharacters} hidden character${prompt.hiddenCharacters === 1 ? "" : "s"}. Read the prompt before you send it.`,
    timeout: 0,
  });
}

export interface LinkedModelSelection {
  readonly provider: ProviderKind;
  readonly instanceId: ProviderInstanceId;
  readonly model: string;
}

/**
 * Puts a linked prompt, and the link's model when it has one, in a thread's composer. Nothing is
 * sent. When the thread already has a different draft, neither changes until the user chooses to
 * replace it.
 */
export function placeLinkedPrompt(
  threadId: ThreadId,
  prompt: LinkedPrompt,
  options: {
    readonly notes?: ReadonlyArray<string>;
    readonly selection?: LinkedModelSelection | null;
  } = {},
): void {
  const notes = options.notes ?? [];
  const selection = options.selection ?? null;
  warnAboutHiddenCharacters(prompt);
  const place = () => {
    const draft = useComposerDraftStore.getState();
    if (selection) {
      draft.setProvider(threadId, selection.provider);
      draft.setProviderInstance(threadId, selection.instanceId);
      draft.setModel(threadId, selection.model);
    }
    draft.setPrompt(threadId, prompt.text);
    toastManager.add({
      type: "info",
      title: "Prompt added from a link",
      description: ["Read it before you send.", ...notes].join(" "),
    });
  };
  const existing = useComposerDraftStore.getState().draftsByThreadId[threadId]?.prompt ?? "";
  if (existing.trim().length === 0 || existing === prompt.text) {
    place();
    return;
  }
  const id = toastManager.add({
    type: "info",
    title: "Linked prompt ready",
    description: "This thread already has a draft. Replace it with the linked prompt?",
    timeout: 0,
    actionProps: {
      children: "Replace draft",
      onClick: () => {
        toastManager.close(id);
        place();
      },
    },
  });
}

/**
 * Resolves a link's provider and model against the providers set up and enabled here. A model
 * the provider does not offer falls back to its default. Returns a note for the user when the
 * link's choice could not be honored; nothing changes until the prompt is placed.
 */
export function resolveLinkedModel(
  link: { readonly provider: string | null; readonly model: string | null },
  providers: ReadonlyArray<ServerProvider>,
): { readonly selection: LinkedModelSelection | null; readonly note: string | null } {
  if (link.provider === null) return { selection: null, note: null };
  const notSetUp = {
    selection: null,
    note: `The link asked for ${link.provider}, which is not set up here, so your default model is used.`,
  };
  // A link's provider is untrusted text; one that is not a valid id cannot name a provider here.
  if (!Schema.is(ProviderInstanceId)(link.provider)) return notSetUp;
  const settings = cachedGlobalDraftSettings();
  const instanceId = link.provider;
  const instance = settings.providerInstances[instanceId];
  const driver = instance?.driver ?? link.provider;
  const configured =
    isKnownProviderKind(driver) &&
    (instance !== undefined || link.provider in settings.providers) &&
    resolveProjectProviderInstanceEnabled(settings, undefined, instanceId);
  if (!configured) return notSetUp;
  const provider = driver as ProviderKind;
  const selection = { provider, instanceId, model: DEFAULT_MODEL_BY_PROVIDER[provider] };
  if (link.model === null) return { selection, note: null };
  const entry = deriveProviderInstanceEntries(providers).find(
    (candidate) => candidate.instanceId === instanceId,
  );
  const offered =
    entry !== undefined &&
    getAppModelOptionsForInstance(
      { ...settings, providerModelPreferences: DEFAULT_CLIENT_SETTINGS.providerModelPreferences },
      entry,
    ).some((option) => option.slug === link.model);
  if (offered) return { selection: { ...selection, model: link.model }, note: null };
  return {
    selection,
    note: `The link asked for a model ${link.provider} does not offer here, so its default model is used.`,
  };
}
