import { useEffect, useState, type ReactNode } from "react";
import * as Router from "@tanstack/react-router";
import type { PrHubPeek } from "@t3tools/contracts";
import {
  parseSourceControlPullRequestUrl,
  formatSourceControlPullRequestKey,
} from "@t3tools/shared/sourceControl";
import * as nativeApi from "../../nativeApi";
import { writeTextToClipboard } from "../../hooks/useCopyToClipboard";
import { getPrHubSelectedAccountId } from "../../lib/prHubAccount";
import { Button } from "../ui/button";

const readPreviewApi = () => {
  try {
    return nativeApi.ensureNativeApi();
  } catch {
    return undefined;
  }
};

const usePreviewRouter = (() => {
  try {
    return Router.useRouter;
  } catch {
    return () => undefined;
  }
})();

export function PrLinkPreview({ url, children }: { url: string; children: ReactNode }) {
  const router = usePreviewRouter({ warn: false });
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState<PrHubPeek | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    let active = true;
    const api = readPreviewApi();
    if (!api?.prHub.peek) return;
    void api.prHub.peek({ url, accountId: getPrHubSelectedAccountId() }).then(
      (result) => {
        if (active) setValue(result);
      },
      () => {
        if (active) setError("Preview unavailable");
      },
    );
    return () => {
      active = false;
    };
  }, [open, url]);
  const ref = value
    ? {
        provider: value.provider,
        host: value.host,
        repository: value.repository,
        number: value.number,
      }
    : parseSourceControlPullRequestUrl(url);
  const hubUrl = ref
    ? `/pull-requests?pr=${encodeURIComponent(formatSourceControlPullRequestKey(ref))}`
    : url;
  return (
    <span
      className="relative inline-block"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <a
        href={hubUrl}
        onClick={(event) => {
          if (!ref || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          const api = readPreviewApi();
          if (!api || !router) return;
          event.preventDefault();
          void api.prHub.track({ url }).then(
            () =>
              router.navigate({
                to: "/pull-requests",
                search: { pr: formatSourceControlPullRequestKey(ref) },
              }),
            () => setError("Could not open this pull request"),
          );
        }}
      >
        {children}
      </a>
      {open ? (
        <span
          role="tooltip"
          className="absolute left-0 top-full z-50 block w-80 rounded-lg border border-border bg-popover p-3 text-sm text-popover-foreground shadow-lg"
        >
          {value ? (
            <>
              <strong className="block">{value.title}</strong>
              <span className="block text-xs text-muted-foreground">
                {value.repository} #{value.number} · {value.state}
              </span>
            </>
          ) : (
            <span>{error ?? "Loading pull request…"}</span>
          )}
          <Button size="xs" variant="outline" onClick={() => void writeTextToClipboard(url)}>
            Copy link
          </Button>
        </span>
      ) : null}
    </span>
  );
}
