import type {
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderKind,
  ResolvedKeybindingsConfig,
  ServerProviderModel,
  ThreadId,
} from "@t3tools/contracts";
import { useEffect, useRef } from "react";

import { useComposerDraftStore } from "../../composerDraftStore";
import {
  addFavoritePreset,
  applyPresetEffort,
  findNextSelectableFavoritePresetIndex,
  formatFavoritePresetLabel,
  MODEL_FAVORITE_SAVE_EVENT,
  type FavoritePreset,
  type FavoritePresetSelection,
  type UsableFavoritePreset,
} from "../../favoritePresets";
import { modelFavoriteJumpIndexFromCommand, resolveShortcutCommand } from "../../keybindings";
import { isKeyboardEventComposing } from "../../lib/keyboardComposition";
import { isTerminalFocused } from "../../lib/terminalFocus";
import { providerModelOptionsToSelections } from "../../providerModelOptions";
import { toastManager } from "../ui/toast";
import { getComposerEffortDescriptors } from "./composerProviderState";
import { getDisplayModelName, type ModelPickerModelOption } from "./providerIconUtils";

export interface FavoritePresetShortcutsInput {
  readonly threadId: ThreadId | null;
  readonly keybindings: ResolvedKeybindingsConfig;
  readonly modelPickerOpen: boolean;
  readonly terminalOpen: boolean;
  /** Send in flight, approval or blocking question, or disconnected. */
  readonly blocked: boolean;
  readonly favorites: ReadonlyArray<FavoritePreset>;
  /** Usable presets in favorites order: favorite N is `presets[N - 1]`. */
  readonly presets: ReadonlyArray<UsableFavoritePreset>;
  /** The composer's place in `presets`, or -1. */
  readonly currentIndex: number;
  readonly current: {
    readonly instanceId: ProviderInstanceId;
    readonly model: string;
    readonly effort: string | null;
  };
  readonly modelOptionsByInstance: ReadonlyMap<
    ProviderInstanceId,
    ReadonlyArray<ModelPickerModelOption>
  >;
  /** Null when the thread may switch to any instance; otherwise names its locked provider. */
  readonly lockedProviderLabel: string | null;
  readonly canSelectInstance: (
    instanceId: ProviderInstanceId,
    driver: ProviderDriverKind,
  ) => boolean;
  /** Selects the preset's model and pinned effort; null when the selection was refused. */
  readonly selectPreset: (preset: UsableFavoritePreset) => FavoritePresetSelection | null;
  readonly isDialogEvent: (event: KeyboardEvent) => boolean;
  readonly saveFavorites: (favorites: ReadonlyArray<FavoritePreset>) => void;
}

/**
 * Sets a preset's pinned effort on the composer draft after its model was
 * selected. A model without that effort keeps its sticky or default effort.
 * Persists as sticky, like `composer.effortUp/Down`.
 */
export function applyFavoritePresetEffort(input: {
  readonly threadId: ThreadId;
  readonly provider: ProviderKind | null;
  readonly driver: ProviderDriverKind;
  readonly model: string;
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly effort: string;
}): boolean {
  const store = useComposerDraftStore.getState();
  const draft = store.draftsByThreadId[input.threadId];
  const selections = input.provider
    ? providerModelOptionsToSelections(input.provider, draft?.modelOptions)
    : undefined;
  const next = applyPresetEffort(
    getComposerEffortDescriptors({
      provider: input.driver,
      model: input.model,
      models: input.models,
      modelOptions: selections,
    }),
    selections,
    input.effort,
  );
  if (!next) return false;
  store.setProviderModelOptions(input.threadId, input.driver, next, {
    model: input.model,
    persistSticky: true,
  });
  return true;
}

let lastToastId: string | null = null;

function showFavoriteToast(toast: Parameters<typeof toastManager.add>[0]) {
  // One toast at a time: quick successive presses replace it rather than stacking.
  if (lastToastId) toastManager.close(lastToastId);
  lastToastId = toastManager.add({ timeout: 2_500, ...toast });
}

function modelName(
  instance: {
    readonly instanceId: ProviderInstanceId;
    readonly isDefault: boolean;
    readonly displayName: string;
  },
  model: string,
  modelOptionsByInstance: FavoritePresetShortcutsInput["modelOptionsByInstance"],
): string {
  const option = modelOptionsByInstance
    .get(instance.instanceId)
    ?.find((candidate) => candidate.slug === model);
  const name = option ? getDisplayModelName(option) : model;
  return instance.isDefault ? name : `${instance.displayName} · ${name}`;
}

/**
 * Global `model.favorite.*` keys: cycle through favorite presets, jump to
 * preset N, or save the composer's model and effort as a preset (also sent by
 * the command palette through {@link MODEL_FAVORITE_SAVE_EVENT}).
 */
