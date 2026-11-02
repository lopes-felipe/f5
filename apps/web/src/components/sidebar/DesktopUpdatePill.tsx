import type { DesktopUpdateState } from "@t3tools/contracts";
import {
  ArrowUpCircleIcon,
  ChevronRightIcon,
  Loader2Icon,
  RotateCwIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { useState } from "react";

import { cn } from "../../lib/utils";
import type { DesktopUpdatePill as DesktopUpdatePillView } from "../desktopUpdate.logic";
import {
  DesktopUpdateDownloadProgress,
  DesktopUpdateInstallProgress,
} from "../DesktopUpdateProgress";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Popover, PopoverClose, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";
import type { DesktopUpdateController } from "./useDesktopUpdate";

const TONE_CLASSES: Record<DesktopUpdatePillView["tone"], string> = {
  warning: "border-warning/30 bg-warning/10 text-warning-foreground",
  info: "border-info/30 bg-info/10 text-info-foreground",
  success: "border-success/30 bg-success/10 text-success-foreground",
  destructive: "border-destructive/30 bg-destructive/10 text-destructive-foreground",
};

function PillIcon({ pill }: { pill: DesktopUpdatePillView }) {
  switch (pill.icon) {
    case "progress":
      return (
        <span
          aria-hidden
          className="size-3 shrink-0 rounded-full shadow-[inset_0_0_0_1.5px_currentColor]"
          style={{
            background: `conic-gradient(currentColor ${pill.percent ?? 0}%, transparent 0)`,
          }}
        />
      );
    case "installing":
      return <Loader2Icon aria-hidden className="size-3 shrink-0 motion-safe:animate-spin" />;
    case "restart":
      return <RotateCwIcon aria-hidden className="size-3 shrink-0" />;
    case "error":
      return <TriangleAlertIcon aria-hidden className="size-3 shrink-0" />;
    case "available":
      return <ArrowUpCircleIcon aria-hidden className="size-3 shrink-0" />;
  }
}

function ReleaseNotes({ notes }: { notes: string }) {
  return (
    <Collapsible>
      <CollapsibleTrigger className="group inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground">
        <ChevronRightIcon className="size-3 transition-transform group-data-panel-open:rotate-90" />
        What’s new
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <div className="mt-1.5 max-h-48 overflow-y-auto whitespace-pre-wrap text-xs leading-relaxed text-muted-foreground">
          {notes}
        </div>
      </CollapsiblePanel>
    </Collapsible>
  );
}

function PopoverBody({
  state,
  update,
}: {
  state: DesktopUpdateState;
  update: DesktopUpdateController;
}) {
  const version = state.downloadedVersion ?? state.availableVersion ?? "update";
  const notes = update.releaseNotes ? <ReleaseNotes notes={update.releaseNotes} /> : null;

  if (state.status === "downloading") {
    return (
      <>
        <PopoverTitle className="text-sm">Downloading F5 {state.availableVersion}</PopoverTitle>
        <DesktopUpdateDownloadProgress state={state} />
        <p className="text-xs text-muted-foreground">
          You can keep working. F5 will let you know when it’s ready.
        </p>
        {notes}
      </>
    );
  }
  if (state.status === "preparing") {
    return (
      <>
        <PopoverTitle className="text-sm">Installing F5 {version}</PopoverTitle>
        <DesktopUpdateInstallProgress state={state} />
      </>
    );
  }
  if (state.errorContext !== null || state.status === "error") {
    const title =
      state.errorContext === "download"
        ? `Download of F5 ${version} failed`
        : state.errorContext === "install"
          ? `Installing F5 ${version} failed`
          : "Update check failed";
    return (
      <>
        <PopoverTitle className="text-sm">{title}</PopoverTitle>
        {state.message ? <p className="text-xs text-muted-foreground">{state.message}</p> : null}
        <div className="flex justify-end gap-1.5">
          <PopoverClose render={<Button size="xs" variant="outline" />}>Later</PopoverClose>
          <Button size="xs" onClick={update.handleButtonClick}>
            Retry
          </Button>
        </div>
      </>
    );
  }
  if (state.status === "downloaded") {
    return (
      <>
        <PopoverTitle className="text-sm">F5 {version} is ready</PopoverTitle>
        <p className="text-xs text-muted-foreground">
          Restarting closes all windows and stops running agents. Your threads reopen afterwards.
        </p>
        {notes}
        <div className="flex justify-end gap-1.5">
          <PopoverClose render={<Button size="xs" variant="outline" />}>Later</PopoverClose>
          <Button size="xs" onClick={update.handleButtonClick}>
            Restart to update…
          </Button>
        </div>
      </>
    );
  }
  return (
    <>
      <PopoverTitle className="text-sm">F5 {version} is available</PopoverTitle>
      <p className="text-xs text-muted-foreground">You have {state.currentVersion}.</p>
      {notes}
      <div className="flex justify-end gap-1.5">
        <PopoverClose render={<Button size="xs" variant="outline" />}>Later</PopoverClose>
        <Button size="xs" onClick={update.handleButtonClick}>
          Download
        </Button>
      </div>
    </>
  );
}

/** Release notes for the version installed before this launch. */
export function DesktopUpdateInstalledNotesDialog({ update }: { update: DesktopUpdateController }) {
  const installed = update.installedNotes;
  return (
    <Dialog
      open={installed !== null}
      onOpenChange={(next) => {
        if (!next) update.closeInstalledNotes();
      }}
    >
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>What’s new in F5 {installed?.toVersion}</DialogTitle>
          <DialogDescription>Updated from {installed?.fromVersion}.</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="max-h-96 overflow-y-auto whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">
            {installed?.releaseNotes}
          </div>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}

/** Sidebar update status pill; every update action lives in its popover. */
export function DesktopUpdatePill({ update }: { update: DesktopUpdateController }) {
  const [open, setOpen] = useState(false);
  const { pill, state } = update;
  if (!pill || !state) return null;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label={update.tooltip}
            className={cn(
              "inline-flex h-6 max-w-28 shrink-0 items-center gap-1 rounded-full border px-2 text-2xs font-semibold tabular-nums transition-colors hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              TONE_CLASSES[pill.tone],
            )}
          >
            <PillIcon pill={pill} />
            <span className="truncate">{pill.label}</span>
          </button>
        }
      />
      <PopoverPopup align="end" className="w-80 max-w-[calc(100vw-2rem)]">
        <div role="status" aria-live="polite" className="space-y-2.5">
          <PopoverBody state={state} update={update} />
        </div>
      </PopoverPopup>
    </Popover>
  );
}
