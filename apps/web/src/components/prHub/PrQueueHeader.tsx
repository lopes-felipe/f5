import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { EllipsisIcon, LinkIcon, RefreshCwIcon, SettingsIcon, UsersIcon } from "lucide-react";
import type { ForgeAccount, PrHubOverview, TrackedPullRequest } from "@t3tools/contracts";

import { getPrHubAccountGeneration } from "../../lib/prHubAccount";
import { forgeAccountsQueryOptions } from "../../lib/prHubReactQuery";
import { formatAbsoluteTimeLabel } from "../../lib/relativeTime";
import { cn } from "../../lib/utils";
import { ensureNativeApi } from "../../nativeApi";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { forgeProviderLabel } from "./forgePresentation";
import { prSyncPillDetail, prSyncPillLabel } from "./prQueueModel";

const SYNC_DOT: Record<NonNullable<PrHubOverview["sync"]>["state"], string> = {
  idle: "bg-success",
  syncing: "bg-info motion-safe:animate-pulse",
  rate_limited: "bg-warning",
  offline: "bg-warning",
  auth_required: "bg-destructive",
  error: "bg-destructive",
};

/**
 * Sync health in one pill. The popover holds what used to sit above the list: when the
 * queue last synced and will next, work still pending, rate limits and coverage.
 */
