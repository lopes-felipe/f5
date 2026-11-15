import { useState } from "react";
import {
  AlarmClockIcon,
  CheckCheckIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  EyeOffIcon,
  GitMergeIcon,
  XIcon,
} from "lucide-react";
import type { PrHubBulkUpdateInput, PullRequestKey, TrackedPullRequest } from "@t3tools/contracts";

import { useAppSettingsSelector } from "../../appSettings";
import { useSettings } from "../../hooks/useSettings";
import { getPrHubSelectedAccountId } from "../../lib/prHubAccount";
import { ensureNativeApi } from "../../nativeApi";
import { SnoozePresetPicker } from "../SnoozePresetPicker";
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
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";
import { defaultSnoozeUntil } from "./prHubPresentation";
import {
  prBulkMergePlan,
  prSeenFingerprints,
  runPrBulkMerge,
  type PrBulkMergeItem,
  type PrBulkMergePlan,
  type PrBulkMergeResult,
} from "./prQueueSelection";

const plural = (count: number) => `${count} pull request${count === 1 ? "" : "s"}`;

function MergeRow({
  item,
  result,
}: {
  item: PrBulkMergeItem;
  result: PrBulkMergeResult | undefined;
}) {
  const { pr } = item;
  const problem =
    result?.state === "failed" || result?.state === "skipped" ? result.message : item.blocked;
  return (
    <li className="flex items-start gap-2 border-b border-border py-2 last:border-b-0">
      <span className="mt-0.5 shrink-0">
        {result?.state === "running" ? (
          <Spinner className="size-3.5" />
        ) : result?.state === "merged" ? (
          <CircleCheckIcon aria-hidden="true" className="size-3.5 text-success-foreground" />
        ) : problem ? (
          <CircleAlertIcon aria-hidden="true" className="size-3.5 text-warning-foreground" />
        ) : (
          <CircleDashedIcon aria-hidden="true" className="size-3.5 text-muted-foreground" />
        )}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-sm text-foreground">{pr.title}</span>
        <span className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
          <span className="font-mono">
            {pr.repository.nameWithOwner}#{pr.number}
          </span>
          {pr.headRefOid ? <span className="font-mono">· {pr.headRefOid.slice(0, 7)}</span> : null}
          {item.method ? <span>· {item.method}</span> : null}
        </span>
        {result?.state === "merged" ? (
          <span className="text-xs text-success-foreground">
            Merged{result.warning ? `. ${result.warning}` : ""}
          </span>
        ) : problem ? (
          <span className="text-xs text-warning-foreground">
            {result?.state === "failed" ? "Not merged. " : "Skipped. "}
            {problem}
          </span>
        ) : null}
      </span>
    </li>
  );
}

/**
 * One confirmation for every ready pull request of the selection, then one merge at a time.
 * The plan is the one made when the dialog opened: a merged pull request leaves the queue
 * and the selection, and must stay in this list with its result.
 */
