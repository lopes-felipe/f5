/**
 * Favorite model presets: a favorite is a provider instance, a model and an
 * optional pinned reasoning effort. The same model may appear more than once
 * with different efforts, and the favorites order is the order that the
 * `model.favorite.*` keys and the picker's Favorites view use.
 */
import type {
  ModelSlug,
  ProviderInstanceId,
  ProviderOptionDescriptor,
  ProviderOptionSelection,
} from "@t3tools/contracts";
import {
  buildProviderOptionSelectionsFromDescriptors,
  getProviderOptionCurrentValue,
  resolveSelectableModel,
} from "@t3tools/shared/model";

import { findEffortSelectDescriptor } from "./components/chat/effortLevels";
import type { ProviderInstanceEntry } from "./providerInstances";

/** Window event the command palette sends to save the composer's model as a preset. */
export const MODEL_FAVORITE_SAVE_EVENT = "f5:model-favorite-save";

export interface FavoritePreset {
  readonly provider: ProviderInstanceId;
  readonly model: string;
  readonly effort?: string | undefined;
}

/** What selecting a preset actually applied. */
export interface FavoritePresetSelection {
  readonly model: ModelSlug;
  /** The pinned effort, or null when the preset has none or the model doesn't offer it. */
  readonly effort: string | null;
}

export interface UsableFavoritePreset {
  readonly instance: ProviderInstanceEntry;
  /** The model resolved against the instance's current options. */
  readonly model: ModelSlug;
  readonly effort: string | undefined;
  /** The stored entry, for removing exactly this preset. */
  readonly favorite: FavoritePreset;
}

export function isSelectableProviderInstance(
  instance: Pick<ProviderInstanceEntry, "enabled" | "isAvailable" | "status">,
): boolean {
  return (
    instance.enabled &&
    instance.isAvailable &&
    instance.status !== "error" &&
    instance.status !== "disabled"
  );
}

export function isSameFavoritePreset(left: FavoritePreset, right: FavoritePreset): boolean {
  return (
    left.provider === right.provider &&
    left.model === right.model &&
    (left.effort ?? null) === (right.effort ?? null)
  );
}

/**
 * Presets the keyboard and picker can apply now, in favorites order. Drops
 * presets on unselectable instances and models the instance no longer offers.
 */
export function listUsableFavoritePresets(
  favorites: ReadonlyArray<FavoritePreset>,
  entries: ReadonlyArray<ProviderInstanceEntry>,
  modelOptionsByInstance: ReadonlyMap<
    ProviderInstanceId,
    ReadonlyArray<{ readonly slug: string; readonly name: string }>
  >,
): UsableFavoritePreset[] {
  const usable: UsableFavoritePreset[] = [];
  for (const favorite of favorites) {
    const instance = entries.find((entry) => entry.instanceId === favorite.provider);
    if (!instance || !isSelectableProviderInstance(instance)) continue;
    const model = resolveSelectableModel(
      instance.driverKind,
      favorite.model,
      modelOptionsByInstance.get(instance.instanceId) ?? [],
    );
    if (!model) continue;
    const preset: UsableFavoritePreset = { instance, model, effort: favorite.effort, favorite };
    if (
      usable.some(
        (existing) =>
          existing.instance.instanceId === instance.instanceId &&
          existing.model === model &&
          (existing.effort ?? null) === (favorite.effort ?? null),
      )
    )
      continue;
    usable.push(preset);
  }
  return usable;
}

/**
 * Index of the preset matching the composer: same instance, model and effort
 * first, then the first preset for the same instance and model, else -1.
 */
export function findCurrentFavoritePresetIndex(
  presets: ReadonlyArray<UsableFavoritePreset>,
  current: {
    readonly instanceId: ProviderInstanceId;
    readonly model: string;
    readonly effort: string | null;
  },
): number {
  const sameModel = (preset: UsableFavoritePreset) =>
    preset.instance.instanceId === current.instanceId && preset.model === current.model;
  const exact = presets.findIndex(
    (preset) =>
      sameModel(preset) && preset.effort !== undefined && preset.effort === current.effort,
  );
  return exact >= 0 ? exact : presets.findIndex(sameModel);
}

/**
 * The composer's place among the presets. The preset applied last wins while
 * the composer still shows it: an effort-less preset keeps the model's sticky
 * effort, so matching by effort alone would land on a sibling preset of the
 * same model and stall the cycle. Otherwise falls back to
 * {@link findCurrentFavoritePresetIndex}.
 */
export function resolveCurrentFavoritePresetIndex(
  presets: ReadonlyArray<UsableFavoritePreset>,
  current: {
    readonly instanceId: ProviderInstanceId;
    readonly model: string;
    readonly effort: string | null;
  },
  lastApplied: FavoritePreset | null,
): number {
  if (lastApplied) {
    const index = presets.findIndex((preset) => isSameFavoritePreset(preset.favorite, lastApplied));
    const preset = presets[index];
    if (
      preset &&
      preset.instance.instanceId === current.instanceId &&
      preset.model === current.model &&
      (preset.effort === undefined || preset.effort === current.effort)
    )
      return index;
  }
  return findCurrentFavoritePresetIndex(presets, current);
}

