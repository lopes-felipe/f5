import {
  type ModelSlug,
  type ProviderKind,
  type ResolvedKeybindingsConfig,
  type ServerProviderStatus,
} from "@t3tools/contracts";
import { resolveSelectableModel } from "@t3tools/shared/model";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { SearchIcon } from "lucide-react";
import { useAppSettings } from "../../appSettings";
import {
  modelPickerJumpCommandForIndex,
  modelPickerJumpIndexFromCommand,
  resolveShortcutCommand,
  shortcutLabelForCommand,
} from "../../keybindings";
import { cn } from "~/lib/utils";
import { Combobox, ComboboxEmpty, ComboboxInput, ComboboxList } from "../ui/combobox";
import { TooltipProvider } from "../ui/tooltip";
import { ModelListRow } from "./ModelListRow";
import { ModelPickerSidebar } from "./ModelPickerSidebar";
import { buildModelPickerSearchText, scoreModelPickerSearch } from "./modelPickerSearch";
import {
  type ModelPickerModelOption,
  findProviderStatus,
  isProviderSelectable,
  providerDisabledReason,
  PROVIDER_ICON_BY_PROVIDER,
  PROVIDER_LABEL_BY_PROVIDER,
} from "./providerIconUtils";

type ModelPickerItem = ModelPickerModelOption & {
  providerKind: ProviderKind;
};

const EMPTY_MODEL_JUMP_LABELS = new Map<string, string>();
const EMPTY_KEYBINDINGS: ResolvedKeybindingsConfig = [];

function toModelKey(providerKind: ProviderKind, modelId: string): string {
  return `${providerKind}:${modelId}`;
}

function parseModelKey(value: string): { providerKind: ProviderKind; modelId: string } | null {
  const separatorIndex = value.indexOf(":");
  if (separatorIndex === -1) {
    return null;
  }
  const providerKind = value.slice(0, separatorIndex);
  const modelId = value.slice(separatorIndex + 1);
  if ((providerKind !== "codex" && providerKind !== "claudeAgent") || !modelId) {
    return null;
  }
  return { providerKind, modelId };
}

