import { useState } from "react";
import type { TrackedPullRequest } from "@t3tools/contracts";
import { ensureNativeApi } from "../../nativeApi";
import { getPrHubAccountGeneration } from "../../lib/prHubAccount";
import { Button } from "../ui/button";

export function PrTrackForm({ onTracked }: { onTracked: (pr: TrackedPullRequest) => void }) {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="space-y-1 px-5 py-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (busy || !url.trim()) return;
        setBusy(true);
        setError(null);
        void ensureNativeApi()
          .prHub.track({ url: url.trim(), accountGeneration: getPrHubAccountGeneration() })
          .then((pr) => {
            setUrl("");
            onTracked(pr);
          })
          .catch((cause: unknown) =>
            setError(cause instanceof Error ? cause.message : "The PR could not be tracked."),
          )
          .finally(() => setBusy(false));
      }}
    >
      <div className="flex gap-2">
        <input
          aria-label="Pull request URL to track"
          type="url"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          placeholder="Track a PR by its GitHub URL"
          className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1 text-sm"
          disabled={busy}
        />
        <Button type="submit" size="sm" variant="outline" disabled={busy || !url.trim()}>
          {busy ? "Tracking?" : "Track PR"}
        </Button>
      </div>
      {error ? (
        <p role="alert" className="text-xs">
          {error}
        </p>
      ) : null}
    </form>
  );
}
