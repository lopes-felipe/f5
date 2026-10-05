import type { ProviderKind } from "@t3tools/contracts";
import { normalizeModelSlug } from "@t3tools/shared/model";

import { getAppModelOptions } from "../../appSettings";
import { cn } from "../../lib/utils";
import { inferProviderForThreadModel } from "../../orchestrationState";
import {
  PROVIDER_ICON_BY_PROVIDER,
  PROVIDER_LABEL_BY_PROVIDER,
  getTriggerDisplayModelName,
} from "./providerIconUtils";

/** Short display name for a model slug ("GPT-5 Codex", "Sonnet 4.5"...). */
export function resolveModelChipName(provider: ProviderKind, model: string): string {
  const options = getAppModelOptions(provider, [], model);
  const normalized = normalizeModelSlug(model, provider);
  const option =
    options.find((candidate) => candidate.slug === model) ??
    options.find((candidate) => candidate.slug === normalized);
  return option ? getTriggerDisplayModelName(option) : model;
}

/**
 * Provider icon plus short model name. `iconOnly` keeps just the icon (dense
 * lists); the full "Provider · Model" text is always available as the label.
 */
export function ModelChip({
  model,
  provider,
  sessionProviderName,
  iconOnly = false,
  className,
}: {
  model: string;
  provider?: ProviderKind | null | undefined;
  /** Used to infer the provider when `provider` is not given. */
  sessionProviderName?: string | null | undefined;
  iconOnly?: boolean | undefined;
  className?: string | undefined;
}) {
  const resolvedProvider =
    provider ??
    inferProviderForThreadModel({ model, sessionProviderName: sessionProviderName ?? null });
  const name = resolveModelChipName(resolvedProvider, model);
  const label = `${PROVIDER_LABEL_BY_PROVIDER[resolvedProvider]} · ${name}`;
  const ProviderIcon = PROVIDER_ICON_BY_PROVIDER[resolvedProvider];

  return (
    <span
      title={label}
      className={cn(
        "inline-flex min-w-0 shrink-0 items-center gap-1 text-2xs text-muted-foreground",
        className,
      )}
    >
      {ProviderIcon ? <ProviderIcon aria-hidden="true" className="size-3.5 shrink-0" /> : null}
      {iconOnly ? (
        <span className="sr-only">{label}</span>
      ) : (
        <span className="truncate">{name}</span>
      )}
    </span>
  );
}
