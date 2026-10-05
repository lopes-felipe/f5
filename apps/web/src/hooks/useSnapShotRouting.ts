import { setAttachmentSource } from "../lib/attachmentUploadQueue";
import { useEffect, useRef } from "react";
import { useParams } from "@tanstack/react-router";
import { ThreadId, type DesktopSnapShotResult } from "@t3tools/contracts";
import { useComposerDraftStore } from "../composerDraftStore";
import { useAppSettings } from "../appSettings";
import { toastManager } from "../components/ui/toast";
/** One renderer-level subscription survives navigation into settings. */
export function useSnapShotRouting() {
  const params = useParams({ strict: false }) as { threadId?: string };
  const { settings } = useAppSettings();
  const lastThread = useRef<ThreadId | undefined>(undefined),
    pending = useRef<DesktopSnapShotResult[]>([]);
  const attach = (thread: ThreadId, result: DesktopSnapShotResult) => {
    const files = [result.image, result.context].map((value) =>
      setAttachmentSource(
        new File([new Uint8Array(value.bytes)], value.name, { type: value.mimeType }),
        "snapshot",
      ),
    );
    void useComposerDraftStore
      .getState()
      .importImages(thread, files)
      .then((result) => {
        for (const failure of result.failures)
          toastManager.add({ type: "error", title: failure.message });
      })
      .catch(() =>
        toastManager.add({ type: "error", title: "Capture could not be attached. Retry." }),
      );
  };
  useEffect(() => {
    if (!params.threadId) return;
    lastThread.current = ThreadId.makeUnsafe(params.threadId);
    for (const result of pending.current.splice(0)) attach(lastThread.current, result);
  }, [params.threadId]);
  useEffect(
    () =>
      window.desktopBridge?.snapShot?.onCapture((result) => {
        if (lastThread.current) {
          attach(lastThread.current, result);
          return;
        }
        if (pending.current.length >= 3) {
          toastManager.add({
            type: "warning",
            title: "Open a thread before capturing more windows.",
          });
          return;
        }
        pending.current.push(result);
        toastManager.add({ type: "info", title: "Capture ready. Open a thread to attach it." });
      }),
    [],
  );
  useEffect(() => {
    const bridge = window.desktopBridge?.snapShot;
    if (!bridge) return;
    void bridge
      .permissions()
      .then((p) =>
        p.supported
          ? bridge.configure(settings.snapShotShortcut, settings.snapShotEnabled)
          : undefined,
      )
      .catch((error) =>
        toastManager.add({
          type: "error",
          title: "Capture shortcut unavailable",
          description:
            error instanceof Error ? error.message : "Choose another shortcut in settings.",
        }),
      );
  }, [settings.snapShotShortcut, settings.snapShotEnabled]);
}
