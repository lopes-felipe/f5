import type {
  ModelSlug,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderKind,
  ProviderOptionSelection,
  ResolvedKeybindingsConfig,
  ServerProviderModel,
  ThreadId,
} from "@t3tools/contracts";
import { useEffect, useRef } from "react";

import { useComposerDraftStore } from "../../composerDraftStore";
import {
  addFavoritePreset,
  applyPresetEffort,
  findCurrentFavoritePresetIndex,
  formatFavoritePresetLabel,
  getCurrentEffort,
  listUsableFavoritePresets,
  MODEL_FAVORITE_SAVE_EVENT,
  stepFavoritePresetIndex,
  type FavoritePreset,
  type UsableFavoritePreset,
} from "../../favoritePresets";
import { modelFavoriteJumpIndexFromCommand, resolveShortcutCommand } from "../../keybindings";
import { isKeyboardEventComposing } from "../../lib/keyboardComposition";
import { isTerminalFocused } from "../../lib/terminalFocus";
import { providerModelOptionsToSelections } from "../../providerModelOptions";
import type { ProviderInstanceEntry } from "../../providerInstances";
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
  readonly entries: ReadonlyArray<ProviderInstanceEntry>;
  readonly modelOptionsByInstance: ReadonlyMap<
    ProviderInstanceId,
    ReadonlyArray<ModelPickerModelOption>
  >;
  readonly current: {
    readonly instanceId: ProviderInstanceId;
    readonly driver: ProviderDriverKind;
    readonly model: string;
    readonly models: ReadonlyArray<ServerProviderModel>;
    readonly modelOptions: ReadonlyArray<ProviderOptionSelection> | undefined;
  };
  /** Null when the thread may switch to any instance; otherwise names its locked provider. */
  readonly lockedProviderLabel: string | null;
  readonly canSelectInstance: (
    instanceId: ProviderInstanceId,
    driver: ProviderDriverKind,
  ) => boolean;
  /** Selects the model, then applies `effort` when given (see {@link applyFavoritePresetEffort}). */
  readonly selectModel: (
    instanceId: ProviderInstanceId,
    driver: ProviderDriverKind,
    model: ModelSlug,
    effort?: string,
  ) => void;
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
  // One toast at a time: a held cycle key replaces it rather than stacking.
  if (lastToastId) toastManager.close(lastToastId);
  lastToastId = toastManager.add({ timeout: 2_500, ...toast });
}

function presetName(
  preset: UsableFavoritePreset,
  modelOptionsByInstance: FavoritePresetShortcutsInput["modelOptionsByInstance"],
): string {
  const option = modelOptionsByInstance
    .get(preset.instance.instanceId)
    ?.find((candidate) => candidate.slug === preset.model);
  const name = option ? getDisplayModelName(option) : preset.model;
  return preset.instance.isDefault ? name : `${preset.instance.displayName} · ${name}`;
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
    const applyPreset = (preset: UsableFavoritePreset, position: string) => {
      const latest = inputRef.current;
      if (!latest.threadId) return;
      const { instanceId, driverKind } = preset.instance;
      if (preset.effort) latest.selectModel(instanceId, driverKind, preset.model, preset.effort);
      else latest.selectModel(instanceId, driverKind, preset.model);
      showFavoriteToast({
        type: "info",
        title: `${formatFavoritePresetLabel(
          presetName(preset, latest.modelOptionsByInstance),
          preset.effort,
        )} ${position}`,
      });
    };

    const usablePresets = () => {
      const latest = inputRef.current;
      return listUsableFavoritePresets(
        latest.favorites,
        latest.entries,
        latest.modelOptionsByInstance,
      );
    };

    const currentEffort = () => {
      const { current } = inputRef.current;
      return getCurrentEffort(
        getComposerEffortDescriptors({
          provider: current.driver,
          model: current.model,
          models: current.models,
          modelOptions: current.modelOptions,
        }),
      );
    };

    const noPresetsToast = () =>
      showFavoriteToast({
        type: "info",
        title: "No favorite models yet",
        description: "Star models in the model picker.",
      });

    const cycle = (direction: 1 | -1) => {
      const latest = inputRef.current;
      const presets = usablePresets();
      if (presets.length === 0) {
        noPresetsToast();
        return;
      }
      let index = findCurrentFavoritePresetIndex(presets, {
        instanceId: latest.current.instanceId,
        model: latest.current.model,
        effort: currentEffort(),
      });
      // At most one lap, skipping presets the thread's provider lock refuses.
      for (let step = 0; step < presets.length; step += 1) {
        index = stepFavoritePresetIndex(presets.length, index, direction);
        const preset = presets[index]!;
        if (latest.canSelectInstance(preset.instance.instanceId, preset.instance.driverKind)) {
          applyPreset(preset, `(${index + 1}/${presets.length})`);
          return;
        }
      }
      showFavoriteToast({
        type: "info",
        title: `Locked to ${latest.lockedProviderLabel ?? "this provider"} in this thread`,
      });
    };

    const jump = (index: number) => {
      const latest = inputRef.current;
      const presets = usablePresets();
      if (presets.length === 0) {
        noPresetsToast();
        return;
      }
      const preset = presets[index];
      if (!preset) {
        showFavoriteToast({
          type: "info",
          title: `No favorite ${index + 1}`,
          description: `You have ${presets.length} favorite ${presets.length === 1 ? "model" : "models"}.`,
        });
        return;
      }
      if (!latest.canSelectInstance(preset.instance.instanceId, preset.instance.driverKind)) {
        showFavoriteToast({
          type: "info",
          title: `Locked to ${latest.lockedProviderLabel ?? "this provider"} in this thread`,
        });
        return;
      }
      applyPreset(preset, `(${index + 1}/${presets.length})`);
    };

    const saveCurrent = () => {
      const latest = inputRef.current;
      const effort = currentEffort();
      const preset: FavoritePreset = {
        provider: latest.current.instanceId,
        model: latest.current.model,
        ...(effort ? { effort } : {}),
      };
      const { favorites, added } = addFavoritePreset(latest.favorites, preset);
      if (added) latest.saveFavorites(favorites);
      const option = latest.modelOptionsByInstance
        .get(latest.current.instanceId)
        ?.find((candidate) => candidate.slug === latest.current.model);
      const label = formatFavoritePresetLabel(
        option ? getDisplayModelName(option) : latest.current.model,
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
