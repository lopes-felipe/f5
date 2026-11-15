import { useRouter } from "@tanstack/react-router";
import { ArrowLeftIcon, ArrowRightIcon, TriangleAlertIcon } from "lucide-react";

import { APP_STAGE_LABEL, APP_VERSION } from "../../branding";
import { isElectron } from "../../env";
import { shortcutLabelForCommand, useServerKeybindings } from "../../keybindings";
import { cn } from "../../lib/utils";
import {
  navigateHistory,
  useCanNavigateHistory,
  type HistoryDirection,
} from "../../navigationHistory";
import { NotificationsBell } from "../../notificationCenter/NotificationsBell";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import { SidebarHeader, SidebarTrigger, useSidebar } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { DesktopUpdateInstalledNotesDialog, DesktopUpdatePill } from "./DesktopUpdatePill";
import type { DesktopUpdateController } from "./useDesktopUpdate";

function F5Icon() {
  return (
    <img
      alt="F5"
      src="/icon.png"
      width={24}
      height={24}
      className="size-6 shrink-0 object-contain"
    />
  );
}

/** Brand icon only; the version and release stage live in the tooltip. */
function SidebarWordmark() {
  const { isMobile } = useSidebar();
  return (
    <div className="flex min-w-0 items-center gap-1">
      {isMobile ? <SidebarTrigger className="shrink-0 text-muted-foreground" /> : null}
      <Tooltip>
        <TooltipTrigger
          render={
            <span className="inline-flex cursor-default items-center rounded-md px-1 py-1">
              <F5Icon />
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

function HistoryNavigationButton({ direction }: { direction: HistoryDirection }) {
  const router = useRouter();
  const keybindings = useServerKeybindings();
  const enabled = useCanNavigateHistory(direction);
  const label = direction === "back" ? "Go back" : "Go forward";
  const shortcutLabel = shortcutLabelForCommand(
    keybindings,
    direction === "back" ? "navigation.back" : "navigation.forward",
  );
  const Icon = direction === "back" ? ArrowLeftIcon : ArrowRightIcon;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={label}
            className="text-muted-foreground"
            disabled={!enabled}
            onClick={() => navigateHistory(router.history, direction)}
            size="icon-xs"
            variant="ghost"
          />
        }
      >
        <Icon className="size-3.5" />
      </TooltipTrigger>
      <TooltipPopup side="bottom">
        {label}
        {shortcutLabel ? ` (${shortcutLabel})` : ""}
      </TooltipPopup>
    </Tooltip>
  );
}

/** Wordmark on the left; history and notifications on the right. */
export function SidebarBrandHeader({ update }: { update: DesktopUpdateController }) {
  return (
    <SidebarHeader
      className={cn(
        "flex-row items-center gap-1 px-3 py-0",
        isElectron ? "drag-region h-(--app-header-height) pl-[90px]" : "h-12",
      )}
    >
      <SidebarWordmark />
      <div className="ml-auto flex shrink-0 items-center gap-1">
        {isElectron ? (
          <div className="hidden shrink-0 items-center md:flex">
            <HistoryNavigationButton direction="back" />
            <HistoryNavigationButton direction="forward" />
          </div>
        ) : null}
        {isElectron && update.showButton ? <DesktopUpdatePill update={update} /> : null}
        <NotificationsBell />
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
