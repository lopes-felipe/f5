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
import { isSameRecentModels, type RecentModel, recordRecentModel } from "~/recentModels";
import {
  type ModelSlug,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ResolvedKeybindingsConfig,
  type ServerProvider,
} from "@t3tools/contracts";
import { resolveSelectableModel } from "@t3tools/shared/model";
import {
  BoxIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  SearchIcon,
  StarIcon,
} from "lucide-react";
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
  /** Zero-based `mod+N` number of a usable Favorites row. */
  readonly jumpIndex?: number | undefined;
}

/** Which rows the list shows: everything, only favorites, or one provider instance. */
type ModelPickerFilter =
  | { readonly kind: "all" }
  | { readonly kind: "favorites" }
  | { readonly kind: "instance"; readonly instanceId: ProviderInstanceId };

type SectionKind = "recent" | "favorites" | "provider";

interface ModelRowEntry {
  readonly kind: "model";
  readonly key: string;
  readonly item: InstanceModelItem;
  readonly section: SectionKind;
}

/** The collapsed "Legacy · N" row at the end of a provider section. */
interface LegacyRowEntry {
  readonly kind: "legacy";
  readonly key: string;
  readonly instanceId: ProviderInstanceId;
  readonly count: number;
  readonly expanded: boolean;
  /** Held open because a legacy model is active or selected, so it cannot collapse. */
  readonly forced: boolean;
}

type RowEntry = ModelRowEntry | LegacyRowEntry;

interface PickerSection {
  readonly key: string;
  readonly kind: SectionKind;
  readonly label: string;
  /** Provider sections show their instance's icon in the header. */
  readonly instance: ProviderInstanceEntry | null;
  readonly count: number;
  readonly rows: ReadonlyArray<RowEntry>;
}

const ALL_FILTER_ID = "all";
const FAVORITES_FILTER_ID = "favorites";
const INSTANCE_FILTER_ID_PREFIX = "instance:";
const ALL_FILTER: ModelPickerFilter = { kind: "all" };

const NO_RECENT_MODELS: UnifiedWebSettings["recentModels"] = [];

function selectPickerSettings(settings: UnifiedWebSettings) {
  return { favorites: settings.favorites, recentModels: settings.recentModels };
}

