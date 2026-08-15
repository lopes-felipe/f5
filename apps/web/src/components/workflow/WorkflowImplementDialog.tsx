import { useEffect, useMemo, useRef, useState } from "react";
import type {
  ModelSlug,
  PlanningWorkflow,
  ProviderKind,
  ProviderModelOptions,
  RuntimeMode,
} from "@t3tools/contracts";
import { RUNTIME_MODE_VALUES } from "@t3tools/contracts";
import { normalizeModelSlug } from "@t3tools/shared/model";
import { runtimeModeCapabilities } from "@t3tools/shared/runtimeMode";
import { useQuery } from "@tanstack/react-query";
import { ChevronDownIcon } from "lucide-react";

import { useAppSettings } from "../../appSettings";
import { gitBranchesQueryOptions } from "../../lib/gitReactQuery";
import { useProjectThreadEnvModeResolver } from "../../lib/projectConfigReactQuery";
import { serverConfigQueryOptions } from "../../lib/serverReactQuery";
import { getModelPreferences, recordModelSelection } from "../../modelPreferencesStore";
import { readNativeApi } from "../../nativeApi";
import { useStore } from "../../store";
import { resolveProviderOptionsForDispatch } from "../../providerOptionsForDispatch";
import {
  getCustomModelOptionsByProvider,
  getProviderDispatchModelsByProvider,
  resolveComposerPickerModel,
} from "../ChatView.logic";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxTrigger,
} from "../ui/combobox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { ProviderFields, normalizeWorkflowSlotModelOptions } from "./WorkflowCreateDialog";
import { RUNTIME_MODE_PRESENTATION } from "../chat/runtimeModePresentation";

function getSingleProviderModelOptions(
  provider: ProviderKind,
  modelOptions: ProviderModelOptions | null | undefined,
): ProviderModelOptions | undefined {
  switch (provider) {
    case "codex":
      return modelOptions?.codex ? { codex: modelOptions.codex } : undefined;
    case "claudeAgent":
      return modelOptions?.claudeAgent ? { claudeAgent: modelOptions.claudeAgent } : undefined;
    case "cursor":
      return modelOptions?.cursor ? { cursor: modelOptions.cursor } : undefined;
    case "opencode":
      return modelOptions?.opencode ? { opencode: modelOptions.opencode } : undefined;
    case "grok":
      return undefined;
  }
}

function resolveImplementationDefaults(workflow: PlanningWorkflow) {
  const slotProvider = workflow.merge.mergeSlot.provider;
  const slotModelOptions =
    workflow.merge.mergeSlot.modelOptions ??
    getSingleProviderModelOptions(slotProvider, getModelPreferences().lastModelOptions);

  return {
    provider: slotProvider,
    model: workflow.merge.mergeSlot.model,
    modelOptions: slotModelOptions,
  };
}

type EnvModeChoice = "local" | "worktree";

function BaseBranchPicker(props: {
  cwd: string | null;
  value: string | null;
  onChange: (branch: string | null) => void;
}) {
  const { settings } = useAppSettings();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const gitAutoRefreshIntervalMs = settings.gitStatusAutoRefreshIntervalSeconds * 1000;
  const gitAutoRefreshEnabled = settings.gitStatusAutoRefreshIntervalSeconds > 0;

  const branchesQuery = useQuery(
    gitBranchesQueryOptions({
      cwd: props.cwd,
      autoRefresh: gitAutoRefreshEnabled,
      refetchIntervalMs: gitAutoRefreshIntervalMs,
    }),
  );

  const branchNames = useMemo(() => {
    const names = (branchesQuery.data?.branches ?? []).map((branch) => branch.name);
    return Array.from(new Set(names));
  }, [branchesQuery.data?.branches]);

  const normalizedQuery = query.trim().toLowerCase();
  const filteredBranchNames = useMemo(() => {
    if (normalizedQuery.length === 0) return branchNames;
    return branchNames.filter((name) => name.toLowerCase().includes(normalizedQuery));
  }, [branchNames, normalizedQuery]);

  return (
    <Combobox
      items={branchNames}
      filteredItems={filteredBranchNames}
      autoHighlight
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (!nextOpen) setQuery("");
      }}
      open={open}
      value={props.value}
    >
      <ComboboxTrigger
        render={
          <Button
            variant="outline"
            size="sm"
            className="w-full justify-between"
            data-testid="workflow-implement-base-branch-trigger"
          />
        }
        disabled={!props.cwd || (branchesQuery.isLoading && branchNames.length === 0)}
      >
        <span className="max-w-[360px] truncate">{props.value ?? "Select base branch"}</span>
        <ChevronDownIcon aria-hidden />
      </ComboboxTrigger>
      <ComboboxPopup align="start" side="bottom" className="w-80">
        <div className="border-b p-1">
          <ComboboxInput
            className="[&_input]:font-sans rounded-md"
            inputClassName="ring-0"
            placeholder="Search branches..."
            showTrigger={false}
            size="sm"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <ComboboxEmpty>No branches found.</ComboboxEmpty>
        <ComboboxList className="max-h-56">
          {filteredBranchNames.map((branchName, index) => (
            <ComboboxItem
              hideIndicator
              key={branchName}
              index={index}
              value={branchName}
              onClick={() => {
                props.onChange(branchName);
                setOpen(false);
                setQuery("");
              }}
            >
              <span className="truncate">{branchName}</span>
            </ComboboxItem>
          ))}
        </ComboboxList>
      </ComboboxPopup>
    </Combobox>
  );
}

