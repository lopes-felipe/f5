import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import type {
  ForgeAccount,
  ForgeAccountRouting,
  SourceControlProviderKind,
} from "@t3tools/contracts";
import { ensureNativeApi } from "../../nativeApi";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

const PROVIDERS = [
  ["github", "GitHub", "github.com"],
  ["gitlab", "GitLab", "gitlab.com"],
  ["bitbucket", "Bitbucket Cloud", "bitbucket.org"],
  ["azure-devops", "Azure DevOps", "dev.azure.com"],
  ["forgejo", "Forgejo / Gitea", ""],
] as const;
const providerLabel = (provider: SourceControlProviderKind) =>
  PROVIDERS.find(([kind]) => kind === provider)?.[1] ?? provider;
const accountLabel = (account: ForgeAccount) =>
  `${providerLabel(account.provider)} · ${account.host} · ${account.login}`;
const selectClass = "h-8 rounded-md border border-input bg-background px-2 text-sm";

export function PrAccounts({
  selectedAccountId,
  onSelect,
}: {
  readonly selectedAccountId?: string | undefined;
  readonly onSelect: (accountId: string | undefined) => void;
}) {
  const id = useId();
  const mounted = useRef(true);
  const [accounts, setAccounts] = useState<readonly ForgeAccount[]>([]);
  const [routing, setRouting] = useState<readonly ForgeAccountRouting[]>([]);
  const [provider, setProvider] = useState<Exclude<SourceControlProviderKind, "unknown">>("github");
  const [host, setHost] = useState("github.com");
  const [token, setToken] = useState("");
  const [organization, setOrganization] = useState("");
  const [routeAccountId, setRouteAccountId] = useState("");
  const [repository, setRepository] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    mounted.current = true;
    let cancelled = false;
    const api = ensureNativeApi().prHub;
    void Promise.all([api.listAccounts(), api.listAccountRouting()]).then(
      ([nextAccounts, nextRouting]) => {
        if (!cancelled) {
          setAccounts(nextAccounts);
          setRouting(nextRouting);
        }
      },
      () => {
        if (!cancelled) setError("Could not load forge accounts.");
      },
    );
    return () => {
      cancelled = true;
      mounted.current = false;
    };
  }, []);

  const saveAccount = async (event: FormEvent) => {
    event.preventDefault();
    if (
      busy ||
      !host.trim() ||
      !token.trim() ||
      (provider === "azure-devops" && !organization.trim())
    )
      return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const api = ensureNativeApi().prHub;
      const saved = await api.saveAccount({
        provider,
        host: host.trim(),
        token,
        ...(provider === "azure-devops" ? { organization: organization.trim() } : {}),
      });
      if (!mounted.current) return;
      setToken("");
      const nextAccounts = await api.listAccounts();
      if (!mounted.current) return;
      setAccounts(nextAccounts);
      setRouteAccountId(saved.id);
      onSelect(saved.id);
      setMessage(`Verified ${saved.login} on ${saved.host}.`);
    } catch {
      if (mounted.current) setError("Could not verify this account. Check the host and token.");
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  const saveRouting = async (event: FormEvent) => {
    event.preventDefault();
    const account = accounts.find((value) => value.id === (routeAccountId || selectedAccountId));
    if (busy || !account || !repository.trim()) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const api = ensureNativeApi().prHub;
      await api.setAccountRouting({
        accountId: account.id,
        provider: account.provider,
        host: account.host,
        repository: repository.trim(),
      });
      const nextRouting = await api.listAccountRouting();
      if (!mounted.current) return;
      setRouting(nextRouting);
      setMessage(`Repository routed to ${account.login}.`);
      setRepository("");
    } catch {
      if (mounted.current) setError("Could not save repository routing.");
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  return (
    <div className="space-y-2">
      <label className="flex flex-wrap items-center gap-2 text-xs" htmlFor={`${id}-selected`}>
        Forge account
        <select
          id={`${id}-selected`}
          className={selectClass}
          value={selectedAccountId ?? ""}
          onChange={(event) => onSelect(event.target.value || undefined)}
        >
          <option value="">Profile GitHub account</option>
          {accounts.map((account) => (
            <option key={account.id} value={account.id}>
              {accountLabel(account)}
            </option>
          ))}
        </select>
      </label>
      <details className="rounded-md border p-2 text-xs">
        <summary className="cursor-pointer font-medium">Manage accounts</summary>
        <div className="mt-3 space-y-4">
          {accounts.map((account) => (
            <div key={account.id} className="flex items-center justify-between gap-2">
              <span>{accountLabel(account)}</span>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  setError(null);
                  try {
                    const api = ensureNativeApi().prHub;
                    await api.removeAccount({ accountId: account.id });
                    setAccounts(await api.listAccounts());
                    setRouting(await api.listAccountRouting());
                    if (selectedAccountId === account.id) onSelect(undefined);
                  } catch (error) {
                    setError(error instanceof Error ? error.message : "Could not remove account.");
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Remove account and routing
              </Button>
            </div>
          ))}
          <p className="text-muted-foreground">
            Accounts are verified on their forge and used independently. Repository routing selects
            an exact account when several share a host.
          </p>
          <form onSubmit={saveAccount} className="flex flex-wrap items-end gap-2">
            <label className="grid gap-1" htmlFor={`${id}-provider`}>
              Provider
              <select
                id={`${id}-provider`}
                value={provider}
                className={selectClass}
                disabled={busy}
                onChange={(event) => {
                  const next = PROVIDERS.find(([kind]) => kind === event.target.value);
                  if (next) {
                    setProvider(next[0]);
                    setHost(next[2]);
                  }
                }}
              >
                {PROVIDERS.map(([kind, label]) => (
                  <option key={kind} value={kind}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label className="grid min-w-40 gap-1" htmlFor={`${id}-host`}>
              Host
              <Input
                id={`${id}-host`}
                value={host}
                disabled={busy}
                autoComplete="off"
                placeholder="git.example.com"
                onChange={(event) => setHost(event.target.value)}
              />
            </label>
            {provider === "azure-devops" && (
              <label className="grid min-w-40 gap-1" htmlFor={`${id}-organization`}>
                Organization
                <Input
                  id={`${id}-organization`}
                  value={organization}
                  disabled={busy}
                  autoComplete="off"
                  placeholder="my-organization"
                  onChange={(event) => setOrganization(event.target.value)}
                />
              </label>
            )}
            <label className="grid min-w-40 gap-1" htmlFor={`${id}-token`}>
              Access token
              <Input
                id={`${id}-token`}
                type="password"
                value={token}
                disabled={busy}
                autoComplete="new-password"
                onChange={(event) => setToken(event.target.value)}
              />
            </label>
            <Button
              type="submit"
              size="sm"
              disabled={
                busy ||
                !host.trim() ||
                !token.trim() ||
                (provider === "azure-devops" && !organization.trim())
              }
            >
              Verify and save account
            </Button>
          </form>
          {accounts.length > 0 && (
            <form onSubmit={saveRouting} className="flex flex-wrap items-end gap-2">
              <label className="grid gap-1" htmlFor={`${id}-route-account`}>
                Account for repository
                <select
                  id={`${id}-route-account`}
                  className={selectClass}
                  disabled={busy}
                  value={routeAccountId || selectedAccountId || ""}
                  onChange={(event) => setRouteAccountId(event.target.value)}
                >
                  <option value="">Choose account</option>
                  {accounts.map((account) => (
                    <option key={account.id} value={account.id}>
                      {accountLabel(account)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="grid min-w-40 gap-1" htmlFor={`${id}-repository`}>
                Repository path
                <Input
                  id={`${id}-repository`}
                  value={repository}
                  disabled={busy}
                  placeholder="owner/repository"
                  autoComplete="off"
                  onChange={(event) => setRepository(event.target.value)}
                />
              </label>
              <Button
                type="submit"
                size="sm"
                disabled={busy || !(routeAccountId || selectedAccountId) || !repository.trim()}
              >
                Save repository routing
              </Button>
            </form>
          )}
          {routing.length > 0 && (
            <ul aria-label="Repository account routing" className="space-y-1 text-muted-foreground">
              {routing.map((route) => (
                <li key={`${route.provider}:${route.host}/${route.repository}`}>
                  {providerLabel(route.provider)} · {route.host}/{route.repository} →{" "}
                  {accounts.find((account) => account.id === route.accountId)?.login ??
                    "Account unavailable"}
                </li>
              ))}
            </ul>
          )}
          {message && <p role="status">{message}</p>}
          {error && (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          )}
        </div>
      </details>
    </div>
  );
}
