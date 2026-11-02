import { useCallback, type MouseEvent } from "react";

import { toastManager } from "../components/ui/toast";
import {
  type ExternalLinkContextMenuFailure,
  isExternalWebLink,
  showExternalLinkContextMenu,
} from "../lib/externalLinkContextMenu";
import * as nativeApi from "../nativeApi";
import { writeTextToClipboard } from "./useCopyToClipboard";
import { useCanOpenLinkInPreview, useOpenLink } from "./useOpenLink";

function reportFailure(failure: ExternalLinkContextMenuFailure, cause: unknown): void {
  if (failure === "copy-link") {
    toastManager.add({
      type: "error",
      title: "Could not copy link",
      description:
        cause instanceof Error ? cause.message : "An unexpected clipboard error occurred.",
    });
    return;
  }
  toastManager.add({
    type: "error",
    title:
      failure === "show-link-context-menu"
        ? "Could not show the link menu. Retry."
        : "Could not open link. Retry.",
  });
}

/** Returns a contextmenu handler that offers the open actions and Copy Link for a web link. */
export function useExternalLinkContextMenu(): (
  event: MouseEvent<HTMLElement>,
  href: string | undefined,
) => void {
  const openLink = useOpenLink();
  const canOpenInPreview = useCanOpenLinkInPreview();
  return useCallback(
    (event, href) => {
      // The browser's own link menu already offers these; the desktop shell's does not.
      const api = window.desktopBridge ? nativeApi.readNativeApi() : undefined;
      if (!api || !isExternalWebLink(href)) return;
      event.preventDefault();
      event.stopPropagation();
      void showExternalLinkContextMenu({
        href,
        position: { x: event.clientX, y: event.clientY },
        canOpenInPreview,
        showContextMenu: (items, position) => api.contextMenu.show(items, position),
        openInPreview: (target) => openLink(target, { preview: true }),
        openExternal: (target) => openLink(target, { external: true }),
        copyLink: writeTextToClipboard,
        onFailure: reportFailure,
      });
    },
    [canOpenInPreview, openLink],
  );
}
