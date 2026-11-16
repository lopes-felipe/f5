import type { UpgradeDialogProps } from "./UpgradeConnectionDialog";
import { F5_UPGRADE_REQUIRED_MESSAGE } from "@t3tools/contracts";
import {
  canAutoReloadForProtocolUpgrade,
  getProtocolState,
  reloadForProtocolUpgrade,
  useProtocolState,
} from "../protocolState";
import { type ReactNode, lazy, Suspense, useEffect, useRef, useState } from "react";

import {
  getComposerReloadStatus,
  serializeComposerDraftRecovery,
  useComposerDraftStore,
} from "../composerDraftStore";
import { type SlowRpcRequest, useSlowRpcRequests } from "../requestLatencyState";
import { useSlowRpcWarningEnabled, useWsDisconnectSurfaceEnabled } from "../webLocalFlags";
import { reconnectWsTransport, useWsConnectionState } from "../wsConnectionState";
import { Button } from "./ui/button";
import { toastManager } from "./ui/toast";

function UpgradeFallback(props: UpgradeDialogProps) {
  return (
    <aside
      role="alert"
      // Above open popups (z-[130]), which portal outside the inert app tree.
      className="fixed inset-0 z-[135] grid place-content-center gap-4 bg-background p-8"
    >
      <h2>{props.title}</h2>
      <p>{props.description}</p>
      {props.children}
    </aside>
  );
}
const UpgradeConnectionDialog = lazy(() =>
  import("./UpgradeConnectionDialog").catch((error) => {
    console.error("Upgrade dialog could not load; recovery actions remain available", error);
    return { default: UpgradeFallback };
  }),
);

function describeSlowRequest(requests: ReadonlyArray<SlowRpcRequest>): string {
  if (requests.length > 1) {
    return "Some requests are taking longer than expected.";
  }

  const [request] = requests;
  if (!request) {
    return "Some requests are taking longer than expected.";
  }

  if (request.method === "orchestration.dispatchCommand") {
    return "Sending your request is taking longer than expected.";
  }

  return "Refreshing thread state is taking longer than expected.";
}

export function SlowRpcWarningToastCoordinator() {
  const enabled = useSlowRpcWarningEnabled();
  const slowRequests = useSlowRpcRequests();
  const connectionState = useWsConnectionState();
  const toastIdRef = useRef<ReturnType<typeof toastManager.add> | null>(null);

  useEffect(() => {
    if (!enabled || connectionState.phase !== "connected" || slowRequests.length === 0) {
      if (toastIdRef.current !== null) {
        toastManager.close(toastIdRef.current);
        toastIdRef.current = null;
      }
      return;
    }

    const nextToast = {
      type: "warning" as const,
      title: "Slow request",
      description: describeSlowRequest(slowRequests),
      timeout: 0,
    };

    if (toastIdRef.current !== null) {
      toastManager.update(toastIdRef.current, nextToast);
      return;
    }

    toastIdRef.current = toastManager.add(nextToast);
  }, [connectionState.phase, enabled, slowRequests]);

  useEffect(() => {
    return () => {
      if (toastIdRef.current !== null) {
        toastManager.close(toastIdRef.current);
      }
    };
  }, []);

  return null;
}

