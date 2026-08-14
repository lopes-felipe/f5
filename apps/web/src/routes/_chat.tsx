import { Outlet, createFileRoute, useLocation, useNavigate } from "@tanstack/react-router";
import { useEffect, useLayoutEffect, useState, type CSSProperties } from "react";

import { CommandPalette } from "../components/CommandPalette";
import ThreadStatusNotificationController from "../components/ThreadStatusNotificationController";
import PrAttentionNotificationController from "../components/prHub/PrAttentionNotificationController";
import { PreviewBrowserHost } from "../components/PreviewBrowserHost";
import ModelRecencyController from "../components/ModelRecencyController";
import ThreadRecencyController from "../components/ThreadRecencyController";
import { NextTurnQueueController } from "../components/NextTurnQueueController";
import { LegacyPinnedThreadsMigrationController } from "../components/LegacyPinnedThreadsMigrationController";
import { SnoozedThreadWakeController } from "../components/SnoozedThreadWakeController";
import ThreadSidebar from "../components/Sidebar";
import {
  Sidebar,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
  useSidebar,
} from "~/components/ui/sidebar";
import { resolveSettingsNavigationSearch } from "~/components/settings/settingsCategories";
import {
  canAcceptThreadSidebarWidth,
  readInitialThreadSidebarWidth,
  resolveAcceptedThreadSidebarWidth,
  THREAD_SIDEBAR_MAX_WIDTH_PX,
  THREAD_SIDEBAR_MIN_WIDTH_PX,
  THREAD_SIDEBAR_WIDTH_STORAGE_KEY,
} from "../threadSidebarWidth";

function CollapsedSidebarControl() {
  const { isMobile, open, openMobile } = useSidebar();
  if (isMobile ? openMobile : open) {
    return null;
  }

  return (
    <SidebarTrigger
      aria-label="Toggle main sidebar"
      className="fixed top-1.5 left-2 z-50 size-7 border border-border/60 bg-background/85 shadow-sm backdrop-blur"
    />
  );
}

function ChatRouteLayout() {
  const location = useLocation();
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
        search: resolveSettingsNavigationSearch(location),
      });
    });

    return () => {
      unsubscribe?.();
    };
  }, [location, navigate]);

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
          collapsible="offcanvas"
          className="border-r border-border bg-card text-foreground"
          resizable={{
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
        <ModelRecencyController />
        <ThreadStatusNotificationController />
        <NextTurnQueueController />
        <LegacyPinnedThreadsMigrationController />
        <SnoozedThreadWakeController />
        <PrAttentionNotificationController />
        <PreviewBrowserHost>
          <Outlet />
        </PreviewBrowserHost>
        <CollapsedSidebarControl />
      </CommandPalette>
    </SidebarProvider>
  );
}

export const Route = createFileRoute("/_chat")({
  component: ChatRouteLayout,
});
