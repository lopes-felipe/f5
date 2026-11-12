import { PROVIDER_DISPLAY_NAMES, type ServerProvider } from "@t3tools/contracts";
import { RefreshCwIcon, TriangleAlertIcon, XIcon } from "lucide-react";
import { memo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { ensureNativeApi } from "../../nativeApi";
import { serverQueryKeys } from "../../lib/serverReactQuery";
import { presentProviderStatus } from "../onboarding/providerStatusIcon";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import type { ThreadNoticeChip } from "./ThreadNoticeStack";

function providerHealthLabel(status: Pick<ServerProvider, "displayName" | "driver">): string {
  return (
    status.displayName ??
    (PROVIDER_DISPLAY_NAMES as Partial<Record<string, string>>)[status.driver] ??
    status.driver
  );
}

/**
 * Limited availability can fold into a status chip. A disabled or unavailable
 * provider blocks sends, so it stays inline.
 */
export function providerHealthChip(
  status: Pick<ServerProvider, "displayName" | "driver" | "status">,
): ThreadNoticeChip | null {
  if (status.status !== "warning") return null;
  const providerLabel = providerHealthLabel(status);
  return {
    icon: TriangleAlertIcon,
    tone: "warning",
    label: `${providerLabel} limited`,
    ariaLabel: `${providerLabel} status: limited`,
  };
}

export const ProviderHealthBanner = memo(function ProviderHealthBanner({
  status,
  onDismiss,
}: {
  status: ServerProvider | null;
  onDismiss?: () => void;
}) {
  const queryClient = useQueryClient();
  const refreshingRef = useRef(false);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const refresh = async () => {
    if (!status || refreshingRef.current) return;
    refreshingRef.current = true;
    setIsRefreshing(true);
    try {
      const { providers } = await ensureNativeApi().server.refreshProviders({
        instanceId: status.instanceId,
      });
      queryClient.setQueryData(serverQueryKeys.config(), (existing) =>
        existing ? { ...existing, providers } : existing,
      );
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Failed to refresh provider status",
        description: error instanceof Error ? error.message : "Please try again.",
      });
    } finally {
      refreshingRef.current = false;
      setIsRefreshing(false);
    }
  };

  if (!status || status.status === "ready") {
    return null;
  }

  const providerLabel = providerHealthLabel(status);
  const defaultMessage =
    status.status === "error"
      ? `${providerLabel} provider is unavailable.`
      : `${providerLabel} provider has limited availability.`;
  const title = providerLabel === "Codex" ? "Codex provider status" : `${providerLabel} status`;
  const isError = status.status === "error";
  const presentation = presentProviderStatus({
    status: status.status === "disabled" ? "warning" : status.status,
  });
  const StatusIcon = presentation.icon;
  return (
    <Alert variant={isError ? "error" : "warning"}>
      <StatusIcon aria-label={presentation.ariaLabel} />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>
        <div className="line-clamp-3" title={status.message ?? defaultMessage}>
          {status.message ?? defaultMessage}
        </div>
        <div className="mt-2 flex justify-end">
          <Button
            aria-label={`Refresh ${providerLabel} provider status`}
            disabled={isRefreshing}
            onClick={() => void refresh()}
            size="xs"
            variant="outline"
          >
            <RefreshCwIcon className={isRefreshing ? "animate-spin" : undefined} />
            {isRefreshing ? "Refreshing..." : "Refresh"}
          </Button>
        </div>
      </AlertDescription>
      {onDismiss && (
        <AlertAction>
          <button
            type="button"
            aria-label="Dismiss provider status"
            className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            onClick={onDismiss}
          >
            <XIcon className="size-3.5" />
          </button>
        </AlertAction>
      )}
    </Alert>
  );
});
