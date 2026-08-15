import type { SourceControlProviderIdentity } from "@t3tools/contracts";
import { parseSourceControlRemoteUrl } from "@t3tools/shared/sourceControl";

import type { GitRemote } from "../git/Services/GitCore.ts";

export function discoverSourceControlProviderIdentities(
  remotes: ReadonlyArray<GitRemote>,
  options: {
    readonly githubHosts?: ReadonlyArray<string>;
  } = {},
): ReadonlyArray<SourceControlProviderIdentity> {
  const githubHosts = new Set(
    (options.githubHosts ?? []).map((host) => host.trim().toLowerCase()).filter(Boolean),
  );
  const identities: SourceControlProviderIdentity[] = [];
  for (const remote of remotes) {
    const parsed = parseSourceControlRemoteUrl(remote.url);
    const kind =
      parsed.kind === "unknown" && parsed.host && githubHosts.has(parsed.host.toLowerCase())
        ? "github"
        : parsed.kind;
    const identity = {
      kind,
      remoteName: remote.name,
      ...(parsed.host ? { host: parsed.host } : {}),
      ...(parsed.owner ? { owner: parsed.owner } : {}),
      ...(parsed.repository ? { repository: parsed.repository } : {}),
      ...(parsed.webUrl ? { webUrl: parsed.webUrl } : {}),
    } satisfies SourceControlProviderIdentity;
    identities.push(identity);
  }
  return identities;
}

export function selectPrimarySourceControlProviderIdentity(
  identities: ReadonlyArray<SourceControlProviderIdentity>,
): SourceControlProviderIdentity {
  return (
    identities.find(
      (identity) => identity.remoteName === "origin" && identity.kind !== "unknown",
    ) ??
    identities.find((identity) => identity.kind !== "unknown") ??
    identities.find((identity) => identity.remoteName === "origin") ??
    identities[0] ?? { kind: "unknown" }
  );
}
