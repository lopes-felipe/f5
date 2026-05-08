import { GitPullRequestIcon, RocketIcon } from "lucide-react";

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

export function ThreadDetailsLoadingState({
  label = "Loading thread details...",
  testId,
}: {
  readonly label?: string;
  readonly testId?: string;
}) {
  return (
    <div
      className="mx-auto w-full max-w-3xl space-y-4 px-3 py-3 sm:px-5 sm:py-4"
      role="status"
      aria-live="polite"
      aria-label={label}
      data-testid={testId}
    >
      <span className="sr-only">{label}</span>
      <p aria-hidden="true" className="px-1 text-xs text-muted-foreground">
        {label}
      </p>
      <div
        aria-hidden="true"
        className="rounded-lg border border-border/70 bg-card/70 p-4 shadow-sm backdrop-blur-sm"
      >
        <div className="space-y-3">
          <Skeleton className="h-4 w-28 rounded-full" />
          <Skeleton className="h-3 w-full rounded-full" />
          <Skeleton className="h-3 w-11/12 rounded-full" />
          <Skeleton className="h-3 w-10/12 rounded-full" />
        </div>
      </div>
      <div
        aria-hidden="true"
        className="rounded-lg border border-border/70 bg-card/70 p-4 shadow-sm backdrop-blur-sm"
      >
        <div className="space-y-3">
          <Skeleton className="h-4 w-36 rounded-full" />
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
      <ThreadDetailsLoadingState label="Loading thread" testId="startup-thread-skeleton" />
    </SidebarInset>
  );
}

export function StartupWorkflowRouteSkeleton({
  kind,
}: {
  readonly kind: "planning" | "code-review";
}) {
  const Icon = kind === "planning" ? RocketIcon : GitPullRequestIcon;
  const label = kind === "planning" ? "Loading planning workflow" : "Loading code review workflow";
  const badgeWidth = kind === "planning" ? "w-16" : "w-20";

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
        <div aria-hidden="true" className="border-b border-border px-6 py-4">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="min-w-0 space-y-3">
              <div className="flex items-center gap-2">
                <Icon className="size-3.5 text-muted-foreground/60" />
                <Skeleton className={`h-3 ${badgeWidth} rounded-full`} />
              </div>
              <Skeleton className="h-7 w-64 max-w-[70vw] rounded-md" />
              <Skeleton className="h-4 w-40 rounded-full" />
            </div>
            <div className="flex gap-2">
              <Skeleton className="h-9 w-24 rounded-md" />
              <Skeleton className="h-9 w-28 rounded-md" />
            </div>
          </div>
        </div>
        <div
          aria-hidden="true"
          className="grid min-h-0 flex-1 gap-6 p-6 lg:grid-cols-[22rem_minmax(0,1fr)]"
        >
          <aside className="overflow-hidden rounded-lg border border-border bg-card p-4">
            <div className="space-y-4">
              {[0, 1, 2, 3].map((index) => (
                <div key={index} className="flex items-start gap-3">
                  <Skeleton className="mt-0.5 size-5 rounded-full" />
                  <div className="min-w-0 flex-1 space-y-2">
                    <Skeleton className="h-4 w-32 rounded-full" />
                    <Skeleton className="h-3 w-24 rounded-full" />
                  </div>
                </div>
              ))}
            </div>
          </aside>
          <main className="min-h-0 min-w-0 rounded-lg border border-border bg-card p-5">
            <div className="space-y-5">
              <Skeleton className="h-5 w-48 rounded-full" />
              <div className="space-y-2">
                <Skeleton className="h-3 w-full rounded-full" />
                <Skeleton className="h-3 w-11/12 rounded-full" />
                <Skeleton className="h-3 w-10/12 rounded-full" />
              </div>
              <div className="space-y-2">
                <Skeleton className="h-3 w-full rounded-full" />
                <Skeleton className="h-3 w-9/12 rounded-full" />
              </div>
            </div>
          </main>
        </div>
      </div>
    </SidebarInset>
  );
}
