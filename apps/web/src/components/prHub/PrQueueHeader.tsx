import { useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import {
  BellIcon,
  EllipsisIcon,
  LinkIcon,
  RefreshCwIcon,
  SettingsIcon,
  UsersIcon,
} from "lucide-react";
import type {
  ForgeAccount,
  PrHubOverview,
  PullRequestKey,
  TrackedPullRequest,
} from "@t3tools/contracts";

import { getPrHubAccountGeneration, getPrHubSelectedAccountId } from "../../lib/prHubAccount";
import { forgeAccountsQueryOptions, prHubActivityQueryOptions } from "../../lib/prHubReactQuery";
import { formatAbsoluteTimeLabel, formatRelativeTimeLabel } from "../../lib/relativeTime";
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
import { toastManager } from "../ui/toast";
import { forgeProviderLabel } from "./forgePresentation";
import { prChangesText, prSyncPillDetail, prSyncPillLabel } from "./prQueueModel";

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

/**
 * What changed since you last looked: the most recent unread pull requests of the active
 * queue. Opening one marks it seen; Mark all seen clears the ones listed.
 */
export function PrActivityPopover({
  overview,
  now,
  onOpen,
}: {
  overview: PrHubOverview | undefined;
  now: number;
  onOpen: (key: PullRequestKey) => void;
}) {
  const [open, setOpen] = useState(false);
  const [marking, setMarking] = useState(false);
  const unread = overview?.unreadCount ?? 0;
  // Nothing is read until the list is opened.
  const query = useInfiniteQuery(prHubActivityQueryOptions(open ? overview?.revision : undefined));
  const rows = query.data?.pages.flatMap((page) => page.pullRequests) ?? [];
  const markAllSeen = () => {
    if (marking || rows.length === 0) return;
    setMarking(true);
    void ensureNativeApi()
      .prHub.bulkUpdate({
        keys: rows.map((pr) => pr.key),
        action: "mark_seen",
        accountId: getPrHubSelectedAccountId(),
      })
      .catch((error: unknown) =>
        toastManager.add({
          type: "error",
          title: "Could not mark the pull requests as seen",
          description: error instanceof Error ? error.message : String(error),
        }),
      )
      .finally(() => setMarking(false));
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            size="xs"
            variant="ghost"
            aria-label={unread > 0 ? `Activity: ${unread} unread` : "Activity"}
            className="text-muted-foreground"
          />
        }
      >
        <BellIcon aria-hidden="true" />
        {unread > 0 ? (
          <span className="rounded-full bg-primary px-1.5 text-2xs font-medium text-primary-foreground tabular-nums">
            {unread > 99 ? "99+" : unread}
          </span>
        ) : null}
      </PopoverTrigger>
      <PopoverPopup align="end" className="w-96">
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <PopoverTitle className="text-sm">Activity</PopoverTitle>
            <Button
              size="xs"
              variant="ghost"
              disabled={marking || rows.length === 0}
              onClick={markAllSeen}
            >
              Mark all seen
            </Button>
          </div>
          {rows.length > 0 ? (
            <ul
              aria-label="Unread pull requests"
              className="-mx-2 flex max-h-96 flex-col overflow-y-auto"
            >
              {rows.map((pr) => (
                <li key={pr.key}>
                  <button
                    type="button"
                    className="flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                    onClick={() => {
                      setOpen(false);
                      onOpen(pr.key);
                    }}
                  >
                    <span className="truncate text-sm font-medium text-foreground">{pr.title}</span>
                    <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                      <span className="truncate font-mono">
                        {pr.repository.nameWithOwner}#{pr.number}
                      </span>
                      <span className="shrink-0 text-foreground">· {prChangesText(pr, 3)}</span>
                      <span className="ms-auto shrink-0 tabular-nums">
                        {formatRelativeTimeLabel(pr.updatedAt, now)}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p role="status" className="text-xs text-muted-foreground">
              {query.isError
                ? "The activity could not be loaded."
                : query.isPending && query.fetchStatus !== "idle"
                  ? "Loading activity…"
                  : "Nothing new since you last looked."}
            </p>
          )}
          {unread > rows.length && rows.length > 0 ? (
            <p className="text-xs text-muted-foreground">
              Showing the {rows.length} most recent of {unread}.
            </p>
          ) : null}
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
