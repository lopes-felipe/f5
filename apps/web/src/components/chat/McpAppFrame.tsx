import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ThreadId } from "@t3tools/contracts";
import {
  injectMcpAppDocumentGuard,
  MCP_APP_MAX_HTML_BYTES,
  clampMcpAppHeight,
  mcpAppAllowAttribute,
  type McpAppView,
} from "@t3tools/shared/mcpApp";
import { stringifyWithinBytes } from "@t3tools/shared/boundedJson";
import { useStore } from "../../store";
import { selectThreadById } from "../../threadSelectors";
import { derivePendingApprovals } from "../../session-logic";
import type { Thread } from "../../types";
import { ensureNativeApi } from "../../nativeApi";
import { attachmentPreviewUrlForId } from "../../orchestrationState";
import { useHtmlRenderTheme } from "../../hooks/useHtmlRenderTheme";
import { readBoundedResponseText } from "../../lib/readBoundedResponseText";
import { makeMcpAppDocumentGuard } from "../../lib/mcpAppDocumentGuard";
import {
  makeMcpAppHost,
  McpAppHostRefusal,
  mcpAppStyleVariables,
  type McpAppHost,
} from "../../lib/mcpAppHost";
import { newCommandId, newMessageId } from "../../lib/utils";
import { Button } from "../ui/button";
import { Dialog, DialogPopup, DialogTitle } from "../ui/dialog";

