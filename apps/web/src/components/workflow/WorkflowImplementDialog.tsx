import { useEffect, useMemo, useState } from "react";
import type {
  ModelSlug,
  PlanningWorkflow,
  ProviderKind,
  ProviderModelOptions,
} from "@t3tools/contracts";
import { useQuery } from "@tanstack/react-query";
import { ChevronDownIcon } from "lucide-react";

import { resolveAppModelSelection, useAppSettings } from "../../appSettings";
import { gitBranchesQueryOptions } from "../../lib/gitReactQuery";
import { getModelPreferences, recordModelSelection } from "../../modelPreferencesStore";
import { readNativeApi } from "../../nativeApi";
import { useStore } from "../../store";
import { getCustomModelOptionsByProvider } from "../ChatView.logic";
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

  const branchesQuery = useQuery(
    gitBranchesQueryOptions({
      cwd: props.cwd,
      autoRefresh: settings.enableGitStatusAutoRefresh,
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
  const initialDefaults = resolveImplementationDefaults(props.workflow);
  const [provider, setProvider] = useState<ProviderKind>(initialDefaults.provider);
  const [model, setModel] = useState(initialDefaults.model);
  const [modelOptions, setModelOptions] = useState<ProviderModelOptions | undefined>(
    initialDefaults.modelOptions,
  );
  const [requireApproval, setRequireApproval] = useState(false);
  const [codeReviewEnabled, setCodeReviewEnabled] = useState(true);
  const [envMode, setEnvMode] = useState<EnvModeChoice>("local");
  const [baseBranch, setBaseBranch] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const modelOptionsByProvider = useMemo(
    () => getCustomModelOptionsByProvider(settings),
    [settings],
  );

  const project = useStore(
    (store) => store.projects.find((entry) => entry.id === props.workflow.projectId) ?? null,
  );
  const projectCwd = project?.cwd ?? null;

  useEffect(() => {
    if (!props.open) {
      return;
    }
    const defaults = resolveImplementationDefaults(props.workflow);
    setProvider(defaults.provider);
    setModel(defaults.model);
    setModelOptions(defaults.modelOptions);
    setRequireApproval(false);
    setCodeReviewEnabled(true);
    setEnvMode("local");
    setBaseBranch(null);
    setSubmitting(false);
    setError(null);
  }, [props.open, props.workflow]);

  const resolveWorkflowModelSelection = (
    nextProvider: ProviderKind,
    nextModel: string,
  ): ModelSlug =>
    resolveAppModelSelection(
      nextProvider,
      nextProvider === "codex"
        ? settings.customCodexModels
        : nextProvider === "claudeAgent"
          ? settings.customClaudeModels
          : [],
      nextModel,
    ) as ModelSlug;

  const selection = resolveWorkflowModelSelection(provider, model);

  const needsBaseBranch = envMode === "worktree" && !baseBranch;
  const submitDisabled = submitting || needsBaseBranch;

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
      await api.orchestration.startImplementation({
        workflowId: props.workflow.id,
        provider,
        model: selection,
        ...(normalizedModelOptions ? { modelOptions: normalizedModelOptions } : {}),
        runtimeMode: requireApproval ? "approval-required" : "full-access",
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
            <label className="flex items-start gap-3">
              <Checkbox
                checked={requireApproval}
                onCheckedChange={(checked) => setRequireApproval(checked === true)}
              />
              <span className="space-y-1">
                <span className="block text-sm font-medium text-foreground">Require approval</span>
                <span className="block text-sm text-muted-foreground">
                  Use approval-required runtime mode instead of full-access for the implementation
                  thread.
                </span>
              </span>
            </label>
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
                onClick={() => setEnvMode("worktree")}
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
