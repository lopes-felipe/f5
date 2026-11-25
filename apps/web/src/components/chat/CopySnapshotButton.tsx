import type { ThreadId } from "@t3tools/contracts";
import { CopyIcon } from "lucide-react";
import { Button } from "../ui/button";
import type { ImageAttachmentActionItem } from "./imageAttachmentActions";
import { useImageAttachmentActions } from "./useImageAttachmentActions";

export function CopySnapshotButton({
  item,
  threadId,
  className,
}: {
  item: ImageAttachmentActionItem;
  threadId: ThreadId;
  className: string;
}) {
  const { canCopyImage, pendingAction, runImageAction } = useImageAttachmentActions(threadId);
  if (!canCopyImage) return null;
  return (
    <Button
      type="button"
      size="icon-xs"
      variant="outline"
      className={className}
      aria-label="Copy Snap Shot"
      title="Copy Snap Shot"
      disabled={pendingAction !== null}
      onClick={() => void runImageAction("copy", item)}
    >
      <CopyIcon />
    </Button>
  );
}
