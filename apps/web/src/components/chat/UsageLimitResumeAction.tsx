import type { OrchestrationUsageLimit, ThreadId } from "@t3tools/contracts";
import { useEffect, useState } from "react";
import { ensureNativeApi } from "../../nativeApi";
import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { useNextTurnQueueStore } from "../../nextTurnQueueStore";
import { SnoozePresetPicker } from "../SnoozePresetPicker";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";

export function usageLimitFailureKey(limit: OrchestrationUsageLimit): string | null {
  if (limit.turnId) return `instance:${limit.providerInstanceId}:turn:${limit.turnId}`;
  if (limit.deliveryId) return `instance:${limit.providerInstanceId}:delivery:${limit.deliveryId}`;
  return null;
}

export function formatUsageResumeTime(value: string, now = new Date()): string {
  const date = new Date(value);
  const today = date.toDateString() === now.toDateString();
  return date.toLocaleString(undefined, {
    ...(today ? {} : { weekday: "short", month: "short", day: "numeric" }),
    hour: "numeric",
    minute: "2-digit",
  });
}

export function UsageLimitResumeAction({
  threadId,
  limit,
}: {
  readonly threadId: ThreadId;
  readonly limit: OrchestrationUsageLimit;
}) {
  const snapshot = useNextTurnQueueStore((state) => state.byThreadId[threadId]?.snapshot ?? null);
  const applySnapshot = useNextTurnQueueStore((state) => state.applySnapshot);
  const automatic = useSettings((settings) => settings.autoResumeUsageLimitedThreads);
  const { updateSettings } = useUpdateSettings();
  const [busy, setBusy] = useState(false);
  const [picker, setPicker] = useState(false);
  const [target, setTarget] = useState(() => new Date(Date.now() + 3_600_000).toISOString());
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
  const resetTime = limit.resetsAt ? formatUsageResumeTime(limit.resetsAt) : null;
  const labels = limit.windows
    .map((window) => window.label)
    .filter(Boolean)
    .join(", ");
  const scheduled = item?.status === "queued";
  const sending = item?.status === "dispatching";

  return (
    <div className="mt-2 space-y-2 text-xs">
      <p>
        {labels ? `${labels} · ` : ""}
        {resetTime ? `Resets ${resetTime}` : "Reset time unavailable"}
      </p>
      {limit.deliveryId ? (
        snapshot?.items.some(
          (candidate) =>
            candidate.scheduleReason === "usage_limit_reset" && candidate.status === "failed",
        ) ? (
          <p>
            Scheduled continue was rejected before starting. Retry the queued turn after the reset.
          </p>
        ) : null
      ) : (
        <>
          {ledger?.state === "cancelled" ? <p>Scheduled continue cancelled.</p> : null}
          <div className="flex flex-wrap items-center gap-2">
            {sending ? (
              <span>Sending…</span>
            ) : scheduled ? (
              <>
                <span>
                  Continue scheduled for{" "}
                  {formatUsageResumeTime(item.notBefore ?? limit.resetsAt ?? target)}
                </span>
                <Button
                  size="xs"
                  variant="outline"
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
                  Send now
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
                  Cancel
                </Button>
              </>
            ) : item?.status === "failed" ? (
              <span>Continue could not be sent. Review the queued turn.</span>
            ) : ledger?.state === "completed" || (ledger?.state === "scheduled" && !item) ? (
              <span>Continued</span>
            ) : (
              <>
                {resetTime ? (
                  <Button size="xs" disabled={busy || !limitKey} onClick={() => void schedule()}>
                    Continue at{" "}
                    {formatUsageResumeTime(
                      new Date(
                        Math.max(Date.now(), Date.parse(limit.resetsAt!)) + 60_000,
                      ).toISOString(),
                    )}
                  </Button>
                ) : null}
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
                  Refresh
                </Button>
              </>
            )}
            {!sending ? (
              <Button
                size="xs"
                variant="ghost"
                disabled={busy || !limitKey}
                onClick={() => setPicker(!picker)}
              >
                {resetTime ? "Pick another time…" : "Schedule continue…"}
              </Button>
            ) : null}
          </div>
          {picker ? (
            <div className="max-w-sm space-y-2">
              <SnoozePresetPicker value={target} onChange={setTarget} />
              <Button size="xs" disabled={busy} onClick={() => void schedule(target)}>
                Schedule continue
              </Button>
            </div>
          ) : null}
          {snapshot?.paused ? (
            <p>The queue must be resumed before this continue can send.</p>
          ) : null}
          {ledger?.state === "gave_up" ? (
            <p>
              Automatic continue stopped after repeated usage-limit failures. You can schedule
              another continue manually.
            </p>
          ) : null}
          <details>
            <summary className="cursor-pointer">Options</summary>
            <label className="mt-2 flex items-center gap-2">
              <input
                type="checkbox"
                checked={automatic}
                disabled={busy}
                onChange={(event) => {
                  const checked = event.currentTarget.checked;
                  void run(() =>
                    updateSettings({ autoResumeUsageLimitedThreads: checked }).then(() => {}),
                  );
                }}
              />
              Always continue automatically
            </label>
          </details>
          <p className="text-muted-foreground">
            F5 must be running at reset time; otherwise it continues when F5 starts again.
          </p>
        </>
      )}
    </div>
  );
}
