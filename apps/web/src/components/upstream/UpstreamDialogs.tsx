import {
  UPSTREAM_MAX_PORT_TOPICS,
  type ModelSelection,
  type RuntimeMode,
  type ServerProvider,
  type UpstreamOverview,
} from "@t3tools/contracts";
import { RUNTIME_MODE_VALUES } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Textarea } from "../ui/textarea";
import { portLimitError } from "./upstreamPage.logic";

const selectClassName = "w-full rounded border bg-background p-2 text-sm";

export function DeclineDialog(props: {
  readonly open: boolean;
  readonly count: number;
  readonly onClose: () => void;
  readonly onConfirm: (reason: string) => void;
}) {
  const [reason, setReason] = useState("");
  useEffect(() => {
    if (props.open) setReason("");
  }, [props.open]);
  return (
    <Dialog open={props.open} onOpenChange={(open) => !open && props.onClose()}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Decline {props.count === 1 ? "topic" : `${props.count} topics`}</DialogTitle>
          <DialogDescription>Declined topics stay in Skipped with your reason.</DialogDescription>
        </DialogHeader>
        <div className="px-6">
          <Textarea
            aria-label="Decline reason"
            autoFocus
            value={reason}
            placeholder="Why f5 does not want this change"
            onChange={(event) => setReason(event.target.value)}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={props.onClose}>
            Cancel
          </Button>
          <Button disabled={!reason.trim()} onClick={() => props.onConfirm(reason.trim())}>
            Decline
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

export function SkipReasonDialog(props: {
  readonly open: boolean;
  readonly count: number;
  readonly reasonKeys: ReadonlyArray<string>;
  readonly reasonLabels: Readonly<Record<string, string>>;
  readonly upstreamOnlySubsystems: ReadonlyArray<string>;
  readonly preselected: string | null;
  readonly defaultReason?: string;
  readonly onClose: () => void;
  readonly onConfirm: (input: { reasonKey: string; reason?: string }) => void;
}) {
  const [reasonKey, setReasonKey] = useState("");
  const [reason, setReason] = useState("");
  useEffect(() => {
    if (!props.open) return;
    setReasonKey(props.preselected ?? "");
    setReason(props.defaultReason ?? "");
  }, [props.open, props.preselected, props.defaultReason]);
  const keys = [...props.reasonKeys, ...props.upstreamOnlySubsystems.map((slug) => `upstream-only:${slug}`)];
  return (
    <Dialog open={props.open} onOpenChange={(open) => !open && props.onClose()}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Skip {props.count === 1 ? "topic" : `${props.count} topics`}</DialogTitle>
          <DialogDescription>Choose the reason recorded in the ledger.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3 px-6">
          <select
            aria-label="Skip reason"
            autoFocus
            className={selectClassName}
            value={reasonKey}
            onChange={(event) => setReasonKey(event.target.value)}
          >
            <option value="">Choose a reason…</option>
            {keys.map((key) => (
              <option key={key} value={key}>
                {props.reasonLabels[key] ?? (key.startsWith("upstream-only:") ? `Upstream-only: ${key.slice(14)}` : key)}
              </option>
            ))}
          </select>
          <Textarea
            aria-label="Skip note"
            value={reason}
            placeholder="Optional note (defaults to the reason label)"
            onChange={(event) => setReason(event.target.value)}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={props.onClose}>
            Cancel
          </Button>
          <Button
            disabled={!reasonKey}
            onClick={() => props.onConfirm({ reasonKey, ...(reason.trim() ? { reason: reason.trim() } : {}) })}
          >
            Skip
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

export interface ModelOption {
  readonly key: string;
  readonly label: string;
  readonly selection: ModelSelection;
}

export function modelOptions(
  providers: ReadonlyArray<ServerProvider>,
  filter: (provider: ServerProvider) => boolean = () => true,
): ModelOption[] {
  return providers
    .filter((provider) => provider.enabled && provider.installed && filter(provider))
    .flatMap((provider) =>
      provider.models.map((model) => ({
        key: `${provider.instanceId}::${model.slug}`,
        label: `${provider.displayName ?? provider.instanceId} · ${model.name}`,
        selection: { instanceId: provider.instanceId, model: model.slug } as ModelSelection,
      })),
    );
}

export const selectionKey = (selection: ModelSelection | null | undefined) =>
  selection ? `${selection.instanceId}::${selection.model}` : "";

export function StartPortDialog(props: {
  readonly open: boolean;
  readonly topicIds: ReadonlyArray<string>;
  readonly models: ReadonlyArray<ModelOption>;
  readonly defaultModel: ModelSelection | null;
  readonly defaultRuntimeMode: RuntimeMode;
  readonly overview: UpstreamOverview;
  readonly busy: boolean;
  readonly onClose: () => void;
  readonly onRunFirst: () => void;
  readonly onStart: (input: {
    grouping: "together" | "separately";
    modelSelection: ModelSelection;
    runtimeMode: RuntimeMode;
    clientRequestId: string;
  }) => void;
}) {
  const [grouping, setGrouping] = useState<"together" | "separately">("together");
  const [model, setModel] = useState("");
  const [runtimeMode, setRuntimeMode] = useState<RuntimeMode>(props.defaultRuntimeMode);
  // One id per dialog open, reused on retry so the server deduplicates.
  const [clientRequestId, setClientRequestId] = useState(() => crypto.randomUUID());
  useEffect(() => {
    if (!props.open) return;
    setGrouping("together");
    setModel(selectionKey(props.defaultModel) || props.models[0]?.key || "");
    setRuntimeMode(props.defaultRuntimeMode);
    setClientRequestId(crypto.randomUUID());
  }, [props.open, props.defaultModel, props.defaultRuntimeMode, props.models]);
  const limitError = portLimitError(props.topicIds.length, grouping);
  const selected = props.models.find((option) => option.key === model);
  const untriaged = props.overview.untriagedUpstreamCount;
  return (
    <Dialog open={props.open} onOpenChange={(open) => !open && !props.busy && props.onClose()}>
      <DialogPopup showCloseButton={!props.busy}>
        <DialogHeader>
          <DialogTitle>
            Start port{props.topicIds.length > 1 ? ` (${props.topicIds.length} topics)` : ""}
          </DialogTitle>
          <DialogDescription>
            Each thread gets its own worktree and branch. Up to {UPSTREAM_MAX_PORT_TOPICS} topics and 5 threads per
            start.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 px-6 text-sm">
          {untriaged > 0 && (
            <div role="status" className="flex flex-wrap items-center gap-2 rounded-md border border-warning/40 bg-warning/8 p-2">
              <span>
                {untriaged} newer upstream commit{untriaged === 1 ? " is" : "s are"} not triaged yet; they may contain
                follow-ups or reverts.
              </span>
              <Button size="xs" variant="outline" disabled={props.busy} onClick={props.onRunFirst}>
                Run now first
              </Button>
            </div>
          )}
          {props.topicIds.length > 1 && (
            <fieldset className="space-y-1">
              <legend className="font-medium">Grouping</legend>
              <label className="flex items-center gap-2">
                <input type="radio" checked={grouping === "together"} onChange={() => setGrouping("together")} />
                One thread for all topics
              </label>
              <label className="flex items-center gap-2">
                <input type="radio" checked={grouping === "separately"} onChange={() => setGrouping("separately")} />
                One thread per topic
              </label>
            </fieldset>
          )}
          <label className="block space-y-1">
            <span className="font-medium">Model</span>
            <select aria-label="Port model" className={selectClassName} value={model} onChange={(e) => setModel(e.target.value)}>
              {props.models.map((option) => (
                <option key={option.key} value={option.key}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label className="block space-y-1">
            <span className="font-medium">Runtime mode</span>
            <select
              aria-label="Runtime mode"
              className={selectClassName}
              value={runtimeMode}
              onChange={(e) => setRuntimeMode(e.target.value as RuntimeMode)}
            >
              {RUNTIME_MODE_VALUES.map((mode) => (
                <option key={mode} value={mode}>
                  {mode}
                </option>
              ))}
            </select>
          </label>
          {limitError && (
            <p role="alert" className="text-destructive-foreground">
              {limitError}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={props.busy} onClick={props.onClose}>
            Cancel
          </Button>
          <Button
            disabled={props.busy || limitError !== null || !selected}
            onClick={() =>
              selected && props.onStart({ grouping, modelSelection: selected.selection, runtimeMode, clientRequestId })
            }
          >
            Start port
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
