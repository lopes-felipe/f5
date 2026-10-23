import { useState } from "react";
import type { ThreadId } from "@t3tools/contracts";
import { useStore } from "../../store";
import { selectThreadById } from "../../threadSelectors";
import { ensureNativeApi } from "../../nativeApi";
import { newCommandId } from "../../lib/utils";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";

export function ThreadSettlementControl({ threadId }: { threadId: ThreadId }) {
  const settled = useStore((state) => selectThreadById(state, threadId)?.settledAt ?? null);
  const [busy, setBusy] = useState(false);
  if (!settled) return null;
  const unsettle = () => {
    setBusy(true);
    void ensureNativeApi()
      .orchestration.dispatchCommand({
        type: "thread.unsettle",
        threadId,
        commandId: newCommandId(),
        createdAt: new Date().toISOString(),
      })
      .catch(() => toastManager.add({ type: "error", title: "Could not update thread settlement" }))
      .finally(() => setBusy(false));
  };
  return (
    <Button variant="outline" size="xs" disabled={busy} onClick={unsettle}>
      Unsettle
    </Button>
  );
}
