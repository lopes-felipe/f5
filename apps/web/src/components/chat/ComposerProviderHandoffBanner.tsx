import { memo } from "react";

export interface ProviderHandoffEndpoint {
  readonly name: string;
  readonly model: string | null;
}

function endpointLabel(endpoint: ProviderHandoffEndpoint): string {
  return endpoint.model ? `${endpoint.name} · ${endpoint.model}` : endpoint.name;
}

/** Tells the user the next send switches providers and hands the conversation off. */
export const ComposerProviderHandoffBanner = memo(function ComposerProviderHandoffBanner({
  from,
  to,
}: {
  from: ProviderHandoffEndpoint;
  to: ProviderHandoffEndpoint;
}) {
  return (
    <div
      role="status"
      className="px-4 py-3.5 sm:px-5 sm:py-4"
      data-testid="composer-provider-handoff"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          Switching to {endpointLabel(to)}
        </span>
      </div>
      <div className="mt-1 text-xs text-muted-foreground">
        The conversation so far will be handed off from {endpointLabel(from)}.
      </div>
    </div>
  );
});

/**
 * The started thread's selected provider cannot take the next send. Nothing
 * switches on the user's behalf; they pick another provider or fix this one.
 */
export const ComposerProviderUnavailableBanner = memo(function ComposerProviderUnavailableBanner({
  name,
  reason,
}: {
  name: string;
  reason: string;
}) {
  return (
    <div
      role="status"
      className="px-4 py-3.5 sm:px-5 sm:py-4"
      data-testid="composer-provider-unavailable"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{name} is unavailable</span>
      </div>
      <div className="mt-1 text-xs text-muted-foreground">
        {reason} Pick another provider to hand the conversation off to it.
      </div>
    </div>
  );
});
