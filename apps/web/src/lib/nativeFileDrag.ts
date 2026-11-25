import type { DragEvent } from "react";
import { toastManager } from "../components/ui/toast";

export function nativeFileDrag(path: string | undefined, resolve?: () => Promise<string>) {
  if (
    typeof window === "undefined" ||
    !path?.startsWith("/") ||
    !window.desktopBridge?.startFileDrag ||
    !/Mac/i.test(navigator.platform)
  ) {
    return {};
  }
  return {
    draggable: true,
    onDragStart(event: DragEvent<HTMLElement>) {
      const start = window.desktopBridge?.startFileDrag;
      if (!start) return;
      event.preventDefault();
      event.stopPropagation();
      void (resolve ? resolve().then(start) : start(path))
        .then((started) => {
          if (!started) throw new Error("The file is unavailable for drag on this Mac.");
        })
        .catch((error: unknown) =>
          toastManager.add({
            type: "error",
            title: "Unable to drag file",
            description: error instanceof Error ? error.message : undefined,
          }),
        );
    },
  };
}