/** Next index in a wrapping cycle; from -1, forward starts at 0 and backward at the end. */
export function stepFavoritePresetIndex(
  length: number,
  currentIndex: number,
  direction: 1 | -1,
): number {
  if (length <= 0) return -1;
  if (currentIndex < 0) return direction === 1 ? 0 : length - 1;
  return (currentIndex + direction + length) % length;
}

/**
 * The next preset `canSelect` accepts, at most one lap from `currentIndex`.
 * -1 when every preset is refused (a thread locked to another provider).
 */
export function findNextSelectableFavoritePresetIndex(
  presets: ReadonlyArray<UsableFavoritePreset>,
  currentIndex: number,
  direction: 1 | -1,
  canSelect: (preset: UsableFavoritePreset) => boolean,
): number {
  let index = currentIndex;
  for (let step = 0; step < presets.length; step += 1) {
    index = stepFavoritePresetIndex(presets.length, index, direction);
    if (canSelect(presets[index]!)) return index;
  }
  return -1;
}

/** The effort the descriptors currently resolve to (selected or default). */
export function getCurrentEffort(
  descriptors: ReadonlyArray<ProviderOptionDescriptor>,
): string | null {
  const value = getProviderOptionCurrentValue(findEffortSelectDescriptor(descriptors));
  return typeof value === "string" ? value : null;
}

/**
 * Model options with the effort select set to `effort`, keeping unrelated
 * traits. Null when the model has no effort select or doesn't offer `effort`,
 * so the model keeps its sticky or default effort.
 */
export function applyPresetEffort(
  descriptors: ReadonlyArray<ProviderOptionDescriptor>,
  modelOptions: ReadonlyArray<ProviderOptionSelection> | null | undefined,
  effort: string,
): ProviderOptionSelection[] | null {
  const descriptor = findEffortSelectDescriptor(descriptors);
  if (!descriptor || !descriptor.options.some((option) => option.id === effort)) return null;
  const next =
    buildProviderOptionSelectionsFromDescriptors(
      descriptors.map((entry) =>
        entry.id === descriptor.id ? { ...descriptor, currentValue: effort } : entry,
      ),
    ) ?? [];
  const updatedIds = new Set(next.map((entry) => entry.id));
  return [...(modelOptions ?? []).filter((entry) => !updatedIds.has(entry.id)), ...next];
}

export function formatFavoritePresetLabel(modelName: string, effort: string | undefined): string {
  return effort ? `${modelName} · ${effort}` : modelName;
}

/** Appends a preset unless an identical one exists. */
export function addFavoritePreset(
  favorites: ReadonlyArray<FavoritePreset>,
  preset: FavoritePreset,
): { readonly favorites: ReadonlyArray<FavoritePreset>; readonly added: boolean } {
  if (favorites.some((favorite) => isSameFavoritePreset(favorite, preset)))
    return { favorites, added: false };
  return { favorites: [...favorites, preset], added: true };
}

export function removeFavoritePreset(
  favorites: ReadonlyArray<FavoritePreset>,
  preset: FavoritePreset,
): FavoritePreset[] {
  return favorites.filter((favorite) => !isSameFavoritePreset(favorite, preset));
}

/**
 * Model-level star: removes every preset for the model, or adds an
 * effort-less preset when there is none.
 */
export function toggleModelFavorite(
  favorites: ReadonlyArray<FavoritePreset>,
  provider: ProviderInstanceId,
  model: string,
): FavoritePreset[] {
  const matches = (favorite: FavoritePreset) =>
    favorite.provider === provider && favorite.model === model;
  return favorites.some(matches)
    ? favorites.filter((favorite) => !matches(favorite))
    : [...favorites, { provider, model }];
}

/**
 * Reconciles one instance's favorites with a list of favorite model slugs
 * (from Settings), keeping positions and pinned efforts of models that stay.
 */
export function withInstanceFavoriteModels(
  favorites: ReadonlyArray<FavoritePreset>,
  instanceId: ProviderInstanceId,
  models: ReadonlyArray<string>,
): FavoritePreset[] {
  const wanted = new Set(models);
  const kept = favorites.filter(
    (favorite) => favorite.provider !== instanceId || wanted.has(favorite.model),
  );
  const present = new Set(
    kept.filter((favorite) => favorite.provider === instanceId).map((favorite) => favorite.model),
  );
  return [
    ...kept,
    ...[...wanted]
      .filter((model) => !present.has(model))
      .map((model) => ({ provider: instanceId, model })),
  ];
}
