import type { ContextMenuItem, ThreadId } from "@t3tools/contracts";
import { useCallback, useRef, useState } from "react";

import { showContextMenuFallback } from "../../contextMenuFallback";
import { isElectron } from "../../env";
import { toastManager } from "../ui/toast";
import {
  canCopyImageToClipboard,
  copyImageAttachment,
  downloadImageAttachment,
  type ImageAttachmentActionItem,
} from "./imageAttachmentActions";

export type ImageAttachmentAction = "copy" | "download";

function imageActionMenuItems(
  canCopyImage: boolean,
): ReadonlyArray<ContextMenuItem<ImageAttachmentAction>> {
  return [
    ...(canCopyImage ? ([{ id: "copy", label: "Copy image" }] as const) : []),
    { id: "download", label: "Download image" },
  ];
}

function actionFailureDescription(error: unknown): string {
  return error instanceof Error ? error.message : "An unexpected image action error occurred.";
}

export function useImageAttachmentActions(threadId: ThreadId): {
  canCopyImage: boolean;
  usesCustomImageContextMenu: boolean;
  pendingAction: ImageAttachmentAction | null;
  runImageAction: (action: ImageAttachmentAction, item: ImageAttachmentActionItem) => Promise<void>;
  showImageActionMenu: (
    item: ImageAttachmentActionItem,
    position: { x: number; y: number },
  ) => Promise<void>;
} {
  const [pendingAction, setPendingAction] = useState<ImageAttachmentAction | null>(null);
  const pendingActionRef = useRef<ImageAttachmentAction | null>(null);
  const canCopyImage = canCopyImageToClipboard();
  const usesCustomImageContextMenu = isElectron;

  const runImageAction = useCallback(
    async (action: ImageAttachmentAction, item: ImageAttachmentActionItem) => {
      if (pendingActionRef.current) {
        return;
      }
      pendingActionRef.current = action;
      setPendingAction(action);
      try {
        if (action === "copy") {
          await copyImageAttachment(item);
          toastManager.add({
            type: "success",
            title: "Image copied",
            data: { threadId },
          });
        } else {
          await downloadImageAttachment(item);
          toastManager.add({
            type: "success",
            title: "Image download started",
            data: { threadId },
          });
        }
      } catch (error) {
        toastManager.add({
          type: "error",
          title: action === "copy" ? "Could not copy image" : "Could not download image",
          description: actionFailureDescription(error),
          data: { threadId },
        });
      } finally {
        pendingActionRef.current = null;
        setPendingAction(null);
      }
    },
    [threadId],
  );

  const showImageActionMenu = useCallback(
    async (item: ImageAttachmentActionItem, position: { x: number; y: number }) => {
      if (!usesCustomImageContextMenu || pendingActionRef.current) {
        return;
      }
      try {
        // Use a renderer-owned menu in Electron so selecting Copy remains in
        // the same user-activation task as navigator.clipboard.write(). The
        // regular browser build keeps its native image context menu.
        const action = await showContextMenuFallback(imageActionMenuItems(canCopyImage), position);
        if (action) {
          await runImageAction(action, item);
        }
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Could not open image actions",
          description: actionFailureDescription(error),
          data: { threadId },
        });
      }
    },
    [canCopyImage, runImageAction, threadId, usesCustomImageContextMenu],
  );

  return {
    canCopyImage,
    usesCustomImageContextMenu,
    pendingAction,
    runImageAction,
    showImageActionMenu,
  };
}
