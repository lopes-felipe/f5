import { type ServerProviderStatus } from "@t3tools/contracts";
import { XIcon } from "lucide-react";
import { memo } from "react";

import { presentProviderStatus } from "../onboarding/providerStatusIcon";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../ui/alert";

export const ProviderHealthBanner = memo(function ProviderHealthBanner({
  status,
  onDismiss,
}: {
  status: ServerProviderStatus | null;
  onDismiss?: () => void;
}) {
  if (!status || status.status === "ready") {
    return null;
  }

  const providerLabel =
    status.provider === "codex"
      ? "Codex"
      : status.provider === "claudeAgent"
        ? "Claude"
        : status.provider;
  const defaultMessage =
    status.status === "error"
      ? `${providerLabel} provider is unavailable.`
      : `${providerLabel} provider has limited availability.`;
  const title = providerLabel === "Codex" ? "Codex provider status" : `${providerLabel} status`;
  const isError = status.status === "error";
  const presentation = presentProviderStatus({ status: status.status });
  const StatusIcon = presentation.icon;
  const dismissButtonClassName = isError
    ? "inline-flex size-6 items-center justify-center rounded-md text-destructive/60 transition-colors hover:text-destructive"
    : "inline-flex size-6 items-center justify-center rounded-md text-muted-foreground/70 transition-colors hover:text-foreground";

  return (
    <div className="pt-3 mx-auto max-w-3xl">
      <Alert variant={isError ? "error" : "warning"}>
        <StatusIcon aria-label={presentation.ariaLabel} />
        <AlertTitle>{title}</AlertTitle>
        <AlertDescription className="line-clamp-3" title={status.message ?? defaultMessage}>
          {status.message ?? defaultMessage}
        </AlertDescription>
        {onDismiss && (
          <AlertAction>
            <button
              type="button"
              aria-label="Dismiss provider status"
              className={dismissButtonClassName}
              onClick={onDismiss}
            >
              <XIcon className="size-3.5" />
            </button>
          </AlertAction>
        )}
      </Alert>
    </div>
  );
});