function filterId(filter: ModelPickerFilter): string {
  if (filter.kind === "all") return ALL_FILTER_ID;
  if (filter.kind === "favorites") return FAVORITES_FILTER_ID;
  return `${INSTANCE_FILTER_ID_PREFIX}${filter.instanceId}`;
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
  /**
   * `preset` is the picked Favorites row's stored preset, only with `favoritePresets`.
   * Return null to refuse the pick, or the slug actually applied; Recent records only
   * accepted picks, under the applied slug. Any other return counts as accepted as-is.
   */
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
  /**
   * Extra reason an available instance cannot be picked here (for example a workflow
   * restriction). Its rows stay listed, disabled with the reason, and it keeps its chip.
   */
  instanceUnavailableReason?: ((instance: ProviderInstanceEntry) => string | null) | undefined;
  /**
   * Picks are remembered in Recent unless this is false. Settings pickers choose a
   * configuration, not the model to talk to, so they still list Recent (a quick way to
   * reach the models in use) without adding their choice to it.
   */
  recordRecents?: boolean;
}) {
  const settings = useSettings(selectPickerSettings);
  // Partial settings snapshots (test doubles of `useSettings`) may lack the field.
  const recentModels = settings.recentModels ?? NO_RECENT_MODELS;
  const { updateSettings } = useUpdateSettings();
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<ModelPickerFilter>(ALL_FILTER);
  // Provider instances whose legacy models the user expanded; reset on close.
  const [expandedLegacy, setExpandedLegacy] = useState<ReadonlySet<ProviderInstanceId>>(
    () => new Set(),
  );
  // The row Enter picks, moved with the arrow keys; null means the first selectable row.
  const [highlightedKey, setHighlightedKey] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const chipsRef = useRef<HTMLDivElement>(null);
  const isOpen = props.open ?? uncontrolledOpen;
  // Every open starts on All, with no search, nothing highlighted and legacy collapsed,
  // however it opened: the trigger, or a controlled `open` such as `modelPicker.toggle`.
  // Adjusting during render (not in an effect) keeps the stale list from flashing.
  const [renderedOpen, setRenderedOpen] = useState(isOpen);
  if (renderedOpen !== isOpen) {
    setRenderedOpen(isOpen);
    if (isOpen) {
      setFilter(ALL_FILTER);
      setSearch("");
      setHighlightedKey(null);
      setExpandedLegacy(new Set());
    }
  }
  const entries = useMemo(
    () => sortProviderInstanceEntries(deriveProviderInstanceEntries(props.providers)),
    [props.providers],
  );
  const activeInstanceId = props.lockedInstanceId ?? props.instanceId;
  // The trigger describes only the instance actually selected: a selection whose instance is
  // gone (a removed provider) shows the bare model, not another provider's icon.
  const activeInstance = entries.find((entry) => entry.instanceId === activeInstanceId) ?? null;
  const visibleEntries = useMemo(
    () =>
      props.lockedInstanceId
        ? entries.filter((entry) => entry.instanceId === props.lockedInstanceId)
        : entries,
    [entries, props.lockedInstanceId],
  );
  // Instances with a filter chip. Unavailable ones only show up in search results.
  const chipEntries = useMemo(
    () => visibleEntries.filter((entry) => unavailableReason(entry) === null),
    [visibleEntries],
  );
  const showChips = !props.lockedInstanceId;
  // A filter whose instance went away while open falls back to All.
  const effectiveFilter: ModelPickerFilter =
    filter.kind === "instance" &&
    !chipEntries.some((entry) => entry.instanceId === filter.instanceId)
      ? ALL_FILTER
      : filter;
  const favoriteKeys = useMemo(
    () => new Set(settings.favorites.map((entry) => modelKey(entry.provider, entry.model))),
    [settings.favorites],
  );
  const isSearching = search.trim().length > 0;

  const usablePresets = useMemo(
    () => listUsableFavoritePresets(settings.favorites, entries, props.modelOptionsByInstance),
    [entries, props.modelOptionsByInstance, settings.favorites],
  );
  const optionFor = useCallback(
    (instanceId: ProviderInstanceId, slug: string): ModelPickerModelOption =>
      props.modelOptionsByInstance.get(instanceId)?.find((option) => option.slug === slug) ?? {
        slug,
        name: slug,
      },
    [props.modelOptionsByInstance],
  );
  const jumpLabelByIndex = useMemo(
    () =>
      Array.from({ length: 9 }, (_, index) => {
        const command = modelPickerJumpCommandForIndex(index);
        return command ? shortcutLabelForCommand(props.keybindings ?? [], command) : null;
      }),
    [props.keybindings],
  );

  const favoriteItems = useMemo((): InstanceModelItem[] => {
    const seen = new Set<string>();
    const out: InstanceModelItem[] = [];
    const push = (item: InstanceModelItem) => {
      const key = itemKey(item);
      if (seen.has(key)) return;
      seen.add(key);
      out.push(item);
    };
    const visibleIds = new Set(visibleEntries.map((entry) => entry.instanceId));
    // With presets, numbers follow the stored order across every instance, so `mod+N` here
    // and `model.favorite.N` name the same preset even when a locked thread hides some.
    // Without presets each model is listed once, so rows are numbered as shown.
    let shownCount = 0;
    usablePresets.forEach((preset, presetIndex) => {
      if (!visibleIds.has(preset.instance.instanceId)) return;
      const before = out.length;
      push({
        ...optionFor(preset.instance.instanceId, preset.model),
        instance: preset.instance,
        jumpIndex: props.favoritePresets ? presetIndex : shownCount,
        ...(props.favoritePresets ? { preset: preset.favorite } : {}),
      });
      if (out.length > before) shownCount += 1;
    });
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
  }, [optionFor, props.favoritePresets, settings.favorites, usablePresets, visibleEntries]);
  // `mod+N` always targets favorite N, whatever the filter or search shows.
  const jumpTargets = useMemo(
    (): ReadonlyArray<InstanceModelItem | undefined> =>
      Array.from({ length: 9 }, (_, index) =>
        favoriteItems.find((item) => item.jumpIndex === index),
      ),
    [favoriteItems],
  );

  // Slugs on an instance that stay listed even when unlisted: the active and fan-out models.
  const selectedSlugsFor = useCallback(
    (instanceId: ProviderInstanceId): Set<string> => {
      const slugs = new Set(
        (props.selectedModels ?? [])
          .filter((selected) => selected.instanceId === instanceId)
          .map((selected) => selected.model),
      );
      if (instanceId === activeInstanceId) slugs.add(props.model);
      return slugs;
    },
    [activeInstanceId, props.model, props.selectedModels],
  );

  // Recent picks that still resolve to a visible instance and a model the picker lists.
  const recentItems = useMemo((): InstanceModelItem[] => {
    const out: InstanceModelItem[] = [];
    for (const recent of recentModels) {
      const instance = visibleEntries.find((entry) => entry.instanceId === recent.provider);
      if (!instance) continue;
      const option = filterPickerVisibleModels(
        props.modelOptionsByInstance.get(instance.instanceId) ?? [],
        selectedSlugsFor(instance.instanceId),
      ).find((candidate) => candidate.slug === recent.model);
      if (!option) continue;
      out.push({ ...option, instance });
    }
    return out;
  }, [props.modelOptionsByInstance, recentModels, selectedSlugsFor, visibleEntries]);

  const sections = useMemo((): PickerSection[] => {
    const modelRow = (item: InstanceModelItem, section: SectionKind): ModelRowEntry => ({
      kind: "model",
      key: `${section}\0${itemKey(item)}`,
      item,
      section,
    });
    const out: PickerSection[] = [];
    const showShortcutSections = !isSearching && effectiveFilter.kind === "all";
    if (showShortcutSections && recentItems.length > 0) {
      out.push({
        key: "recent",
        kind: "recent",
        label: "Recent",
        instance: null,
        count: recentItems.length,
        rows: recentItems.map((item) => modelRow(item, "recent")),
      });
    }
    if (showShortcutSections || effectiveFilter.kind === "favorites") {
      const items = favoriteItems.filter((item) => matchesSearch(item, search));
      if (items.length > 0) {
        out.push({
          key: "favorites",
          kind: "favorites",
          label: "Favorites",
          instance: null,
          count: items.length,
          rows: items.map((item) => modelRow(item, "favorites")),
        });
      }
    }
    if (effectiveFilter.kind === "favorites") return out;

    const providerEntries =
      effectiveFilter.kind === "instance"
        ? visibleEntries.filter((entry) => entry.instanceId === effectiveFilter.instanceId)
        : isSearching || props.lockedInstanceId
          ? visibleEntries
          : chipEntries;
    for (const instance of providerEntries) {
      const selectedSlugs = selectedSlugsFor(instance.instanceId);
      const items = filterPickerVisibleModels(
        props.modelOptionsByInstance.get(instance.instanceId) ?? [],
        selectedSlugs,
      )
        .map((model): InstanceModelItem => ({ ...model, instance }))
        .filter((item) => matchesSearch(item, search))
        // The catalog has already applied capability and manual ordering.
        // Stable sorting floats favorites without replacing that order with names.
        .toSorted(
          (left, right) =>
            Number(favoriteKeys.has(modelKey(right.instance.instanceId, right.slug))) -
            Number(favoriteKeys.has(modelKey(left.instance.instanceId, left.slug))),
        );
      if (items.length === 0) continue;
      const current = items.filter((item) => item.isLegacy !== true);
      const legacy = items.filter((item) => item.isLegacy === true);
      const rows: RowEntry[] = current.map((item) => modelRow(item, "provider"));
      if (legacy.length > 0) {
        if (isSearching) {
          rows.push(...legacy.map((item) => modelRow(item, "provider")));
        } else {
          // A legacy model that is in use keeps the disclosure open so it stays visible.
          const forced = legacy.some((item) => selectedSlugs.has(item.slug));
          const expanded = forced || expandedLegacy.has(instance.instanceId);
          rows.push({
            kind: "legacy",
            key: `legacy\0${instance.instanceId}`,
            instanceId: instance.instanceId,
            count: legacy.length,
            expanded,
            forced,
          });
          if (expanded) rows.push(...legacy.map((item) => modelRow(item, "provider")));
        }
      }
      out.push({
        key: `provider\0${instance.instanceId}`,
        kind: "provider",
        label: instance.displayName,
        instance,
        count: items.length,
        rows,
      });
    }
    return out;
  }, [
    chipEntries,
    effectiveFilter,
    expandedLegacy,
    favoriteItems,
    favoriteKeys,
    isSearching,
    props.lockedInstanceId,
    props.modelOptionsByInstance,
    recentItems,
    search,
    selectedSlugsFor,
    visibleEntries,
  ]);
  const rowEntries = useMemo(() => sections.flatMap((section) => section.rows), [sections]);
  // A section of only legacy models still shows its disclosure, so any row counts.
  const hasRows = rowEntries.length > 0;

  const selectedOptions = activeInstance
    ? (props.modelOptionsByInstance.get(activeInstance.instanceId) ?? [])
    : [];
  const selectedModel =
    selectedOptions.find((option) => option.slug === props.model) ??
    ({ slug: props.model, name: props.model } satisfies ModelPickerModelOption);
  const DriverIcon = activeInstance
    ? PROVIDER_ICON_BY_PROVIDER[activeInstance.driverKind]
    : undefined;
  const filters = useMemo(
    (): ReadonlyArray<ModelPickerFilter> => [
      ALL_FILTER,
      { kind: "favorites" },
      ...chipEntries.map(
        (entry): ModelPickerFilter => ({ kind: "instance", instanceId: entry.instanceId }),
      ),
    ],
    [chipEntries],
  );

  const setOpen = useCallback(
    (open: boolean) => {
      props.onOpenChange?.(open);
      if (props.open === undefined) setUncontrolledOpen(open);
    },
    [props.onOpenChange, props.open],
  );

  const changeFilter = useCallback((next: ModelPickerFilter) => {
    setFilter(next);
    setHighlightedKey(null);
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    const frame = window.requestAnimationFrame(() => searchRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [isOpen]);

  useEffect(() => {
    if (props.disabled && isOpen) setOpen(false);
  }, [isOpen, props.disabled, setOpen]);

  const currentFilterId = filterId(effectiveFilter);
  useEffect(() => {
    if (!isOpen) return;
    chipsRef.current
      ?.querySelector(`[data-model-picker-provider="${CSS.escape(currentFilterId)}"]`)
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [currentFilterId, isOpen]);

  const rowUnavailableReason = (instance: ProviderInstanceEntry): string | null =>
    unavailableReason(instance) ?? props.instanceUnavailableReason?.(instance) ?? null;

  // Arrow keys move over the rows that can be picked and the legacy disclosures that toggle.
  const navigableEntries = rowEntries.filter((entry) =>
    entry.kind === "legacy" ? !entry.forced : rowUnavailableReason(entry.item.instance) === null,
  );
  const highlightedEntry =
    navigableEntries.find((entry) => entry.key === highlightedKey) ??
    navigableEntries.find((entry) => entry.kind === "model") ??
    null;
  const highlightedEntryKey = highlightedEntry?.key ?? null;
  const moveHighlight = (direction: 1 | -1) => {
    if (navigableEntries.length === 0) return;
    const fallbackKey = highlightedEntryKey;
    // Functional, so keys pressed faster than React renders still all count.
    setHighlightedKey((previous) => {
      const currentKey = previous ?? fallbackKey;
      const current = Math.max(
        navigableEntries.findIndex((entry) => entry.key === currentKey),
        0,
      );
      const next = Math.min(Math.max(current + direction, 0), navigableEntries.length - 1);
      return navigableEntries[next]!.key;
    });
  };
  useEffect(() => {
    if (!highlightedKey) return;
    listRef.current
      ?.querySelector("[data-model-picker-row][data-highlighted]")
      ?.scrollIntoView({ block: "nearest" });
  }, [highlightedKey]);

  const setLegacyExpanded = (instanceId: ProviderInstanceId, expanded: boolean) => {
    setExpandedLegacy((previous) => {
      if (previous.has(instanceId) === expanded) return previous;
      const next = new Set(previous);
      if (expanded) next.add(instanceId);
      else next.delete(instanceId);
      return next;
    });
  };

  // A stored pick is stale once its instance's loaded catalog no longer offers the model.
  // Instances this picker doesn't know about are left alone: callers may pass a subset.
  const isStaleRecent = (recent: RecentModel): boolean => {
    if (!entries.some((entry) => entry.instanceId === recent.provider)) return false;
    const options = props.modelOptionsByInstance.get(recent.provider) ?? [];
    return options.length > 0 && !options.some((option) => option.slug === recent.model);
  };

  const selectModel = (item: InstanceModelItem, additive = false) => {
    if (props.disabled || rowUnavailableReason(item.instance) !== null) return;
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
    const applied = item.preset
      ? props.onInstanceModelChange(
          item.instance.instanceId,
          item.instance.driverKind,
          resolved,
          item.preset,
        )
      : props.onInstanceModelChange(item.instance.instanceId, item.instance.driverKind, resolved);
    // A caller returns null when it refused the pick, or the slug it applied instead.
    if (props.recordRecents !== false && applied !== null) {
      const appliedModel = typeof applied === "string" && applied.length > 0 ? applied : resolved;
      const next = recordRecentModel(
        recentModels,
        item.instance.instanceId,
        appliedModel,
        isStaleRecent,
      );
      if (!isSameRecentModels(next, recentModels)) void updateSettings({ recentModels: next });
    }
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
      if (!showChips) return;
      const direction = command === "modelPicker.nextProvider" ? 1 : -1;
      const current = Math.max(
        filters.findIndex((candidate) => filterId(candidate) === currentFilterId),
        0,
      );
      event.preventDefault();
      changeFilter(filters[(current + direction + filters.length) % filters.length]!);
    };
    window.addEventListener("keydown", handle, true);
    return () => window.removeEventListener("keydown", handle, true);
  }, [changeFilter, currentFilterId, filters, isOpen, props.keybindings, showChips]);

  const triggerTitle = getTriggerDisplayModelName(selectedModel);
  const triggerLabel = activeInstance
    ? `${activeInstance.displayName} · ${getTriggerDisplayModelLabel(selectedModel)}`
    : getTriggerDisplayModelLabel(selectedModel);
  const providerShortcutHint = showChips
    ? [
        shortcutLabelForCommand(props.keybindings ?? [], "modelPicker.previousProvider"),
        shortcutLabelForCommand(props.keybindings ?? [], "modelPicker.nextProvider"),
      ].filter((label): label is string => Boolean(label))
    : [];

  const renderModelRow = (entry: ModelRowEntry) => {
    const { item, section } = entry;
    const isFavorite = favoriteKeys.has(modelKey(item.instance.instanceId, item.slug));
    const reason = rowUnavailableReason(item.instance);
    const Icon = PROVIDER_ICON_BY_PROVIDER[item.instance.driverKind];
    const isMixedSection = section !== "provider";
    const jumpLabel =
      section === "favorites" && item.jumpIndex !== undefined && !reason
        ? (jumpLabelByIndex[item.jumpIndex] ?? null)
        : null;
    const presetEffort = item.preset?.effort;
    const fanOutSelected = isFanOutSelected(item);
    const isActive =
      fanOutCount <= 1 &&
      (item.preset && props.activePreset !== undefined
        ? props.activePreset !== null && isSameFavoritePreset(item.preset, props.activePreset)
        : item.instance.instanceId === activeInstanceId && item.slug === props.model);
    const isChecked = isActive || fanOutSelected;
    const isHighlighted = entry.key === highlightedEntryKey;
    // Provider sections keep a favorite's filled star visible; Recent and Favorites
    // show the star only on hover, since there it is not news.
    const starAlwaysVisible = section === "provider" && isFavorite;
    return (
      <div
        key={entry.key}
        data-model-picker-row={entry.key}
        data-model-picker-section={section}
        data-highlighted={isHighlighted ? "true" : undefined}
        data-model-picker-active={isActive ? "true" : undefined}
        title={reason ?? undefined}
        className={cn(
          "group flex items-center gap-1 rounded-md pr-1",
          reason
            ? "opacity-55"
            : isChecked
              ? isHighlighted
                ? "bg-primary/15"
                : "bg-primary/10"
              : isHighlighted && "bg-muted",
        )}
        onMouseMove={reason || isHighlighted ? undefined : () => setHighlightedKey(entry.key)}
      >
        <button
          type="button"
          data-model-picker-select
          className="flex min-w-0 flex-1 items-center gap-2 py-1.5 pl-2 text-left disabled:cursor-not-allowed"
          onClick={(event) => selectModel(item, event.shiftKey)}
          aria-pressed={fanOutCount > 1 ? fanOutSelected : undefined}
          disabled={Boolean(reason)}
        >
          {isMixedSection && Icon ? (
            <Icon
              className={cn("size-3.5 shrink-0", providerIconClassName(item.instance.driverKind))}
            />
          ) : null}
          <span className="flex min-w-0 shrink items-center gap-1.5 text-xs font-medium">
            <span className="truncate" data-model-picker-name>
              {getDisplayModelName(item)}
            </span>
            {isMixedSection && !item.instance.isDefault ? (
              <span className="shrink-0 truncate text-2xs font-normal text-muted-foreground">
                {item.instance.displayName}
              </span>
            ) : null}
            {presetEffort ? (
              <span
                className="shrink-0 rounded border border-border px-1 text-2xs font-normal text-muted-foreground"
                data-model-picker-preset-effort={presetEffort}
              >
                {presetEffort}
              </span>
            ) : null}
          </span>
          {/* A disabled row says why in place of its slug, so it is visible and announced. */}
          <span
            className={cn(
              "ml-auto min-w-0 shrink-[2] truncate pl-2 text-right text-2xs text-muted-foreground",
              !reason && "font-mono",
            )}
            data-model-picker-reason={reason ? true : undefined}
          >
            {reason ?? item.slug}
          </span>
          {jumpLabel ? (
            <kbd className="shrink-0 font-sans text-2xs text-faint-foreground tabular-nums">
              {jumpLabel}
            </kbd>
          ) : null}
          {isChecked ? (
            <CheckIcon
              className="size-3.5 shrink-0 text-primary"
              aria-label={fanOutSelected ? "Selected" : "Active"}
            />
          ) : null}
        </button>
        <button
          type="button"
          className={cn(
            "shrink-0 rounded p-1 text-muted-foreground transition-opacity hover:text-foreground focus-visible:opacity-100 disabled:cursor-not-allowed",
            starAlwaysVisible || isHighlighted
              ? "opacity-100"
              : "opacity-0 group-hover:opacity-100",
          )}
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
              (isFavorite || item.preset) && "fill-current text-warning-foreground",
            )}
          />
        </button>
      </div>
    );
  };

  const renderLegacyRow = (entry: LegacyRowEntry) => {
    const isHighlighted = entry.key === highlightedEntryKey;
    return (
      <button
        key={entry.key}
        type="button"
        data-model-picker-row={entry.key}
        data-model-picker-legacy={entry.instanceId}
        data-highlighted={isHighlighted ? "true" : undefined}
        aria-expanded={entry.expanded}
        // Held open while a legacy model is in use, so there is nothing to toggle.
        disabled={entry.forced}
        title={entry.forced ? "Shown while a legacy model is selected" : undefined}
        className={cn(
          "flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-2xs text-muted-foreground",
          entry.forced ? "cursor-default" : "hover:text-foreground",
          isHighlighted && "bg-muted text-foreground",
        )}
        onMouseMove={isHighlighted || entry.forced ? undefined : () => setHighlightedKey(entry.key)}
        onClick={() => {
          setLegacyExpanded(entry.instanceId, !entry.expanded);
          searchRef.current?.focus();
        }}
      >
        {entry.expanded ? (
          <ChevronDownIcon className="size-3 shrink-0" />
        ) : (
          <ChevronRightIcon className="size-3 shrink-0" />
        )}
        <span>Legacy</span>
        <span className="tabular-nums opacity-60">{entry.count}</span>
      </button>
    );
  };

  const renderChip = (chipFilter: ModelPickerFilter) => {
    const id = filterId(chipFilter);
    const isSelected = id === currentFilterId;
    const instance =
      chipFilter.kind === "instance"
        ? (chipEntries.find((entry) => entry.instanceId === chipFilter.instanceId) ?? null)
        : null;
    const ChipIcon = instance ? (PROVIDER_ICON_BY_PROVIDER[instance.driverKind] ?? BoxIcon) : null;
    const label =
      chipFilter.kind === "all"
        ? "All"
        : chipFilter.kind === "favorites"
          ? "Favorites"
          : (instance?.displayName ?? chipFilter.instanceId);
    return (
      <button
        key={id}
        type="button"
        data-model-picker-provider={id}
        aria-pressed={isSelected}
        className={cn(
          "relative flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-2xs font-medium transition-colors",
          isSelected
            ? "border-foreground bg-foreground text-background"
            : "border-border text-muted-foreground hover:bg-muted hover:text-foreground",
        )}
        onClick={() => {
          changeFilter(chipFilter);
          window.requestAnimationFrame(() => searchRef.current?.focus());
        }}
      >
        {chipFilter.kind === "favorites" ? (
          <StarIcon
            className={cn("size-3 shrink-0 fill-current", !isSelected && "text-warning-foreground")}
            aria-hidden
          />
        ) : null}
        {ChipIcon && instance ? (
          <ChipIcon
            className={cn(
              "size-3 shrink-0",
              !isSelected && providerIconClassName(instance.driverKind),
            )}
            aria-hidden
          />
        ) : null}
        <span>{label}</span>
        {instance && !instance.isDefault ? (
          <span
            className="size-1.5 shrink-0 rounded-full bg-current opacity-60"
            style={instance.accentColor ? { backgroundColor: instance.accentColor } : undefined}
            aria-hidden
          />
        ) : null}
      </button>
    );
  };

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
          {DriverIcon && activeInstance ? (
            <DriverIcon
              className={cn(
                "size-4 shrink-0",
                providerIconClassName(activeInstance.driverKind),
                activeInstance.driverKind === "claudeAgent" && props.ultrathinkActive
                  ? "ultrathink-chroma"
                  : undefined,
              )}
            />
          ) : null}
          <Tooltip>
            <TooltipTrigger render={<span className="min-w-0 flex-1 truncate" />}>
              {fanOutCount > 1
                ? `${fanOutCount} models`
                : activeInstance && !activeInstance.isDefault
                  ? `${activeInstance.displayName} · ${triggerTitle}`
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
          <div className="relative flex h-screen max-h-[min(24rem,var(--available-height))] w-screen max-w-100 flex-col overflow-hidden rounded-lg border bg-popover text-popover-foreground shadow-lg/5">
            {props.lockedInstanceId && activeInstance && DriverIcon ? (
              <div className="flex items-center gap-2 border-b px-4 py-3">
                <DriverIcon
                  className={cn(
                    "size-5 shrink-0",
                    providerIconClassName(activeInstance.driverKind),
                  )}
                />
                <span className="truncate text-sm font-medium">{activeInstance.displayName}</span>
              </div>
            ) : null}

            <div className="border-b px-3 py-2">
              <div className="relative">
                <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 z-10 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  ref={searchRef}
                  className={cn("pl-8 shadow-none", providerShortcutHint.length > 0 && "pr-16")}
                  size="sm"
                  value={search}
                  onChange={(event) => {
                    setSearch(event.target.value);
                    setHighlightedKey(null);
                    // Enter picks the first result, so keep it in view.
                    if (scrollRef.current) scrollRef.current.scrollTop = 0;
                  }}
                  onKeyDown={(event) => {
                    // Composition keys belong to the IME, and a key the window shortcut
                    // listener already handled (provider cycling) must not also move rows.
                    if (
                      isKeyboardEventComposing(event.nativeEvent) ||
                      event.nativeEvent.defaultPrevented
                    ) {
                      event.stopPropagation();
                      return;
                    }
                    if (event.key === "Escape") {
                      event.preventDefault();
                      event.stopPropagation();
                      setOpen(false);
                      return;
                    }
                    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                      event.preventDefault();
                      event.stopPropagation();
                      moveHighlight(event.key === "ArrowDown" ? 1 : -1);
                      return;
                    }
                    if (
                      highlightedEntry?.kind === "legacy" &&
                      (event.key === "Enter" ||
                        event.key === "ArrowRight" ||
                        event.key === "ArrowLeft")
                    ) {
                      event.preventDefault();
                      event.stopPropagation();
                      setLegacyExpanded(
                        highlightedEntry.instanceId,
                        event.key === "Enter"
                          ? !highlightedEntry.expanded
                          : event.key === "ArrowRight",
                      );
                      return;
                    }
                    if (event.key === "Enter" && highlightedEntry?.kind === "model") {
                      event.preventDefault();
                      event.stopPropagation();
                      selectModel(highlightedEntry.item, event.shiftKey);
                      return;
                    }
                    event.stopPropagation();
                  }}
                  onMouseDown={(event) => event.stopPropagation()}
                  onTouchStart={(event) => event.stopPropagation()}
                  placeholder="Search models..."
                />
                {providerShortcutHint.length > 0 ? (
                  <span
                    className="pointer-events-none absolute top-1/2 right-2 flex -translate-y-1/2 gap-1"
                    aria-hidden
                  >
                    {providerShortcutHint.map((label) => (
                      <kbd
                        key={label}
                        className="rounded border border-border px-1 font-sans text-2xs leading-4 text-faint-foreground"
                      >
                        {label}
                      </kbd>
                    ))}
                  </span>
                ) : null}
              </div>
            </div>

            {showChips ? (
              <div
                ref={chipsRef}
                role="toolbar"
                aria-label="Filter models by provider"
                className="flex gap-1 overflow-x-auto border-b px-3 py-1.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
              >
                {filters.map(renderChip)}
              </div>
            ) : null}

            <div
              ref={scrollRef}
              className="relative min-h-0 flex-1 overflow-y-auto p-1 before:pointer-events-none before:absolute before:inset-0 before:bg-muted/40"
            >
              <div ref={listRef} className="relative">
                {!hasRows ? (
                  <div className="px-3 py-8 text-center text-xs text-muted-foreground">
                    {effectiveFilter.kind === "favorites" && !isSearching
                      ? "No favorite models yet"
                      : "No models found"}
                  </div>
                ) : (
                  sections.map((section) => {
                    const SectionIcon = section.instance
                      ? (PROVIDER_ICON_BY_PROVIDER[section.instance.driverKind] ?? BoxIcon)
                      : null;
                    return (
                      <section
                        key={section.key}
                        role="group"
                        aria-label={`${section.label} models`}
                        data-model-picker-section-kind={section.kind}
                      >
                        <div className="sticky top-0 z-10 flex items-center gap-1.5 bg-popover/95 px-2 py-1.5 text-2xs font-semibold tracking-wider text-muted-foreground uppercase backdrop-blur-sm">
                          {SectionIcon && section.instance ? (
                            <SectionIcon
                              className={cn(
                                "size-3 shrink-0",
                                providerIconClassName(section.instance.driverKind),
                              )}
                              aria-hidden
                            />
                          ) : null}
                          <span>{section.label}</span>
                          <span className="font-normal tabular-nums opacity-60">
                            {section.count}
                          </span>
                        </div>
                        {section.rows.map((entry) =>
                          entry.kind === "model" ? renderModelRow(entry) : renderLegacyRow(entry),
                        )}
                      </section>
                    );
                  })
                )}
              </div>
            </div>
          </div>
        </TooltipProvider>
      </PopoverPopup>
    </Popover>
  );
});
