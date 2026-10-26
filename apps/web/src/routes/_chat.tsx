import { useScheduledInvalidation } from "../hooks/useScheduledInvalidation";
import { ScheduledNotificationController } from "../components/scheduled/ScheduledNotificationController";
import { WorktreeRemovalDialogHost } from "../components/WorktreeRemovalDialogHost";
import { ComputerAccessInbox } from "../components/ComputerAccessCard";
import { useServerUpdateOutcome } from "../hooks/useServerUpdateOutcome";
import { useSnapShotRouting } from "../hooks/useSnapShotRouting";
import { useDesktopLinkRouting } from "../hooks/useDesktopLinkRouting";
import { QuitHoldOverlay } from "../components/QuitHoldOverlay";
import { ProjectCloneController } from "../components/ProjectCloneController";
import { ProjectCreateNewController } from "../components/ProjectCreateNewController";
import { DesktopPromptLinkController } from "../components/promptLinks/DesktopPromptLinkController";
import { ThreadNavigationController } from "../components/ThreadNavigationController";
import { Outlet, createFileRoute, useNavigate, useRouter } from "@tanstack/react-router";
import { lazy, Suspense, useEffect, useLayoutEffect, useState, type CSSProperties } from "react";

import { CommandPalette } from "../components/CommandPalette";
import ThreadStatusNotificationController from "../components/ThreadStatusNotificationController";
import PrAttentionNotificationController from "../components/prHub/PrAttentionNotificationController";
import UpstreamNotificationController from "../components/upstream/UpstreamNotificationController";
import { PreviewBrowserHost } from "../components/PreviewBrowserHost";
import { ComputerUseBanner } from "../components/ComputerUseBanner";
import ModelRecencyController from "../components/ModelRecencyController";
import ThreadRecencyController from "../components/ThreadRecencyController";
import { NextTurnQueueController } from "../components/NextTurnQueueController";
import { LegacyPinnedThreadsMigrationController } from "../components/LegacyPinnedThreadsMigrationController";
import { SnoozedThreadWakeController } from "../components/SnoozedThreadWakeController";
import ThreadSidebar from "../components/Sidebar";
import { useWorkflowCreateDialogStore } from "../workflowCreateDialogStore";
import { Sidebar, SidebarProvider, SidebarRail } from "~/components/ui/sidebar";
import { resolveSettingsNavigationSearch } from "~/components/settings/settingsRouting";
import {
  canAcceptThreadSidebarWidth,
  readInitialThreadSidebarWidth,
  resolveAcceptedThreadSidebarWidth,
  THREAD_SIDEBAR_MAX_WIDTH_PX,
  THREAD_SIDEBAR_MIN_WIDTH_PX,
  THREAD_SIDEBAR_DEFAULT_WIDTH_PX,
  THREAD_SIDEBAR_WIDTH_STORAGE_KEY,
} from "../threadSidebarWidth";

/** App-wide "New workflow" dialog, opened through `workflowCreateDialogStore`. */
const WorkflowCreateDialog = lazy(() =>
  import("../components/workflow/WorkflowCreateDialog").then((module) => ({
    default: module.WorkflowCreateDialog,
  })),
);

function WorkflowCreateDialogHost() {
  const projectId = useWorkflowCreateDialogStore((state) => state.projectId);
  const close = useWorkflowCreateDialogStore((state) => state.close);
  const notifyCreated = useWorkflowCreateDialogStore((state) => state.notifyCreated);
  if (!projectId) return null;
  return (
    <Suspense fallback={null}>
      <WorkflowCreateDialog
        open
        projectId={projectId}
        onOpenChange={(open) => {
          if (!open) close();
        }}
        onWorkflowCreated={notifyCreated}
      />
    </Suspense>
  );
}

function ChatRouteLayout() {
  useScheduledInvalidation();
  useDesktopLinkRouting();
  useSnapShotRouting();
  useServerUpdateOutcome();
  // The location is read when the menu action fires, so navigation does not re-render the layout.
  const router = useRouter();
  const navigate = useNavigate();
  const [initialThreadSidebarWidth, setInitialThreadSidebarWidth] = useState(() =>
    readInitialThreadSidebarWidth(),
  );
  useLayoutEffect(() => {
    const wrapper = document.querySelector<HTMLElement>("[data-thread-sidebar-layout='true']");
    if (!wrapper) {
      return;
    }

    const acceptedWidth = resolveAcceptedThreadSidebarWidth({
      preferredWidth: initialThreadSidebarWidth,
      wrapper,
    });
    if (acceptedWidth === initialThreadSidebarWidth) {
      return;
    }

    setInitialThreadSidebarWidth(acceptedWidth);
    try {
      window.localStorage.setItem(THREAD_SIDEBAR_WIDTH_STORAGE_KEY, String(acceptedWidth));
    } catch {
      // Ignore storage failures to avoid blocking the initial render path.
    }
  }, [initialThreadSidebarWidth]);

  useEffect(() => {
    const onMenuAction = window.desktopBridge?.onMenuAction;
    if (typeof onMenuAction !== "function") {
      return;
    }

    const unsubscribe = onMenuAction((action) => {
      if (action !== "open-settings") return;
      void navigate({
        to: "/settings",
        search: resolveSettingsNavigationSearch(router.state.location),
      });
    });

    return () => {
      unsubscribe?.();
    };
  }, [navigate, router]);

  return (
    <SidebarProvider
      defaultOpen
      keyboardShortcut
      data-thread-sidebar-layout="true"
      style={{ "--sidebar-width": `${initialThreadSidebarWidth}px` } as CSSProperties}
    >
      <CommandPalette>
        <Sidebar
          side="left"
          variant="inset"
          collapsible="offcanvas"
          className="p-0 text-foreground"
          resizable={{
            defaultWidth: THREAD_SIDEBAR_DEFAULT_WIDTH_PX,
            storageKey: THREAD_SIDEBAR_WIDTH_STORAGE_KEY,
            minWidth: THREAD_SIDEBAR_MIN_WIDTH_PX,
            maxWidth: THREAD_SIDEBAR_MAX_WIDTH_PX,
            shouldAcceptWidth: canAcceptThreadSidebarWidth,
          }}
        >
          <ThreadSidebar />
          <SidebarRail />
        </Sidebar>
        <ThreadRecencyController />
        <ThreadNavigationController />
        <ProjectCloneController />
        <ProjectCreateNewController />
        <DesktopPromptLinkController />
        <ModelRecencyController />
        <ScheduledNotificationController />
        <ThreadStatusNotificationController />
        <QuitHoldOverlay />
        <NextTurnQueueController />
        <LegacyPinnedThreadsMigrationController />
        <SnoozedThreadWakeController />
        <PrAttentionNotificationController />
        <UpstreamNotificationController />
        <PreviewBrowserHost>
          <Outlet />
        </PreviewBrowserHost>
        <ComputerAccessInbox />
        <ComputerUseBanner />
        <WorkflowCreateDialogHost />
        <WorktreeRemovalDialogHost />
      </CommandPalette>
    </SidebarProvider>
  );
}

export const Route = createFileRoute("/_chat")({
  component: ChatRouteLayout,
});
