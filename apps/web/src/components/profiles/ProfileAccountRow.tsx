import { isProviderDriverKind, type ProfileSummary } from "@t3tools/contracts";
import { useQuery } from "@tanstack/react-query";

import { serverConfigQueryOptions } from "../../lib/serverReactQuery";
import { Badge } from "../ui/badge";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { ProviderAccountPanel } from "../settings/ProviderAccountPanel";
import { CodexAccountSecurityNotice } from "../settings/CodexAccountSecurityNotice";
import { profileAccountPresentation } from "./profileStatus";

type ProfileAccount = ProfileSummary["providerAccounts"][number];

/**
 * One provider account for the active profile. Renders the structural truth
 * the server already reports on `providerAccounts[]` — this replaces the old
 * `<h4>{displayName}: {status}</h4>`, which put a raw enum slug in a heading.
 */
export function ProfileAccountRow({ account }: { readonly account: ProfileAccount }) {
  const presentation = profileAccountPresentation(account);
  const driverKind = isProviderDriverKind(account.driver) ? account.driver : null;
  const serverConfigQuery = useQuery(serverConfigQueryOptions());
  const authType = serverConfigQuery.data?.providers?.find(
    (provider) => provider.instanceId === account.instanceId,
  )?.auth.type;

  return (
    <div className="border-t border-border px-5 py-4 first:border-t-0">
      <div className="flex flex-wrap items-center gap-2">
        {driverKind ? (
          <ProviderInstanceIcon
            driverKind={driverKind}
            displayName={account.displayName}
            className="size-5"
          />
        ) : null}
        <p className="text-sm font-medium text-foreground">{account.displayName}</p>
        <Badge variant={presentation.badge} size="sm">
          {presentation.label}
        </Badge>
        {presentation.detail ? (
          <span className="min-w-0 truncate text-xs text-muted-foreground">
            {presentation.detail}
          </span>
        ) : null}
      </div>
      {account.message && account.message !== presentation.detail ? (
        <p className="mt-1.5 text-xs text-muted-foreground">{account.message}</p>
      ) : null}
      {driverKind === "codex" && account.status === "authenticated" && (
        <CodexAccountSecurityNotice
          instanceId={account.instanceId}
          identity={account.identity ?? ""}
        />
      )}
      {presentation.canSignIn ? (
        <ProviderAccountPanel
          className="mt-2.5"
          instanceId={account.instanceId}
          driver={account.driver}
          status={account.status}
          authType={authType}
        />
      ) : presentation.detail ? null : (
        // The server's `reason` already renders on the header line above; only
        // fall back to generic copy when it did not send one.
        <p className="mt-1.5 text-xs text-muted-foreground">
          This provider cannot be isolated per profile.
        </p>
      )}
    </div>
  );
}