export const ModelPickerContent = memo(function ModelPickerContent(props: {
  provider: ProviderKind;
  model: string;
  lockedProvider: ProviderKind | null;
  providers?: ReadonlyArray<ServerProviderStatus> | undefined;
  keybindings?: ResolvedKeybindingsConfig | undefined;
  modelOptionsByProvider: Record<ProviderKind, ReadonlyArray<ModelPickerModelOption>>;
  terminalOpen: boolean;
  onRequestClose?: (() => void) | undefined;
  onProviderModelChange: (provider: ProviderKind, model: ModelSlug) => void;
}) {
  const { settings, updateSettings } = useAppSettings();
  const [searchQuery, setSearchQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);
  const highlightedModelKeyRef = useRef<string | null>(null);
  const listRegionRef = useRef<HTMLDivElement>(null);
  const keybindings = props.keybindings ?? EMPTY_KEYBINDINGS;
  const [selectedProvider, setSelectedProvider] = useState<ProviderKind | "favorites">(() => {
    if (props.lockedProvider !== null) {
      return props.lockedProvider;
    }
    return settings.favoriteModels.some(
      (favorite) => favorite.providerKind === props.provider && favorite.modelId === props.model,
    )
      ? "favorites"
      : props.provider;
  });

  const focusSearchInput = useCallback(() => {
    searchInputRef.current?.focus({ preventScroll: true });
  }, []);

  const handleSelectProvider = useCallback(
    (providerKind: ProviderKind | "favorites") => {
      setSelectedProvider(providerKind);
      window.requestAnimationFrame(focusSearchInput);
    },
    [focusSearchInput],
  );

  useLayoutEffect(() => {
    focusSearchInput();
    const frame = window.requestAnimationFrame(focusSearchInput);
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [focusSearchInput]);

  const favoriteKeySet = useMemo(
    () =>
      new Set(
        settings.favoriteModels.map((favorite) =>
          toModelKey(favorite.providerKind, favorite.modelId),
        ),
      ),
    [settings.favoriteModels],
  );
  const favoriteOrder = useMemo(
    () =>
      new Map(
        settings.favoriteModels.map((favorite, index) => [
          toModelKey(favorite.providerKind, favorite.modelId),
          index,
        ]),
      ),
    [settings.favoriteModels],
  );

  const flatModels = useMemo<ModelPickerItem[]>(
    () =>
      Object.entries(props.modelOptionsByProvider).flatMap(([providerKind, models]) =>
        models.map((model) => ({
          ...model,
          providerKind: providerKind as ProviderKind,
        })),
      ),
    [props.modelOptionsByProvider],
  );

  const filteredModels = useMemo(() => {
    if (searchQuery.trim()) {
      return flatModels
        .map((model) => {
          const key = toModelKey(model.providerKind, model.slug);
          const score = scoreModelPickerSearch(
            {
              providerKind: model.providerKind,
              modelId: model.slug,
              name: model.name,
              shortName: model.shortName,
              subProvider: model.subProvider,
              isFavorite: favoriteKeySet.has(key),
            },
            searchQuery,
          );
          return score === null
            ? null
            : {
                model,
                score,
                tieBreaker: buildModelPickerSearchText({
                  providerKind: model.providerKind,
                  modelId: model.slug,
                  name: model.name,
                  shortName: model.shortName,
                  subProvider: model.subProvider,
                }),
              };
        })
        .filter(
          (
            entry,
          ): entry is {
            model: ModelPickerItem;
            score: number;
            tieBreaker: string;
          } => entry !== null,
        )
        .filter((entry) =>
          props.lockedProvider === null ? true : entry.model.providerKind === props.lockedProvider,
        )
        .toSorted((left, right) => {
          const scoreDelta = left.score - right.score;
          if (scoreDelta !== 0) return scoreDelta;
          return left.tieBreaker.localeCompare(right.tieBreaker);
        })
        .map((entry) => entry.model);
    }

    const providerFilteredModels =
      props.lockedProvider !== null
        ? flatModels.filter((model) => model.providerKind === props.lockedProvider)
        : selectedProvider === "favorites"
          ? flatModels.filter((model) =>
              favoriteKeySet.has(toModelKey(model.providerKind, model.slug)),
            )
          : flatModels.filter((model) => model.providerKind === selectedProvider);

    return providerFilteredModels.toSorted((left, right) => {
      const leftOrder = favoriteOrder.get(toModelKey(left.providerKind, left.slug));
      const rightOrder = favoriteOrder.get(toModelKey(right.providerKind, right.slug));
      if (leftOrder !== undefined && rightOrder !== undefined) return leftOrder - rightOrder;
      if (leftOrder !== undefined) return -1;
      if (rightOrder !== undefined) return 1;
      return 0;
    });
  }, [
    favoriteKeySet,
    favoriteOrder,
    flatModels,
    props.lockedProvider,
    searchQuery,
    selectedProvider,
  ]);

  const allModelKeys = useMemo(
    () => flatModels.map((model) => toModelKey(model.providerKind, model.slug)),
    [flatModels],
  );
  const filteredModelKeys = useMemo(
    () => filteredModels.map((model) => toModelKey(model.providerKind, model.slug)),
    [filteredModels],
  );
  const filteredModelByKey = useMemo(
    () =>
      new Map(
        filteredModels.map((model) => [toModelKey(model.providerKind, model.slug), model] as const),
      ),
    [filteredModels],
  );

  const handleModelSelect = useCallback(
    (providerKind: ProviderKind, modelId: string) => {
      const status = findProviderStatus(props.providers, providerKind);
      if (!isProviderSelectable(status)) {
        return;
      }
      const resolvedModel = resolveSelectableModel(
        providerKind,
        modelId,
        props.modelOptionsByProvider[providerKind],
      );
      if (!resolvedModel) {
        return;
      }
      props.onProviderModelChange(providerKind, resolvedModel);
    },
    [props],
  );

  const toggleFavorite = useCallback(
    (providerKind: ProviderKind, modelId: string) => {
      const existing = settings.favoriteModels;
      const index = existing.findIndex(
        (favorite) => favorite.providerKind === providerKind && favorite.modelId === modelId,
      );
      updateSettings({
        favoriteModels:
          index >= 0
            ? existing.filter((_, favoriteIndex) => favoriteIndex !== index)
            : [...existing, { providerKind, modelId }],
      });
    },
    [settings.favoriteModels, updateSettings],
  );

  const isLocked = props.lockedProvider !== null;
  const isSearching = searchQuery.trim().length > 0;
  const showSidebar = !isLocked && !isSearching;
  const lockedProviderIcon =
    props.lockedProvider !== null ? PROVIDER_ICON_BY_PROVIDER[props.lockedProvider] : null;
  const modelJumpCommandByKey = useMemo(() => {
    const mapping = new Map<
      string,
      NonNullable<ReturnType<typeof modelPickerJumpCommandForIndex>>
    >();
    for (const model of filteredModels) {
      const status = findProviderStatus(props.providers, model.providerKind);
      if (!isProviderSelectable(status)) {
        continue;
      }
      const command = modelPickerJumpCommandForIndex(mapping.size);
      if (!command) {
        return mapping;
      }
      mapping.set(toModelKey(model.providerKind, model.slug), command);
    }
    return mapping;
  }, [filteredModels, props.providers]);
  const modelJumpModelKeys = useMemo(
    () => [...modelJumpCommandByKey.keys()],
    [modelJumpCommandByKey],
  );
  const modelJumpShortcutContext = useMemo(
    () => ({
      terminalFocus: false,
      terminalOpen: props.terminalOpen,
      modelPickerOpen: true,
    }),
    [props.terminalOpen],
  );
  const modelJumpLabelByKey = useMemo((): ReadonlyMap<string, string> => {
    if (modelJumpCommandByKey.size === 0) {
      return EMPTY_MODEL_JUMP_LABELS;
    }
    const mapping = new Map<string, string>();
    for (const [modelKey, command] of modelJumpCommandByKey) {
      const label = shortcutLabelForCommand(keybindings, command, navigator.platform);
      if (label) {
        mapping.set(modelKey, label);
      }
    }
    return mapping.size > 0 ? mapping : EMPTY_MODEL_JUMP_LABELS;
  }, [keybindings, modelJumpCommandByKey]);

  useEffect(() => {
    const onWindowKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat) {
        return;
      }
      if (event.target === searchInputRef.current) {
        return;
      }
      const command = resolveShortcutCommand(event, keybindings, {
        platform: navigator.platform,
        context: modelJumpShortcutContext,
      });
      const jumpIndex = modelPickerJumpIndexFromCommand(command ?? "");
      if (jumpIndex === null) {
        return;
      }
      const targetModelKey = modelJumpModelKeys[jumpIndex];
      if (!targetModelKey) {
        return;
      }
      const parsed = parseModelKey(targetModelKey);
      if (!parsed) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      handleModelSelect(parsed.providerKind, parsed.modelId);
    };

    window.addEventListener("keydown", onWindowKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onWindowKeyDown, true);
    };
  }, [handleModelSelect, keybindings, modelJumpModelKeys, modelJumpShortcutContext]);

  useLayoutEffect(() => {
    const listRegion = listRegionRef.current;
    if (!listRegion) {
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      const viewport = listRegion.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]');
      if (!viewport || viewport.scrollHeight <= viewport.clientHeight) {
        return;
      }
      const originalScrollTop = viewport.scrollTop;
      viewport.scrollTop = Math.min(
        originalScrollTop + 1,
        viewport.scrollHeight - viewport.clientHeight,
      );
      viewport.scrollTop = originalScrollTop;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [filteredModelKeys]);

  return (
    <TooltipProvider delay={0}>
      <div
        className={cn(
          "relative flex h-screen max-h-96 w-screen max-w-100 overflow-hidden rounded-lg border bg-popover text-popover-foreground shadow-lg/5",
          isLocked ? "flex-col" : "flex-row",
        )}
      >
        {isLocked && lockedProviderIcon && props.lockedProvider ? (
          <div className="flex items-center gap-2 border-b px-4 py-3">
            {(() => {
              const LockedProviderIcon = lockedProviderIcon;
              return <LockedProviderIcon className="size-5 shrink-0" />;
            })()}
            <span className="text-sm font-medium">
              {PROVIDER_LABEL_BY_PROVIDER[props.lockedProvider]}
            </span>
          </div>
        ) : null}

        {showSidebar ? (
          <ModelPickerSidebar
            selectedProvider={selectedProvider}
            providers={props.providers}
            onSelectProvider={handleSelectProvider}
          />
        ) : null}

        <Combobox
          inline
          items={allModelKeys}
          filteredItems={filteredModelKeys}
          filter={null}
          autoHighlight
          open
          value={toModelKey(props.provider, props.model)}
          onItemHighlighted={(modelKey) => {
            highlightedModelKeyRef.current = typeof modelKey === "string" ? modelKey : null;
          }}
          onValueChange={(modelKey) => {
            if (typeof modelKey !== "string") {
              return;
            }
            const parsed = parseModelKey(modelKey);
            if (parsed) {
              handleModelSelect(parsed.providerKind, parsed.modelId);
            }
          }}
        >
          <div
            className={cn(
              "flex min-h-0 flex-1 flex-col overflow-hidden",
              isLocked ? "min-w-0" : showSidebar && "border-l",
            )}
          >
            <div className="border-b px-3 py-2">
              <ComboboxInput
                ref={searchInputRef}
                className="rounded-md [&_input]:font-sans"
                inputClassName="border-0 shadow-none ring-0 focus-visible:ring-0"
                placeholder="Search models..."
                showTrigger={false}
                startAddon={<SearchIcon className="size-4 shrink-0 text-muted-foreground/50" />}
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.preventDefault();
                    event.stopPropagation();
                    props.onRequestClose?.();
                    return;
                  }
                  if (event.key === "Enter" && highlightedModelKeyRef.current) {
                    (
                      event as typeof event & { preventBaseUIHandler?: () => void }
                    ).preventBaseUIHandler?.();
                    event.preventDefault();
                    event.stopPropagation();
                    const parsed = parseModelKey(highlightedModelKeyRef.current);
                    if (parsed) {
                      handleModelSelect(parsed.providerKind, parsed.modelId);
                    }
                    return;
                  }
                  event.stopPropagation();
                }}
                onMouseDown={(event) => event.stopPropagation()}
                onTouchStart={(event) => event.stopPropagation()}
                size="sm"
              />
            </div>

            <div
              ref={listRegionRef}
              className="relative min-h-0 flex-1 before:pointer-events-none before:absolute before:inset-0 before:bg-muted/40"
            >
              <ComboboxList className="model-picker-list size-full divide-y px-2 py-1">
                {filteredModelKeys.map((modelKey, index) => {
                  const model = filteredModelByKey.get(modelKey);
                  if (!model) {
                    return null;
                  }
                  const status = findProviderStatus(props.providers, model.providerKind);
                  const disabledReason = providerDisabledReason(status);
                  return (
                    <ModelListRow
                      key={modelKey}
                      index={index}
                      model={model}
                      providerKind={model.providerKind}
                      isFavorite={favoriteKeySet.has(modelKey)}
                      isSelected={
                        model.providerKind === props.provider && model.slug === props.model
                      }
                      showProvider={!isLocked}
                      disabled={disabledReason !== null}
                      disabledReason={disabledReason}
                      preferShortName={!isLocked}
                      useTriggerLabel={isLocked}
                      jumpLabel={modelJumpLabelByKey.get(modelKey) ?? null}
                      onToggleFavorite={() => toggleFavorite(model.providerKind, model.slug)}
                    />
                  );
                })}
              </ComboboxList>
            </div>
            <ComboboxEmpty className="not-empty:py-6 empty:h-0 text-xs font-normal leading-snug">
              No models found
            </ComboboxEmpty>
          </div>
        </Combobox>
      </div>
    </TooltipProvider>
  );
});