export function PrSyncPill({
  overview,
  now,
  isRefreshing,
  onRefresh,
}: {
  overview: PrHubOverview | undefined;
  now: number;
  isRefreshing: boolean;
  onRefresh: () => void;
}) {
  const sync = overview?.sync;
  const nextSync = sync?.nextSyncAt ?? overview?.nextRefreshAt;
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            size="xs"
            variant="ghost"
            aria-label={`Sync status: ${prSyncPillLabel(sync, now)}`}
            className="text-muted-foreground"
          />
        }
      >
        <span
          aria-hidden="true"
          className={cn("size-1.5 rounded-full", sync ? SYNC_DOT[sync.state] : "bg-border")}
        />
        <span className="hidden @md/titlebar:inline">{prSyncPillLabel(sync, now)}</span>
      </PopoverTrigger>
      <PopoverPopup align="start" className="w-96">
        <div className="flex flex-col gap-3 text-xs">
          <div className="flex flex-col gap-1">
            <PopoverTitle className="text-sm">{prSyncPillLabel(sync, now)}</PopoverTitle>
            <p className="text-muted-foreground">
              {sync ? prSyncPillDetail(sync) : "Loading the queue."}
            </p>
          </div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
            {overview?.viewerLogin ? (
              <>
                <dt className="text-muted-foreground">Account</dt>
                <dd>
                  {overview.viewerLogin} on {overview.host}
                </dd>
              </>
            ) : null}
            <dt className="text-muted-foreground">Last synced</dt>
            <dd>{sync?.lastSyncedAt ? formatAbsoluteTimeLabel(sync.lastSyncedAt) : "Not yet"}</dd>
            {nextSync ? (
              <>
                <dt className="text-muted-foreground">Next sync</dt>
                <dd>{formatAbsoluteTimeLabel(nextSync)}</dd>
              </>
            ) : null}
          </dl>
          {overview?.scheduler ? (
            <details>
              <summary className="cursor-pointer text-muted-foreground">Rate limits</summary>
              <table className="mt-2 w-full text-left tabular-nums">
                <thead className="text-muted-foreground">
                  <tr>
                    <th className="font-normal">Resource</th>
                    <th className="font-normal">Used</th>
                    <th className="font-normal">Remaining</th>
                    <th className="font-normal">Resumes</th>
                  </tr>
                </thead>
                <tbody>
                  {overview.scheduler.resources.map((resource) => (
                    <tr key={resource.resource}>
                      <td>{resource.resource.toUpperCase()}</td>
                      <td>
                        {resource.used} / {resource.windowLimit}
                      </td>
                      <td>{resource.remaining ?? "Unknown"}</td>
                      <td>
                        {resource.resumeAt ? formatAbsoluteTimeLabel(resource.resumeAt) : "Now"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          ) : null}
          {overview?.coverage.length ? (
            <details>
              <summary className="cursor-pointer text-muted-foreground">What is monitored</summary>
              <ul className="mt-2 flex flex-col gap-1">
                {overview.coverage.map((scope) => (
                  <li key={scope.scope}>{scope.description}</li>
                ))}
              </ul>
            </details>
          ) : null}
          <Button
            size="xs"
            variant="outline"
            className="self-start"
            disabled={isRefreshing}
            onClick={onRefresh}
          >
            <RefreshCwIcon className={isRefreshing ? "animate-spin" : ""} />
            {isRefreshing ? "Refreshing…" : "Refresh now"}
          </Button>
        </div>
      </PopoverPopup>
    </Popover>
  );
}

const PROFILE_ACCOUNT = "profile";
const accountLabel = (account: ForgeAccount) =>
  `${account.login} · ${forgeProviderLabel(account.provider)} ${account.host}`;

/** Shown only when there is a second account to switch to; accounts are managed in Settings. */
export function PrAccountSwitcher({
  selectedAccountId,
  onSelect,
}: {
  selectedAccountId: string | undefined;
  onSelect: (accountId: string | undefined) => void;
}) {
  const accounts = useQuery(forgeAccountsQueryOptions()).data ?? [];
  if (accounts.length === 0) return null;
  const selected = accounts.find((account) => account.id === selectedAccountId);
  return (
    <Select
      value={selected?.id ?? PROFILE_ACCOUNT}
      onValueChange={(value) => onSelect(!value || value === PROFILE_ACCOUNT ? undefined : value)}
    >
      <SelectTrigger size="sm" className="max-w-56" aria-label="Forge account">
        <SelectValue>{selected ? accountLabel(selected) : "Profile GitHub account"}</SelectValue>
      </SelectTrigger>
      <SelectPopup align="end">
        <SelectItem value={PROFILE_ACCOUNT}>Profile GitHub account</SelectItem>
        {accounts.map((account) => (
          <SelectItem key={account.id} value={account.id}>
            {accountLabel(account)}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

/** Tracking reads the forge and saves the pull request locally; it changes nothing remotely. */
function PrTrackDialog({
  open,
  onOpenChange,
  onTracked,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onTracked: (pr: TrackedPullRequest) => void;
}) {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setError(null);
        onOpenChange(next);
      }}
    >
      <DialogPopup>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (busy || !url.trim()) return;
            setBusy(true);
            setError(null);
            void ensureNativeApi()
              .prHub.track({ url: url.trim(), accountGeneration: getPrHubAccountGeneration() })
              .then((pr) => {
                setUrl("");
                onOpenChange(false);
                onTracked(pr);
              })
              .catch((cause: unknown) =>
                setError(
                  cause instanceof Error ? cause.message : "The pull request could not be tracked.",
                ),
              )
              .finally(() => setBusy(false));
          }}
        >
          <DialogHeader>
            <DialogTitle>Track a pull request</DialogTitle>
            <DialogDescription>
              Adds a pull request to the queue even if you are not its author or reviewer.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-2">
            <Input
              aria-label="Pull request URL"
              type="url"
              autoFocus
              value={url}
              disabled={busy}
              placeholder="https://github.com/owner/repository/pull/123"
              onChange={(event) => setUrl(event.target.value)}
            />
            {error ? (
              <p role="alert" className="text-xs text-destructive-foreground">
                {error}
              </p>
            ) : null}
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !url.trim()}>
              {busy ? "Tracking…" : "Track"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

export type PrQueueSettingsTarget = "accounts" | "github" | "prHub";

export function PrQueueMenu({
  onTracked,
  onOpenSettings,
}: {
  onTracked: (pr: TrackedPullRequest) => void;
  onOpenSettings: (target: PrQueueSettingsTarget) => void;
}) {
  const [tracking, setTracking] = useState(false);
  return (
    <>
      <Menu>
        <MenuTrigger
          render={<Button aria-label="Pull request options" size="icon-sm" variant="ghost" />}
        >
          <EllipsisIcon aria-hidden="true" />
        </MenuTrigger>
        <MenuPopup align="end" className="min-w-52">
          <MenuItem onClick={() => setTracking(true)}>
            <LinkIcon /> Track a pull request by URL…
          </MenuItem>
          <MenuItem onClick={() => onOpenSettings("accounts")}>
            <UsersIcon /> Manage accounts
          </MenuItem>
          <MenuItem onClick={() => onOpenSettings("prHub")}>
            <SettingsIcon /> PR Hub settings
          </MenuItem>
        </MenuPopup>
      </Menu>
      <PrTrackDialog open={tracking} onOpenChange={setTracking} onTracked={onTracked} />
    </>
  );
}
