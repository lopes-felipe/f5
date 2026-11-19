import { useQuery } from "@tanstack/react-query";
import { isKnownProviderKind, type ServerConfig } from "@t3tools/contracts";
import { useCallback } from "react";
import { serverConfigQueryOptions } from "../../lib/serverReactQuery";
import { PROVIDER_ICON_BY_PROVIDER } from "./providerIconUtils";
import { BotIcon } from "lucide-react";
export function ModelMentionChip({ instanceId, model }: { instanceId: string; model: string }) {
  const { data } = useQuery({
    ...serverConfigQueryOptions(),
    select: useCallback(
      (config: ServerConfig) => {
        const provider = config.providers.find((entry) => entry.instanceId === instanceId);
        const known = provider?.models.find((entry) => entry.slug === model);
        return provider && known ? { driver: provider.driver, name: known.name } : null;
      },
      [instanceId, model],
    ),
  });
  if (!data || !isKnownProviderKind(data.driver))
    return <span>{"model:" + instanceId + "/" + model}</span>;
  const Icon = PROVIDER_ICON_BY_PROVIDER[data.driver] ?? BotIcon;
  return (
    <span
      className="inline-flex items-center gap-1 rounded border border-border bg-muted px-1 text-xs align-middle"
      title={"model:" + instanceId + "/" + model}
    >
      <Icon className="size-3" />
      {data.name}
    </span>
  );
}
