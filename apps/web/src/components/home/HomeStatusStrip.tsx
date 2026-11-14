import type { ScheduledTaskListResult } from "@t3tools/contracts";
import { formatByteSize } from "@t3tools/shared/byteSize";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { lazy, Suspense } from "react";

import { useAppSettingsSelector } from "../../appSettings";
import { useDiskSpaceStatus } from "../../hooks/useDiskSpaceStatus";
import { useUpstreamNav } from "../../hooks/useSurfaceCounts";
import { useNowMinute } from "../../lib/nowTicker";
import { scheduledTasksQueryOptions } from "../../lib/scheduledTasksQuery";
import { readNativeApi } from "../../nativeApi";
import { formatShortTimestamp } from "../../timestampFormat";
import { fullestLowDiskVolume } from "../chat/LowDiskSpaceBanner";
import { formatCompactCount } from "../Sidebar.logic";
import { HomeStripChip, HomeStripValue } from "./HomeStripChip";

const HomeLimitChip = lazy(() => import("./HomeLimitChip"));

/** The soonest upcoming run among tasks that can still run, or null. */
export function nextScheduledRunAt(
  tasks: (typeof ScheduledTaskListResult.Type)["tasks"] | undefined,
  nowMs: number,
): string | null {
  let next: string | null = null;
  for (const { task } of tasks ?? []) {
    if (!task.enabled || task.disabledReason || !task.nextRunAt) continue;
    if (Date.parse(task.nextRunAt) <= nowMs) continue;
    if (next === null || task.nextRunAt < next) next = task.nextRunAt;
  }
  return next;
}

/**
 * One line for everything Home does not list: pull requests and upstream topics waiting on
 * the user, the next scheduled run, the tightest usage limit and low disk space. Each chip
 * opens its page and is left out while it has nothing to report, so an empty strip renders
 * nothing.
 */
export function HomeStatusStrip(props: {
  /** Home reads this count once and words its empty state by it too. */
  readonly prsNeedingYou: number;
}) {
  const navigate = useNavigate();
  const { prsNeedingYou } = props;
  const upstream = useUpstreamNav();
  const diskSpace = useDiskSpaceStatus();
  const timestampFormat = useAppSettingsSelector((settings) => settings.timestampFormat);
  const now = useNowMinute();
  const scheduled = useQuery({
    ...scheduledTasksQueryOptions(),
    enabled: Boolean(readNativeApi()?.scheduledTasks),
  });
  const nextRunAt = nextScheduledRunAt(scheduled.data?.tasks, now);
  const lowVolume = diskSpace && diskSpace.level !== "ok" ? fullestLowDiskVolume(diskSpace) : null;

  return (
    <div
      role="group"
      aria-label="Elsewhere in F5"
      data-slot="home-status-strip"
      className="flex flex-wrap items-center gap-1.5 empty:hidden"
    >
      {prsNeedingYou > 0 ? (
        <HomeStripChip
          testId="home-strip-prs"
          tone="warning"
          title={`${prsNeedingYou.toLocaleString()} pull requests need you`}
          onClick={() => void navigate({ to: "/pull-requests" })}
        >
          <HomeStripValue>{formatCompactCount(prsNeedingYou)}</HomeStripValue>{" "}
          {prsNeedingYou === 1 ? "PR needs you" : "PRs need you"}
        </HomeStripChip>
      ) : null}
      {upstream.visible && upstream.inbox > 0 ? (
        <HomeStripChip
          testId="home-strip-upstream"
          title={`${upstream.inbox.toLocaleString()} upstream topics to review`}
          onClick={() => void navigate({ to: "/upstream" })}
        >
          <HomeStripValue>{formatCompactCount(upstream.inbox)}</HomeStripValue> upstream to review
        </HomeStripChip>
      ) : null}
      {nextRunAt ? (
        <HomeStripChip
          testId="home-strip-scheduled"
          onClick={() => void navigate({ to: "/scheduled" })}
        >
          Next scheduled{" "}
          <HomeStripValue>{formatShortTimestamp(nextRunAt, timestampFormat)}</HomeStripValue>
        </HomeStripChip>
      ) : null}
      <Suspense fallback={null}>
        <HomeLimitChip onOpen={() => void navigate({ to: "/usage" })} />
      </Suspense>
      {diskSpace && lowVolume ? (
        <HomeStripChip
          testId="home-strip-disk"
          tone={diskSpace.level === "critical" ? "error" : "warning"}
          title={
            diskSpace.level === "critical"
              ? "Disk almost full: new turns are held. Open Storage to free up space."
              : "Low disk space. Open Storage to free up space."
          }
          onClick={() =>
            void navigate({
              to: "/settings",
              search: { category: "storage", item: "storage.overview" },
            })
          }
        >
          Disk <HomeStripValue>{formatByteSize(lowVolume.freeBytes)}</HomeStripValue> free
          {diskSpace.level === "critical" ? " · turns held" : " · Free up"}
        </HomeStripChip>
      ) : null}
    </div>
  );
}