export function WorkflowImplementDialog(props: {
  open: boolean;
  workflow: PlanningWorkflow;
  onOpenChange: (open: boolean) => void;
}) {
  const { settings } = useAppSettings();
  const serverConfigQuery = useQuery(serverConfigQueryOptions());
  const resolveProjectThreadEnvMode = useProjectThreadEnvModeResolver();
  const initialDefaults = resolveImplementationDefaults(props.workflow);
  const [provider, setProvider] = useState<ProviderKind>(initialDefaults.provider);
  const [model, setModel] = useState(initialDefaults.model);
  const [modelOptions, setModelOptions] = useState<ProviderModelOptions | undefined>(
    initialDefaults.modelOptions,
  );
  const [runtimeMode, setRuntimeMode] = useState<RuntimeMode>("full-access");
  const [codeReviewEnabled, setCodeReviewEnabled] = useState(true);
  const [envMode, setEnvMode] = useState<EnvModeChoice>("local");
  const [baseBranch, setBaseBranch] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const modelOptionsByProvider = useMemo(
    () =>
      getCustomModelOptionsByProvider(
        settings,
        serverConfigQuery.data?.providers,
        serverConfigQuery.data?.settings,
      ),
    [settings, serverConfigQuery.data?.providers, serverConfigQuery.data?.settings],
  );
  const dispatchModelsByProvider = useMemo(
    () =>
      getProviderDispatchModelsByProvider(
        settings,
        serverConfigQuery.data?.providers,
        serverConfigQuery.data?.settings,
      ),
    [settings, serverConfigQuery.data?.providers, serverConfigQuery.data?.settings],
  );
  const wasOpenRef = useRef(false);
  const envModeTouchedRef = useRef(false);
  const envModeResolutionRef = useRef(0);

  const project = useStore(
    (store) => store.projects.find((entry) => entry.id === props.workflow.projectId) ?? null,
  );
  const projectCwd = project?.cwd ?? null;

  useEffect(() => {
    if (!runtimeModeCapabilities(provider).has(runtimeMode)) {
      setRuntimeMode("full-access");
    }
  }, [provider, runtimeMode]);

  useEffect(() => {
    if (props.open && !wasOpenRef.current) {
      const resolution = ++envModeResolutionRef.current;
      const defaults = resolveImplementationDefaults(props.workflow);
      setProvider(defaults.provider);
      setModel(defaults.model);
      setModelOptions(defaults.modelOptions);
      setRuntimeMode("full-access");
      setCodeReviewEnabled(true);
      setEnvMode("local");
      envModeTouchedRef.current = false;
      void resolveProjectThreadEnvMode(props.workflow.projectId).then((resolved) => {
        if (envModeResolutionRef.current === resolution && !envModeTouchedRef.current) {
          setEnvMode(resolved);
        }
      });
      setBaseBranch(null);
      setSubmitting(false);
      setError(null);
    }
    if (!props.open) envModeResolutionRef.current += 1;
    wasOpenRef.current = props.open;
  }, [props.open, props.workflow, resolveProjectThreadEnvMode]);

  const resolveWorkflowModelSelection = (
    nextProvider: ProviderKind,
    nextModel: string,
  ): ModelSlug =>
    resolveComposerPickerModel({
      provider: nextProvider,
      rawModel: nextModel,
      pickerOptions: modelOptionsByProvider[nextProvider],
      providers: serverConfigQuery.data?.providers ?? null,
    }) as ModelSlug;

  const selection = resolveWorkflowModelSelection(provider, model);
  useEffect(() => {
    if (!serverConfigQuery.data || model === selection) return;
    const preservesOptions = normalizeModelSlug(model, provider) === selection;
    setModel(selection);
    if (!preservesOptions) setModelOptions(undefined);
  }, [model, provider, selection, serverConfigQuery.data]);

  const needsBaseBranch = envMode === "worktree" && !baseBranch;
  const submitDisabled = submitting || needsBaseBranch || serverConfigQuery.data === undefined;

  const onSubmit = async () => {
    const api = readNativeApi();
    if (!api) {
      setError("Native API is unavailable.");
      return;
    }

    if (envMode === "worktree" && !baseBranch) {
      setError("Select a base branch before sending in New worktree mode.");
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      const normalizedModelOptions = normalizeWorkflowSlotModelOptions(
        provider,
        selection,
        modelOptions,
      );
      const providerOptions = resolveProviderOptionsForDispatch({
        settings,
        provider,
        projectId: props.workflow.projectId,
        availableModels: dispatchModelsByProvider[provider],
      });
      await api.orchestration.startImplementation({
        workflowId: props.workflow.id,
        provider,
        model: selection,
        ...(normalizedModelOptions ? { modelOptions: normalizedModelOptions } : {}),
        ...(providerOptions ? { providerOptions } : {}),
        runtimeMode,
        codeReviewEnabled,
        envMode,
        ...(envMode === "worktree" && baseBranch ? { baseBranch } : {}),
      });
      props.onOpenChange(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Implement workflow plan</DialogTitle>
          <DialogDescription>
            Pick the model and runtime settings for the implementation thread.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          <ProviderFields
            label="Implementation model"
            provider={provider}
            model={selection}
            modelOptions={modelOptions}
            modelOptionsByProvider={modelOptionsByProvider}
            onProviderModelChange={(nextProvider, nextModel) => {
              setProvider(nextProvider);
              setModel(nextModel);
              setModelOptions(undefined);
              recordModelSelection(nextProvider, nextModel, undefined);
            }}
            onModelOptionsChange={(nextModelOptions) => {
              setModelOptions(nextModelOptions);
              recordModelSelection(
                provider,
                selection,
                normalizeWorkflowSlotModelOptions(provider, selection, nextModelOptions),
              );
            }}
          />
          <div className="space-y-2 rounded-md border border-input bg-background px-3 py-3">
            <label
              className="block text-sm font-medium text-foreground"
              htmlFor="workflow-runtime-mode"
            >
              Access mode
            </label>
            <select
              id="workflow-runtime-mode"
              className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
              value={runtimeMode}
              onChange={(event) => setRuntimeMode(event.currentTarget.value as RuntimeMode)}
            >
              {RUNTIME_MODE_VALUES.map((mode) => (
                <option
                  key={mode}
                  value={mode}
                  disabled={!runtimeModeCapabilities(provider).has(mode)}
                >
                  {RUNTIME_MODE_PRESENTATION[mode].label}
                </option>
              ))}
            </select>
            <p className="text-sm text-muted-foreground">
              {RUNTIME_MODE_PRESENTATION[runtimeMode].description}
            </p>
          </div>
          <div className="space-y-2 rounded-md border border-input bg-background px-3 py-3">
            <label className="flex items-start gap-3">
              <Checkbox
                checked={codeReviewEnabled}
                onCheckedChange={(checked) => setCodeReviewEnabled(checked === true)}
              />
              <span className="space-y-1">
                <span className="block text-sm font-medium text-foreground">
                  Code review after implementation
                </span>
                <span className="block text-sm text-muted-foreground">
                  After implementation completes, both planning models review the code before
                  feedback is applied.
                </span>
              </span>
            </label>
          </div>
          <div
            className="flex flex-wrap items-center gap-2"
            data-testid="workflow-implement-env-mode"
          >
            <span className="text-sm font-medium text-foreground">Environment</span>
            <div className="flex gap-1">
              <Button
                type="button"
                variant={envMode === "local" ? "default" : "outline"}
                size="sm"
                aria-pressed={envMode === "local"}
                onClick={() => {
                  envModeTouchedRef.current = true;
                  setEnvMode("local");
                  setBaseBranch(null);
                }}
              >
                Local
              </Button>
              <Button
                type="button"
                variant={envMode === "worktree" ? "default" : "outline"}
                size="sm"
                aria-pressed={envMode === "worktree"}
                onClick={() => {
                  envModeTouchedRef.current = true;
                  setEnvMode("worktree");
                }}
              >
                New worktree
              </Button>
            </div>
            {envMode === "worktree" ? (
              <div className="min-w-[12rem] flex-1">
                <BaseBranchPicker cwd={projectCwd} value={baseBranch} onChange={setBaseBranch} />
              </div>
            ) : null}
            {envMode === "worktree" && needsBaseBranch ? (
              <p className="w-full text-xs text-muted-foreground">
                Select a base branch before sending.
              </p>
            ) : null}
          </div>
          {error ? <p className="text-sm text-red-500">{error}</p> : null}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={() => props.onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => void onSubmit()} disabled={submitDisabled}>
            {submitting ? "Starting..." : "Start implementation"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