export function useFavoritePresetShortcuts(input: FavoritePresetShortcutsInput): void {
  const inputRef = useRef(input);
  useEffect(() => {
    inputRef.current = input;
  });

  useEffect(() => {
    const lockedToast = () =>
      showFavoriteToast({
        type: "info",
        title: `Locked to ${inputRef.current.lockedProviderLabel ?? "this provider"} in this thread`,
      });

    const canSelect = (preset: UsableFavoritePreset) =>
      inputRef.current.canSelectInstance(preset.instance.instanceId, preset.instance.driverKind);

    // The toast reports what was applied, not what the preset asked for.
    const applyPreset = (index: number) => {
      const latest = inputRef.current;
      const preset = latest.presets[index];
      if (!preset) return;
      const name = modelName(preset.instance, preset.model, latest.modelOptionsByInstance);
      const selection = latest.selectPreset(preset);
      if (!selection) {
        showFavoriteToast({ type: "info", title: `Couldn't switch to ${name}` });
        return;
      }
      const effortSkipped = preset.effort !== undefined && selection.effort === null;
      showFavoriteToast({
        type: "info",
        title: `${formatFavoritePresetLabel(name, selection.effort ?? undefined)} (${index + 1}/${latest.presets.length})`,
        ...(effortSkipped
          ? { description: `${preset.effort} isn't available for this model.` }
          : {}),
      });
    };

    const noPresetsToast = () =>
      showFavoriteToast({
        type: "info",
        title: "No favorite models yet",
        description: "Star models in the model picker.",
      });

    const cycle = (direction: 1 | -1) => {
      const latest = inputRef.current;
      if (latest.presets.length === 0) return noPresetsToast();
      const index = findNextSelectableFavoritePresetIndex(
        latest.presets,
        latest.currentIndex,
        direction,
        canSelect,
      );
      if (index < 0) return lockedToast();
      applyPreset(index);
    };

    const jump = (index: number) => {
      const latest = inputRef.current;
      if (latest.presets.length === 0) return noPresetsToast();
      const preset = latest.presets[index];
      if (!preset) {
        showFavoriteToast({
          type: "info",
          title: `No favorite ${index + 1}`,
          description: `You have ${latest.presets.length} favorite ${latest.presets.length === 1 ? "model" : "models"}.`,
        });
        return;
      }
      if (!canSelect(preset)) return lockedToast();
      applyPreset(index);
    };

    const saveCurrent = () => {
      const latest = inputRef.current;
      const { instanceId, model, effort } = latest.current;
      const preset: FavoritePreset = {
        provider: instanceId,
        model,
        ...(effort ? { effort } : {}),
      };
      const { favorites, added } = addFavoritePreset(latest.favorites, preset);
      if (added) latest.saveFavorites(favorites);
      const option = latest.modelOptionsByInstance
        .get(instanceId)
        ?.find((candidate) => candidate.slug === model);
      const label = formatFavoritePresetLabel(
        option ? getDisplayModelName(option) : model,
        preset.effort,
      );
      showFavoriteToast({
        type: added ? "success" : "info",
        title: added ? `Saved ${label} as a favorite` : `${label} is already a favorite`,
      });
    };

    const onKeyDown = (event: KeyboardEvent) => {
      const latest = inputRef.current;
      if (!latest.threadId || event.defaultPrevented || isKeyboardEventComposing(event)) return;
      const terminalFocus = isTerminalFocused();
      const dialogFocus = latest.isDialogEvent(event);
      const command = resolveShortcutCommand(event, latest.keybindings, {
        context: {
          terminalFocus,
          terminalOpen: latest.terminalOpen,
          dialogFocus,
          modelPickerOpen: latest.modelPickerOpen,
        },
      });
      if (!command?.startsWith("model.favorite.")) return;
      // Terminals and dialogs keep their keys even under a custom binding
      // that drops the default when clause.
      if (terminalFocus || dialogFocus) return;
      event.preventDefault();
      event.stopPropagation();
      // Auto-repeat is ignored: holding the key switches once.
      if (event.repeat || latest.blocked) return;
      if (command === "model.favorite.next") cycle(1);
      else if (command === "model.favorite.previous") cycle(-1);
      else if (command === "model.favorite.saveCurrent") saveCurrent();
      else {
        const index = modelFavoriteJumpIndexFromCommand(command);
        if (index !== null) jump(index);
      }
    };

    const onSaveEvent = (event: Event) => {
      const latest = inputRef.current;
      if ((event as CustomEvent<ThreadId>).detail !== latest.threadId || latest.blocked) return;
      saveCurrent();
    };

    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener(MODEL_FAVORITE_SAVE_EVENT, onSaveEvent);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener(MODEL_FAVORITE_SAVE_EVENT, onSaveEvent);
    };
  }, []);
}
