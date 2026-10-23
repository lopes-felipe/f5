import { HTML_RENDER_MAX_PAGE_BYTES } from "@t3tools/contracts";
import { getServerHttpOrigin } from "../lib/serverHttpOrigin";
import { readBoundedResponseText } from "../lib/readBoundedResponseText";
import { useEffect } from "react";
import { readNativeApi } from "../nativeApi";
import { onServerWelcome } from "../wsNativeApi";

/** Only desktop app renderers can fulfill offscreen preview requests. */
export function HtmlPreviewHost() {
  useEffect(() => {
    const render = window.desktopBridge?.htmlPreview;
    const api = readNativeApi()?.htmlRender;
    if (!render || !api) return;
    let disposed = false;
    const requests = new Map<string, AbortController>();
    const register = () => {
      if (!disposed) void api.setHost({ available: true }).catch(() => undefined);
    };
    const stop = api.onRequest((request) => {
      if (requests.has(request.requestId)) return;
      const controller = new AbortController();
      requests.set(request.requestId, controller);
      void fetch(`${getServerHttpOrigin()}${request.documentPath}`, {
        credentials: "include",
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
      })
        .then((response) => readBoundedResponseText(response, HTML_RENDER_MAX_PAGE_BYTES))
        .then((html) => {
          if (disposed || controller.signal.aborted) throw new Error("Preview host closed");
          return render({
            requestId: request.requestId,
            threadId: request.threadId,
            width: request.width,
            appearance: request.appearance,
            html,
          });
        })
        .then((result) => {
          if (!disposed) return api.respond({ requestId: request.requestId, result });
        })
        .catch(() => {
          if (!disposed)
            void api
              .respond({
                requestId: request.requestId,
                result: {
                  _tag: "Unavailable",
                  message: "The desktop could not render this HTML preview.",
                },
              })
              .catch(() => undefined);
        })
        .finally(() => requests.delete(request.requestId));
    });
    const stopWelcome = onServerWelcome(register);
    register();
    return () => {
      disposed = true;
      for (const controller of requests.values()) controller.abort();
      requests.clear();
      stop();
      stopWelcome();
      void api.setHost({ available: false }).catch(() => undefined);
    };
  }, []);
  return null;
}
