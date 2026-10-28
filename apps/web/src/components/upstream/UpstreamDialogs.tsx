import {
  isKnownProviderKind,
  ProviderDriverKind,
  UPSTREAM_MAX_PORT_TOPICS,
  type ModelSelection,
  type ProjectId,
  type RuntimeMode,
  type ServerProvider,
  type UpstreamOverview,
  type UpstreamPortReviewSettings,
  type UpstreamPortReviewRequest,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { projectProviderSnapshots } from "@t3tools/shared/serverSettings";
import { useEffect, useState } from "react";

import { useSettings } from "../../hooks/useSettings";
import { getModelPreferences } from "../../modelPreferencesStore";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import { useStore } from "../../store";
import {
  isReadyProvider,
  pickedModelSelection,
  resolveNewThreadModelSelection,
} from "../chat/newThreadModelSelection";
import { ProviderInstanceModelPicker } from "../chat/ProviderInstanceModelPicker";
import { RuntimeModePicker } from "../chat/RuntimeModePicker";
import { TraitsPicker } from "../chat/TraitsPicker";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { randomUUID } from "../../lib/utils";
import {
  Select,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { Textarea } from "../ui/textarea";
import { portLimitError } from "./upstreamPage.logic";
import { getCustomModelOptionsByProvider, getProviderDispatchModelsByProvider } from "../ChatView.logic";
import { makeWorkflowSlotBuilder } from "../workflow/workflowSlots";
import { PortReviewOptions, portReviewDefaults, portReviewOptionsError } from "./PortReviewOptions";

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
  const upstreamOnly = props.upstreamOnlySubsystems.map((slug) => `upstream-only:${slug}`);
  const labelOf = (key: string) =>
    props.reasonLabels[key] ?? (key.startsWith("upstream-only:") ? `Upstream-only: ${key.slice(14)}` : key);
  return (
    <Dialog open={props.open} onOpenChange={(open) => !open && props.onClose()}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Skip {props.count === 1 ? "topic" : `${props.count} topics`}</DialogTitle>
          <DialogDescription>Choose the reason recorded in the ledger.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3 px-6">
          <Select value={reasonKey || null} onValueChange={(value) => setReasonKey(value ?? "")}>
            <SelectTrigger aria-label="Skip reason" autoFocus>
              <SelectValue>{reasonKey ? labelOf(reasonKey) : "Choose a reason…"}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {props.reasonKeys.map((key) => (
                <SelectItem key={key} value={key}>
                  {labelOf(key)}
                </SelectItem>
              ))}
              {upstreamOnly.length > 0 && (
                <SelectGroup>
                  <SelectGroupLabel>Upstream-only subsystems</SelectGroupLabel>
                  {upstreamOnly.map((key) => (
                    <SelectItem key={key} value={key}>
                      {labelOf(key)}
                    </SelectItem>
                  ))}
                </SelectGroup>
              )}
            </SelectPopup>
          </Select>
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

export interface ConfirmRequest {
  readonly title: string;
  readonly description: string;
  readonly confirmLabel: string;
  readonly onConfirm: () => void;
}

/** A confirm step for actions that cannot be undone. */
export function ConfirmDialog(props: { readonly request: ConfirmRequest | null; readonly onClose: () => void }) {
  return (
    <AlertDialog open={props.request !== null} onOpenChange={(open) => !open && props.onClose()}>
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>{props.request?.title}</AlertDialogTitle>
          <AlertDialogDescription>{props.request?.description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
          <Button
            variant="destructive"
            onClick={() => {
              const request = props.request;
              props.onClose();
              request?.onConfirm();
            }}
          >
            {props.request?.confirmLabel}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
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
  readonly savedReview?: UpstreamPortReviewSettings | undefined;
  readonly reviewSettingsLoaded?: boolean;
  readonly reviewSettingsError?: boolean;
  readonly open: boolean;
  readonly projectId: ProjectId;
  readonly topicIds: ReadonlyArray<string>;
  readonly providers: ReadonlyArray<ServerProvider>;
  /** The project's saved port model; otherwise the dialog starts on the new-thread default. */
  readonly savedModel: ModelSelection | null;
  readonly defaultRuntimeMode: RuntimeMode;
  readonly overview: UpstreamOverview;
  readonly busy: boolean;
  readonly onClose: () => void;
  readonly onRunFirst: () => void;
  /** Shown above the choices, e.g. when Start port for all was capped. */
  readonly note?: string | null;
  readonly onStart: (input: {
    grouping: "together" | "separately";
    modelSelection: ModelSelection;
    runtimeMode: RuntimeMode;
    clientRequestId: string;
    review: UpstreamPortReviewRequest | null;
    reviewPreference: UpstreamPortReviewSettings;
  }) => void;
}) {
  const settings = useSettings(undefined, props.projectId);
  const project = useStore((s) => s.projects.find((p) => p.id === props.projectId));
  const providers = projectProviderSnapshots(props.providers, settings, props.projectId);
  const reviewModels = getCustomModelOptionsByProvider(settings, providers);
  const [reviewOptions, setReviewOptions] = useState(() => portReviewDefaults(props.savedReview, reviewModels, providers));
  const [lockedReview, setLockedReview] = useState<{
    review: UpstreamPortReviewRequest | null; reviewPreference: UpstreamPortReviewSettings;
  } | null>(null);
  const isReady = (selection: ModelSelection) =>
    providers.some((p) => p.instanceId === selection.instanceId && isReadyProvider(p));
  const defaultModel =
    props.savedModel && isReady(props.savedModel)
      ? props.savedModel
      : resolveNewThreadModelSelection({ project, settings, providers, preferences: getModelPreferences() });
  const [grouping, setGrouping] = useState<"together" | "separately">("together");
  const [modelSelection, setModelSelection] = useState<ModelSelection>(defaultModel);
  const [runtimeMode, setRuntimeMode] = useState<RuntimeMode>(props.defaultRuntimeMode);
  // One id per dialog open, reused on retry so the server deduplicates. After the
  // first submit the choices are locked, so a retry repeats the same request.
  const [clientRequestId, setClientRequestId] = useState(() => randomUUID());
  const [submitted, setSubmitted] = useState(false);
  const [reviewHydrated, setReviewHydrated] = useState(false);
  // Reset only when the dialog opens: parent re-renders pass new `providers` arrays.
  const [wasOpen, setWasOpen] = useState(false);
  if (props.open !== wasOpen) {
    setWasOpen(props.open);
    if (props.open) {
      setGrouping("together");
      setModelSelection(defaultModel);
      setRuntimeMode(props.defaultRuntimeMode);
      setClientRequestId(randomUUID());
      setSubmitted(false);
      setReviewHydrated(false);
      setReviewOptions(portReviewDefaults(props.savedReview, reviewModels, providers));
      setLockedReview(null);
    }
  }
  // Hydrate once after settings and providers arrive; query refreshes must not
  // overwrite edits or the frozen request used by Retry.
  if (props.open && !submitted && !reviewHydrated && props.reviewSettingsLoaded !== false) {
    setReviewOptions(portReviewDefaults(props.savedReview, reviewModels, providers));
    setReviewHydrated(true);
  }
  // Providers can arrive after opening; replace a choice that cannot run without overriding the user's.
  if (
    props.open &&
    !submitted &&
    !isReady(modelSelection) &&
    selectionKey(defaultModel) !== selectionKey(modelSelection)
  )
    setModelSelection(defaultModel);
  const limitError = portLimitError(props.topicIds.length, grouping);
  const reviewError = submitted ? null : portReviewOptionsError(reviewOptions, providers);
  const ready = isReady(modelSelection);
  const provider = providers.find((p) => p.instanceId === modelSelection.instanceId);
  const driver = provider?.driver ?? ProviderDriverKind.make("codex");
  const locked = props.busy || submitted;
  const untriaged = props.overview.untriagedUpstreamCount;
  return (
    <Dialog open={props.open} onOpenChange={(open) => !open && !props.busy && props.onClose()}>
      <DialogPopup showCloseButton={!props.busy} className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
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
          {props.note && (
            <p role="status" className="text-muted-foreground">
              {props.note}
            </p>
          )}
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
                <input
                  type="radio"
                  disabled={locked}
                  checked={grouping === "together"}
                  onChange={() => setGrouping("together")}
                />
                One thread for all topics
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  disabled={locked}
                  checked={grouping === "separately"}
                  onChange={() => setGrouping("separately")}
                />
                One thread per topic
              </label>
            </fieldset>
          )}
          <div className="space-y-1" role="group" aria-label="Port model">
            <span className="font-medium">Model</span>
            <div className="flex flex-wrap items-center gap-2">
              <ProviderInstanceModelPicker
                instanceId={modelSelection.instanceId}
                model={modelSelection.model}
                lockedInstanceId={null}
                providers={providers}
                modelOptionsByInstance={getCustomModelOptionsByInstance(settings, providers)}
                disabled={locked}
                onInstanceModelChange={(instanceId, pickedDriver, model) =>
                  setModelSelection(pickedModelSelection(providers, instanceId, pickedDriver, model))
                }
              />
              <TraitsPicker
                disabled={locked}
                provider={driver}
                model={modelSelection.model}
                models={provider?.models ?? []}
                modelOptions={modelSelection.options}
                onModelOptionsChange={(options) =>
                  setModelSelection(createModelSelection(modelSelection.instanceId, modelSelection.model, options))
                }
              />
              {isKnownProviderKind(driver) && (
                <RuntimeModePicker
                  disabled={locked}
                  provider={driver}
                  value={runtimeMode}
                  onValueChange={setRuntimeMode}
                />
              )}
            </div>
          </div>
          <PortReviewOptions value={reviewOptions} providers={providers} modelOptionsByProvider={reviewModels}
            locked={locked || !reviewHydrated} onChange={setReviewOptions} />
          {!reviewHydrated && <p role="status">Loading review preferences…</p>}
          {props.reviewSettingsError && <p role="status">Could not load saved review preferences. Check the review options before starting.</p>}
          {reviewHydrated && reviewError && <p role="alert" className="text-destructive-foreground">{reviewError}</p>}
          {limitError && (
            <p role="alert" className="text-destructive-foreground">
              {limitError}
            </p>
          )}
          {submitted && !props.busy && (
            <p role="status" className="text-muted-foreground">
              Retry repeats the same request, so threads that already started are not created twice. Close and reopen to change the choices.
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={props.busy} onClick={props.onClose}>
            Cancel
          </Button>
          <Button
            disabled={props.busy || limitError !== null || !ready || !reviewHydrated || reviewError !== null}
            onClick={() => {
              if (!ready || !reviewHydrated || reviewError) return;
              let review = lockedReview;
              if (!review) {
                const buildSlot = makeWorkflowSlotBuilder({
                  providers, settings, projectId: props.projectId,
                  dispatchModelsByProvider: getProviderDispatchModelsByProvider(settings, providers),
                });
                const build = (key: "reviewerA" | "reviewerB" | "consolidation") => {
                  const slot = reviewOptions[key]!;
                  return buildSlot(slot.provider, slot.model, slot.modelOptions);
                };
                const admittedReview = reviewOptions.enabled ? {
                  reviewerA: build("reviewerA"), reviewerB: build("reviewerB"), consolidation: build("consolidation"),
                } : null;
                const remember = ({ provider, model, modelOptions }: NonNullable<typeof admittedReview>["reviewerA"]) =>
                  ({ provider, model, ...(modelOptions ? { modelOptions } : {}) });
                review = {
                  review: admittedReview,
                  reviewPreference: admittedReview ? {
                    enabled: true, reviewerA: remember(admittedReview.reviewerA),
                    reviewerB: remember(admittedReview.reviewerB), consolidation: remember(admittedReview.consolidation),
                  } : {
                    enabled: false, reviewerA: props.savedReview?.reviewerA ?? null,
                    reviewerB: props.savedReview?.reviewerB ?? null, consolidation: props.savedReview?.consolidation ?? null,
                  },
                };
                setLockedReview(review);
              }
              setSubmitted(true);
              props.onStart({ grouping, modelSelection, runtimeMode, clientRequestId, ...review });
            }}
          >
            {submitted ? "Retry" : "Start port"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
