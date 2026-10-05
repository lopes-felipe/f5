import { GitPullRequestIcon, RocketIcon, SearchIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "../lib/utils";
import { Skeleton } from "./ui/skeleton";
import { SidebarInset, SidebarMenuSkeleton } from "./ui/sidebar";

const SIDEBAR_PROJECT_WIDTHS = ["76%", "68%", "72%"] as const;
const SIDEBAR_THREAD_WIDTHS = [
  ["64%", "54%"],
  ["58%", "66%"],
  ["62%", "50%"],
] as const;

export function StartupSidebarSkeleton() {
  return (
    <div
      className="px-2 pt-3"
      role="status"
      aria-live="polite"
      aria-label="Loading projects"
      data-testid="startup-sidebar-skeleton"
    >
      <span className="sr-only">Loading projects</span>
      <div aria-hidden="true" className="space-y-3">
        {SIDEBAR_PROJECT_WIDTHS.map((projectWidth, projectIndex) => (
          <div key={projectWidth} className="space-y-1">
            <SidebarMenuSkeleton showIcon width={projectWidth} className="h-7 px-2" />
            <div className="space-y-1 pl-5">
              {(SIDEBAR_THREAD_WIDTHS[projectIndex] ?? []).map((threadWidth) => (
                <SidebarMenuSkeleton
                  key={threadWidth}
                  width={threadWidth}
                  className="h-6 rounded-md px-2"
                />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Title bar placeholder: same height as `AppTitlebar` on web. */
function TitlebarSkeleton({ children }: { readonly children?: ReactNode }) {
  return (
    <div aria-hidden="true" className="flex h-11 shrink-0 items-center gap-2 px-3">
      {children ?? <Skeleton className="h-3.5 w-40 rounded-full" />}
    </div>
  );
}

/**
 * Mirrors the Canvas timeline: a right-aligned user bubble, an assistant
 * reply in plain prose, and a work row, so content lands where the skeleton
 * was instead of jumping.
 */
export function ThreadDetailsLoadingState({
  label = "Loading thread details...",
  testId,
}: {
  readonly label?: string;
  readonly testId?: string;
}) {
  return (
    <div
      className="mx-auto w-full max-w-(--chat-content-max-width) px-3 py-4 sm:px-5 sm:py-6"
      role="status"
      aria-live="polite"
      aria-label={label}
      data-testid={testId}
    >
      <span className="sr-only">{label}</span>
      <div aria-hidden="true" className="space-y-6">
        <div className="flex justify-end">
          <Skeleton className="h-9 w-7/12 rounded-2xl" />
        </div>
        <div className="space-y-2.5">
          <Skeleton className="h-3 w-full rounded-full" />
          <Skeleton className="h-3 w-11/12 rounded-full" />
          <Skeleton className="h-3 w-9/12 rounded-full" />
        </div>
        <div className="flex items-center gap-2">
          <Skeleton className="size-4 rounded-md" />
          <Skeleton className="h-3 w-44 rounded-full" />
        </div>
        <div className="space-y-2.5">
          <Skeleton className="h-3 w-full rounded-full" />
          <Skeleton className="h-3 w-8/12 rounded-full" />
        </div>
      </div>
    </div>
  );
}

export function StartupThreadRouteSkeleton() {
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <TitlebarSkeleton />
      <ThreadDetailsLoadingState label="Loading thread" testId="startup-thread-skeleton" />
    </SidebarInset>
  );
}

const WORKFLOW_SKELETON_COLUMNS = [3, 2, 2, 1] as const;

/**
 * Mirrors `WorkflowPageLayout`: breadcrumb title bar, title and meta line,
 * then the phase board at `lg+` (a single list column below it).
 */
export function StartupWorkflowRouteSkeleton({
  kind,
}: {
  readonly kind: "planning" | "code-review" | "investigation";
}) {
  const Icon =
    kind === "planning" ? RocketIcon : kind === "investigation" ? SearchIcon : GitPullRequestIcon;
  const label =
    kind === "planning"
      ? "Loading planning workflow"
      : kind === "investigation"
        ? "Loading investigation workflow"
        : "Loading code review workflow";

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div
        className="flex h-full min-h-0 flex-col bg-background"
        role="status"
        aria-live="polite"
        aria-label={label}
        data-testid="startup-workflow-skeleton"
        data-kind={kind}
      >
        <span className="sr-only">{label}</span>
        <TitlebarSkeleton>
          <Skeleton className="h-3.5 w-24 rounded-full" />
          <Icon className="size-3.5 text-faint-foreground" />
          <Skeleton className="h-3.5 w-20 rounded-full" />
        </TitlebarSkeleton>
        <div aria-hidden="true" className="min-h-0 flex-1 space-y-6 px-4 py-5 sm:px-6">
          <div className="space-y-2.5">
            <Skeleton className="h-6 w-72 max-w-[70vw] rounded-md" />
            <Skeleton className="h-3 w-56 rounded-full" />
          </div>
          <div className="flex gap-3">
            {WORKFLOW_SKELETON_COLUMNS.map((cardCount, columnIndex) => (
              <div
                key={columnIndex}
                className={cn("w-full space-y-2 lg:w-60", columnIndex > 0 && "max-lg:hidden")}
              >
                <Skeleton className="h-3 w-24 rounded-full" />
                {Array.from({ length: cardCount }, (_, cardIndex) => (
                  <div key={cardIndex} className="space-y-2 rounded-lg border border-border p-3">
                    <Skeleton className="h-3.5 w-32 rounded-full" />
                    <Skeleton className="h-3 w-20 rounded-full" />
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      </div>
    </SidebarInset>
  );
}
