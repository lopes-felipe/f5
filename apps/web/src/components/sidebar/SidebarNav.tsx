import { useLocation, useNavigate } from "@tanstack/react-router";
import {
  CalendarClockIcon,
  GitMergeIcon,
  GaugeIcon,
  GitPullRequestIcon,
  ClockIcon,
  HomeIcon,
  ListIcon,
  type LucideIcon,
  SearchIcon,
} from "lucide-react";
import { useRef, useState } from "react";

import { usePrHubNeedsYouCount, useUpstreamNav } from "../../hooks/useSurfaceCounts";
import { cn } from "../../lib/utils";

import { SidebarThreadSearchInput } from "../SidebarThreadSearch";
import { formatCompactCount } from "../Sidebar.logic";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { Kbd } from "../ui/kbd";

/** Shared look for sidebar navigation rows: 32px, `text-ui`, 16px icon. */
export const SIDEBAR_NAV_ROW_CLASS_NAME =
  "h-8 gap-2 px-2 text-ui text-muted-foreground hover:bg-accent/60 hover:text-foreground data-[active=true]:bg-sidebar-accent data-[active=true]:text-foreground";

/** The sidebar's two views; `Sidebar.tsx` persists the choice with a schema built from this. */
export const SIDEBAR_VIEWS = ["projects", "recent"] as const;
export type SidebarView = (typeof SIDEBAR_VIEWS)[number];

const SIDEBAR_VIEW_OPTIONS: ReadonlyArray<{
  value: SidebarView;
  label: string;
  icon: LucideIcon;
}> = [
  { value: "projects", label: "Projects", icon: ListIcon },
  { value: "recent", label: "Recent", icon: ClockIcon },
];

/**
 * Projects | Recent as two icons at the end of the strip: a radio group with one Tab stop,
 * where the arrow keys move both the choice and focus.
 */
function SidebarViewToggle(props: {
  view: SidebarView;
  onViewChange: (view: SidebarView) => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-label="Sidebar view"
      className="flex shrink-0 items-center gap-px rounded-md border border-border p-px"
    >
      {SIDEBAR_VIEW_OPTIONS.map((option, index) => {
        const Icon = option.icon;
        const checked = props.view === option.value;
        return (
          <Tooltip key={option.value}>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  role="radio"
                  aria-checked={checked}
                  aria-label={option.label}
                  tabIndex={checked ? 0 : -1}
                  data-testid={`sidebar-view-${option.value}`}
                  className="inline-flex size-5 items-center justify-center rounded-sm text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring aria-checked:bg-accent aria-checked:text-foreground"
                  onClick={() => props.onViewChange(option.value)}
                  onKeyDown={(event) => {
                    const step =
                      event.key === "ArrowRight" || event.key === "ArrowDown"
                        ? 1
                        : event.key === "ArrowLeft" || event.key === "ArrowUp"
                          ? -1
                          : 0;
                    if (step === 0) return;
                    event.preventDefault();
                    const count = SIDEBAR_VIEW_OPTIONS.length;
                    const next = SIDEBAR_VIEW_OPTIONS[(index + step + count) % count]!;
                    props.onViewChange(next.value);
                    event.currentTarget.parentElement
                      ?.querySelector<HTMLElement>(`[data-testid="sidebar-view-${next.value}"]`)
                      ?.focus();
                  }}
                />
              }
            >
              <Icon aria-hidden="true" className="size-3.5" />
            </TooltipTrigger>
            <TooltipPopup side="bottom">{option.label}</TooltipPopup>
          </Tooltip>
        );
      })}
    </div>
  );
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
 * One strip of icon buttons (Home, Search, Pull requests, Upstream, Scheduled, Usage), ending
 * with the Projects | Recent toggle. Search toggles the thread search field under the strip;
 * the field stays while it holds a query.
 */
export function SidebarNav(props: {
  searchQuery: string;
  onSearchQueryChange: (query: string) => void;
  onOpenCommandPalette: () => void;
  commandPaletteShortcutLabel: string | null;
  homeShortcutLabel: string | null;
  view: SidebarView;
  onViewChange: (view: SidebarView) => void;
}) {
  const navigate = useNavigate();
  const isOnScheduled = useLocation({ select: (loc) => loc.pathname === "/scheduled" });
  const isOnHome = useLocation({ select: (loc) => loc.pathname === "/" });
  const isOnUpstream = useLocation({ select: (loc) => loc.pathname === "/upstream" });
  const upstream = useUpstreamNav();
  const [searchOpen, setSearchOpen] = useState(false);
  const searchButtonRef = useRef<HTMLButtonElement | null>(null);
  const searchVisible = searchOpen || props.searchQuery.length > 0;

  return (
    // Pinned above the scroll area. Top padding keeps the count badges, which rise above their
    // buttons, clear of the New thread row.
    <nav aria-label="Primary" className="shrink-0 p-2">
      <div className="flex items-center justify-between gap-0.5 border-b border-sidebar-border pb-2">
        <NavIconButton
          icon={HomeIcon}
          label="Home"
          shortcutLabel={props.homeShortcutLabel}
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
        <span aria-hidden="true" className="mx-0.5 h-4 w-px shrink-0 bg-border" />
        <SidebarViewToggle view={props.view} onViewChange={props.onViewChange} />
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
/** Workspace utilities live together in the sidebar footer. */
export function SidebarWorkspaceNavigation({
  pullRequestsShortcutLabel,
}: {
  pullRequestsShortcutLabel: string | null;
}) {
  const navigate = useNavigate();
  const count = usePrHubNeedsYouCount();
  return (
    <>
      <NavIconButton
        icon={GitPullRequestIcon}
        label="Pull requests"
        shortcutLabel={pullRequestsShortcutLabel}
        isActive={false}
        badge={{ count, label: "need you", tone: "warning" }}
        onSelect={() => void navigate({ to: "/pull-requests" })}
      />
      <NavIconButton
        icon={GaugeIcon}
        label="Usage"
        isActive={false}
        onSelect={() => void navigate({ to: "/usage" })}
      />
    </>
  );
}
