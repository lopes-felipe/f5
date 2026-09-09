import type { ProfileSummary } from "@t3tools/contracts";

import { ProfileAccountRow } from "./ProfileAccountRow";

/**
 * Accounts for the active profile.
 *
 * The server only computes `providerAccounts` for the active profile
 * (`computeProfiles` in wsServer.ts), so this is a page-level section rather
 * than a per-card block that would render empty for every other profile.
 */
export function ProfileAccountsSection({ profile }: { readonly profile: ProfileSummary }) {
  if (profile.providerAccounts.length === 0) return null;

  return (
    <section
      className="rounded-2xl border border-border bg-card"
      data-settings-search-target="profiles.accounts"
    >
      <div className="border-b border-border px-5 py-4">
        <h2 className="text-sm font-medium text-foreground">Accounts</h2>
        <p className="mt-1 max-w-2xl text-xs text-muted-foreground">
          Sign in to the CLIs this profile uses. Credentials are stored inside{" "}
          <code className="rounded bg-muted/60 px-1 py-0.5 text-[10px]">{profile.stateDir}</code>{" "}
          and are not shared with other profiles.
        </p>
      </div>
      <div>
        {profile.providerAccounts.map((account) => (
          <ProfileAccountRow key={account.instanceId} account={account} />
        ))}
      </div>
    </section>
  );
}
