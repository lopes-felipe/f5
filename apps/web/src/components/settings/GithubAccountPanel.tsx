import type { GithubCliAccount, GithubCliCandidates } from "@t3tools/contracts";
import {
  CheckIcon,
  ChevronDownIcon,
  CopyIcon,
  KeyRoundIcon,
  RotateCwIcon,
  TerminalIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { cn } from "../../lib/utils";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible";
import { Input } from "../ui/input";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";
import { SettingsCard } from "./SettingsCard";
import {
  GITHUB_TOKEN_SCOPES,
  type GithubConnection,
  useGitAuthorDraft,
  useGithubAccount,
} from "./useGithubAccount";

function connectionBadge(connection: GithubConnection, signingIn: boolean) {
  if (signingIn) return <Badge variant="info">Signing in</Badge>;
  switch (connection.kind) {
    case "invalid-host":
      return <Badge variant="warning">Invalid host</Badge>;
    case "checking":
      return <Badge variant="outline">Checking…</Badge>;
    case "connected":
      return <Badge variant="success">Connected</Badge>;
    case "disconnected":
      return <Badge variant="outline">Not connected</Badge>;
    case "error":
      return <Badge variant="error">Unavailable</Badge>;
  }
}

/** Screen-reader status line, e.g. "github.com: octocat" / "github.com: Not connected". */
function connectionStatusText(connection: GithubConnection): string {
  switch (connection.kind) {
    case "invalid-host":
      return "Enter a GitHub hostname";
    case "checking":
      return `${connection.host}: Checking`;
    case "connected":
      return `${connection.host}: ${connection.login}`;
    case "disconnected":
      return `${connection.host}: Not connected`;
    case "error":
      return `${connection.host}: Unavailable`;
  }
}

function Disclosure({
  label,
  open,
  onOpenChange,
  children,
}: {
  label: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  return (
    <Collapsible open={open} onOpenChange={onOpenChange}>
      <CollapsibleTrigger
        render={
          <button
            type="button"
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
          >
            <ChevronDownIcon className={cn("size-3 transition-transform", open && "rotate-180")} />
            {label}
          </button>
        }
      />
      <CollapsibleContent>{children}</CollapsibleContent>
    </Collapsible>
  );
}

/** Accounts the workstation GitHub CLI is logged in to, each importable into this profile. */
function GithubCliLogins({
  candidates,
  loading,
  importing,
  busy,
  currentHost,
  onImport,
}: {
  candidates: GithubCliCandidates | null;
  loading: boolean;
  importing: boolean;
  busy: boolean;
  currentHost: string | null;
  onImport: (account: GithubCliAccount) => void;
}) {
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const accounts = [...(candidates?.accounts ?? [])].sort(
    (a, b) =>
      Number(b.host === currentHost) - Number(a.host === currentHost) ||
      Number(b.active) - Number(a.active),
  );
  return (
    <div
      className="space-y-2 rounded-lg border border-border bg-background px-3 py-2"
      aria-label="GitHub CLI logins"
      role="group"
    >
      {loading ? (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Spinner className="size-3" />
          Checking GitHub CLI on this computer…
        </p>
      ) : !candidates ? null : !candidates.ghAvailable ? (
        <p className="text-xs text-muted-foreground">
          GitHub CLI isn&apos;t installed on this computer.
        </p>
      ) : accounts.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No GitHub CLI login found. Run <code>gh auth login</code> in a terminal, or sign in with
          GitHub.
        </p>
      ) : (
        <>
          <ul className="divide-y divide-border">
            {accounts.map((account) => (
              <li
                key={`${account.host}/${account.login}`}
                className="flex flex-wrap items-center justify-between gap-2 py-1.5"
              >
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <span className="truncate text-sm font-medium text-foreground">
                    @{account.login}
                  </span>
                  <span className="text-xs text-muted-foreground">{account.host}</span>
                  {account.active ? (
                    <Badge variant="outline" size="sm">
                      Active
                    </Badge>
                  ) : null}
                  {account.missingScopes.length > 0 ? (
                    <Badge variant="warning" size="sm">
                      No {account.missingScopes.join(", ")} scope
                    </Badge>
                  ) : null}
                </div>
                <Button
                  size="xs"
                  disabled={busy}
                  aria-label={`Import @${account.login} on ${account.host}`}
                  onClick={() => {
                    setPendingKey(`${account.host}/${account.login}`);
                    onImport(account);
                  }}
                >
                  {importing && pendingKey === `${account.host}/${account.login}` ? (
                    <Spinner className="size-3" />
                  ) : null}
                  Import
                </Button>
              </li>
            ))}
          </ul>
          <p className="text-[11px] text-muted-foreground">
            Copies the current token into this profile. Later changes to your terminal gh login,
            such as a logout or account switch, don&apos;t affect F5. Use this button again to
            update.
          </p>
        </>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="grid gap-1.5">
      <span className="text-xs font-medium text-foreground">{label}</span>
      {children}
    </label>
  );
}

export function GithubAccountPanel() {
  const github = useGithubAccount();
  const author = useGitAuthorDraft();
  const [token, setToken] = useState("");
  const [tokenOpenOverride, setTokenOpen] = useState<boolean | null>(null);
  const [aboutOpen, setAboutOpen] = useState(false);
  const { copyToClipboard, isCopied } = useCopyToClipboard();

  if (!github.api) return null;

  const { connection, host, attempt, busy } = github;
  const connected = connection.kind === "connected";
  const browserSignInDisabled = github.browserSignInAvailable === false;
  const canUseBrowserSignIn = github.browserSignInSupportedForHost && !browserSignInDisabled;
  // When browser sign-in can't be used (Enterprise host, or disabled for this install), the
  // token form is the primary way to connect, so it starts open.
  const tokenOpen = tokenOpenOverride ?? (Boolean(host) && !canUseBrowserSignIn);
  const tokenUrl = host
    ? `https://${host}/settings/tokens/new?scopes=${GITHUB_TOKEN_SCOPES.join(",")}&description=F5`
    : undefined;

  return (
    <SettingsCard
      title="GitHub"
      searchTarget="integrations.github"
      description="Connect this profile's GitHub account. F5's GitHub features, agents, and terminal gh and git commands use it."
      actions={connectionBadge(connection, github.signingIn)}
    >
      <div className="space-y-3">
        <Field label="Host">
          <Input
            size="sm"
            aria-label="GitHub or GitHub Enterprise hostname"
            placeholder="github.com"
            spellCheck={false}
            autoComplete="off"
            disabled={busy || github.signingIn}
            value={github.hostInput}
            onChange={(event) => github.setHostInput(event.target.value)}
          />
        </Field>
        {connection.kind === "invalid-host" ? (
          <p className="text-xs text-destructive">
            Enter a hostname such as github.com or github.example.com.
          </p>
        ) : null}

        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-background px-3 py-2">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-foreground">
              {connected ? `@${connection.login}` : "Not connected"}
            </p>
            <p className="truncate text-xs text-muted-foreground">
              {connection.kind === "invalid-host" ? "No host selected" : connection.host}
            </p>
            <span role="status" className="sr-only">
              {connectionStatusText(connection)}
            </span>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-1.5">
            {github.signingIn || !canUseBrowserSignIn ? null : (
              <Button
                size="xs"
                variant={connected ? "outline" : "default"}
                disabled={busy}
                onClick={() => void github.signIn()}
              >
                {github.action === "sign-in" ? <Spinner className="size-3" /> : null}
                {connected ? "Reconnect" : "Sign in with GitHub"}
              </Button>
            )}
            {github.signingIn ? null : (
              <Button
                size="xs"
                variant="outline"
                disabled={!host || busy}
                aria-expanded={github.cliPanelOpen}
                onClick={() =>
                  void (github.cliPanelOpen ? github.closeCliLogins() : github.findCliLogins())
                }
              >
                {github.action === "cli-find" ? (
                  <Spinner className="size-3" />
                ) : (
                  <TerminalIcon className="size-3" />
                )}
                Use GitHub CLI login
              </Button>
            )}
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="Check account"
              title="Check account"
              disabled={!host || busy}
              onClick={() => void github.recheck()}
            >
              <RotateCwIcon className={cn("size-3", github.action === "check" && "animate-spin")} />
            </Button>
            {connected ? (
              <Button
                size="xs"
                variant="destructive-outline"
                disabled={busy}
                onClick={() =>
                  void github.disconnect().then((done) => {
                    if (done) toastManager.add({ type: "success", title: "GitHub disconnected" });
                  })
                }
              >
                Disconnect
              </Button>
            ) : null}
          </div>
        </div>

        {github.cliPanelOpen ? (
          <GithubCliLogins
            candidates={github.cliCandidates}
            loading={github.action === "cli-find"}
            importing={github.action === "cli-import"}
            busy={busy}
            currentHost={host}
            onImport={(account) =>
              void github.importCliLogin(account).then((done) => {
                if (done)
                  toastManager.add({
                    type: "success",
                    title: `Imported @${account.login} from GitHub CLI`,
                  });
              })
            }
          />
        ) : null}

        {connected &&
        github.cliImported &&
        github.cliImported.login === connection.login &&
        github.cliImported.missingScopes.length > 0 ? (
          <Alert variant="warning" className="text-xs">
            <AlertDescription>
              This token is missing the {github.cliImported.missingScopes.join(", ")} scope
              {github.cliImported.missingScopes.length === 1 ? "" : "s"}, so some GitHub features
              may not work. Run{" "}
              <code className="select-all">
                gh auth refresh -h {github.cliImported.host} -s{" "}
                {github.cliImported.missingScopes.join(",")}
              </code>{" "}
              in a terminal, then import again.
            </AlertDescription>
          </Alert>
        ) : null}

        {host && !canUseBrowserSignIn ? (
          <p className="text-xs text-muted-foreground">
            {browserSignInDisabled
              ? "Browser sign-in is disabled for this installation. Use your GitHub CLI login or a personal access token."
              : "Browser sign-in is available for github.com. Use your GitHub CLI login or a personal access token for this host."}
          </p>
        ) : null}

        {attempt?.state === "pending" ? (
          <Alert variant="info" className="text-xs">
            <KeyRoundIcon />
            <AlertTitle>Enter this code on GitHub</AlertTitle>
            <AlertDescription>
              {attempt.userCode ? (
                <span className="select-all font-mono text-sm tracking-wider">
                  {attempt.userCode}
                </span>
              ) : null}
              <span className="flex items-center gap-2 text-muted-foreground">
                <Spinner className="size-3" />
                Waiting for authorization… Choose the account for this profile.
              </span>
            </AlertDescription>
            <AlertAction>
              {attempt.userCode ? (
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label="Copy code"
                  onClick={() => copyToClipboard(attempt.userCode!, undefined)}
                >
                  {isCopied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
                </Button>
              ) : null}
              {attempt.verificationUri ? (
                <Button
                  size="xs"
                  onClick={() => void github.openExternal(attempt.verificationUri!)}
                >
                  Open GitHub
                </Button>
              ) : null}
              <Button
                size="xs"
                variant="destructive-outline"
                disabled={github.action === "cancel"}
                onClick={() => void github.cancelSignIn()}
              >
                Cancel sign-in
              </Button>
            </AlertAction>
          </Alert>
        ) : null}

        {attempt?.error && attempt.state !== "pending" ? (
          <Alert variant={attempt.state === "cancelled" ? "warning" : "error"} className="text-xs">
            <AlertDescription>{attempt.error}</AlertDescription>
          </Alert>
        ) : null}
        {connection.kind === "error" ? (
          <Alert variant="error" className="text-xs">
            <AlertDescription>{connection.message}</AlertDescription>
          </Alert>
        ) : null}
        {github.actionError ? (
          <Alert variant="error" className="text-xs" role="alert">
            <AlertDescription>{github.actionError}</AlertDescription>
          </Alert>
        ) : null}

        <Disclosure
          label="Use a personal access token"
          open={tokenOpen}
          onOpenChange={setTokenOpen}
        >
          <form
            className="mt-2 grid gap-1.5"
            onSubmit={(event) => {
              event.preventDefault();
              void github.saveToken(token).then((saved) => {
                if (saved) setToken("");
              });
            }}
          >
            <span className="text-xs font-medium text-foreground">Token for {host ?? "host"}</span>
            <div className="flex gap-2">
              <Input
                size="sm"
                aria-label="GitHub token"
                type="password"
                autoComplete="off"
                placeholder="ghp_…"
                value={token}
                onChange={(event) => setToken(event.target.value)}
              />
              <Button type="submit" size="sm" disabled={!host || !token.trim() || busy}>
                {github.action === "token" ? <Spinner className="size-3" /> : null}
                Verify and save token
              </Button>
            </div>
            <span className="text-[11px] text-muted-foreground">
              Needs the <code>repo</code>, <code>read:org</code>, and <code>notifications</code>{" "}
              scopes.{" "}
              {tokenUrl ? (
                <button
                  type="button"
                  className="text-foreground underline underline-offset-2"
                  onClick={() => void github.openExternal(tokenUrl)}
                >
                  Create a token on {host}
                </button>
              ) : null}
            </span>
          </form>
        </Disclosure>
      </div>

      <div className="mt-4 space-y-3 border-t border-border pt-4">
        <div>
          <p className="text-xs font-medium text-foreground">Git author for this profile</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Used for commits made by F5, agents, and terminals. Signing in to GitHub does not change
            it.
          </p>
        </div>
        <form
          className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
          onSubmit={(event) => {
            event.preventDefault();
            void author.save().then((saved) => {
              if (saved) toastManager.add({ type: "success", title: "Git author saved" });
            });
          }}
        >
          <Field label="Name">
            <Input
              size="sm"
              aria-label="Git author name"
              placeholder="Ada Lovelace"
              autoComplete="name"
              value={author.name}
              onChange={(event) => author.setName(event.target.value)}
            />
          </Field>
          <Field label="Email">
            <Input
              size="sm"
              type="email"
              aria-label="Git author email"
              placeholder="ada@example.com"
              autoComplete="email"
              value={author.email}
              onChange={(event) => author.setEmail(event.target.value)}
            />
          </Field>
          <Button type="submit" size="sm" disabled={!author.canSave}>
            {author.saving ? <Spinner className="size-3" /> : null}
            Save Git author
          </Button>
        </form>
        {!author.complete ? (
          <p className="text-xs text-muted-foreground">
            Enter both a name and an email, or clear both to use your Git defaults.
          </p>
        ) : !author.emailValid ? (
          <p className="text-xs text-destructive">Enter a valid email address.</p>
        ) : null}
        {author.error ? (
          <Alert variant="error" className="text-xs">
            <AlertDescription>{author.error}</AlertDescription>
          </Alert>
        ) : null}
      </div>

      <div className="mt-4">
        <Disclosure label="How this works" open={aboutOpen} onOpenChange={setAboutOpen}>
          <div className="mt-2 space-y-2 text-xs text-muted-foreground">
            <p>
              Browser sign-in uses GitHub&apos;s device flow with the GitHub CLI app and requests
              the repo, read:org, and notifications scopes. GitHub lists the grant as “GitHub CLI”
              under Authorized OAuth Apps; revoking it there also signs out gh on this computer. It
              does not touch your gh login or keychain.
            </p>
            <p>
              “Use GitHub CLI login” only reads your terminal&apos;s gh login (it never changes it)
              and copies the token you pick into this profile. F5 never imports it automatically.
            </p>
            <p>
              Credentials are stored in private files in this profile and sent only to the selected
              host. Disconnect removes them locally; it does not revoke the grant on GitHub.
            </p>
            <p>
              Upgrading from workstation GitHub authentication? Connect once here, including in
              Default. F5 does not import your workstation login, CLI aliases, or Git protocol
              preferences.
            </p>
          </div>
        </Disclosure>
      </div>
    </SettingsCard>
  );
}
