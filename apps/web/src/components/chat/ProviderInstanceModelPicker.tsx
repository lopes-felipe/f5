import { filterPickerVisibleModels } from "./providerIconUtils";
import { isKeyboardEventComposing } from "../../lib/keyboardComposition";
import {
  modelPickerJumpCommandForIndex,
  modelPickerJumpIndexFromCommand,
  resolveShortcutCommand,
  shortcutLabelForCommand,
} from "~/keybindings";
import {
  type FavoritePreset,
  isSameFavoritePreset,
  isSelectableProviderInstance,
  listUsableFavoritePresets,
  removeFavoritePreset,
  toggleModelFavorite,
} from "~/favoritePresets";
import {
  type ModelSlug,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ResolvedKeybindingsConfig,
  type ServerProvider,
} from "@t3tools/contracts";
import { resolveSelectableModel } from "@t3tools/shared/model";
import { BoxIcon, ChevronDownIcon, SearchIcon, StarIcon } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { VariantProps } from "class-variance-authority";

import { type UnifiedWebSettings, useSettings, useUpdateSettings } from "../../hooks/useSettings";
import {
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
  type ProviderInstanceEntry,
} from "../../providerInstances";
import { Button, buttonVariants } from "../ui/button";
import { Input } from "../ui/input";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipProvider, TooltipTrigger } from "../ui/tooltip";
import { cn } from "~/lib/utils";
import { COMPOSER_CHIP_CLASS_NAME } from "./composer/composerChip";
import { ModelPickerSidebarRail, type ModelPickerSidebarRailItem } from "./ModelPickerSidebar";
import {
  getDisplayModelName,
  getTriggerDisplayModelLabel,
  getTriggerDisplayModelName,
  type ModelPickerModelOption,
  PROVIDER_ICON_BY_PROVIDER,
  providerIconClassName,
} from "./providerIconUtils";
import { getModelCompanyLabel } from "./providerInstanceModelGrouping";

interface InstanceModelItem extends ModelPickerModelOption {
  readonly instance: ProviderInstanceEntry;
  /** Set on Favorites rows: the stored preset, which may pin an effort. */
  readonly preset?: FavoritePreset | undefined;
  /** Zero-based favorite number shared with `model.favorite.N`, across all instances. */
  readonly presetIndex?: number | undefined;
}

type ModelPickerSource =
  | { readonly kind: "favorites" }
  | { readonly kind: "instance"; readonly instanceId: ProviderInstanceId };

const INSTANCE_SIDEBAR_ID_PREFIX = "instance:";

function selectFavoriteSettings(settings: UnifiedWebSettings) {
  return { favorites: settings.favorites };
}

function instanceSidebarId(instanceId: ProviderInstanceId): string {
  return `${INSTANCE_SIDEBAR_ID_PREFIX}${instanceId}`;
}

function modelKey(instanceId: ProviderInstanceId, model: string): string {
  return `${instanceId}\0${model}`;
}

function itemKey(item: InstanceModelItem): string {
  const base = modelKey(item.instance.instanceId, item.slug);
  return item.preset ? `${base}\0${item.preset.effort ?? ""}` : base;
}

function unavailableReason(instance: ProviderInstanceEntry): string | null {
  if (isSelectableProviderInstance(instance)) return null;
  return (
    instance.snapshot.message ??
    instance.snapshot.unavailableReason ??
    `${instance.displayName} is unavailable.`
  );
}

function matchesSearch(item: InstanceModelItem, query: string): boolean {
  const tokens = query.trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean);
  if (tokens.length === 0) return true;
  const haystack = [
    item.instance.displayName,
    item.instance.instanceId,
    item.instance.driverKind,
    item.name,
    item.shortName,
    item.slug,
    item.subProvider,
    getModelCompanyLabel({
      driverKind: item.instance.driverKind,
      instanceDisplayName: item.instance.displayName,
      name: item.name,
      slug: item.slug,
      subProvider: item.subProvider,
    }),
  ]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLocaleLowerCase();
  return tokens.every((token) => haystack.includes(token));
}

