import { useAppSettings } from "../../appSettings";
import { PrAccounts } from "../prHub/PrAccounts";

/** Accounts on other forges and hosts, and which of them the pull request queue shows. */
export function ForgeAccountsPanel() {
  const { settings, updateSettings } = useAppSettings();
  return (
    <section
      className="rounded-xl border border-border bg-card p-5"
      data-settings-search-target="accounts.forges"
    >
      <div className="mb-4">
        <h2 className="text-sm font-medium text-foreground">Forge accounts</h2>
        <p className="mt-1 max-w-2xl text-xs text-muted-foreground">
          Accounts for pull requests on GitLab, Bitbucket, Azure DevOps, Forgejo or another GitHub
          host. The profile&apos;s GitHub account above needs no entry here.
        </p>
      </div>
      <PrAccounts
        selectedAccountId={settings.prHubAccountId ?? undefined}
        onSelect={(accountId) => updateSettings({ prHubAccountId: accountId ?? null })}
      />
    </section>
  );
}
