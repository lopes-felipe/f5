import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Schema } from "effect";
import { PrHubThreadLinks } from "@t3tools/contracts";
import type { ThreadId } from "@t3tools/contracts";
import { ensureNativeApi } from "../../nativeApi";
import { newCommandId } from "../../lib/utils";
import { PrLinkPreview } from "./PrLinkPreview";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
export function ThreadPrLinks({ threadId }: { threadId: ThreadId }) {
  const [editing, setEditing] = useState(false),
    [url, setUrl] = useState(""),
    [error, setError] = useState<string | null>(null),
    [busy, setBusy] = useState(false);
  const query = useQuery({
    queryKey: ["threadPrLinks", threadId],
    queryFn: async () =>
      Schema.decodeUnknownSync(PrHubThreadLinks)(
        await ensureNativeApi().prHub.getThreadLinks({ threadId }),
      ),
    staleTime: 60000,
    retry: false,
  });
  return (
    <span className="flex items-center gap-1 text-xs">
      {query.data?.map((link) => (
        <span
          key={`${link.provider}:${link.host}/${link.repository}#${link.number}`}
          className="rounded border border-border px-1"
        >
          <PrLinkPreview url={link.url}>
            {link.provider} #{link.number}
          </PrLinkPreview>
        </span>
      ))}
      <Button
        size="icon-xs"
        variant="ghost"
        aria-label="Link pull request"
        onClick={() => setEditing(!editing)}
      >
        +
      </Button>
      {editing ? (
        <span className="flex gap-1">
          <Input
            aria-label="Pull request URL to link"
            placeholder="Pull request URL"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
          <Button
            size="xs"
            disabled={busy || !url.trim()}
            onClick={() => {
              setBusy(true);
              setError(null);
              void (async () => {
                const api = ensureNativeApi();
                const preview = await api.prHub.peek({ url });
                if (!preview) throw new Error("Enter a supported pull request URL.");
                await api.orchestration.dispatchCommand({
                  type: "thread.meta.update",
                  commandId: newCommandId(),
                  threadId,
                  pullRequest: {
                    provider: preview.provider,
                    host: preview.host,
                    repository: preview.repository,
                    number: preview.number,
                    title: preview.title,
                    url: preview.url,
                  },
                });
                await query.refetch();
                setEditing(false);
                setUrl("");
              })()
                .catch((cause) =>
                  setError(cause instanceof Error ? cause.message : "Could not link pull request."),
                )
                .finally(() => setBusy(false));
            }}
          >
            Link
          </Button>
          {error ? <span role="alert">{error}</span> : null}
        </span>
      ) : null}
    </span>
  );
}
