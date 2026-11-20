import { useState } from "react";
import { useShallow } from "zustand/react/shallow";
import type { ThreadId } from "@t3tools/contracts";
import { useStore } from "../../../store";
import { openNewSideChat } from "../../../lib/sideChats";
import { useRightPanelStore } from "../../../rightPanelStore";
import { MenuItem, MenuSeparator } from "../../ui/menu";
import { toastManager } from "../../ui/toast";

export function SideChatMenuItems({ threadId }: { threadId: ThreadId }) {
  const [busy, setBusy] = useState(false);
  const parent = useStore((state) => state.threads.find((thread) => thread.id === threadId));
  const children = useStore(
    useShallow((state) => state.threads.filter((thread) => thread.sideChatOf === threadId)),
  );
  if (!parent || parent.sideChatOf) return null;
  return (
    <>
      <MenuSeparator />
      <MenuItem
        disabled={busy || !parent.session?.capabilities}
        onClick={() => {
          setBusy(true);
          void openNewSideChat(threadId)
            .catch((cause) =>
              toastManager.add({
                type: "error",
                title: "Side chat could not open",
                description: String(cause),
              }),
            )
            .finally(() => setBusy(false));
        }}
      >
        {busy ? "Opening side chat…" : "New side chat"}
      </MenuItem>
      {children.slice(-20).map((child) => (
        <MenuItem
          key={child.id}
          onClick={() =>
            useRightPanelStore.getState().openSideChat(threadId, child.id, child.title)
          }
        >
          {child.title}
        </MenuItem>
      ))}
    </>
  );
}
