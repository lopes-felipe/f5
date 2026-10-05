import { useLocation, useNavigate } from "@tanstack/react-router";
import { GaugeIcon, GitPullRequestIcon, HomeIcon, type LucideIcon } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { readNativeApi } from "../../nativeApi";
import { SidebarThreadSearchInput } from "../SidebarThreadSearch";
import { Badge } from "../ui/badge";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { Kbd } from "../ui/kbd";

/** Shared look for sidebar navigation rows: 32px, `text-ui`, 16px icon. */
export const SIDEBAR_NAV_ROW_CLASS_NAME =
  "h-8 gap-2 px-2 text-ui text-muted-foreground hover:bg-accent/60 hover:text-foreground data-[active=true]:bg-sidebar-accent data-[active=true]:text-foreground";

/** PR Hub "needs you" count, kept live through the native API. */
function usePrHubNeedsYouCount(): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    const api = readNativeApi();
    if (!api?.prHub) return;

    const updateCount = (snapshot: { counts: { needs_you: number } }) => {
      setCount(snapshot.counts.needs_you);
    };
    void api.prHub
      .getOverview()
      .then(updateCount)
      .catch(() => setCount(0));
    return api.prHub.onChanged(updateCount);
  }, []);
  return count;
}

function NavRow(props: {
  icon: LucideIcon;
  label: string;
  isActive: boolean;
  onSelect: () => void;
  trailing?: ReactNode;
  tooltip?: ReactNode;
}) {
  const Icon = props.icon;
  const button = (
    <SidebarMenuButton
      className={SIDEBAR_NAV_ROW_CLASS_NAME}
      isActive={props.isActive}
      onClick={props.onSelect}
    >
      <Icon aria-hidden="true" className="size-4" />
      <span className="flex-1 truncate">{props.label}</span>
      {props.trailing}
    </SidebarMenuButton>
  );
  if (!props.tooltip) return button;
  return (
    <Tooltip>
      <TooltipTrigger render={button} />
      <TooltipPopup side="right" className="flex items-center gap-2">
        {props.tooltip}
      </TooltipPopup>
    </Tooltip>
  );
}

/** Home, thread search, Pull requests and Usage. */
export function SidebarNav(props: {
  searchQuery: string;
  onSearchQueryChange: (query: string) => void;
  onOpenCommandPalette: () => void;
  commandPaletteShortcutLabel: string | null;
  pullRequestsShortcutLabel: string | null;
}) {
  const navigate = useNavigate();
  const isOnHome = useLocation({ select: (loc) => loc.pathname === "/" });
  const isOnPullRequests = useLocation({ select: (loc) => loc.pathname === "/pull-requests" });
  const isOnUsage = useLocation({ select: (loc) => loc.pathname === "/usage" });
  const prHubNeedsYouCount = usePrHubNeedsYouCount();

  return (
    <nav aria-label="Primary" className="shrink-0 px-2 pb-2">
      <SidebarMenu className="gap-px">
        <SidebarMenuItem>
          <NavRow
            icon={HomeIcon}
            label="Home"
            isActive={isOnHome}
            onSelect={() => void navigate({ to: "/" })}
          />
        </SidebarMenuItem>
        <SidebarMenuItem>
          <SidebarThreadSearchInput
            query={props.searchQuery}
            onQueryChange={props.onSearchQueryChange}
            onOpenCommandPalette={props.onOpenCommandPalette}
            commandPaletteShortcutLabel={props.commandPaletteShortcutLabel}
          />
        </SidebarMenuItem>
        <SidebarMenuItem>
          <NavRow
            icon={GitPullRequestIcon}
            label="Pull requests"
            isActive={isOnPullRequests}
            onSelect={() => void navigate({ to: "/pull-requests" })}
            trailing={
              prHubNeedsYouCount > 0 ? (
                <Badge variant="warning" size="sm" className="tabular-nums">
                  {prHubNeedsYouCount}
                  <span className="sr-only"> need you</span>
                </Badge>
              ) : null
            }
            tooltip={
              props.pullRequestsShortcutLabel ? (
                <>
                  Pull requests <Kbd>{props.pullRequestsShortcutLabel}</Kbd>
                </>
              ) : undefined
            }
          />
        </SidebarMenuItem>
        <SidebarMenuItem>
          <NavRow
            icon={GaugeIcon}
            label="Usage"
            isActive={isOnUsage}
            onSelect={() => void navigate({ to: "/usage" })}
          />
        </SidebarMenuItem>
      </SidebarMenu>
    </nav>
  );
}
