import type { DesktopUpdateState } from "@t3tools/contracts";
import { CheckIcon } from "lucide-react";

import { cn } from "../lib/utils";
import {
  formatDesktopUpdateProgressDetail,
  getDesktopUpdateInstallPhaseDescription,
  getDesktopUpdateInstallSteps,
} from "./desktopUpdate.logic";

/** Determinate download bar, or an indeterminate one when percent is null. */
export function DesktopUpdateProgressBar({
  percent,
  label,
}: {
  percent: number | null;
  label: string;
}) {
  const value = percent === null ? null : Math.max(0, Math.min(100, Math.floor(percent)));
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={value ?? undefined}
      className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
    >
      <div
        className={cn(
          "h-full rounded-full bg-primary transition-[width] duration-300",
          value === null && "w-full opacity-60 motion-safe:animate-pulse",
        )}
        style={value === null ? undefined : { width: `${value}%` }}
      />
    </div>
  );
}

/** Download bar plus bytes, speed and time left. */
export function DesktopUpdateDownloadProgress({ state }: { state: DesktopUpdateState }) {
  const detail = formatDesktopUpdateProgressDetail(state);
  return (
    <div className="space-y-1.5">
      <DesktopUpdateProgressBar
        percent={state.downloadPercent ?? 0}
        label={`Downloading ${state.availableVersion ?? "update"}`}
      />
      {detail ? <p className="text-xs text-muted-foreground">{detail}</p> : null}
    </div>
  );
}

/** Install step list, indeterminate bar and the current phase description. */
export function DesktopUpdateInstallProgress({ state }: { state: DesktopUpdateState }) {
  const steps = getDesktopUpdateInstallSteps(state);
  return (
    <div className="space-y-2">
      <ol className="flex flex-wrap gap-1" aria-label="Install steps">
        {steps.map((step) => (
          <li
            key={step.label}
            aria-current={step.status === "active" ? "step" : undefined}
            className={cn(
              "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-2xs",
              step.status === "done" && "bg-success/10 text-success-foreground",
              step.status === "active" && "bg-primary text-primary-foreground",
              step.status === "pending" && "bg-muted text-muted-foreground",
            )}
          >
            {step.status === "done" ? <CheckIcon className="size-3" /> : null}
            {step.label}
          </li>
        ))}
      </ol>
      <DesktopUpdateProgressBar percent={null} label="Installing update" />
      <p className="text-xs text-muted-foreground">
        {getDesktopUpdateInstallPhaseDescription(state)}
      </p>
    </div>
  );
}
