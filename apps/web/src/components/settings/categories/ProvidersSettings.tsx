import {
  DEFAULT_GIT_TEXT_GENERATION_MODEL,
  DEFAULT_THREAD_TITLE_MODEL_BY_PROVIDER,
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  type ProviderInstanceConfig,
  type ProviderInstanceId,
  type ProviderKind,
  type ServerProvider,
  type ServerSettings,
} from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { Equal } from "effect";
import { PlusIcon, RotateCwIcon } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import {
  buildAppSettingsPatch,
  getAppModelOptions,
  resolveAuxiliaryAppModelSelection,
} from "../../../appSettings";
import { PROVIDER_LABEL_BY_PROVIDER } from "../../chat/providerIconUtils";
import {
  getCustomModelsForProvider,
  getDefaultCustomModelsForProvider,
  patchCustomModels,
} from "../useSettingsRouteState";
import { useSettingsRouteContext } from "../SettingsRouteContext";
import { useSettings as useUnifiedSettings, useUpdateSettings } from "../../../hooks/useSettings";
import { serverConfigQueryOptions, serverQueryKeys } from "../../../lib/serverReactQuery";
import { ensureNativeApi } from "../../../nativeApi";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../../ui/select";
import { AddProviderInstanceDialog } from "../AddProviderInstanceDialog";
import { ProviderInstanceCard } from "../ProviderInstanceCard";
import { getDriverOption } from "../providerDriverMeta";
import { buildProviderInstanceUpdatePatch } from "../SettingsPanels.logic";

const MODEL_PROVIDER_SETTINGS: Array<{
  provider: ProviderKind;
  title: string;
  description: string;
  placeholder: string;
  example: string;
}> = [
  {
    provider: "codex",
    title: "Codex",
    description: "Save additional Codex model slugs for the picker.",
    placeholder: "your-codex-model-slug",
    example: "gpt-6.7-codex-ultra-preview",
  },
  {
    provider: "claudeAgent",
    title: "Claude",
    description: "Save additional Claude model slugs for the picker.",
    placeholder: "your-claude-model-slug",
    example: "claude-sonnet-5-0",
  },
] as const;

const CODEX_OVERRIDE_KEYS = ["codexBinaryPath", "codexHomePath"] as const;
const GIT_KEYS = ["textGenerationModel"] as const;
const BUILT_IN_PROVIDER_DRIVERS = [
  ProviderDriverKind.make("codex"),
  ProviderDriverKind.make("claudeAgent"),
  ProviderDriverKind.make("cursor"),
  ProviderDriverKind.make("opencode"),
] as const;

function withoutProviderInstanceKey<V>(
  record: Readonly<Record<ProviderInstanceId, V>> | undefined,
  key: ProviderInstanceId,
): Record<ProviderInstanceId, V> {
  const next = { ...record } as Record<ProviderInstanceId, V>;
  delete next[key];
  return next;
}

function withoutProviderInstanceFavorites(
  favorites: ReadonlyArray<{ readonly provider: ProviderInstanceId; readonly model: string }>,
  instanceId: ProviderInstanceId,
) {
  return favorites.filter((favorite) => favorite.provider !== instanceId);
}

interface ProviderInstanceRow {
  readonly instanceId: ProviderInstanceId;
  readonly instance: ProviderInstanceConfig;
  readonly driver: ProviderDriverKind;
  readonly isDefault: boolean;
  readonly isDirty?: boolean;
}

