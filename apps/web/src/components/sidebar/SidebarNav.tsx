import { useLocation, useNavigate } from "@tanstack/react-router";
import {
  CalendarClockIcon,
  GitMergeIcon,
  GaugeIcon,
  GitPullRequestIcon,
  HomeIcon,
  type LucideIcon,
  SearchIcon,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

import { upstreamProjectsQueryOptions } from "../../lib/upstreamPortsReactQuery";
import { cn } from "../../lib/utils";

import { readNativeApi } from "../../nativeApi";
import { SidebarThreadSearchInput } from "../SidebarThreadSearch";
import { formatCompactCount } from "../Sidebar.logic";
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

/** Projects with an `upstream` block and their inbox total; refreshed by `upstreamPorts.changed`. */
function useUpstreamNav(): { readonly visible: boolean; readonly inbox: number } {
  const query = useQuery({
    ...upstreamProjectsQueryOptions(),
    enabled: Boolean(readNativeApi()?.upstreamPorts),
  });
  const projects = query.data?.projects ?? [];
  return {
    visible: projects.length > 0,
    inbox: projects.reduce(
      (sum, project) => sum + (project.managedByThisProfile ? project.inboxCount : 0),
      0,
    ),
  };
}

/** A count badge pinned to a nav button's top-right corner. */
interface NavBadge {
  count: number;
  /** Screen-reader suffix, as in "432 need you". */
  label: string;
  tone: "warning" | "outline";
}

/** One icon button of the nav strip: label and shortcut in its tooltip, optional count badge. */
function NavIconButton(props: {
  icon: LucideIcon;
  label: string;
  isActive: boolean;
  onSelect: () => void;
  shortcutLabel?: string | null | undefined;
  badge?: NavBadge | undefined;
  pressed?: boolean | undefined;
  testId?: string | undefined;
  buttonRef?: React.Ref<HTMLButtonElement> | undefined;
}) {
  const Icon = props.icon;
  const badge = props.badge && props.badge.count > 0 ? props.badge : null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            ref={props.buttonRef}
            type="button"
            aria-label={props.label}
            {...(props.isActive ? { "aria-current": "page" as const } : {})}
            {...(props.pressed !== undefined ? { "aria-pressed": props.pressed } : {})}
            {...(props.testId ? { "data-testid": props.testId } : {})}
            data-active={props.isActive || props.pressed ? "true" : undefined}
            className="relative inline-flex h-7 max-w-8 min-w-0 flex-1 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors duration-(--duration-fast) hover:bg-accent/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-[active=true]:bg-sidebar-accent data-[active=true]:text-foreground"
            onClick={props.onSelect}
          />
        }
      >
        <Icon aria-hidden="true" className="size-4" />
        {badge ? (
          <span
            className={cn(
              "pointer-events-none absolute -top-1.5 left-[calc(50%+2px)] inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-2xs leading-none font-medium tabular-nums",
              badge.tone === "warning"
                ? "bg-warning/20 text-warning-foreground"
                : "border border-input bg-background text-foreground",
            )}
          >
            <span aria-hidden="true">{formatCompactCount(badge.count)}</span>
            <span className="sr-only">{` ${badge.count} ${badge.label}`}</span>
          </span>
        ) : null}
      </TooltipTrigger>
      <TooltipPopup side="bottom" className="flex items-center gap-2">
        {props.label}
        {badge ? (
          <span className="text-muted-foreground tabular-nums">
            {badge.count.toLocaleString()} {badge.label}
          </span>
        ) : null}
        {props.shortcutLabel ? <Kbd>{props.shortcutLabel}</Kbd> : null}
      </TooltipPopup>
    </Tooltip>
  );
}

/**
 * One strip of icon buttons (Home, Search, Pull requests, Upstream, Scheduled, Usage). Search
 * toggles the thread search field under the strip; the field stays while it holds a query.
 */
export function SidebarNav(props: {
  searchQuery: string;
  onSearchQueryChange: (query: string) => void;
  onOpenCommandPalette: () => void;
  commandPaletteShortcutLabel: string | null;
  pullRequestsShortcutLabel: string | null;
}) {
  const navigate = useNavigate();
  const isOnScheduled = useLocation({ select: (loc) => loc.pathname === "/scheduled" });
  const isOnHome = useLocation({ select: (loc) => loc.pathname === "/" });
  const isOnPullRequests = useLocation({ select: (loc) => loc.pathname === "/pull-requests" });
  const isOnUsage = useLocation({ select: (loc) => loc.pathname === "/usage" });
  const isOnUpstream = useLocation({ select: (loc) => loc.pathname === "/upstream" });
  const prHubNeedsYouCount = usePrHubNeedsYouCount();
  const upstream = useUpstreamNav();
  const [searchOpen, setSearchOpen] = useState(false);
  const searchButtonRef = useRef<HTMLButtonElement | null>(null);
  const searchVisible = searchOpen || props.searchQuery.length > 0;

  return (
    <nav aria-label="Primary" className="shrink-0 px-2 pb-2">
      <div className="flex items-center justify-between gap-0.5 border-b border-sidebar-border pb-2">
        <NavIconButton
          icon={HomeIcon}
          label="Home"
          isActive={isOnHome}
          onSelect={() => void navigate({ to: "/" })}
        />
        <NavIconButton
          icon={SearchIcon}
          label="Search threads"
          isActive={false}
          pressed={searchVisible}
          testId="sidebar-search-toggle"
          buttonRef={searchButtonRef}
          onSelect={() => {
            if (searchVisible) {
              props.onSearchQueryChange("");
              setSearchOpen(false);
              return;
            }
            setSearchOpen(true);
          }}
        />
        <NavIconButton
          icon={GitPullRequestIcon}
          label="Pull requests"
          isActive={isOnPullRequests}
          shortcutLabel={props.pullRequestsShortcutLabel}
          badge={{ count: prHubNeedsYouCount, label: "need you", tone: "warning" }}
          onSelect={() => void navigate({ to: "/pull-requests" })}
        />
        {upstream.visible ? (
          <NavIconButton
            icon={GitMergeIcon}
            label="Upstream"
            isActive={isOnUpstream}
            badge={{ count: upstream.inbox, label: "to review", tone: "outline" }}
            onSelect={() => void navigate({ to: "/upstream" })}
          />
        ) : null}
        <NavIconButton
          icon={CalendarClockIcon}
          label="Scheduled"
          isActive={isOnScheduled}
          onSelect={() => void navigate({ to: "/scheduled" })}
        />
        <NavIconButton
          icon={GaugeIcon}
          label="Usage"
          isActive={isOnUsage}
          onSelect={() => void navigate({ to: "/usage" })}
        />
      </div>
      {searchVisible ? (
        <div className="pt-2">
          <SidebarThreadSearchInput
            query={props.searchQuery}
            onQueryChange={props.onSearchQueryChange}
            onOpenCommandPalette={props.onOpenCommandPalette}
            commandPaletteShortcutLabel={props.commandPaletteShortcutLabel}
            autoFocus={searchOpen}
            onDismiss={(restoreFocus, nextFocus) => {
              // Focus moving to the Search button lets its click close the field instead.
              if (nextFocus !== null && nextFocus === searchButtonRef.current) return;
              setSearchOpen(false);
              if (restoreFocus) searchButtonRef.current?.focus();
            }}
          />
        </div>
      ) : null}
    </nav>
  );
}
