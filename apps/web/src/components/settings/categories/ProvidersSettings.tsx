import {
  DEFAULT_GIT_TEXT_GENERATION_MODEL,
  DEFAULT_THREAD_TITLE_MODEL_BY_PROVIDER,
  type ProviderKind,
} from "@t3tools/contracts";

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
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../../ui/select";

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

  return (
    <>
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
    </>
  );
}
