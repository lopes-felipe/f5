import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { StorageUsageReport } from "@t3tools/contracts";
import { ensureNativeApi } from "../../nativeApi";
import { Button } from "../ui/button";

export function StorageOperationDetails({
  operationId,
  report,
}: {
  readonly operationId: string;
  readonly report: StorageUsageReport | null;
}) {
  const [open, setOpen] = useState(false),
    [cursor, setCursor] = useState(0);
  const query = useQuery({
    queryKey: ["storage", "operation", operationId, cursor],
    enabled: open,
    queryFn: () => ensureNativeApi().storage.getOperation({ operationId, cursor, limit: 50 }),
    retry: false,
    refetchOnWindowFocus: false,
  });
  return (
    <details
      onToggle={(event) => setOpen(event.currentTarget.open)}
      className="rounded-xl border border-border p-4 text-xs"
    >
      <summary className="cursor-pointer font-medium">Inspect cleanup details</summary>
      {query.isLoading ? (
        <p role="status" className="mt-2">
          Loading cleanup details…
        </p>
      ) : null}
      {query.error ? (
        <p role="alert" className="mt-2 text-destructive">
          {query.error.message}
        </p>
      ) : null}
      {query.data ? (
        <div className="mt-2 space-y-2">
          {query.data.status.omittedCount > 0 ? (
            <p className="text-muted-foreground">
              {query.data.status.omittedCount} details are not retained. Totals include them.
            </p>
          ) : null}
          <ul className="space-y-2">
            {query.data.results.map((entry, index) => {
              const category = report?.categories.find(
                (category) => category.id === entry.categoryId,
              );
              return (
                <li key={index} className="rounded border p-2">
                  <span className="font-medium">
                    {category?.title ?? entry.categoryId.replace(/([A-Z])/g, " $1")}
                  </span>
                  {entry.perTargetReclaimed.map((target) => (
                    <p key={target.id} className="break-words text-muted-foreground">
                      {target.status ?? "Removed"}:{" "}
                      {category?.targets.find((candidate) => candidate.id === target.id)?.label ??
                        target.path ??
                        target.id}
                      {target.branch ? ` (branch ${target.branch})` : ""}
                    </p>
                  ))}
                  {entry.warnings.map((warning, warningIndex) => (
                    <p key={warningIndex} className="break-words text-muted-foreground">
                      {warning.reason}
                    </p>
                  ))}
                </li>
              );
            })}
          </ul>
          <div className="flex gap-2">
            <Button
              size="xs"
              variant="outline"
              disabled={cursor === 0}
              onClick={() => setCursor(Math.max(0, cursor - 50))}
            >
              Previous
            </Button>
            <Button
              size="xs"
              variant="outline"
              disabled={query.data.nextCursor === null}
              onClick={() => {
                if (query.data?.nextCursor !== null && query.data?.nextCursor !== undefined)
                  setCursor(query.data.nextCursor);
              }}
            >
              Next 50
            </Button>
          </div>
        </div>
      ) : null}
    </details>
  );
}