export function ProvidersSettings() {
  const {
    settings,
    defaults,
    updateSettings,
    claudeLaunchArgsParseResult,
    customModelInputByProvider,
    setCustomModelInputByProvider,
    customModelErrorByProvider,
    setCustomModelErrorByProvider,
    addCustomModel,
    removeCustomModel,
    gitTextGenerationModelOptions,
    selectedGitTextGenerationModelLabel,
  } = useSettingsRouteContext();
  const unifiedSettings = useUnifiedSettings();
  const { updateSettings: updateUnifiedSettings } = useUpdateSettings();
  const queryClient = useQueryClient();
  const serverConfigQuery = useQuery(serverConfigQueryOptions());
  const liveProviders = serverConfigQuery.data?.providers ?? [];
  const [isAddInstanceDialogOpen, setIsAddInstanceDialogOpen] = useState(false);
  const [openInstanceDetails, setOpenInstanceDetails] = useState<Record<string, boolean>>({});
  const [isRefreshingProviders, setIsRefreshingProviders] = useState(false);
  const favoriteModelRows = settings.favoriteModels.map((favorite) => {
    const customModels = getCustomModelsForProvider(settings, favorite.providerKind);
    const option = getAppModelOptions(favorite.providerKind, customModels, favorite.modelId).find(
      (modelOption) => modelOption.slug === favorite.modelId,
    );
    return {
      ...favorite,
      label: option?.name ?? favorite.modelId,
      providerLabel: PROVIDER_LABEL_BY_PROVIDER[favorite.providerKind],
    };
  });
  const removeFavoriteModel = (favorite: (typeof favoriteModelRows)[number]) => {
    updateSettings({
      favoriteModels: settings.favoriteModels.filter(
        (entry) =>
          entry.providerKind !== favorite.providerKind || entry.modelId !== favorite.modelId,
      ),
    });
  };
  const instancesByDriver = new Map<
    ProviderDriverKind,
    Array<[ProviderInstanceId, ProviderInstanceConfig]>
  >();
  for (const [rawId, instance] of Object.entries(unifiedSettings.providerInstances ?? {})) {
    const driver = instance.driver;
    const list = instancesByDriver.get(driver) ?? [];
    list.push([rawId as ProviderInstanceId, instance]);
    instancesByDriver.set(driver, list);
  }

  const providerInstanceRows: ProviderInstanceRow[] = [];
  const visibleDriverKinds = new Set<ProviderDriverKind>(BUILT_IN_PROVIDER_DRIVERS);
  for (const driver of BUILT_IN_PROVIDER_DRIVERS) {
    type LegacyProviderSettings = ServerSettings["providers"][keyof ServerSettings["providers"]];
    const legacyProviders = unifiedSettings.providers as Record<string, LegacyProviderSettings>;
    const defaultLegacyProviders = DEFAULT_UNIFIED_SETTINGS.providers as Record<
      string,
      LegacyProviderSettings
    >;
    const defaultInstanceId = defaultInstanceIdForDriver(driver);
    const explicitInstance = unifiedSettings.providerInstances?.[defaultInstanceId];
    const legacyConfig = legacyProviders[driver]!;
    const defaultLegacyConfig = defaultLegacyProviders[driver]!;
    const effectiveInstance: ProviderInstanceConfig =
      explicitInstance ??
      ({
        driver,
        enabled: legacyConfig.enabled,
        config: legacyConfig,
      } satisfies ProviderInstanceConfig);
    providerInstanceRows.push({
      instanceId: defaultInstanceId,
      instance: effectiveInstance,
      driver,
      isDefault: true,
      isDirty: explicitInstance !== undefined || !Equal.equals(legacyConfig, defaultLegacyConfig),
    });
    for (const [id, instance] of instancesByDriver.get(driver) ?? []) {
      if (id === defaultInstanceId) continue;
      providerInstanceRows.push({
        instanceId: id,
        instance,
        driver: instance.driver,
        isDefault: false,
      });
    }
  }
  for (const [driver, list] of instancesByDriver) {
    if (visibleDriverKinds.has(driver)) continue;
    for (const [id, instance] of list) {
      providerInstanceRows.push({
        instanceId: id,
        instance,
        driver: instance.driver,
        isDefault: false,
      });
    }
  }

  const lastCheckedAt =
    liveProviders.length > 0
      ? liveProviders.reduce(
          (latest, provider) => (provider.checkedAt > latest ? provider.checkedAt : latest),
          liveProviders[0]!.checkedAt,
        )
      : null;

  const updateProviderInstance = (
    row: ProviderInstanceRow,
    next: ProviderInstanceConfig,
    options?: {
      readonly textGenerationModelSelection?: ServerSettings["textGenerationModelSelection"];
    },
  ) => {
    updateUnifiedSettings(
      buildProviderInstanceUpdatePatch({
        settings: unifiedSettings,
        instanceId: row.instanceId,
        instance: next,
        driver: row.driver,
        isDefault: row.isDefault,
        textGenerationModelSelection: options?.textGenerationModelSelection,
      }),
    );
  };

  const deleteProviderInstance = (id: ProviderInstanceId) => {
    updateUnifiedSettings({
      providerInstances: withoutProviderInstanceKey(unifiedSettings.providerInstances, id),
      providerModelPreferences: withoutProviderInstanceKey(
        unifiedSettings.providerModelPreferences,
        id,
      ),
      favorites: withoutProviderInstanceFavorites(unifiedSettings.favorites ?? [], id),
    });
  };

  const updateProviderModelPreferences = (
    instanceId: ProviderInstanceId,
    next: {
      readonly hiddenModels: ReadonlyArray<string>;
      readonly modelOrder: ReadonlyArray<string>;
    },
  ) => {
    const hiddenModels = [...new Set(next.hiddenModels.filter((slug) => slug.trim().length > 0))];
    const modelOrder = [...new Set(next.modelOrder.filter((slug) => slug.trim().length > 0))];
    const rest = withoutProviderInstanceKey(unifiedSettings.providerModelPreferences, instanceId);
    updateUnifiedSettings({
      providerModelPreferences:
        hiddenModels.length === 0 && modelOrder.length === 0
          ? rest
          : {
              ...rest,
              [instanceId]: {
                hiddenModels,
                modelOrder,
              },
            },
    });
  };

  const updateProviderFavoriteModels = (
    instanceId: ProviderInstanceId,
    nextFavoriteModels: ReadonlyArray<string>,
  ) => {
    const favoriteModels = [
      ...new Set(nextFavoriteModels.map((slug) => slug.trim()).filter((slug) => slug.length > 0)),
    ];
    updateUnifiedSettings({
      favorites: [
        ...withoutProviderInstanceFavorites(unifiedSettings.favorites ?? [], instanceId),
        ...favoriteModels.map((model) => ({ provider: instanceId, model })),
      ],
    });
  };

  const resetDefaultInstance = (driverKind: ProviderDriverKind) => {
    type LegacyProviderSettings = ServerSettings["providers"][keyof ServerSettings["providers"]];
    const defaultLegacyProviders = DEFAULT_UNIFIED_SETTINGS.providers as Record<
      string,
      LegacyProviderSettings | undefined
    >;
    const defaultInstanceId = defaultInstanceIdForDriver(driverKind);
    const defaultLegacyProvider = defaultLegacyProviders[driverKind];
    if (defaultLegacyProvider === undefined) return;
    updateUnifiedSettings({
      providers: {
        ...unifiedSettings.providers,
        [driverKind]: defaultLegacyProvider,
      } as typeof unifiedSettings.providers,
      providerInstances: withoutProviderInstanceKey(
        unifiedSettings.providerInstances,
        defaultInstanceId,
      ),
      providerModelPreferences: withoutProviderInstanceKey(
        unifiedSettings.providerModelPreferences,
        defaultInstanceId,
      ),
      favorites: withoutProviderInstanceFavorites(
        unifiedSettings.favorites ?? [],
        defaultInstanceId,
      ),
    });
  };
  const refreshProviders = () => {
    if (isRefreshingProviders) return;
    setIsRefreshingProviders(true);
    void ensureNativeApi()
      .server.refreshProviders()
      .then(({ providers }) => {
        queryClient.setQueryData(serverQueryKeys.config(), (existing) =>
          existing ? { ...existing, providers } : existing,
        );
      })
      .catch((error) => {
        console.warn("Failed to refresh providers", error);
      })
      .finally(() => {
        setIsRefreshingProviders(false);
      });
  };

  return (
    <>
      <section className="rounded-2xl border border-border bg-card">
        <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
          <div>
            <h2 className="text-sm font-medium text-foreground">Provider instances</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Configure built-in and custom provider instances. Unavailable providers stay visible
              here and in the picker until their CLI/auth probe passes.
            </p>
            {lastCheckedAt ? (
              <p className="mt-1 text-[11px] text-muted-foreground">
                Last checked: <code>{lastCheckedAt}</code>
              </p>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button
              size="xs"
              variant="outline"
              onClick={refreshProviders}
              disabled={isRefreshingProviders || serverConfigQuery.isFetching}
            >
              <RotateCwIcon className={`size-3 ${isRefreshingProviders ? "animate-spin" : ""}`} />
              Refresh
            </Button>
            <Button size="xs" onClick={() => setIsAddInstanceDialogOpen(true)}>
              <PlusIcon className="size-3" />
              Add
            </Button>
          </div>
        </div>

        <div>
          {providerInstanceRows.map((row) => {
            const driverOption = getDriverOption(row.driver);
            const liveProvider: ServerProvider | undefined = liveProviders.find(
              (candidate) => candidate.instanceId === row.instanceId,
            );
            const modelPreferences = unifiedSettings.providerModelPreferences?.[row.instanceId] ?? {
              hiddenModels: [],
              modelOrder: [],
            };
            const favoriteModels = (unifiedSettings.favorites ?? [])
              .filter((favorite) => favorite.provider === row.instanceId)
              .map((favorite) => favorite.model);
            const resetLabel = driverOption?.label ?? String(row.driver);
            return (
              <ProviderInstanceCard
                key={row.instanceId}
                instanceId={row.instanceId}
                instance={row.instance}
                driverOption={driverOption}
                liveProvider={liveProvider}
                isExpanded={openInstanceDetails[row.instanceId] ?? false}
                onExpandedChange={(open) =>
                  setOpenInstanceDetails((existing) => ({
                    ...existing,
                    [row.instanceId]: open,
                  }))
                }
                onUpdate={(next) => {
                  const wasEnabled = row.instance.enabled ?? true;
                  const isDisabling = next.enabled === false && wasEnabled;
                  const shouldClearTextGen =
                    isDisabling &&
                    unifiedSettings.textGenerationModelSelection.instanceId === row.instanceId;
                  updateProviderInstance(
                    row,
                    next,
                    shouldClearTextGen
                      ? {
                          textGenerationModelSelection:
                            DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection,
                        }
                      : undefined,
                  );
                }}
                onDelete={row.isDefault ? undefined : () => deleteProviderInstance(row.instanceId)}
                headerAction={
                  row.isDefault && row.isDirty ? (
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      className="size-5 rounded-sm p-0 text-muted-foreground hover:text-foreground"
                      onClick={() => resetDefaultInstance(row.driver)}
                      aria-label={`Reset ${resetLabel} provider settings`}
                    >
                      <RotateCwIcon className="size-3" />
                    </Button>
                  ) : null
                }
                hiddenModels={modelPreferences.hiddenModels}
                favoriteModels={favoriteModels}
                modelOrder={modelPreferences.modelOrder}
                onHiddenModelsChange={(hiddenModels) =>
                  updateProviderModelPreferences(row.instanceId, {
                    ...modelPreferences,
                    hiddenModels,
                  })
                }
                onFavoriteModelsChange={(nextFavoriteModels) =>
                  updateProviderFavoriteModels(row.instanceId, nextFavoriteModels)
                }
                onModelOrderChange={(modelOrder) =>
                  updateProviderModelPreferences(row.instanceId, {
                    ...modelPreferences,
                    modelOrder,
                  })
                }
              />
            );
          })}
        </div>
      </section>

      <section className="rounded-2xl border border-border bg-card p-5">
        <div className="mb-4">
          <h2 className="text-sm font-medium text-foreground">Codex App Server</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            These overrides apply to new sessions and let you use a non-default Codex install.
          </p>
        </div>

        <div className="space-y-4">
          <label htmlFor="codex-binary-path" className="block space-y-1">
            <span className="text-xs font-medium text-foreground">Codex binary path</span>
            <Input
              id="codex-binary-path"
              value={settings.codexBinaryPath}
              onChange={(event) => updateSettings({ codexBinaryPath: event.target.value })}
              placeholder="codex"
              spellCheck={false}
            />
            <span className="text-xs text-muted-foreground">
              Leave blank to use <code>codex</code> from your PATH.
            </span>
          </label>

          <label htmlFor="codex-home-path" className="block space-y-1">
            <span className="text-xs font-medium text-foreground">CODEX_HOME path</span>
            <Input
              id="codex-home-path"
              value={settings.codexHomePath}
              onChange={(event) => updateSettings({ codexHomePath: event.target.value })}
              placeholder="/Users/you/.codex"
              spellCheck={false}
            />
            <span className="text-xs text-muted-foreground">
              Optional custom Codex home/config directory.
            </span>
          </label>

          <div className="flex flex-col gap-3 text-xs text-muted-foreground sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0 flex-1">
              <p>Binary source</p>
              <p className="mt-1 break-all font-mono text-[11px] text-foreground">
                {settings.codexBinaryPath || "PATH"}
              </p>
            </div>
            <Button
              size="xs"
              variant="outline"
              className="self-start"
              onClick={() => updateSettings(buildAppSettingsPatch(CODEX_OVERRIDE_KEYS, defaults))}
            >
              Reset codex overrides
            </Button>
          </div>
        </div>
      </section>

      <section className="rounded-2xl border border-border bg-card p-5">
        <div className="mb-4">
          <h2 className="text-sm font-medium text-foreground">Claude Code</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            These overrides apply to new Claude sessions. Changing the binary or CLI flags restarts
            active Claude sessions.
          </p>
        </div>
        <div className="space-y-3">
          <label htmlFor="claude-binary-path" className="block space-y-1">
            <span className="text-xs font-medium text-foreground">Claude binary path</span>
            <Input
              id="claude-binary-path"
              value={settings.claudeBinaryPath}
              onChange={(event) => updateSettings({ claudeBinaryPath: event.target.value })}
              placeholder="claude"
              spellCheck={false}
            />
            <span className="text-xs text-muted-foreground">
              Leave blank to use <code>claude</code> from your PATH.
            </span>
          </label>

          <label htmlFor="claude-launch-args" className="block space-y-1">
            <span className="text-xs font-medium text-foreground">Additional CLI args</span>
            <Input
              id="claude-launch-args"
              value={settings.claudeLaunchArgs}
              onChange={(event) => updateSettings({ claudeLaunchArgs: event.target.value })}
              placeholder="--verbose --debug --some-flag=value"
              spellCheck={false}
            />
            <span className="text-xs text-muted-foreground">
              Use <code>--flag</code> or <code>--key=value</code>. Quote values with spaces.
              Positional arguments are not allowed.
            </span>
          </label>
          {claudeLaunchArgsParseResult.ok ? (
            Object.keys(claudeLaunchArgsParseResult.args).length > 0 ? (
              <p className="text-xs text-muted-foreground">
                Will pass:{" "}
                <code className="break-all text-foreground">
                  {Object.entries(claudeLaunchArgsParseResult.args)
                    .map(([key, value]) => (value === null ? `--${key}` : `--${key}=${value}`))
                    .join(" ")}
                </code>
              </p>
            ) : null
          ) : (
            <p className="text-xs text-destructive">
              Invalid arguments: {claudeLaunchArgsParseResult.error}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            {settings.claudeBinaryPath !== defaults.claudeBinaryPath ? (
              <Button
                size="xs"
                variant="outline"
                onClick={() => updateSettings({ claudeBinaryPath: defaults.claudeBinaryPath })}
              >
                Reset binary path
              </Button>
            ) : null}
            {settings.claudeLaunchArgs !== defaults.claudeLaunchArgs ? (
              <Button
                size="xs"
                variant="outline"
                onClick={() => updateSettings({ claudeLaunchArgs: defaults.claudeLaunchArgs })}
              >
                Reset CLI args
              </Button>
            ) : null}
          </div>
        </div>
      </section>

      <section className="rounded-2xl border border-border bg-card p-5">
        <div className="mb-4">
          <h2 className="text-sm font-medium text-foreground">Models</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Save additional provider model slugs so they appear in the chat model picker.
          </p>
        </div>

        <div className="space-y-5">
          <div className="rounded-xl border border-border bg-background/50 p-4">
            <div className="mb-4 flex items-start justify-between gap-3">
              <div>
                <h3 className="text-sm font-medium text-foreground">Favorite models</h3>
                <p className="mt-1 text-xs text-muted-foreground">
                  Star models in the picker to pin them at the top of model lists.
                </p>
              </div>
              {favoriteModelRows.length > 0 ? (
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() => updateSettings({ favoriteModels: defaults.favoriteModels })}
                >
                  Clear favorites
                </Button>
              ) : null}
            </div>
            {favoriteModelRows.length > 0 ? (
              <div className="space-y-2">
                {favoriteModelRows.map((favorite) => (
                  <div
                    key={`${favorite.providerKind}:${favorite.modelId}`}
                    className="flex items-center justify-between gap-3 rounded-lg border border-border bg-background px-3 py-2"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs font-medium text-foreground">
                        {favorite.label}
                      </p>
                      <p className="truncate text-[11px] text-muted-foreground">
                        {favorite.providerLabel} · {favorite.modelId}
                      </p>
                    </div>
                    <Button size="xs" variant="ghost" onClick={() => removeFavoriteModel(favorite)}>
                      Remove
                    </Button>
                  </div>
                ))}
              </div>
            ) : (
              <div className="rounded-lg border border-dashed border-border bg-background px-3 py-4 text-xs text-muted-foreground">
                No favorite models yet.
              </div>
            )}
          </div>

          {MODEL_PROVIDER_SETTINGS.map((providerSettings) => {
            const provider = providerSettings.provider;
            const customModels = getCustomModelsForProvider(settings, provider);
            const customModelInput = customModelInputByProvider[provider];
            const customModelError = customModelErrorByProvider[provider] ?? null;
            const threadTitleModelOptions = getAppModelOptions(
              provider,
              customModels,
              settings.codexThreadTitleModel,
            );
            const effectiveThreadTitleModel = resolveAuxiliaryAppModelSelection(
              provider,
              customModels,
              settings.codexThreadTitleModel,
              DEFAULT_THREAD_TITLE_MODEL_BY_PROVIDER[provider],
            );

            return (
              <div key={provider} className="rounded-xl border border-border bg-background/50 p-4">
                <div className="mb-4">
                  <h3 className="text-sm font-medium text-foreground">{providerSettings.title}</h3>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {providerSettings.description}
                  </p>
                </div>

                <div className="space-y-4">
                  <label className="block space-y-1">
                    <span className="text-xs font-medium text-foreground">Thread title model</span>
                    <Input
                      list={`thread-title-model-options-${provider}`}
                      value={settings.codexThreadTitleModel}
                      onChange={(event) =>
                        updateSettings({
                          codexThreadTitleModel: event.target.value,
                        })
                      }
                      placeholder={DEFAULT_THREAD_TITLE_MODEL_BY_PROVIDER[provider]}
                      spellCheck={false}
                    />
                    <datalist id={`thread-title-model-options-${provider}`}>
                      {threadTitleModelOptions.map((option) => (
                        <option key={`${provider}:thread-title:${option.slug}`} value={option.slug}>
                          {option.name}
                        </option>
                      ))}
                    </datalist>
                    <span className="text-xs text-muted-foreground">
                      Used for async first-thread title generation. Enter any model slug or pick a
                      saved suggestion. Invalid or removed saved slugs fall back to{" "}
                      <code>{DEFAULT_THREAD_TITLE_MODEL_BY_PROVIDER[provider]}</code>.
                    </span>
                    <span className="text-xs text-muted-foreground">
                      Effective model: <code>{effectiveThreadTitleModel}</code>
                    </span>
                  </label>

                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
                    <label
                      htmlFor={`custom-model-slug-${provider}`}
                      className="block flex-1 space-y-1"
                    >
                      <span className="text-xs font-medium text-foreground">Custom model slug</span>
                      <Input
                        id={`custom-model-slug-${provider}`}
                        value={customModelInput}
                        onChange={(event) => {
                          const value = event.target.value;
                          setCustomModelInputByProvider((existing) => ({
                            ...existing,
                            [provider]: value,
                          }));
                          if (customModelError) {
                            setCustomModelErrorByProvider((existing) => ({
                              ...existing,
                              [provider]: null,
                            }));
                          }
                        }}
                        onKeyDown={(event) => {
                          if (event.key !== "Enter") {
                            return;
                          }
                          event.preventDefault();
                          addCustomModel(provider);
                        }}
                        placeholder={providerSettings.placeholder}
                        spellCheck={false}
                      />
                      <span className="text-xs text-muted-foreground">
                        Example: <code>{providerSettings.example}</code>
                      </span>
                    </label>

                    <Button
                      className="sm:mt-6"
                      type="button"
                      onClick={() => addCustomModel(provider)}
                    >
                      Add model
                    </Button>
                  </div>

                  {customModelError ? (
                    <p className="text-xs text-destructive">{customModelError}</p>
                  ) : null}

                  <div className="space-y-2">
                    <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                      <p>Saved custom models: {customModels.length}</p>
                      {customModels.length > 0 ? (
                        <Button
                          size="xs"
                          variant="outline"
                          onClick={() =>
                            updateSettings(
                              patchCustomModels(provider, [
                                ...getDefaultCustomModelsForProvider(defaults, provider),
                              ]),
                            )
                          }
                        >
                          Reset custom models
                        </Button>
                      ) : null}
                    </div>

                    {customModels.length > 0 ? (
                      <div className="space-y-2">
                        {customModels.map((slug) => (
                          <div
                            key={`${provider}:${slug}`}
                            className="flex items-center justify-between gap-3 rounded-lg border border-border bg-background px-3 py-2"
                          >
                            <code className="min-w-0 flex-1 truncate text-xs text-foreground">
                              {slug}
                            </code>
                            <Button
                              size="xs"
                              variant="ghost"
                              onClick={() => removeCustomModel(provider, slug)}
                            >
                              Remove
                            </Button>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="rounded-lg border border-dashed border-border bg-background px-3 py-4 text-xs text-muted-foreground">
                        No custom models saved yet.
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <section className="rounded-2xl border border-border bg-card p-5">
        <div className="mb-4">
          <h2 className="text-sm font-medium text-foreground">Git</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Configure the model used for generating commit messages, PR titles, and branch names.
          </p>
        </div>

        <div className="flex flex-col gap-4 rounded-lg border border-border bg-background px-3 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-foreground">Text generation model</p>
            <p className="text-xs text-muted-foreground">
              Model used for auto-generated git content.
            </p>
          </div>
          <Select
            value={settings.textGenerationModel ?? DEFAULT_GIT_TEXT_GENERATION_MODEL}
            onValueChange={(value) => {
              if (value) {
                updateSettings({
                  textGenerationModel: value,
                });
              }
            }}
          >
            <SelectTrigger
              className="w-full shrink-0 sm:w-48"
              aria-label="Git text generation model"
            >
              <SelectValue>{selectedGitTextGenerationModelLabel}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end">
              {gitTextGenerationModelOptions.map((option) => (
                <SelectItem key={option.slug} value={option.slug}>
                  {option.name}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>

        {settings.textGenerationModel !== defaults.textGenerationModel ? (
          <div className="mt-3 flex justify-end">
            <Button
              size="xs"
              variant="outline"
              onClick={() => updateSettings(buildAppSettingsPatch(GIT_KEYS, defaults))}
            >
              Restore default
            </Button>
          </div>
        ) : null}
      </section>

      <AddProviderInstanceDialog
        open={isAddInstanceDialogOpen}
        onOpenChange={setIsAddInstanceDialogOpen}
      />
    </>
  );
}
