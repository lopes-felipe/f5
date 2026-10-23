import type { PrQuickActionRequest } from "../../lib/prQuickActions";
import { useQuery } from "@tanstack/react-query";
import type { ThreadId } from "@t3tools/contracts";
import { useAppSettings } from "../../appSettings";
import { OpenLinkThread, useOpenLink } from "../../hooks/useOpenLink";
import { ensureNativeApi } from "../../nativeApi";
import {
  assertPrHubAccountGeneration,
  getPrHubAccountGeneration,
  getPrHubSelectedAccountId,
  setPrHubSelectedAccountId,
} from "../../lib/prHubAccount";
import { Button } from "../ui/button";
import { PrDetailPanel } from "./PrDetailPanel";

/** Uses the normal PR model and write paths while retaining the thread and its draft. */
export default function PrLinkedPanel({
  url,
  threadId,
  initialAction,
  onInitialActionHandled,
}: {
  url: string;
  threadId?: ThreadId;
  initialAction?: PrQuickActionRequest | undefined;
  onInitialActionHandled?: (() => void) | undefined;
}) {
  const { settings } = useAppSettings();
  const openLink = useOpenLink();
  setPrHubSelectedAccountId(settings.prHubAccountId ?? undefined);
  const accountId = getPrHubSelectedAccountId();
  const generation = getPrHubAccountGeneration();
  const query = useQuery({
    queryKey: ["prHub", "linkedPanel", accountId, generation, url],
    queryFn: async () => {
      const api = ensureNativeApi().prHub;
      const overview = await api.getOverview({ accountId });
      const accountGeneration = overview.account?.generation;
      if (!accountGeneration) throw new Error("Connect a forge account in Pull requests first.");
      const verify = () => {
        if (getPrHubSelectedAccountId() !== accountId)
          throw new Error("The forge account changed. Reopen this pull request.");
        assertPrHubAccountGeneration(accountGeneration);
      };
      verify();
      // Tracking reads the forge and saves its local PR model. It never changes the remote PR.
      const pr = await api.track({ url, accountGeneration });
      verify();
      return { pr, accountGeneration };
    },
    retry: false,
    staleTime: 30_000,
  });
  const value = query.data && query.data.accountGeneration === generation ? query.data.pr : null;
  return (
    <OpenLinkThread.Provider value={threadId}>
      <div className="min-h-0 flex-1 overflow-auto p-4" aria-label="Pull request panel">
        <div className="mb-4 flex items-center justify-between gap-2">
          <span className="text-sm font-medium">Pull request</span>
          <Button
            size="xs"
            variant="outline"
            onClick={() => void openLink(url, { external: true })}
          >
            Open on forge
          </Button>
        </div>
        {query.isPending ? <p role="status">Loading pull request…</p> : null}
        {query.isError ? (
          <div className="space-y-2">
            <p role="alert">{query.error.message}</p>
            <Button size="sm" variant="outline" onClick={() => void query.refetch()}>
              Retry
            </Button>
          </div>
        ) : null}
        {value ? (
          <PrDetailPanel
            key={`${generation}:${value.key}`}
            pr={value}
            confirmationMode="inline"
            initialAction={initialAction}
            onInitialActionHandled={onInitialActionHandled}
          />
        ) : null}
      </div>
    </OpenLinkThread.Provider>
  );
}
