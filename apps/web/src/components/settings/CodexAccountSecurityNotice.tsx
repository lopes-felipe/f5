import { useQuery } from "@tanstack/react-query";
import type { ProviderInstanceId } from "@t3tools/contracts";
import { supportsCodexRelease6 } from "@t3tools/shared/providerRuntimeCapabilities";
import { serverConfigQueryOptions } from "../../lib/serverReactQuery";
import { ensureNativeApi } from "../../nativeApi";

/** Account-keyed, read-only reminder. No security action runs without a user click. */
export function CodexAccountSecurityNotice({
  instanceId,
  identity,
}: {
  instanceId: ProviderInstanceId;
  identity: string;
}) {
  const config = useQuery({ ...serverConfigQueryOptions(), enabled: false });
  const version = config.data?.providers.find(
    (provider) => provider.instanceId === instanceId,
  )?.version;
  const query = useQuery({
    queryKey: ["codex-account-security", instanceId, identity],
    queryFn: async () => {
      const call = ensureNativeApi().server.codexConfiguration;
      return call ? call({ instanceId, action: { type: "securityRead" } }) : null;
    },
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    retry: false,
    enabled: !version || supportsCodexRelease6(version),
  });
  const notice = query.data?.securityNotice;
  if (!notice) return null;
  let url: URL;
  try {
    url = new URL(notice.action.url);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  return (
    <div className="mt-2 rounded border p-2 text-xs">
      <p className="font-medium">{notice.title}</p>
      <p>{notice.description}</p>
      <a className="underline" href={url.href} target="_blank" rel="noreferrer">
        {notice.action.label}
      </a>
    </div>
  );
}