export const ProviderInstanceModelPicker = memo(function ProviderInstanceModelPicker(props: {
  instanceId: ProviderInstanceId;
  model: ModelSlug;
  lockedInstanceId: ProviderInstanceId | null;
  providers: ReadonlyArray<ServerProvider>;
  modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelPickerModelOption>>;
  keybindings?: ResolvedKeybindingsConfig | undefined;
  ultrathinkActive?: boolean;
  compact?: boolean;
  docked?: boolean;
  disabled?: boolean;
  terminalOpen?: boolean;
  open?: boolean;
  triggerVariant?: VariantProps<typeof buttonVariants>["variant"] | undefined;
  triggerClassName?: string | undefined;
  onOpenChange?: ((open: boolean) => void) | undefined;
  /** `preset` is the picked Favorites row's stored preset, only with `favoritePresets`. */
  onInstanceModelChange: (
    instanceId: ProviderInstanceId,
    driver: ProviderDriverKind,
    model: ModelSlug,
    preset?: FavoritePreset,
  ) => unknown;
  /**
   * Favorites rows are presets: a model may appear once per pinned effort, and
   * picking one passes the preset. Off, Favorites lists each model once.
   */
  favoritePresets?: boolean;
  /** The preset the composer currently shows, marked active among the Favorites rows. */
  activePreset?: FavoritePreset | null;
  /** Models chosen for multi-model fan-out; more than one shows a combined trigger. */
  selectedModels?: ReadonlyArray<{
    readonly instanceId: ProviderInstanceId;
    readonly model: string;
  }>;
  /** Shift-click toggles a model for fan-out instead of replacing the selection. */
  onToggleModel?:
    | ((instanceId: ProviderInstanceId, driver: ProviderDriverKind, model: ModelSlug) => void)
    | undefined;
}) {
  const settings = useSettings(selectFavoriteSettings);
  const { updateSettings } = useUpdateSettings();
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const [search, setSearch] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const isOpen = props.open ?? uncontrolledOpen;
  const entries = useMemo(
    () => sortProviderInstanceEntries(deriveProviderInstanceEntries(props.providers)),
    [props.providers],
  );
  const activeInstanceId = props.lockedInstanceId ?? props.instanceId;
  const selectedInstance =
    entries.find((entry) => entry.instanceId === activeInstanceId) ?? entries[0] ?? null;
  const visibleEntries = props.lockedInstanceId
    ? entries.filter((entry) => entry.instanceId === props.lockedInstanceId)
    : entries;
  const favoriteKeys = useMemo(
    () => new Set(settings.favorites.map((entry) => modelKey(entry.provider, entry.model))),
    [settings.favorites],
  );
  const [selectedSource, setSelectedSource] = useState<ModelPickerSource>(() =>
    favoriteKeys.has(modelKey(activeInstanceId, props.model))
      ? { kind: "favorites" }
      : selectedInstance
        ? { kind: "instance", instanceId: selectedInstance.instanceId }
        : { kind: "favorites" },
  );
  const isSearching = search.trim().length > 0;
  const showFavorites = !isSearching && selectedSource.kind === "favorites";
  // Favorites follow the stored order. With presets on, rows carry their
  // favorite number across every instance, so `mod+N` here and `model.favorite.N`
  // name the same preset even when a locked thread hides other instances.
  const favoriteItems = useMemo((): InstanceModelItem[] => {
    if (!showFavorites) return [];
    const optionFor = (instanceId: ProviderInstanceId, slug: string): ModelPickerModelOption =>
      props.modelOptionsByInstance.get(instanceId)?.find((option) => option.slug === slug) ?? {
        slug,
        name: slug,
      };
    const seen = new Set<string>();
    const out: InstanceModelItem[] = [];
    const push = (item: InstanceModelItem) => {
      const key = itemKey(item);
      if (seen.has(key)) return;
      seen.add(key);
      out.push(item);
    };
    const visibleIds = new Set(visibleEntries.map((entry) => entry.instanceId));
    listUsableFavoritePresets(settings.favorites, entries, props.modelOptionsByInstance).forEach(
      (preset, presetIndex) => {
        if (!visibleIds.has(preset.instance.instanceId)) return;
        push({
          ...optionFor(preset.instance.instanceId, preset.model),
          instance: preset.instance,
          ...(props.favoritePresets ? { preset: preset.favorite, presetIndex } : {}),
        });
      },
    );
    // Favorites on an unavailable instance stay visible (disabled) after the usable ones.
    for (const favorite of settings.favorites) {
      const instance = visibleEntries.find((entry) => entry.instanceId === favorite.provider);
      if (!instance || isSelectableProviderInstance(instance)) continue;
      push({
        ...optionFor(instance.instanceId, favorite.model),
        instance,
        ...(props.favoritePresets ? { preset: favorite } : {}),
      });
    }
    return out;
  }, [
    entries,
    props.favoritePresets,
    props.modelOptionsByInstance,
    settings.favorites,
    showFavorites,
    visibleEntries,
  ]);
  const groups = useMemo(() => {
    if (showFavorites) {
      return favoriteItems.length > 0 ? [{ company: "Favorites", items: favoriteItems }] : [];
    }
    const byCompany = new Map<string, InstanceModelItem[]>();
    for (const instance of visibleEntries) {
      if (
        !isSearching &&
        selectedSource.kind === "instance" &&
        instance.instanceId !== selectedSource.instanceId
      ) {
        continue;
      }
      const selectedSlugs = new Set(
        (props.selectedModels ?? [])
          .filter((selected) => selected.instanceId === instance.instanceId)
          .map((selected) => selected.model),
      );
      if (instance.instanceId === activeInstanceId) selectedSlugs.add(props.model);
      for (const model of filterPickerVisibleModels(
        props.modelOptionsByInstance.get(instance.instanceId) ?? [],
        selectedSlugs,
      )) {
        const item = { ...model, instance } satisfies InstanceModelItem;
        if (!matchesSearch(item, search)) continue;
        const company = getModelCompanyLabel({
          driverKind: instance.driverKind,
          instanceDisplayName: instance.displayName,
          name: model.name,
          slug: model.slug,
          subProvider: model.subProvider,
        });
        const group = byCompany.get(company);
        if (group) group.push(item);
        else byCompany.set(company, [item]);
      }
    }

    return Array.from(byCompany, ([company, groupItems]) => ({
      company,
      items: groupItems.toSorted((left, right) => {
        const favoriteDelta =
          Number(favoriteKeys.has(modelKey(right.instance.instanceId, right.slug))) -
          Number(favoriteKeys.has(modelKey(left.instance.instanceId, left.slug)));
        if (favoriteDelta !== 0) return favoriteDelta;
        // The catalog has already applied capability and manual ordering.
        // Stable sorting groups favorites without replacing that order with names.
        return 0;
      }),
    }));
  }, [
    favoriteItems,
    favoriteKeys,
    isSearching,
    props.modelOptionsByInstance,
    activeInstanceId,
    props.model,
    props.selectedModels,
    search,
    selectedSource,
    showFavorites,
    visibleEntries,
  ]);
  const items = useMemo(() => groups.flatMap((group) => group.items), [groups]);
  // `mod+N` targets: favorite N on numbered preset rows, otherwise row N.
  const jumpTargets = useMemo((): ReadonlyArray<InstanceModelItem | undefined> => {
    const numbered = items.some((item) => item.presetIndex !== undefined);
    return Array.from({ length: 9 }, (_, index) =>
      numbered ? items.find((item) => item.presetIndex === index) : items[index],
    );
  }, [items]);
  const jumpLabelByItem = useMemo(() => {
    const labels = new Map<InstanceModelItem, string>();
    jumpTargets.forEach((item, index) => {
      const command = modelPickerJumpCommandForIndex(index);
      const label = command ? shortcutLabelForCommand(props.keybindings ?? [], command) : null;
      if (item && label) labels.set(item, label);
    });
    return labels;
  }, [jumpTargets, props.keybindings]);
  const selectedOptions = selectedInstance
    ? (props.modelOptionsByInstance.get(selectedInstance.instanceId) ?? [])
    : [];
  const selectedModel =
    selectedOptions.find((option) => option.slug === props.model) ??
    ({ slug: props.model, name: props.model } satisfies ModelPickerModelOption);
  const DriverIcon = selectedInstance
    ? PROVIDER_ICON_BY_PROVIDER[selectedInstance.driverKind]
    : undefined;
  const sidebarItems = useMemo<ModelPickerSidebarRailItem[]>(
    () =>
      visibleEntries.flatMap((instance) => {
        const reason = unavailableReason(instance);
        if (reason !== null) return [];
        return [
          {
            id: instanceSidebarId(instance.instanceId),
            label: instance.displayName,
            icon: PROVIDER_ICON_BY_PROVIDER[instance.driverKind] ?? BoxIcon,
            iconClassName: providerIconClassName(instance.driverKind),
            isCustom: !instance.isDefault,
            accentColor: instance.accentColor,
          } satisfies ModelPickerSidebarRailItem,
        ];
      }),
    [visibleEntries],
  );

  const setOpen = useCallback(
    (open: boolean) => {
      props.onOpenChange?.(open);
      if (props.open === undefined) setUncontrolledOpen(open);
      if (open && !props.lockedInstanceId) {
        setSelectedSource(
          favoriteKeys.has(modelKey(activeInstanceId, props.model))
            ? { kind: "favorites" }
            : selectedInstance
              ? { kind: "instance", instanceId: selectedInstance.instanceId }
              : visibleEntries[0]
                ? { kind: "instance", instanceId: visibleEntries[0].instanceId }
                : { kind: "favorites" },
        );
      }
      if (!open) setSearch("");
    },
    [
      favoriteKeys,
      activeInstanceId,
      props.lockedInstanceId,
      props.model,
      props.onOpenChange,
      props.open,
      selectedInstance?.instanceId,
      visibleEntries,
    ],
  );

  useEffect(() => {
    if (!isOpen) return;
    const frame = window.requestAnimationFrame(() => searchRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [isOpen]);

  useEffect(() => {
    if (props.disabled && isOpen) setOpen(false);
  }, [isOpen, props.disabled, setOpen]);

  const selectModel = (item: InstanceModelItem, additive = false) => {
    if (props.disabled || !isSelectableProviderInstance(item.instance)) return;
    const resolved = resolveSelectableModel(
      item.instance.driverKind,
      item.slug,
      props.modelOptionsByInstance.get(item.instance.instanceId) ?? [],
    );
    if (!resolved) return;
    if (additive && props.onToggleModel) {
      // Fan-out selection keeps the picker open so several models can be added.
      props.onToggleModel(item.instance.instanceId, item.instance.driverKind, resolved);
      return;
    }
    if (item.preset)
      props.onInstanceModelChange(
        item.instance.instanceId,
        item.instance.driverKind,
        resolved,
        item.preset,
      );
    else props.onInstanceModelChange(item.instance.instanceId, item.instance.driverKind, resolved);
    setOpen(false);
  };
  // The window keydown listener reads the latest rows without resubscribing per render.
  const jumpTargetsRef = useRef({ jumpTargets, selectModel });
  useEffect(() => {
    jumpTargetsRef.current = { jumpTargets, selectModel };
  });
  const fanOutCount = props.selectedModels?.length ?? 0;
  const isFanOutSelected = (item: InstanceModelItem) =>
    fanOutCount > 1 &&
    (props.selectedModels ?? []).some(
      (entry) => entry.instanceId === item.instance.instanceId && entry.model === item.slug,
    );

  // A preset row's star removes just that preset; elsewhere the star covers the model.
  const toggleFavorite = (item: InstanceModelItem) => {
    void updateSettings({
      favorites: item.preset
        ? removeFavoritePreset(settings.favorites, item.preset)
        : toggleModelFavorite(settings.favorites, item.instance.instanceId, item.slug),
    });
  };

  useEffect(() => {
    if (!isOpen) return;
    const handle = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isKeyboardEventComposing(event)) return;
      const command = resolveShortcutCommand(event, props.keybindings ?? [], {
        context: { modelPickerOpen: true },
      });
      const jumpIndex = modelPickerJumpIndexFromCommand(command ?? "");
      if (jumpIndex !== null) {
        const target = jumpTargetsRef.current.jumpTargets[jumpIndex];
        if (!target) return;
        event.preventDefault();
        event.stopPropagation();
        if (!event.repeat) jumpTargetsRef.current.selectModel(target);
        return;
      }
      if (command !== "modelPicker.previousProvider" && command !== "modelPicker.nextProvider")
        return;
      const available = visibleEntries.filter(isSelectableProviderInstance);
      if (!available.length) return;
      const current =
        selectedSource.kind === "instance"
          ? available.findIndex((item) => item.instanceId === selectedSource.instanceId)
          : -1;
      const direction = command === "modelPicker.nextProvider" ? 1 : -1;
      const index =
        current < 0
          ? direction === 1
            ? 0
            : available.length - 1
          : (current + direction + available.length) % available.length;
      event.preventDefault();
      setSearch("");
      setSelectedSource({ kind: "instance", instanceId: available[index]!.instanceId });
    };
    window.addEventListener("keydown", handle, true);
    return () => window.removeEventListener("keydown", handle, true);
  }, [isOpen, props.keybindings, selectedSource, visibleEntries]);

  const triggerTitle = getTriggerDisplayModelName(selectedModel);
  const triggerLabel = selectedInstance
    ? `${selectedInstance.displayName} · ${getTriggerDisplayModelLabel(selectedModel)}`
    : getTriggerDisplayModelLabel(selectedModel);

  return (
    <Popover
      open={isOpen}
      onOpenChange={(open) => (props.disabled ? setOpen(false) : setOpen(open))}
    >
      <PopoverTrigger
        render={
          <Button
            size="sm"
            variant={props.triggerVariant ?? "ghost"}
            data-chat-provider-model-picker="true"
            className={cn(
              COMPOSER_CHIP_CLASS_NAME,
              "min-w-0 justify-start overflow-hidden [&_svg]:mx-0",
              props.compact ? "max-w-42 shrink-0" : "max-w-48 shrink sm:max-w-56",
              props.triggerClassName,
            )}
            disabled={props.disabled}
          />
        }
      >
        <span className="flex min-w-0 w-full items-center gap-2 overflow-hidden">
          {DriverIcon && selectedInstance ? (
            <DriverIcon
              className={cn(
                "size-4 shrink-0",
                providerIconClassName(selectedInstance.driverKind),
                selectedInstance.driverKind === "claudeAgent" && props.ultrathinkActive
                  ? "ultrathink-chroma"
                  : undefined,
              )}
            />
          ) : null}
          <Tooltip>
            <TooltipTrigger render={<span className="min-w-0 flex-1 truncate" />}>
              {fanOutCount > 1
                ? `${fanOutCount} models`
                : selectedInstance && !selectedInstance.isDefault
                  ? `${selectedInstance.displayName} · ${triggerTitle}`
                  : triggerTitle}
            </TooltipTrigger>
            <TooltipPopup side="top">
              {fanOutCount > 1
                ? `${(props.selectedModels ?? []).map((entry) => entry.model).join(", ")} · each starts its own thread and worktree`
                : triggerLabel}
            </TooltipPopup>
          </Tooltip>
          <ChevronDownIcon className="size-3 shrink-0 opacity-60" />
        </span>
      </PopoverTrigger>
      <PopoverPopup
        align="start"
        {...(props.docked
          ? { side: "top" as const, collisionAvoidance: { side: "shift", align: "shift" } as const }
          : {})}
        className="border-0 bg-transparent p-0 shadow-none before:hidden [--viewport-inline-padding:0] *:data-[slot=popover-viewport]:p-0"
      >
        <TooltipProvider delay={0}>
          <div
            className={cn(
              "relative flex h-screen max-h-[min(24rem,var(--available-height))] w-screen max-w-100 overflow-hidden rounded-lg border bg-popover text-popover-foreground shadow-lg/5",
              props.lockedInstanceId ? "flex-col" : "flex-row",
            )}
          >
            {props.lockedInstanceId && selectedInstance && DriverIcon ? (
              <div className="flex items-center gap-2 border-b px-4 py-3">
                <DriverIcon
                  className={cn(
                    "size-5 shrink-0",
                    providerIconClassName(selectedInstance.driverKind),
                  )}
                />
                <span className="truncate text-sm font-medium">{selectedInstance.displayName}</span>
              </div>
            ) : null}

            {!props.lockedInstanceId && !isSearching ? (
              <ModelPickerSidebarRail
                selectedId={
                  selectedSource.kind === "favorites"
                    ? "favorites"
                    : instanceSidebarId(selectedSource.instanceId)
                }
                items={sidebarItems}
                onSelect={(id) => {
                  if (id === "favorites") {
                    setSelectedSource({ kind: "favorites" });
                  } else if (id.startsWith(INSTANCE_SIDEBAR_ID_PREFIX)) {
                    const instanceId = id.slice(INSTANCE_SIDEBAR_ID_PREFIX.length);
                    const entry = visibleEntries.find(
                      (candidate) => candidate.instanceId === instanceId,
                    );
                    if (entry) {
                      setSelectedSource({ kind: "instance", instanceId: entry.instanceId });
                    }
                  }
                  window.requestAnimationFrame(() => searchRef.current?.focus());
                }}
              />
            ) : null}

            <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
              <div className="border-b px-3 py-2">
                <div className="relative">
                  <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    ref={searchRef}
                    className="pl-8 shadow-none"
                    size="sm"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    onKeyDown={(event) => {
                      if (isKeyboardEventComposing(event.nativeEvent)) {
                        event.stopPropagation();
                        return;
                      }
                      if (event.key === "Escape") {
                        event.preventDefault();
                        event.stopPropagation();
                        setOpen(false);
                        return;
                      }
                      if (event.key === "Enter" && items[0]) {
                        event.preventDefault();
                        event.stopPropagation();
                        selectModel(items[0], event.shiftKey);
                        return;
                      }
                      event.stopPropagation();
                    }}
                    onMouseDown={(event) => event.stopPropagation()}
                    onTouchStart={(event) => event.stopPropagation()}
                    placeholder="Search models..."
                  />
                </div>
              </div>

              <div className="relative min-h-0 flex-1 overflow-y-auto p-1 before:pointer-events-none before:absolute before:inset-0 before:bg-muted/40">
                <div className="relative">
                  {items.length === 0 ? (
                    <div className="px-3 py-8 text-center text-xs text-muted-foreground">
                      {selectedSource.kind === "favorites" && !isSearching
                        ? "No favorite models yet"
                        : "No models found"}
                    </div>
                  ) : (
                    groups.map((group) => (
                      <section
                        key={group.company}
                        role="group"
                        aria-label={`${group.company} models`}
                      >
                        <div className="sticky top-0 z-10 flex items-center gap-2 bg-popover/95 px-3 py-1.5 text-2xs font-semibold tracking-wider text-muted-foreground uppercase backdrop-blur-sm">
                          <span>{group.company}</span>
                          <span className="font-normal tabular-nums opacity-60">
                            {group.items.length}
                          </span>
                        </div>
                        {group.items.map((item) => {
                          const key = itemKey(item);
                          const isFavorite = favoriteKeys.has(
                            modelKey(item.instance.instanceId, item.slug),
                          );
                          const reason = unavailableReason(item.instance);
                          const Icon = PROVIDER_ICON_BY_PROVIDER[item.instance.driverKind];
                          const jumpLabel = jumpLabelByItem.get(item) ?? null;
                          const presetEffort = item.preset?.effort;
                          const isActive =
                            fanOutCount <= 1 &&
                            (item.preset && props.activePreset !== undefined
                              ? props.activePreset !== null &&
                                isSameFavoritePreset(item.preset, props.activePreset)
                              : item.instance.instanceId === activeInstanceId &&
                                item.slug === props.model);
                          return (
                            <div
                              key={key}
                              data-model-picker-row={key}
                              className={cn(
                                "group flex items-center gap-2 rounded-md px-2 py-1.5",
                                reason ? "opacity-55" : "hover:bg-muted",
                              )}
                            >
                              <button
                                type="button"
                                className="rounded p-1 text-muted-foreground opacity-45 transition-opacity group-hover:opacity-100 hover:text-foreground disabled:cursor-not-allowed"
                                aria-label={
                                  item.preset
                                    ? `Remove ${getDisplayModelName(item)}${presetEffort ? ` · ${presetEffort}` : ""} from favorites`
                                    : isFavorite
                                      ? "Remove from favorites"
                                      : "Add to favorites"
                                }
                                onClick={() => toggleFavorite(item)}
                                disabled={Boolean(reason)}
                              >
                                <StarIcon
                                  className={cn(
                                    "size-3.5",
                                    (isFavorite || item.preset) &&
                                      "fill-current text-warning-foreground opacity-100",
                                  )}
                                />
                              </button>
                              <button
                                type="button"
                                className="flex min-w-0 flex-1 items-center gap-2 text-left disabled:cursor-not-allowed"
                                onClick={(event) => selectModel(item, event.shiftKey)}
                                aria-pressed={fanOutCount > 1 ? isFanOutSelected(item) : undefined}
                                disabled={Boolean(reason)}
                                title={reason ?? undefined}
                              >
                                {Icon ? (
                                  <Icon
                                    className={cn(
                                      "size-4 shrink-0",
                                      providerIconClassName(item.instance.driverKind),
                                    )}
                                  />
                                ) : null}
                                <span className="min-w-0 flex-1">
                                  <span className="flex items-center gap-2 text-xs font-medium">
                                    <span className="truncate">{getDisplayModelName(item)}</span>
                                    {presetEffort ? (
                                      <span
                                        className="shrink-0 rounded border border-border px-1 text-2xs font-normal text-muted-foreground"
                                        data-model-picker-preset-effort={presetEffort}
                                      >
                                        {presetEffort}
                                      </span>
                                    ) : null}
                                    {isFanOutSelected(item) ? (
                                      <span className="rounded border border-primary/30 bg-primary/10 px-1 text-2xs uppercase text-primary">
                                        Selected
                                      </span>
                                    ) : isActive ? (
                                      <span className="rounded border border-primary/30 bg-primary/10 px-1 text-2xs uppercase text-primary">
                                        Active
                                      </span>
                                    ) : null}
                                  </span>
                                  <span className="block truncate text-2xs text-muted-foreground">
                                    {item.instance.displayName} · {item.slug}
                                    {reason ? ` · ${reason}` : ""}
                                  </span>
                                </span>
                                {jumpLabel && !reason ? (
                                  <kbd className="shrink-0 font-sans text-2xs text-faint-foreground tabular-nums">
                                    {jumpLabel}
                                  </kbd>
                                ) : null}
                              </button>
                            </div>
                          );
                        })}
                      </section>
                    ))
                  )}
                </div>
              </div>
            </div>
          </div>
        </TooltipProvider>
      </PopoverPopup>
    </Popover>
  );
});