export function PrBulkMergeDialog({
  plan,
  onClose,
}: {
  plan: PrBulkMergePlan;
  onClose: (merged: number) => void;
}) {
  const { items, overLimit } = plan;
  const [results, setResults] = useState<ReadonlyMap<PullRequestKey, PrBulkMergeResult>>(
    () => new Map(),
  );
  const [phase, setPhase] = useState<"confirm" | "running" | "done">("confirm");
  const mergeable = items.filter((item) => !item.blocked);
  const merged = [...results.values()].filter((result) => result.state === "merged").length;
  const run = () => {
    setPhase("running");
    void runPrBulkMerge(items, ensureNativeApi().prHub, (key, result) =>
      setResults((current) => new Map(current).set(key, result)),
    ).finally(() => setPhase("done"));
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        // A run in progress finishes its current merge either way; keep its report open.
        if (!open && phase !== "running") onClose(merged);
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>
            {phase === "done"
              ? `Merged ${merged} of ${items.length}`
              : `Merge ${plural(mergeable.length)}`}
          </DialogTitle>
          <DialogDescription>
            {phase === "done"
              ? "Pull requests that were not merged are unchanged."
              : "Each one is merged at the commit listed here, with the method shown. If one fails, the others still run."}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <ul aria-label="Pull requests to merge" className="flex flex-col">
            {items.map((item) => (
              <MergeRow key={item.pr.key} item={item} result={results.get(item.pr.key)} />
            ))}
          </ul>
          {overLimit > 0 ? (
            <p className="mt-2 text-xs text-muted-foreground">
              {plural(overLimit)} more in the selection {overLimit === 1 ? "is" : "are"} ready.
              Merge those in a second pass.
            </p>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          {phase === "done" ? (
            <Button onClick={() => onClose(merged)}>Done</Button>
          ) : (
            <>
              <Button variant="outline" disabled={phase === "running"} onClick={() => onClose(0)}>
                Cancel
              </Button>
              <Button disabled={phase === "running" || mergeable.length === 0} onClick={run}>
                {phase === "running" ? "Merging…" : `Merge ${plural(mergeable.length)}`}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

/**
 * Actions for the ticked rows, shown at the bottom of the queue while any row is ticked.
 * Snooze, Ignore and Mark seen are one request for the whole selection.
 */
export function PrQueueBulkBar({
  selected,
  onClear,
  onMerge,
}: {
  /** The ticked rows, in the order they are on screen. */
  selected: readonly TrackedPullRequest[];
  onClear: () => void;
  /** Opens the merge confirmation for this plan; its owner keeps it open through the run. */
  onMerge: (plan: PrBulkMergePlan) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [snoozing, setSnoozing] = useState(false);
  const [snoozeUntil, setSnoozeUntil] = useState(defaultSnoozeUntil);
  const configured = useSettings((settings) => settings.prHubDefaultMergeMethod);
  const lastUsed = useAppSettingsSelector((settings) => settings.prHubLastMergeMethods);
  const plan = prBulkMergePlan(selected, { configured, lastUsed });
  const count = selected.length;

  const update = (
    action: PrHubBulkUpdateInput["action"],
    done: (updated: number) => string,
    until?: string,
  ) => {
    if (busy || count === 0) return;
    setBusy(true);
    void ensureNativeApi()
      .prHub.bulkUpdate({
        keys: selected.map((pr) => pr.key),
        action,
        accountId: getPrHubSelectedAccountId(),
        ...(until ? { until } : {}),
        // Marking seen covers what these rows show now, not what arrives meanwhile.
        ...(action === "mark_seen" ? { seenFingerprints: prSeenFingerprints(selected) } : {}),
      })
      .then(({ updated }) => {
        toastManager.add(
          updated > 0
            ? { type: "success", title: done(updated) }
            : { type: "info", title: "Nothing changed" },
        );
        onClear();
      })
      .catch((error: unknown) =>
        toastManager.add({
          type: "error",
          title: "Could not update the selected pull requests",
          description: error instanceof Error ? error.message : String(error),
        }),
      )
      .finally(() => setBusy(false));
  };

  return (
    <div
      role="toolbar"
      aria-label="Selected pull requests"
      className="flex shrink-0 flex-wrap items-center gap-2 border-t border-border bg-muted/40 px-4 py-2"
    >
      <span role="status" className="me-2 text-xs font-medium text-foreground tabular-nums">
        {count} selected
      </span>
      <Popover
        open={snoozing}
        onOpenChange={(open) => {
          if (open) setSnoozeUntil(defaultSnoozeUntil());
          setSnoozing(open);
        }}
      >
        <PopoverTrigger render={<Button size="xs" variant="outline" disabled={busy} />}>
          <AlarmClockIcon /> Snooze
        </PopoverTrigger>
        <PopoverPopup align="start" side="top" className="w-80">
          <div className="flex flex-col gap-3">
            <PopoverTitle className="text-sm">Snooze {plural(count)}</PopoverTitle>
            <SnoozePresetPicker value={snoozeUntil} onChange={setSnoozeUntil} />
            <Button
              size="sm"
              className="self-end"
              disabled={busy || !(Date.parse(snoozeUntil) > Date.now())}
              onClick={() => {
                setSnoozing(false);
                update(
                  "snooze",
                  (updated) => `Snoozed ${plural(updated)}`,
                  new Date(snoozeUntil).toISOString(),
                );
              }}
            >
              Snooze
            </Button>
          </div>
        </PopoverPopup>
      </Popover>
      <Button
        size="xs"
        variant="outline"
        disabled={busy}
        title="Ignored pull requests are listed under Ignored, where you can restore them"
        onClick={() => update("ignore", (updated) => `Ignored ${plural(updated)}`)}
      >
        <EyeOffIcon /> Ignore
      </Button>
      <Button
        size="xs"
        variant="outline"
        disabled={busy}
        onClick={() => update("mark_seen", (updated) => `Marked ${plural(updated)} as seen`)}
      >
        <CheckCheckIcon /> Mark seen
      </Button>
      {plan.items.length > 0 ? (
        <Button size="xs" variant="outline" disabled={busy} onClick={() => onMerge(plan)}>
          <GitMergeIcon /> Merge ready ({plan.items.length})
        </Button>
      ) : null}
      <Button size="xs" variant="ghost" className="ms-auto" onClick={onClear}>
        <XIcon /> Clear
      </Button>
    </div>
  );
}