export function WebSocketConnectionSurface({ children }: { readonly children: ReactNode }) {
  const protocol = useProtocolState();
  const connectionState = useWsConnectionState();
  const needsRecovery = protocol.upgradeRequired || connectionState.synchronizationError !== null;
  const drafts = useComposerDraftStore((state) => (needsRecovery ? state.draftsByThreadId : null));
  const imports = useComposerDraftStore((state) =>
    needsRecovery ? state.imageImportsByThreadId : null,
  );
  const [draftStatus, setDraftStatus] =
    useState<ReturnType<typeof getComposerReloadStatus>>("pending");
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  const autoReloadAllowed = canAutoReloadForProtocolUpgrade();
  useEffect(() => {
    if (!protocol.upgradeRequired) return;
    const status = getComposerReloadStatus();
    setDraftStatus(status);
    if (protocol.activeUploads > 0 || status !== "ready" || !autoReloadAllowed) return;
    const timer = setTimeout(() => {
      // Recheck live state; imports can complete while the timer is pending.
      const latest = getComposerReloadStatus();
      setDraftStatus(latest);
      if (latest === "ready") reloadForProtocolUpgrade();
    }, 300);
    return () => clearTimeout(timer);
  }, [protocol.upgradeRequired, protocol.activeUploads, drafts, imports, autoReloadAllowed]);
  const enabled = useWsDisconnectSurfaceEnabled();
  const shouldBlock = protocol.upgradeRequired;
  const disconnected =
    connectionState.synchronizationError !== null ||
    (enabled && (connectionState.phase !== "connected" || !connectionState.synchronized));
  const copy = protocol.upgradeRequired
    ? {
        title: F5_UPGRADE_REQUIRED_MESSAGE,
        description:
          protocol.activeUploads > 0
            ? "Waiting for uploads to finish before reloading."
            : draftStatus !== "ready"
              ? "Draft attachments are still being prepared or could not be saved. Download drafts before reloading to keep a recovery copy."
              : autoReloadAllowed
                ? "Reloading…"
                : "Automatic reload already attempted. Reload manually after the update is available.",
      }
    : null;

  const guardedReload = () => {
    const unsafe = getProtocolState().activeUploads > 0 || getComposerReloadStatus() !== "ready";
    if (
      !unsafe ||
      window.confirm(
        "Reload anyway? Uploads will be interrupted and unsaved draft attachments will be lost. Download drafts first to keep a recovery copy.",
      )
    )
      window.location.reload();
  };
  const recoveryActions = (
    <>
      <Button
        size="sm"
        disabled={Object.values(imports ?? {}).some((value) => (value?.pendingCount ?? 0) > 0)}
        onClick={() => {
          setRecoveryError(null);
          void serializeComposerDraftRecovery()
            .then((text) => {
              const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
              const link = document.createElement("a");
              link.href = url;
              link.download = "f5-draft-recovery.json";
              link.click();
              setTimeout(() => URL.revokeObjectURL(url), 1000);
            })
            .catch(() =>
              setRecoveryError("Could not download drafts. Keep this tab open and try again."),
            );
        }}
      >
        Download drafts
      </Button>
      <Button size="sm" variant="outline" onClick={guardedReload}>
        {protocol.upgradeRequired ? "Reload anyway" : "Reload app"}
      </Button>
      {recoveryError && <p role="alert">{recoveryError}</p>}
    </>
  );

  return (
    <>
      <div aria-hidden={shouldBlock || undefined} inert={shouldBlock}>
        {children}
      </div>
      {disconnected && !protocol.upgradeRequired ? (
        <aside
          role="status"
          className="fixed right-4 bottom-4 z-[90] max-h-[80vh] max-w-sm overflow-y-auto break-words rounded-lg border border-border bg-card p-3 text-sm shadow-lg"
        >
          <p>
            {connectionState.synchronizationError ??
              (connectionState.phase === "connected"
                ? "Resynchronizing…"
                : connectionState.phase === "connecting"
                  ? "Connecting…"
                  : "Connection lost. Reconnecting…")}
          </p>
          <p className="text-xs text-muted-foreground">
            Reading and local drafts remain available. Server changes resume after synchronization.
          </p>
          {connectionState.synchronizationError ? (
            recoveryActions
          ) : (
            <Button
              size="xs"
              variant="outline"
              onClick={() => void reconnectWsTransport().catch(() => undefined)}
            >
              Retry now
            </Button>
          )}
        </aside>
      ) : null}
      {shouldBlock && copy ? (
        <Suspense
          fallback={
            <UpgradeFallback title={copy.title} description={copy.description} fallback={null}>
              {recoveryActions}
            </UpgradeFallback>
          }
        >
          <UpgradeConnectionDialog
            title={copy.title}
            description={copy.description}
            fallback={
              <UpgradeFallback title={copy.title} description={copy.description} fallback={null}>
                {recoveryActions}
              </UpgradeFallback>
            }
          >
            {recoveryActions}
          </UpgradeConnectionDialog>
        </Suspense>
      ) : null}
    </>
  );
}
