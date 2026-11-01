import {
  AppWindowIcon,
  ArrowDownUpIcon,
  CameraIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CodeIcon,
  GlobeIcon,
  HourglassIcon,
  KeyboardIcon,
  LinkIcon,
  MonitorIcon,
  MousePointer2Icon,
  MousePointerClickIcon,
  MoveIcon,
  ProportionsIcon,
  ScanSearchIcon,
  ScanTextIcon,
  ShieldCheckIcon,
  SquareMousePointerIcon,
  TypeIcon,
  VideoIcon,
  ZoomInIcon,
  type LucideIcon,
} from "lucide-react";
import { memo, useMemo, useState, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import type { TimestampFormat } from "../../appSettings";
import { attachmentPreviewUrlForId } from "../../orchestrationState";
import type { WorkLogEntry } from "../../session-logic";
import { formatTimestamp } from "../../timestampFormat";
import {
  COMPUTER_STATUS_TONE_CLASS,
  type ComputerStatusTone,
} from "../AgentComputerLiveCard.logic";
import { Badge } from "../ui/badge";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import {
  automationEntryOp,
  automationStepDetail,
  automationStepHeading,
  buildAutomationRun,
  classifyAutomationEntry,
  isAutomationEntryFailed,
  type AutomationRunImage,
  type AutomationRunStatus,
  type AutomationSurface,
} from "./AutomationSessionCard.logic";
import { buildExpandedImagePreview, type ExpandedImagePreview } from "./ExpandedImagePreview";
import { McpToolCallDetails } from "./McpToolCallDetails";

const OP_ICON: Record<string, LucideIcon> = {
  click: MousePointerClickIcon,
  move: MousePointer2Icon,
  drag: MoveIcon,
  scroll: ArrowDownUpIcon,
  type: TypeIcon,
  key: KeyboardIcon,
  press: KeyboardIcon,
  screenshot: CameraIcon,
  zoom: ZoomInIcon,
  inspect: ScanSearchIcon,
  elementAction: SquareMousePointerIcon,
  openApp: AppWindowIcon,
  activateApp: AppWindowIcon,
  open: AppWindowIcon,
  wait: HourglassIcon,
  wait_for: HourglassIcon,
  status: ShieldCheckIcon,
  requestAccess: ShieldCheckIcon,
  requestForeground: ShieldCheckIcon,
  listApps: ShieldCheckIcon,
  resolveApps: ShieldCheckIcon,
  navigate: LinkIcon,
  evaluate: CodeIcon,
  snapshot: ScanTextIcon,
  viewport: ProportionsIcon,
  recording_start: VideoIcon,
  recording_stop: VideoIcon,
};

const SURFACE_ICON: Record<AutomationSurface, LucideIcon> = {
  computer: MonitorIcon,
  preview: GlobeIcon,
};

const RUN_TONE: Record<AutomationRunStatus, ComputerStatusTone> = {
  running: "pending",
  failed: "error",
  done: "ok",
};

const FILMSTRIP_SIZE = 3;

function opIcon(op: string | undefined): LucideIcon {
  return (op && OP_ICON[op]) || MousePointerClickIcon;
}

function openGallery(
  images: ReadonlyArray<AutomationRunImage>,
  selectedIndex: number,
  onImageExpand: (preview: ExpandedImagePreview) => void,
) {
  const preview = buildExpandedImagePreview(
    images.map((image, index) => ({
      id: `${index}:${image.attachmentId}`,
      name: `Screenshot ${index + 1}`,
      mimeType: image.mimeType,
      previewUrl: attachmentPreviewUrlForId(image.attachmentId),
    })),
    `${selectedIndex}:${images[selectedIndex]?.attachmentId}`,
  );
  if (preview) onImageExpand(preview);
}

export const AutomationSessionCard = memo(function AutomationSessionCard(props: {
  surface: AutomationSurface;
  entries: ReadonlyArray<WorkLogEntry>;
  timestampFormat: TimestampFormat;
  markdownCwd: string | undefined;
  onImageExpand: (preview: ExpandedImagePreview) => void;
  /** The run belongs to the working turn; otherwise in-progress calls read as interrupted. */
  active: boolean;
  /** Renders the hook/review diagnostics correlated with the run's calls. */
  renderDiagnostics?: ((diagnostics: ReadonlyArray<WorkLogEntry>) => ReactNode) | undefined;
  /** Present when a finished turn's card can fold back into its summary line. */
  onCollapse?: (() => void) | undefined;
}) {
  const { surface, entries, timestampFormat, markdownCwd, onImageExpand, onCollapse, active } =
    props;
  const run = useMemo(
    () => buildAutomationRun(surface, entries, active),
    [surface, entries, active],
  );
  const diagnostics = useMemo(
    () => entries.flatMap((entry) => entry.nestedDiagnostics ?? []),
    [entries],
  );
  const [stepsOpen, setStepsOpen] = useState(false);
  const SurfaceIcon = SURFACE_ICON[surface];
  const firstEntry = entries[0];
  const filmstripStart = Math.max(0, run.images.length - FILMSTRIP_SIZE);
  const filmstrip = run.images.slice(filmstripStart);

  return (
    <div
      className="group/automation rounded-xl border border-border bg-card"
      data-testid="automation-session-card"
      data-surface={surface}
      data-status={run.status}
    >
      <div className="flex items-center gap-2.5 px-3 pt-2.5">
        {onCollapse ? (
          <button
            type="button"
            aria-expanded
            aria-label="Collapse"
            className="-ml-1 shrink-0 rounded-sm text-faint-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            onClick={onCollapse}
          >
            <ChevronDownIcon className="size-3.5" />
          </button>
        ) : null}
        <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          <SurfaceIcon className="size-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="flex min-w-0 items-center gap-1.5 text-ui font-medium text-foreground">
            <span
              aria-hidden="true"
              className={cn(
                "size-1.5 shrink-0 rounded-full",
                COMPUTER_STATUS_TONE_CLASS[RUN_TONE[run.status]],
              )}
            />
            <span className="truncate" aria-live="polite" data-testid="automation-session-title">
              {run.title}
            </span>
          </p>
          <p className="text-2xs tabular-nums text-muted-foreground">
            {run.actionCount} {run.actionCount === 1 ? "action" : "actions"}
            {run.duration ? ` · ${run.duration}` : ""}
          </p>
        </div>
        {run.failedCount > 0 ? (
          <Badge variant="error" className="shrink-0">
            {run.failedCount} failed
          </Badge>
        ) : null}
        {firstEntry ? (
          <time
            dateTime={firstEntry.createdAt}
            title={new Date(firstEntry.createdAt).toLocaleString()}
            className="shrink-0 text-2xs tabular-nums text-muted-foreground opacity-0 group-hover/automation:opacity-100 group-focus-within/automation:opacity-100 pointer-coarse:opacity-100"
          >
            {formatTimestamp(firstEntry.createdAt, timestampFormat)}
          </time>
        ) : null}
      </div>

      <ol className="flex flex-wrap items-center gap-1 px-3 pt-2" aria-label="Actions">
        {run.hiddenChipCount > 0 ? (
          <li className="inline-flex h-6 items-center rounded-full px-1.5 text-2xs text-muted-foreground">
            +{run.hiddenChipCount} earlier
          </li>
        ) : null}
        {run.chips.map((chip) => {
          const ChipIcon = opIcon(chip.op);
          return (
            <li
              key={chip.key}
              title={chip.count > 1 ? `${chip.title} ×${chip.count}` : chip.title}
              data-failed={chip.failed || undefined}
              className={cn(
                "inline-flex h-6 items-center gap-1 rounded-full border border-border bg-muted/40 px-2 text-2xs tabular-nums text-muted-foreground",
                chip.failed && "border-destructive/40 bg-destructive/8 text-destructive-foreground",
                chip.running && "animate-pulse border-info/50 text-foreground",
              )}
            >
              <ChipIcon aria-hidden="true" className="size-3" />
              <span className="sr-only">{chip.title}</span>
              {chip.count > 1 ? <span>×{chip.count}</span> : null}
            </li>
          );
        })}
      </ol>

      {filmstrip.length > 0 ? (
        <div className="flex items-end gap-2 px-3 pt-2.5" data-testid="automation-filmstrip">
          {filmstripStart > 0 ? (
            <button
              type="button"
              className="flex h-20 w-12 shrink-0 items-center justify-center rounded-md border border-border bg-muted/40 text-2xs text-muted-foreground hover:text-foreground"
              aria-label={`Show ${filmstripStart} earlier screenshots`}
              onClick={() => openGallery(run.images, filmstripStart - 1, onImageExpand)}
            >
              +{filmstripStart}
            </button>
          ) : null}
          {filmstrip.map((image, offset) => {
            const index = filmstripStart + offset;
            const latest = index === run.images.length - 1;
            return (
              // Attachment URLs need the app's session, so they open in the in-app viewer.
              <button
                key={`${index}:${image.attachmentId}`}
                type="button"
                className="shrink-0 cursor-zoom-in rounded-md"
                aria-label={`Preview screenshot ${index + 1}`}
                onClick={() => openGallery(run.images, index, onImageExpand)}
              >
                <img
                  src={attachmentPreviewUrlForId(image.attachmentId)}
                  alt={`Screenshot ${index + 1}`}
                  loading="lazy"
                  className={cn(
                    "h-20 max-w-40 rounded-md border border-border object-cover object-top",
                    latest && "ring-2 ring-ring/40",
                  )}
                />
              </button>
            );
          })}
          {run.omittedImageCount > 0 ? (
            <span className="self-end text-2xs text-muted-foreground">
              +{run.omittedImageCount} not shown
            </span>
          ) : null}
        </div>
      ) : null}

      {diagnostics.length > 0 && props.renderDiagnostics ? (
        <div className="px-3 pt-2.5" data-testid="automation-diagnostics">
          {props.renderDiagnostics(diagnostics)}
        </div>
      ) : null}

      <Collapsible open={stepsOpen} onOpenChange={setStepsOpen}>
        <CollapsibleTrigger className="flex items-center gap-1 rounded-b-xl px-3 py-2 text-2xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
          {stepsOpen ? (
            <ChevronDownIcon aria-hidden="true" className="size-3" />
          ) : (
            <ChevronRightIcon aria-hidden="true" className="size-3" />
          )}
          {stepsOpen
            ? "Hide steps"
            : `Show ${run.actionCount} ${run.actionCount === 1 ? "step" : "steps"}`}
        </CollapsibleTrigger>
        <CollapsiblePanel>
          <ol className="border-t border-border px-1.5 py-1.5" data-testid="automation-steps">
            {entries.map((entry) =>
              classifyAutomationEntry(entry) === surface ? (
                <AutomationStepRow
                  key={entry.id}
                  entry={entry}
                  active={active}
                  timestampFormat={timestampFormat}
                  markdownCwd={markdownCwd}
                  onImageExpand={onImageExpand}
                />
              ) : (
                <li
                  key={entry.id}
                  className="line-clamp-2 px-2 py-1 text-2xs italic text-muted-foreground"
                >
                  {entry.detail ?? entry.label}
                </li>
              ),
            )}
          </ol>
        </CollapsiblePanel>
      </Collapsible>
    </div>
  );
});

function AutomationStepRow(props: {
  entry: WorkLogEntry;
  active: boolean;
  timestampFormat: TimestampFormat;
  markdownCwd: string | undefined;
  onImageExpand: (preview: ExpandedImagePreview) => void;
}) {
  const { entry, active, timestampFormat, markdownCwd, onImageExpand } = props;
  const [open, setOpen] = useState(false);
  const StepIcon = opIcon(automationEntryOp(entry));
  const failed = isAutomationEntryFailed(entry);
  const detail = automationStepDetail(entry);
  const images = (entry.mcpImages ?? []).map((image) => ({
    attachmentId: image.attachmentId,
    mimeType: image.mimeType,
  }));
  const hasDetails = Boolean(entry.mcpInput || entry.mcpResult || images.length);
  return (
    <li data-failed={failed || undefined}>
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger
          disabled={!hasDetails}
          className={cn(
            "flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left text-xs outline-none hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring",
            !hasDetails && "cursor-default hover:bg-transparent",
          )}
        >
          <StepIcon
            aria-hidden="true"
            className={cn(
              "size-3.5 shrink-0",
              failed ? "text-destructive-foreground" : "text-muted-foreground",
            )}
          />
          <span
            className={cn(
              "shrink-0 font-medium",
              failed ? "text-destructive-foreground" : "text-foreground",
            )}
          >
            {automationStepHeading(entry, active)}
          </span>
          {detail ? <span className="min-w-0 truncate text-muted-foreground">{detail}</span> : null}
          <time
            dateTime={entry.createdAt}
            className="ml-auto shrink-0 text-2xs tabular-nums text-muted-foreground"
          >
            {formatTimestamp(entry.createdAt, timestampFormat)}
          </time>
        </CollapsibleTrigger>
        {hasDetails ? (
          <CollapsiblePanel>
            <div className="space-y-2 px-2 pt-1 pb-2 pl-7.5">
              {images.length > 0 ? (
                <div className="flex flex-wrap gap-2">
                  {images.map((image, index) => (
                    <button
                      key={`${index}:${image.attachmentId}`}
                      type="button"
                      className="cursor-zoom-in rounded-md"
                      aria-label={`Preview step screenshot ${index + 1}`}
                      onClick={() => openGallery(images, index, onImageExpand)}
                    >
                      <img
                        src={attachmentPreviewUrlForId(image.attachmentId)}
                        alt={`Step screenshot ${index + 1}`}
                        loading="lazy"
                        className="h-16 max-w-32 rounded-md border border-border object-cover object-top"
                      />
                    </button>
                  ))}
                </div>
              ) : null}
              <McpToolCallDetails
                mcpInput={entry.mcpInput}
                mcpResult={entry.mcpResult}
                markdownCwd={markdownCwd}
              />
            </div>
          </CollapsiblePanel>
        ) : null}
      </Collapsible>
    </li>
  );
}
