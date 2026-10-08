import type { OrchestrationUsageLimit, ThreadId } from "@t3tools/contracts";
import { usageLimitFailureKey } from "@t3tools/shared/usageLimit";
export { usageLimitFailureKey } from "@t3tools/shared/usageLimit";
import { ChevronDownIcon, EllipsisIcon, InfoIcon, PauseIcon, XIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { ensureNativeApi } from "../../nativeApi";
import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { formatTimeUntil, formatUsageResumeTime } from "../../lib/usageLimits";
import { useNextTurnQueueStore } from "../../nextTurnQueueStore";
import { SnoozePresetPicker } from "../SnoozePresetPicker";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import { Menu, MenuCheckboxItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** Re-renders every 30s until the reset passes so the countdown stays current. */
function useCountdown(resetsAt: string | null): string | null {
  const [nowMs, setNowMs] = useState(() => Date.now());
  const deadline = resetsAt ? Date.parse(resetsAt) : Number.NaN;
  useEffect(() => {
    if (!Number.isFinite(deadline) || deadline <= Date.now()) return;
    const interval = window.setInterval(() => {
      const now = Date.now();
      setNowMs(now);
      if (now >= deadline) window.clearInterval(interval);
    }, 30_000);
    return () => window.clearInterval(interval);
  }, [deadline]);
  return resetsAt ? formatTimeUntil(resetsAt, nowMs) : null;
}

export function UsageLimitNotice({
  threadId,
  limit,
  providerLabel,
  onDismiss,
}: {
  readonly threadId: ThreadId;
  readonly limit: OrchestrationUsageLimit;
  readonly providerLabel: string;
  readonly onDismiss: () => void;
}) {
  const snapshot = useNextTurnQueueStore((state) => state.byThreadId[threadId]?.snapshot ?? null);
  const applySnapshot = useNextTurnQueueStore((state) => state.applySnapshot);
  const automatic = useSettings((settings) => settings.autoResumeUsageLimitedThreads);
  const { updateSettings } = useUpdateSettings();
  const [busy, setBusy] = useState(false);
  const [picker, setPicker] = useState(false);
  const [target, setTarget] = useState(() => new Date(Date.now() + 3_600_000).toISOString());
  const countdown = useCountdown(limit.resetsAt);
  const limitKey = usageLimitFailureKey(limit);
  const ledger =
    snapshot?.usageLimitResume?.limitKey === limitKey ? snapshot.usageLimitResume : null;
  const item = ledger
    ? snapshot?.items.find(
        (candidate) =>
          candidate.itemId === ledger.itemId && candidate.scheduleReason === "usage_limit_reset",
      )
    : undefined;

  useEffect(() => {
    let disposed = false;
    void ensureNativeApi()
      .nextTurnQueue.list({ threadId })
      .then((next) => {
        if (!disposed) applySnapshot(next);
      })
      .catch(() => {});
    return () => {
      disposed = true;
    };
  }, [threadId, applySnapshot]);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not update scheduled continue",
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(false);
    }
  };
  const schedule = (notBefore?: string) =>
    run(async () => {
      if (!limitKey) throw new Error("This failure has not been correlated to a turn yet.");
      applySnapshot(
        await ensureNativeApi().nextTurnQueue.scheduleUsageLimitResume({
          threadId,
          expectedLimitKey: limitKey,
          ...(notBefore ? { notBefore } : {}),
        }),
      );
      setPicker(false);
    });
  const togglePicker = () => {
    if (!picker) setTarget(new Date(Date.now() + 3_600_000).toISOString());
    setPicker(!picker);
  };

  const resetTime = limit.resetsAt ? formatUsageResumeTime(limit.resetsAt) : null;
  const labels = limit.windows
    .map((window) => window.label)
    .filter(Boolean)
    .join(", ");
  const scheduled = item?.status === "queued";
  const sending = item?.status === "dispatching";
  const failed = item?.status === "failed";
  const continued = ledger?.state === "completed" || (ledger?.state === "scheduled" && !item);
  const delivered = limit.deliveryId !== null;

  if (!delivered && !sending && !scheduled && !failed && continued) return null;

  const scheduledTime = scheduled
    ? formatUsageResumeTime(item.notBefore ?? limit.resetsAt ?? target)
    : null;
  const rejectedBeforeStart =
    delivered &&
    snapshot?.items.some(
      (candidate) =>
        candidate.scheduleReason === "usage_limit_reset" && candidate.status === "failed",
    );
  const problem = delivered
    ? null
    : failed
      ? "Continue could not be sent. Review the queued turn."
      : scheduled && snapshot?.paused
        ? "Resume the queue so this can send."
        : !scheduled && ledger?.state === "gave_up"
          ? "Automatic continue stopped after repeated limit errors."
          : null;
  const showControls = !delivered && !sending;

  return (
    <Alert variant="warning">
      <PauseIcon />
      <AlertTitle className="text-foreground">
        Paused: {providerLabel} {labels ? `${labels} ` : "usage "}limit
      </AlertTitle>
      <AlertDescription className="min-w-0 gap-0 text-xs">
        {sending ? (
          <p className="text-foreground">Continuing…</p>
        ) : resetTime ? (
          <p className="text-foreground">
            Resets {resetTime}
            {countdown ? <span className="text-muted-foreground"> · {countdown}</span> : null}
          </p>
        ) : (
          <p>{providerLabel} didn&apos;t say when the limit resets</p>
        )}
        {scheduledTime ? (
          <p className="flex items-center gap-1 text-foreground">
            Continues automatically at {scheduledTime}
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    aria-label="About automatic continue"
                    className="inline-flex text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                  />
                }
              >
                <InfoIcon className="size-3.5" aria-hidden="true" />
              </TooltipTrigger>
              <TooltipPopup side="top">
                F5 has to be running at {scheduledTime}. If it isn&apos;t, the thread continues the
                next time F5 starts.
              </TooltipPopup>
            </Tooltip>
          </p>
        ) : null}
        {rejectedBeforeStart ? (
          <p className="mt-1 text-warning">
            Scheduled continue was rejected before starting. Retry the queued turn after the reset.
          </p>
        ) : null}
        {problem ? <p className="mt-1 text-warning">{problem}</p> : null}
        {showControls ? (
          <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
            {scheduled ? (
              <>
                <Button
                  size="xs"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      applySnapshot(
                        await ensureNativeApi().nextTurnQueue.promote({
                          itemId: item.itemId,
                          interruptActive: false,
                          expectedRevision: snapshot!.revision,
                        }),
                      );
                    })
                  }
                >
                  Continue now
                </Button>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={busy || !limitKey}
                  aria-expanded={picker}
                  onClick={togglePicker}
                >
                  Change time
                  <ChevronDownIcon aria-hidden="true" />
                </Button>
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      const result = await ensureNativeApi().nextTurnQueue.cancelUsageLimitResume({
                        threadId,
                        itemId: item.itemId,
                        expectedRevision: snapshot!.revision,
                      });
                      if (result.kind === "already_sending")
                        throw new Error(
                          "This continue is already sending. Use the normal interrupt action.",
                        );
                      applySnapshot(result.snapshot);
                    })
                  }
                >
                  Don&apos;t continue
                </Button>
              </>
            ) : failed ? (
              <Button
                size="xs"
                variant="outline"
                disabled={busy || !limitKey}
                onClick={togglePicker}
              >
                Pick time…
              </Button>
            ) : resetTime ? (
              <>
                <Button size="xs" disabled={busy || !limitKey} onClick={() => void schedule()}>
                  Continue at{" "}
                  {formatUsageResumeTime(
                    new Date(
                      Math.max(Date.now(), Date.parse(limit.resetsAt!)) + 60_000,
                    ).toISOString(),
                  )}
                </Button>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={busy || !limitKey}
                  onClick={togglePicker}
                >
                  Pick time…
                </Button>
              </>
            ) : (
              <>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={busy || !limitKey}
                  onClick={() =>
                    void run(async () => {
                      applySnapshot(
                        await ensureNativeApi().nextTurnQueue.refreshUsageLimitResume({
                          threadId,
                          expectedLimitKey: limitKey!,
                        }),
                      );
                    })
                  }
                >
                  Check again
                </Button>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={busy || !limitKey}
                  onClick={togglePicker}
                >
                  Schedule continue…
                </Button>
              </>
            )}
          </div>
        ) : null}
        {showControls && picker ? (
          <div className="mt-2 max-w-sm space-y-2">
            <SnoozePresetPicker value={target} onChange={setTarget} />
            <Button size="xs" disabled={busy} onClick={() => void schedule(target)}>
              Schedule continue
            </Button>
          </div>
        ) : null}
      </AlertDescription>
      <AlertAction className="sm:self-start">
        {showControls ? (
          <Menu>
            <MenuTrigger
              render={
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost"
                  aria-label="Usage limit options"
                  className="text-muted-foreground"
                />
              }
            >
              <EllipsisIcon aria-hidden="true" />
            </MenuTrigger>
            <MenuPopup side="bottom" align="end">
              <MenuCheckboxItem
                checked={automatic}
                disabled={busy}
                onCheckedChange={(checked) =>
                  void run(() =>
                    updateSettings({ autoResumeUsageLimitedThreads: checked }).then(() => {}),
                  )
                }
              >
                Always continue automatically
              </MenuCheckboxItem>
              <p className="max-w-64 px-2 pb-1 ps-8 text-xs text-muted-foreground">
                Global default. Project settings can override it.
              </p>
            </MenuPopup>
          </Menu>
        ) : null}
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          aria-label="Dismiss usage limit notice"
          className="text-muted-foreground"
          onClick={onDismiss}
        >
          <XIcon aria-hidden="true" />
        </Button>
      </AlertAction>
    </Alert>
  );
}
