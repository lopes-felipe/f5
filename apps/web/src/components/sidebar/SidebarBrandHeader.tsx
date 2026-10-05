import { RocketIcon, ScrollTextIcon, TriangleAlertIcon } from "lucide-react";

import { APP_STAGE_LABEL, APP_VERSION } from "../../branding";
import { isElectron } from "../../env";
import { cn } from "../../lib/utils";
import { ProfileSwitcher } from "../ProfileSwitcher";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";
import { SidebarHeader, SidebarTrigger } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { DesktopUpdateController } from "./useDesktopUpdate";

function F5Wordmark() {
  return (
    <svg
      aria-label="F5"
      role="img"
      className="h-3 w-auto shrink-0 text-foreground"
      viewBox="0 0 84 44"
      xmlns="http://www.w3.org/2000/svg"
    >
      <text
        x="1"
        y="33"
        fill="currentColor"
        fontFamily="'Arial Black', 'SF Pro Display', sans-serif"
        fontSize="34"
        fontWeight="900"
        letterSpacing="-2"
      >
        F5
      </text>
    </svg>
  );
}

/** Wordmark only; the version and release stage live in the tooltip. */
function SidebarWordmark() {
  return (
    <div className="flex min-w-0 items-center gap-1">
      <SidebarTrigger className="shrink-0 text-muted-foreground md:hidden" />
      <Tooltip>
        <TooltipTrigger
          render={
            <span className="inline-flex cursor-default items-center rounded-md px-1 py-1">
              <F5Wordmark />
            </span>
          }
        />
        <TooltipPopup side="bottom" sideOffset={2}>
          {`F5 ${APP_VERSION} (${APP_STAGE_LABEL})`}
        </TooltipPopup>
      </Tooltip>
    </div>
  );
}

function DesktopUpdateButtons({ update }: { update: DesktopUpdateController }) {
  return (
    <div className="flex items-center gap-0.5">
      {update.releaseNotes ? (
        <Popover>
          <PopoverTrigger
            render={
              <button
                type="button"
                aria-label="Show update release notes"
                className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <ScrollTextIcon className="size-4" />
              </button>
            }
          />
          <PopoverPopup align="end" className="w-80 max-w-[calc(100vw-2rem)]">
            <div className="space-y-2">
              <PopoverTitle className="text-sm">
                What’s new in {update.state?.availableVersion ?? "this update"}
              </PopoverTitle>
              <div className="max-h-64 overflow-y-auto whitespace-pre-wrap text-xs leading-relaxed text-muted-foreground">
                {update.releaseNotes}
              </div>
            </div>
          </PopoverPopup>
        </Popover>
      ) : null}
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label={update.tooltip}
              aria-disabled={update.buttonDisabled || undefined}
              disabled={update.buttonDisabled}
              className={cn(
                "inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                update.buttonInteractivityClasses,
                update.buttonToneClasses,
              )}
              onClick={update.handleButtonClick}
            >
              <RocketIcon className="size-4" />
            </button>
          }
        />
        <TooltipPopup side="bottom">{update.tooltip}</TooltipPopup>
      </Tooltip>
    </div>
  );
}

/** Wordmark, profile switcher and (desktop) update controls. */
export function SidebarBrandHeader({ update }: { update: DesktopUpdateController }) {
  return (
    <SidebarHeader
      className={cn(
        "flex-row items-center gap-2 py-0",
        isElectron ? "drag-region h-(--app-header-height) pr-3 pl-[90px]" : "h-12 px-3",
      )}
    >
      <SidebarWordmark />
      <div className="ml-auto flex min-w-0 items-center gap-1">
        {isElectron && update.showButton ? <DesktopUpdateButtons update={update} /> : null}
        <ProfileSwitcher />
      </div>
    </SidebarHeader>
  );
}

export function SidebarArm64Warning({ update }: { update: DesktopUpdateController }) {
  if (!update.showArm64IntelBuildWarning || !update.arm64IntelBuildWarningDescription) {
    return null;
  }
  return (
    <div className="shrink-0 px-2 pb-2">
      <Alert variant="warning" className="rounded-xl">
        <TriangleAlertIcon />
        <AlertTitle>Intel build on Apple Silicon</AlertTitle>
        <AlertDescription>{update.arm64IntelBuildWarningDescription}</AlertDescription>
        {update.buttonAction !== "none" ? (
          <AlertAction>
            <Button
              size="xs"
              variant="outline"
              disabled={update.buttonDisabled}
              onClick={update.handleButtonClick}
            >
              {update.buttonAction === "download" ? "Download ARM build" : "Install ARM build"}
            </Button>
          </AlertAction>
        ) : null}
      </Alert>
    </div>
  );
}
