import { useInfiniteQuery } from "@tanstack/react-query";
import { AlertTriangleIcon, FileIcon, LoaderCircleIcon } from "lucide-react";
import type { TrackedPullRequest } from "@t3tools/contracts";

import { prHubFilesQueryOptions } from "../../lib/prHubReactQuery";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";

export function PrFilesTab({ pr, active }: { pr: TrackedPullRequest; active: boolean }) {
  const query = useInfiniteQuery({ ...prHubFilesQueryOptions(pr.key), enabled: active });
  const pages = query.data?.pages ?? [];
  const files = pages.flatMap((page) => page.files);
  const warning = pages.find((page) => page.warning)?.warning;

  if (query.isPending) {
    return (
      <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground" role="tabpanel">
        <LoaderCircleIcon className="size-4 animate-spin" /> Loading changed files…
      </div>
    );
  }
  if (query.isError) {
    return (
      <Alert variant="error" role="tabpanel">
        <AlertTriangleIcon />
        <AlertTitle>Changed files unavailable</AlertTitle>
        <AlertDescription>
          <span>{query.error instanceof Error ? query.error.message : "GitHub files failed."}</span>
          <Button size="xs" variant="outline" onClick={() => void query.refetch()}>
            Retry
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="space-y-3" role="tabpanel" aria-label="Files">
      {warning ? (
        <Alert variant="warning">
          <AlertTriangleIcon />
          <AlertTitle>Showing cached files</AlertTitle>
          <AlertDescription>{warning}</AlertDescription>
        </Alert>
      ) : null}
      {files.length === 0 ? (
        <p className="py-4 text-sm text-muted-foreground">No changed files reported.</p>
      ) : (
        <div className="divide-y divide-border overflow-hidden rounded-lg border border-border">
          {files.map((file) => (
            <div key={file.path} className="flex min-w-0 items-center gap-3 px-3 py-2 text-sm">
              <FileIcon className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate font-mono text-xs">{file.path}</span>
              <span className="shrink-0 tabular-nums">
                <span className="text-success-foreground">+{file.additions}</span>{" "}
                <span className="text-destructive-foreground">−{file.deletions}</span>
              </span>
              <Badge variant="outline" size="sm">
                {file.changeType}
              </Badge>
            </div>
          ))}
        </div>
      )}
      {query.hasNextPage ? (
        <Button
          size="sm"
          variant="outline"
          disabled={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
        >
          {query.isFetchingNextPage ? "Loading…" : "Load more files"}
        </Button>
      ) : null}
    </div>
  );
}
