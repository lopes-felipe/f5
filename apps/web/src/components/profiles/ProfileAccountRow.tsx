import { isProviderDriverKind, type ProfileSummary } from "@t3tools/contracts";

import { Badge } from "../ui/badge";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { ProviderAccountPanel } from "../settings/ProviderAccountPanel";
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
      {presentation.canSignIn ? (
        <ProviderAccountPanel
          className="mt-2.5"
          instanceId={account.instanceId}
          status={account.status}
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
