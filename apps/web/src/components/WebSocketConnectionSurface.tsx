import { F5_UPGRADE_REQUIRED_MESSAGE } from "@t3tools/contracts";
import {
  canAutoReloadForProtocolUpgrade,
  reloadForProtocolUpgrade,
  useProtocolState,
} from "../protocolState";
import { AlertTriangle, LoaderCircle, RefreshCw } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";

import {
  getComposerReloadStatus,
  serializeComposerDraftRecovery,
  useComposerDraftStore,
} from "../composerDraftStore";
import { APP_DISPLAY_NAME } from "../branding";
import { type SlowRpcRequest, useSlowRpcRequests } from "../requestLatencyState";
import { useSlowRpcWarningEnabled, useWsDisconnectSurfaceEnabled } from "../webLocalFlags";
import {
  isWsInteractionBlocked,
  reconnectWsTransport,
  useWsConnectionState,
} from "../wsConnectionState";
import { Button } from "./ui/button";
import { toastManager } from "./ui/toast";

const connectionTimeFormatter = new Intl.DateTimeFormat(undefined, {
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  month: "short",
  second: "2-digit",
});

function formatConnectionMoment(isoDate: string | null): string {
  if (!isoDate) {
    return "Pending";
  }

  return connectionTimeFormatter.format(new Date(isoDate));
}

function getLatestConnectionMoment(
  disconnectedAt: string | null,
  lastErrorAt: string | null,
): string | null {
  if (!disconnectedAt) {
    return lastErrorAt;
  }
  if (!lastErrorAt) {
    return disconnectedAt;
  }

  return new Date(disconnectedAt).getTime() >= new Date(lastErrorAt).getTime()
    ? disconnectedAt
    : lastErrorAt;
}

function buildSurfaceCopy(phase: "disconnected" | "reconnecting"): {
  readonly description: string;
  readonly eyebrow: string;
  readonly title: string;
} {
  if (phase === "reconnecting") {
    return {
      description:
        "The connection to the F5 server dropped. The app is waiting for the next WebSocket connection attempt.",
      eyebrow: "Reconnecting",
      title: `Reconnecting to ${APP_DISPLAY_NAME}`,
    };
  }

  return {
    description:
      "The app could not keep its WebSocket connection to the F5 server. Retry the connection or reload the app.",
    eyebrow: "Disconnected",
    title: `Connection to ${APP_DISPLAY_NAME} lost`,
  };
}

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
  const drafts = useComposerDraftStore((state) =>
    protocol.upgradeRequired ? state.draftsByThreadId : null,
  );
  const imports = useComposerDraftStore((state) =>
    protocol.upgradeRequired ? state.imageImportsByThreadId : null,
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
  const connectionState = useWsConnectionState();

  const shouldBlock =
    protocol.upgradeRequired || (enabled && isWsInteractionBlocked(connectionState.phase));
  const blockingPhase = connectionState.phase === "reconnecting" ? "reconnecting" : "disconnected";
  const copy = protocol.upgradeRequired
    ? {
        title: F5_UPGRADE_REQUIRED_MESSAGE,
        eyebrow: "Update available",
        description:
          protocol.activeUploads > 0
            ? "Waiting for uploads to finish before reloading."
            : draftStatus !== "ready"
              ? "Draft attachments are still being prepared or could not be saved. Download drafts before reloading to keep a recovery copy."
              : autoReloadAllowed
                ? "Reloading…"
                : "Automatic reload already attempted. Reload manually after the update is available.",
      }
    : shouldBlock
      ? buildSurfaceCopy(blockingPhase)
      : null;
  const latestMoment = getLatestConnectionMoment(
    connectionState.disconnectedAt,
    connectionState.lastErrorAt,
  );

  return (
    <>
      <div aria-hidden={shouldBlock || undefined} inert={shouldBlock}>
        {children}
      </div>
      {shouldBlock && copy ? (
        <div className="fixed inset-0 z-[90] flex items-center justify-center bg-background/72 px-4 py-10 text-foreground backdrop-blur-sm sm:px-6">
          <section className="w-full max-w-xl rounded-[1.75rem] border border-border/80 bg-card/96 p-6 shadow-2xl shadow-black/25 sm:p-8">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-[11px] font-semibold tracking-[0.18em] text-muted-foreground uppercase">
                  {copy.eyebrow}
                </p>
                <h1 className="mt-3 text-2xl font-semibold tracking-tight sm:text-3xl">
                  {copy.title}
                </h1>
              </div>
              <div className="rounded-2xl border border-border/70 bg-background/80 p-3 shadow-sm">
                {connectionState.phase === "reconnecting" ? (
                  <LoaderCircle className="size-5 animate-spin" />
                ) : (
                  <AlertTriangle className="size-5" />
                )}
              </div>
            </div>

            <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{copy.description}</p>

            {!protocol.upgradeRequired && (
              <div className="mt-5 grid gap-3 rounded-2xl border border-border/70 bg-background/60 p-4 text-sm sm:grid-cols-2">
                <div>
                  <p className="text-[11px] font-semibold tracking-[0.16em] text-muted-foreground uppercase">
                    Attempts
                  </p>
                  <p className="mt-1 font-medium text-foreground">{connectionState.attemptCount}</p>
                </div>
                <div>
                  <p className="text-[11px] font-semibold tracking-[0.16em] text-muted-foreground uppercase">
                    Latest event
                  </p>
                  <p className="mt-1 font-medium text-foreground">
                    {formatConnectionMoment(latestMoment)}
                  </p>
                </div>
              </div>
            )}

            {connectionState.lastError && !protocol.upgradeRequired ? (
              <div className="mt-4 rounded-2xl border border-warning/25 bg-warning/8 px-4 py-3 text-sm text-warning-foreground">
                {connectionState.lastError}
              </div>
            ) : null}

            {protocol.upgradeRequired && (
              <div className="mt-5 flex flex-wrap gap-2">
                <Button
                  size="sm"
                  disabled={Object.values(imports ?? {}).some(
                    (value) => (value?.pendingCount ?? 0) > 0,
                  )}
                  onClick={() => {
                    setRecoveryError(null);
                    void serializeComposerDraftRecovery()
                      .then((text) => {
                        const url = URL.createObjectURL(
                          new Blob([text], { type: "application/json" }),
                        );
                        const link = document.createElement("a");
                        link.href = url;
                        link.download = "f5-draft-recovery.json";
                        link.click();
                        setTimeout(() => URL.revokeObjectURL(url), 1000);
                      })
                      .catch(() =>
                        setRecoveryError(
                          "Could not download drafts. Keep this tab open and try again.",
                        ),
                      );
                  }}
                >
                  Download drafts
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    const unsafe =
                      protocol.activeUploads > 0 || getComposerReloadStatus() !== "ready";
                    if (
                      !unsafe ||
                      window.confirm(
                        "Reload anyway? Uploads will be interrupted and unsaved draft attachments will be lost. Download drafts first to keep a recovery copy.",
                      )
                    )
                      window.location.reload();
                  }}
                >
                  Reload anyway
                </Button>
                {recoveryError && <p role="alert">{recoveryError}</p>}
              </div>
            )}
            {!protocol.upgradeRequired && (
              <div className="mt-5 flex flex-wrap gap-2">
                <Button
                  size="sm"
                  onClick={() => {
                    void reconnectWsTransport().catch(() => undefined);
                  }}
                >
                  <RefreshCw />
                  Retry now
                </Button>
                <Button size="sm" variant="outline" onClick={() => window.location.reload()}>
                  Reload app
                </Button>
              </div>
            )}
          </section>
        </div>
      ) : null}
    </>
  );
}
