import { TriangleAlertIcon } from "lucide-react";

import { APP_STAGE_LABEL, APP_VERSION } from "../../branding";
import { isElectron } from "../../env";
import { cn } from "../../lib/utils";
import { ProfileSwitcher } from "../ProfileSwitcher";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import { SidebarHeader, SidebarTrigger } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { DesktopUpdateInstalledNotesDialog, DesktopUpdatePill } from "./DesktopUpdatePill";
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
          {`F5 ${APP_VERSION}${APP_STAGE_LABEL ? ` (${APP_STAGE_LABEL})` : ""}`}
        </TooltipPopup>
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
        {isElectron && update.showButton ? <DesktopUpdatePill update={update} /> : null}
        <ProfileSwitcher />
      </div>
      {isElectron ? <DesktopUpdateInstalledNotesDialog update={update} /> : null}
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
        {update.buttonAction === "download" || update.buttonAction === "install" ? (
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
