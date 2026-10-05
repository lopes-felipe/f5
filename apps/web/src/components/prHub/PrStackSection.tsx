import { useQuery } from "@tanstack/react-query";
import type { TrackedPullRequest } from "@t3tools/contracts";
import { ensureNativeApi } from "../../nativeApi";
import { getPrHubAccountGeneration } from "../../lib/prHubAccount";
import { PrLinkPreview } from "./PrLinkPreview";
import { ForgeOperationPanel } from "./ForgeOperationPanel";
export function PrStackSection({ pr }: { pr: TrackedPullRequest }) {
  const generation = getPrHubAccountGeneration();
  const query = useQuery({
    queryKey: ["prHub", "stack", generation, pr.key],
    enabled: pr.provider === "github" && !!pr.forgeCapabilities?.stacks,
    queryFn: () => ensureNativeApi().prHub.getStack({ key: pr.key, accountGeneration: generation }),
    staleTime: 30000,
    retry: false,
  });
  if (!query.data) return null;
  const stack = query.data;
  return (
    <section className="space-y-2" aria-label="Pull request stack">
      <h3 className="text-sm font-semibold">Stack #{stack.number}</h3>
      <div className="flex flex-wrap gap-2">
        {stack.layers.map((layer) => (
          <span key={layer.number} className="rounded border border-border px-2 py-1 text-xs">
            <PrLinkPreview url={layer.url}>
              #{layer.number} {layer.title}
            </PrLinkPreview>
          </span>
        ))}
      </div>
      {pr.forgeCapabilities?.stackActions ? (
        <div className="flex gap-2">
          <ForgeOperationPanel
            pr={pr}
            label="Merge stack"
            payload={{
              kind: "stack",
              action: "merge",
              method: pr.allowedMergeMethods?.[0] ?? "merge",
              fingerprint: stack.fingerprint,
            }}
          />
          {stack.layers.at(-1)?.number === pr.number ? (
            <ForgeOperationPanel
              pr={pr}
              label="Rebase stack"
              payload={{
                kind: "stack",
                action: "rebase",
                method: "rebase",
                fingerprint: stack.fingerprint,
              }}
            />
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
