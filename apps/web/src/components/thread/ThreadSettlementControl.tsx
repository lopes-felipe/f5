import { useState } from "react";
import type { ThreadId } from "@t3tools/contracts";
import { useStore } from "../../store";
import { selectThreadById } from "../../threadSelectors";
import { ensureNativeApi } from "../../nativeApi";
import { newCommandId } from "../../lib/utils";
import { Switch } from "../ui/switch";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";

export function ThreadSettlementControl({ threadId }: { threadId: ThreadId }) {
  const disabled = useStore(
    (state) => selectThreadById(state, threadId)?.autoSettleDisabled ?? false,
  );
  const settled = useStore((state) => selectThreadById(state, threadId)?.settledAt ?? null);
  const [busy, setBusy] = useState(false);
  const run = (enabled?: boolean) => {
    setBusy(true);
    const base = { threadId, commandId: newCommandId(), createdAt: new Date().toISOString() };
    void ensureNativeApi()
      .orchestration.dispatchCommand(
        enabled === undefined
          ? { ...base, type: "thread.unsettle" }
          : { ...base, type: "thread.auto-settle.set", enabled },
      )
      .catch(() => toastManager.add({ type: "error", title: "Could not update thread settlement" }))
      .finally(() => setBusy(false));
  };
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
      {settled ? (
        <Button variant="outline" size="xs" disabled={busy} onClick={() => run()}>
          Unsettle
        </Button>
      ) : null}
      <label
        className="inline-flex items-center gap-1.5"
        title="Allow this thread to follow the project's automatic settlement rules. Those rules are off by default."
      >
        <span>Auto-settle</span>
        <Switch
          aria-label="Auto-settle this thread"
          checked={!disabled}
          disabled={busy}
          onCheckedChange={(enabled) => run(enabled)}
        />
      </label>
    </span>
  );
}
