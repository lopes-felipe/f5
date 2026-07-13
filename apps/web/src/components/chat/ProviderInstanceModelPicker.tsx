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

import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
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
import { ModelPickerSidebarRail, type ModelPickerSidebarRailItem } from "./ModelPickerSidebar";
import {
  COMING_SOON_PROVIDER_OPTIONS,
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
}

type ModelPickerSource =
  | { readonly kind: "favorites" }
  | { readonly kind: "instance"; readonly instanceId: ProviderInstanceId };

const INSTANCE_SIDEBAR_ID_PREFIX = "instance:";

function instanceSidebarId(instanceId: ProviderInstanceId): string {
  return `${INSTANCE_SIDEBAR_ID_PREFIX}${instanceId}`;
}

function modelKey(instanceId: ProviderInstanceId, model: string): string {
  return `${instanceId}\0${model}`;
}

function isSelectable(instance: ProviderInstanceEntry): boolean {
  return (
    instance.enabled &&
    instance.isAvailable &&
    instance.status !== "error" &&
    instance.status !== "disabled"
  );
}

function unavailableReason(instance: ProviderInstanceEntry): string | null {
  if (isSelectable(instance)) return null;
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
  disabled?: boolean;
  terminalOpen?: boolean;
  open?: boolean;
  triggerVariant?: VariantProps<typeof buttonVariants>["variant"] | undefined;
  triggerClassName?: string | undefined;
  onOpenChange?: ((open: boolean) => void) | undefined;
  onInstanceModelChange: (
    instanceId: ProviderInstanceId,
    driver: ProviderDriverKind,
    model: ModelSlug,
  ) => void;
}) {
  const settings = useSettings();
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
  const groups = useMemo(() => {
    const byCompany = new Map<string, InstanceModelItem[]>();
    for (const instance of visibleEntries) {
      if (
        !isSearching &&
        selectedSource.kind === "instance" &&
        instance.instanceId !== selectedSource.instanceId
      ) {
        continue;
      }
      for (const model of props.modelOptionsByInstance.get(instance.instanceId) ?? []) {
        const item = { ...model, instance } satisfies InstanceModelItem;
        if (!matchesSearch(item, search)) continue;
        if (
          !isSearching &&
          selectedSource.kind === "favorites" &&
          !favoriteKeys.has(modelKey(instance.instanceId, model.slug))
        ) {
          continue;
        }
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
        const nameDelta = left.name.localeCompare(right.name, undefined, { numeric: true });
        if (nameDelta !== 0) return nameDelta;
        return left.instance.displayName.localeCompare(right.instance.displayName);
      }),
    }));
  }, [
    favoriteKeys,
    isSearching,
    props.modelOptionsByInstance,
    search,
    selectedSource,
    visibleEntries,
  ]);
  const items = useMemo(() => groups.flatMap((group) => group.items), [groups]);
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
    () => [
      ...visibleEntries.map((instance) => {
        const reason = unavailableReason(instance);
        return {
          id: instanceSidebarId(instance.instanceId),
          label: reason ? `${instance.displayName}. ${reason}` : instance.displayName,
          icon: PROVIDER_ICON_BY_PROVIDER[instance.driverKind] ?? BoxIcon,
          iconClassName: providerIconClassName(instance.driverKind),
          disabled: reason !== null,
          isCustom: !instance.isDefault,
          accentColor: instance.accentColor,
        } satisfies ModelPickerSidebarRailItem;
      }),
      ...COMING_SOON_PROVIDER_OPTIONS.map(
        (option) =>
          ({
            id: `coming-soon:${option.id}`,
            label: `${option.label} · Coming soon`,
            icon: option.icon,
            iconClassName: "text-muted-foreground/85",
            disabled: true,
            comingSoon: true,
          }) satisfies ModelPickerSidebarRailItem,
      ),
    ],
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

  const selectModel = (item: InstanceModelItem) => {
    if (props.disabled || !isSelectable(item.instance)) return;
    const resolved = resolveSelectableModel(
      item.instance.driverKind,
      item.slug,
      props.modelOptionsByInstance.get(item.instance.instanceId) ?? [],
    );
    if (!resolved) return;
    props.onInstanceModelChange(item.instance.instanceId, item.instance.driverKind, resolved);
    setOpen(false);
  };

  const toggleFavorite = (item: InstanceModelItem) => {
    const key = modelKey(item.instance.instanceId, item.slug);
    const existing = settings.favorites;
    const next = favoriteKeys.has(key)
      ? existing.filter(
          (favorite) =>
            favorite.provider !== item.instance.instanceId || favorite.model !== item.slug,
        )
      : [...existing, { provider: item.instance.instanceId, model: item.slug }];
    void updateSettings({ favorites: next });
  };

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
              "min-w-0 justify-start overflow-hidden whitespace-nowrap px-2 text-muted-foreground/70 hover:text-foreground/80 [&_svg]:mx-0",
              props.compact ? "max-w-42 shrink-0" : "max-w-48 shrink sm:max-w-56 sm:px-3",
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
              {selectedInstance && !selectedInstance.isDefault
                ? `${selectedInstance.displayName} · ${triggerTitle}`
                : triggerTitle}
            </TooltipTrigger>
            <TooltipPopup side="top">{triggerLabel}</TooltipPopup>
          </Tooltip>
          <ChevronDownIcon className="size-3 shrink-0 opacity-60" />
        </span>
      </PopoverTrigger>
      <PopoverPopup
        align="start"
        className="border-0 bg-transparent p-0 shadow-none before:hidden [--viewport-inline-padding:0] *:data-[slot=popover-viewport]:p-0"
      >
        <TooltipProvider delay={0}>
          <div
            className={cn(
              "relative flex h-screen max-h-96 w-screen max-w-100 overflow-hidden rounded-lg border bg-popover text-popover-foreground shadow-lg/5",
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
                  <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground/50" />
                  <Input
                    ref={searchRef}
                    className="pl-8 font-sans shadow-none"
                    size="sm"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") {
                        event.preventDefault();
                        event.stopPropagation();
                        setOpen(false);
                        return;
                      }
                      if (event.key === "Enter" && items[0]) {
                        event.preventDefault();
                        event.stopPropagation();
                        selectModel(items[0]);
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
                        <div className="sticky top-0 z-10 flex items-center gap-2 bg-popover/95 px-3 py-1.5 text-[10px] font-semibold tracking-wider text-muted-foreground uppercase backdrop-blur-sm">
                          <span>{group.company}</span>
                          <span className="font-normal tabular-nums opacity-60">
                            {group.items.length}
                          </span>
                        </div>
                        {group.items.map((item) => {
                          const key = modelKey(item.instance.instanceId, item.slug);
                          const isFavorite = favoriteKeys.has(key);
                          const reason = unavailableReason(item.instance);
                          const Icon = PROVIDER_ICON_BY_PROVIDER[item.instance.driverKind];
                          return (
                            <div
                              key={key}
                              className={cn(
                                "group flex items-center gap-2 rounded-md px-2 py-1.5",
                                reason ? "opacity-55" : "hover:bg-muted",
                              )}
                            >
                              <button
                                type="button"
                                className="rounded p-1 text-muted-foreground opacity-45 transition-opacity group-hover:opacity-100 hover:text-foreground disabled:cursor-not-allowed"
                                aria-label={
                                  isFavorite ? "Remove from favorites" : "Add to favorites"
                                }
                                onClick={() => toggleFavorite(item)}
                                disabled={Boolean(reason)}
                              >
                                <StarIcon
                                  className={cn(
                                    "size-3.5",
                                    isFavorite && "fill-current text-yellow-500 opacity-100",
                                  )}
                                />
                              </button>
                              <button
                                type="button"
                                className="flex min-w-0 flex-1 items-center gap-2 text-left disabled:cursor-not-allowed"
                                onClick={() => selectModel(item)}
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
                                    {item.instance.instanceId === activeInstanceId &&
                                    item.slug === props.model ? (
                                      <span className="rounded border border-primary/30 bg-primary/10 px-1 text-[10px] uppercase text-primary">
                                        Active
                                      </span>
                                    ) : null}
                                  </span>
                                  <span className="block truncate text-[11px] text-muted-foreground">
                                    {item.instance.displayName} · {item.slug}
                                    {reason ? ` · ${reason}` : ""}
                                  </span>
                                </span>
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
