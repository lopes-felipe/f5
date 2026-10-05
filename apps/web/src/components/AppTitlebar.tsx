import { ChevronRightIcon, XIcon } from "lucide-react";
import { Fragment, type ReactNode } from "react";

import { isElectron } from "../env";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { SidebarTrigger, useOptionalSidebar } from "./ui/sidebar";

export interface AppTitlebarCrumb {
  readonly key?: string | undefined;
  readonly label: string;
  readonly icon?: ReactNode | undefined;
  /** Makes a non-current crumb a button. */
  readonly onSelect?: (() => void) | undefined;
  /** Replaces the default rendering (menus, inline editors). */
  readonly render?: ReactNode | undefined;
}

export interface AppTitlebarProps {
  /**
   * `always`: rendered on web and desktop. `mobile-only`: on web the bar only
   * appears below `md` (where the sidebar becomes a sheet) or while the
   * sidebar is collapsed, i.e. whenever its trigger is needed; desktop always
   * renders it for the drag region.
   */
  readonly webVisibility?: "always" | "mobile-only" | undefined;
  /** Breadcrumb trail; the last crumb is the current page heading. */
  readonly breadcrumb?: ReadonlyArray<AppTitlebarCrumb> | undefined;
  /** Custom leading content instead of a breadcrumb (e.g. the thread header). */
  readonly children?: ReactNode | undefined;
  readonly status?: ReactNode | undefined;
  readonly trailing?: ReactNode | undefined;
  readonly onClose?: (() => void) | undefined;
  readonly closeLabel?: string | undefined;
  readonly className?: string | undefined;
}

/**
 * One title bar for every route: the Electron drag region (52px, traffic-light
 * clearance while the sidebar is collapsed), the sidebar trigger whenever the
 * sidebar is hidden, a breadcrumb or custom leading content, and trailing
 * actions.
 */
export function AppTitlebar({
  webVisibility = "always",
  breadcrumb,
  children,
  status,
  trailing,
  onClose,
  closeLabel = "Close",
  className,
}: AppTitlebarProps) {
  // Without a provider (isolated renders) there is no sidebar to reveal.
  const sidebar = useOptionalSidebar();
  const isMobile = sidebar?.isMobile ?? false;
  const open = sidebar?.open ?? true;
  const sidebarHidden = sidebar !== null && (isMobile ? !sidebar.openMobile : !open);

  return (
    <header
      data-slot="app-titlebar"
      className={cn(
        // `w-full`: inline-size containment zeroes the intrinsic width.
        "@container/titlebar flex w-full min-w-0 shrink-0 items-center gap-2",
        isElectron
          ? // Traffic lights overlay the canvas whenever the sidebar is not
            // beside it (collapsed, or a sheet below `md`).
            cn("drag-region h-(--app-header-height) px-4", (isMobile || !open) && "pl-[90px]")
          : // A collapsed sidebar needs the trigger, so `mobile-only` bars
            // still show at `md+` while it is collapsed.
            cn("h-11 px-3", webVisibility === "mobile-only" && open && "md:hidden"),
        className,
      )}
    >
      {sidebarHidden ? (
        <SidebarTrigger
          aria-label="Toggle sidebar"
          className="size-7 shrink-0 text-muted-foreground hover:text-foreground"
        />
      ) : null}
      {children ?? (breadcrumb ? <AppTitlebarBreadcrumb items={breadcrumb} /> : null)}
      {status ? <div className="flex shrink-0 items-center gap-1.5">{status}</div> : null}
      {trailing || onClose ? (
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {trailing}
          {onClose ? (
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={closeLabel}
              className="text-muted-foreground"
              onClick={onClose}
            >
              <XIcon className="size-4" />
            </Button>
          ) : null}
        </div>
      ) : null}
    </header>
  );
}

export function AppTitlebarBreadcrumb({ items }: { items: ReadonlyArray<AppTitlebarCrumb> }) {
  return (
    <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5">
      {items.map((item, index) => {
        const isCurrent = index === items.length - 1;
        return (
          <Fragment key={item.key ?? `${item.label}-${index}`}>
            {index > 0 ? (
              <ChevronRightIcon
                aria-hidden="true"
                className="size-3.5 shrink-0 text-faint-foreground"
              />
            ) : null}
            {item.render ? (
              item.render
            ) : isCurrent ? (
              <h1
                className="flex min-w-0 items-center gap-1.5 truncate text-sm font-medium text-foreground"
                title={item.label}
              >
                {item.icon}
                <span className="truncate">{item.label}</span>
              </h1>
            ) : item.onSelect ? (
              <button
                type="button"
                onClick={item.onSelect}
                className="flex min-w-0 shrink items-center gap-1.5 rounded-md px-1 py-0.5 text-ui text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              >
                {item.icon}
                <span className="truncate">{item.label}</span>
              </button>
            ) : (
              <span className="flex min-w-0 shrink items-center gap-1.5 px-1 text-ui text-muted-foreground">
                {item.icon}
                <span className="truncate">{item.label}</span>
              </span>
            )}
          </Fragment>
        );
      })}
    </nav>
  );
}
