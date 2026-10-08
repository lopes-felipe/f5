import type { DiskSpaceStatus } from "@t3tools/contracts";
import { formatByteSize } from "@t3tools/shared/byteSize";
import { describeDiskSpaceRoles } from "@t3tools/shared/diskSpace";
import { HardDriveIcon } from "lucide-react";
import { memo } from "react";

import { Alert, AlertAction, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";

const RECLAIMABLE_SHOWN = 3;

/**
 * Persistent while a watched volume is below the low threshold; not
 * dismissible, because below the critical threshold new turns are held.
 * Points at the biggest reclaimable items and Storage maintenance.
 */
export const LowDiskSpaceBanner = memo(function LowDiskSpaceBanner({
  status,
  onOpenStorage,
}: {
  status: DiskSpaceStatus | null;
  onOpenStorage: () => void;
}) {
  if (!status || status.level === "ok") return null;
  const critical = status.level === "critical";
  const fullest = status.volumes
    .filter((volume) => volume.level !== "ok")
    .toSorted((left, right) => left.freeBytes - right.freeBytes)[0];
  const reclaimable = status.reclaimable.slice(0, RECLAIMABLE_SHOWN);

  return (
    <Alert variant={critical ? "error" : "warning"}>
      <HardDriveIcon />
      <AlertTitle>
        {critical ? "Disk almost full: new turns are held" : "Low disk space"}
      </AlertTitle>
      <AlertDescription>
        {fullest ? (
          <p>
            {formatByteSize(fullest.freeBytes)} free on the volume holding{" "}
            {describeDiskSpaceRoles(fullest.roles)}
            <span className="text-muted-foreground"> ({fullest.path})</span>.{" "}
            {critical
              ? `Turns start again once more than ${formatByteSize(status.criticalThresholdBytes)} is free.`
              : `New turns are held below ${formatByteSize(status.criticalThresholdBytes)}.`}
          </p>
        ) : null}
        {reclaimable.length > 0 ? (
          <p>
            Reclaimable:{" "}
            {reclaimable.map((item) => `${item.title} (${formatByteSize(item.bytes)})`).join(", ")}.
          </p>
        ) : null}
      </AlertDescription>
      <AlertAction>
        <Button size="sm" variant={critical ? "default" : "outline"} onClick={onOpenStorage}>
          Free up space
        </Button>
      </AlertAction>
    </Alert>
  );
});