const approvalsByActivities = new WeakMap<Thread["activities"], boolean>();
interface Approval {
  title: string;
  detail: string;
  finish: (allow: boolean) => void;
}
export function McpAppFrame({ app, threadId }: { app: McpAppView; threadId: ThreadId }) {
  const theme = useHtmlRenderTheme();
  const live = useStore((state) => {
    const session = selectThreadById(state, threadId)?.session;
    return session?.provider === "codex" && ["ready", "running"].includes(session.status);
  });
  const awaitingApproval = useStore((state) => {
    const thread = selectThreadById(state, threadId);
    if (!thread) return false;
    if (thread.pendingUserInputs?.length) return true;
    const cached = approvalsByActivities.get(thread.activities);
    if (cached !== undefined) return cached;
    const pending = derivePendingApprovals(thread.activities).length > 0;
    approvalsByActivities.set(thread.activities, pending);
    return pending;
  });
  const root = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const host = useRef<McpAppHost | null>(null);
  const [visible, setVisible] = useState(false);
  const [nonce, setNonce] = useState(() => crypto.randomUUID());
  const [html, setHtml] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [stopped, setStopped] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [height, setHeight] = useState(320);
  const [width, setWidth] = useState(0);
  const [approval, setApproval] = useState<Approval | null>(null);
  const approvalRef = useRef<Approval | null>(null);
  const loads = useRef(0);
  const current = useRef({ theme, live, width, fullscreen, awaitingApproval });
  current.current = { theme, live, width, fullscreen, awaitingApproval };
  useEffect(() => {
    if (!root.current) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "200px" },
    );
    observer.observe(root.current);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    if (!root.current) return;
    const observer = new ResizeObserver((entries) => {
      if (entries[0]) setWidth(Math.round(entries[0].contentRect.width));
    });
    observer.observe(root.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (awaitingApproval || !live) setFullscreen(false);
  }, [awaitingApproval, live]);
  useEffect(() => {
    if (!live || !visible) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
      setFailed(true);
    }, 15000);
    setHtml(null);
    setFailed(false);
    setStopped(false);
    loads.current = 0;
    void fetch(attachmentPreviewUrlForId(app.reference.attachmentId), {
      credentials: "include",
      signal: controller.signal,
    })
      .then((response) => readBoundedResponseText(response, MCP_APP_MAX_HTML_BYTES + 8192))
      .then((value) => {
        if (!controller.signal.aborted) setHtml(injectMcpAppDocumentGuard(value, nonce));
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      })
      .finally(() => clearTimeout(timer));
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [app.reference.attachmentId, live, visible, nonce]);
  useLayoutEffect(() => {
    if (!html || !live || stopped || !frame.current) return;
    const controller = new AbortController();
    const base = { threadId, attachmentId: app.reference.attachmentId };
    const stop = () => {
      host.current?.dispose();
      setStopped(true);
      setFullscreen(false);
    };
    const guard = makeMcpAppDocumentGuard({
      nonce,
      frameWindow: () => frame.current?.contentWindow ?? null,
      onLeave: stop,
      onEscape: () => setFullscreen(false),
    });
    const active = async () => {
      if (controller.signal.aborted || !current.current.live || !(await guard.check()))
        throw new McpAppHostRefusal("This app document is no longer active.");
    };
    const confirm = async (title: string, detail: string) => {
      if (approvalRef.current)
        throw new McpAppHostRefusal("Another app request is awaiting your decision.");
      setFullscreen(false);
      const allowed = await new Promise<boolean>((finish) => {
        const value = { title, detail, finish };
        approvalRef.current = value;
        setApproval(value);
      });
      if (!allowed) throw new McpAppHostRefusal("Declined by user.");
      await active();
    };
    const post = (message: unknown) => {
      let json = stringifyWithinBytes(message, 256 * 1024);
      if (!json) {
        const id =
          message && typeof message === "object" && "id" in message ? message.id : undefined;
        if ((typeof id !== "string" || id.length > 256) && typeof id !== "number") return;
        json = JSON.stringify({
          jsonrpc: "2.0",
          id,
          error: { code: -32000, message: "The app response exceeded its size limit." },
        });
      }
      const outgoing: unknown = JSON.parse(json);
      void guard.check().then((valid) => {
        if (valid && !controller.signal.aborted)
          frame.current?.contentWindow?.postMessage(outgoing, "*");
      });
    };
    const bridge = makeMcpAppHost({
      app: app.reference,
      hostVersion: "1",
      post,
      hostContext: () => ({
        theme: current.current.theme.appearance,
        styles: { variables: mcpAppStyleVariables(current.current.theme.variables) },
        displayMode: current.current.fullscreen ? "fullscreen" : "inline",
        availableDisplayModes: ["inline", "fullscreen"],
        containerDimensions: current.current.fullscreen
          ? { width: current.current.width, height: Math.max(80, window.innerHeight - 100) }
          : { width: current.current.width, maxHeight: 2000 },
        platform: "web",
        locale: navigator.language,
      }),
      callTool: async (input) => {
        await active();
        const api = ensureNativeApi();
        const info = await api.mcpApps.toolInfo({ ...base, name: input.name });
        await active();
        if (!info.readOnlyHint)
          await confirm(
            `Allow ${input.name}?`,
            `${info.description ?? "This app wants to call a tool."}\n\n${JSON.stringify(input.arguments, null, 2)}`,
          );
        return api.mcpApps.callTool({
          ...base,
          ...input,
          sessionIdentity: info.sessionIdentity,
          approved: !info.readOnlyHint,
        });
      },
      readResource: async (input) => {
        await active();
        return ensureNativeApi().mcpApps.readResource({ ...base, ...input });
      },
      updateModelContext: async (input) => {
        await active();
        await ensureNativeApi().mcpApps.updateModelContext({ ...base, ...input });
      },
      // The parent cannot tell whether a click inside the app asked for a link or a download, so
      // the user confirms each one, as with messages; an app cannot open them in a loop.
      openLink: async (url) => {
        await active();
        await confirm("Open this link?", url);
        await ensureNativeApi().shell.openExternal(url);
      },
      sendMessage: async (text) => {
        await active();
        await confirm("Send this message?", text);
        const thread = selectThreadById(useStore.getState(), threadId);
        if (!thread || thread.archivedAt)
          throw new McpAppHostRefusal("This thread is unavailable.");
        const commandId = newCommandId();
        const result = await ensureNativeApi().nextTurnQueue.submit({
          submissionId: commandId,
          intent: "auto",
          command: {
            type: "thread.turn.start",
            commandId,
            threadId,
            message: { messageId: newMessageId(), role: "user", text, attachments: [] },
            model: thread.model,
            ...(thread.modelSelection ? { modelSelection: thread.modelSelection } : {}),
            runtimeMode: thread.runtimeMode,
            interactionMode: thread.interactionMode,
            createdAt: new Date().toISOString(),
          },
        });
        if (["canceled", "cleared", "rejected"].includes(result.disposition))
          throw new McpAppHostRefusal("The message was not accepted.");
      },
      requestDisplayMode: async (mode) => {
        await active();
        if (approvalRef.current || current.current.awaitingApproval) return "inline";
        setFullscreen(mode === "fullscreen");
        return mode === "fullscreen" ? "fullscreen" : "inline";
      },
      downloadFile: async (files) => {
        await active();
        if (
          files.length > 10 ||
          files.reduce(
            (bytes, file) => bytes + (file._tag === "embedded" ? file.bytes.byteLength : 0),
            0,
          ) >
            25 * 1024 * 1024
        )
          throw new McpAppHostRefusal("The download exceeds its size limit.");
        await confirm(
          files.length === 1 ? "Download this file?" : `Download ${files.length} files?`,
          files.map((file) => (file._tag === "link" ? file.uri : file.name)).join("\n"),
        );
        for (const file of files) {
          if (file._tag === "link") {
            if (!/^https?:\/\//i.test(file.uri))
              throw new McpAppHostRefusal("Only web download links are supported.");
            await ensureNativeApi().shell.openExternal(file.uri);
          } else {
            const url = URL.createObjectURL(
              new Blob([new Uint8Array(file.bytes)], { type: file.mimeType }),
            );
            const anchor = document.createElement("a");
            anchor.href = url;
            anchor.download = file.name;
            anchor.click();
            setTimeout(() => URL.revokeObjectURL(url), 60000);
          }
        }
      },
      onRequestTeardown: stop,
      onSizeChanged: (size) => {
        if (size.height !== undefined) setHeight(clampMcpAppHeight(size.height));
      },
    });
    bridge.setToolCall({ arguments: app.arguments, result: app.result });
    host.current = bridge;
    const receive = (event: MessageEvent) => {
      if (
        !event.isTrusted ||
        event.source !== frame.current?.contentWindow ||
        controller.signal.aborted
      )
        return;
      if (guard.accept(event)) return;
      void guard.check().then((valid) => {
        if (valid && !controller.signal.aborted) bridge.receive(event.data);
      });
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setFullscreen(false);
    };
    window.addEventListener("message", receive);
    window.addEventListener("keydown", escape);
    return () => {
      controller.abort();
      window.removeEventListener("message", receive);
      window.removeEventListener("keydown", escape);
      bridge.dispose();
      guard.dispose();
      if (host.current === bridge) host.current = null;
      approvalRef.current?.finish(false);
      approvalRef.current = null;
    };
  }, [html, live, stopped, app.reference.attachmentId, threadId, nonce]);
  useEffect(() => {
    host.current?.updateHostContext();
  }, [theme, width, fullscreen]);
  const srcDoc = html ?? undefined;
  const decide = (allow: boolean) => {
    const value = approvalRef.current;
    approvalRef.current = null;
    setApproval(null);
    value?.finish(allow);
  };
  return (
    <>
      <div
        ref={root}
        className={
          fullscreen
            ? "fixed inset-4 z-50 flex flex-col overflow-hidden rounded-xl border bg-background shadow-2xl"
            : "min-w-0 overflow-hidden rounded-lg border bg-background"
        }
      >
        <div className="flex items-center justify-between gap-2 px-3 py-1.5 text-xs text-muted-foreground">
          <span className="truncate">{app.reference.tool}</span>
          <Button
            size="xs"
            variant="ghost"
            disabled={!html || !live || stopped || awaitingApproval}
            onClick={() => setFullscreen((value) => !value)}
          >
            {fullscreen ? "Return to conversation" : "Expand app"}
          </Button>
        </div>
        {!live ? (
          <p className="px-3 py-4 text-sm text-muted-foreground">Send a message to reconnect.</p>
        ) : failed || stopped ? (
          <div className="px-3 py-4 text-sm">
            <p>
              {stopped
                ? "This app stopped after closing or navigating away."
                : "The app could not be loaded."}
            </p>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setApproval(null);
                setNonce(crypto.randomUUID());
              }}
            >
              Reload app
            </Button>
          </div>
        ) : srcDoc ? (
          // The desktop app blocks this frame from navigating anywhere else (appFramePolicy). A
          // plain browser cannot, so there the onLoad check below only notices a navigation after
          // its request has gone out.
          <iframe
            key={nonce}
            ref={frame}
            title={`${app.reference.tool} app`}
            srcDoc={srcDoc}
            sandbox="allow-scripts"
            allow={mcpAppAllowAttribute(app.reference.permissions)}
            referrerPolicy="no-referrer"
            className="w-full border-0"
            style={{
              height: fullscreen ? "calc(100dvh - 6rem)" : height,
              flex: fullscreen ? "1" : undefined,
            }}
            onLoad={() => {
              if (++loads.current > 1) {
                host.current?.dispose();
                setStopped(true);
                setFullscreen(false);
              }
            }}
          />
        ) : (
          <p className="px-3 py-4 text-sm text-muted-foreground">Loading app…</p>
        )}
      </div>
      <Dialog
        open={approval !== null}
        onOpenChange={(open) => {
          if (!open) decide(false);
        }}
      >
        <DialogPopup className="max-w-xl gap-3 p-6">
          <DialogTitle className="shrink-0 break-words pr-6">{approval?.title}</DialogTitle>
          <pre className="max-h-[min(24rem,60dvh)] min-h-0 overflow-auto overscroll-contain whitespace-pre-wrap break-words rounded border p-3 text-xs select-text">
            {approval?.detail}
          </pre>
          <div className="flex shrink-0 justify-end gap-2">
            <Button variant="outline" onClick={() => decide(false)}>
              Cancel
            </Button>
            <Button onClick={() => decide(true)}>Allow</Button>
          </div>
        </DialogPopup>
      </Dialog>
    </>
  );
}
