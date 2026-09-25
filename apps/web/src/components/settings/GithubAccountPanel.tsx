import { CheckIcon, ChevronDownIcon, CopyIcon, KeyRoundIcon, RotateCwIcon } from "lucide-react";
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
import { type GithubConnection, useGitAuthorDraft, useGithubAccount } from "./useGithubAccount";

const GH_INSTALL_URL = "https://cli.github.com";

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
  const ghMissing = github.browserSignInAvailable === false;
  // Without gh the token form is the primary way to connect, so it starts open.
  const tokenOpen = tokenOpenOverride ?? ghMissing;
  const tokenUrl = host
    ? `https://${host}/settings/tokens/new?scopes=repo,read:org,notifications&description=F5`
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
            {github.signingIn ? null : (
              <Button
                size="xs"
                variant={connected ? "outline" : "default"}
                disabled={!host || busy || ghMissing}
                onClick={() => void github.signIn()}
              >
                {github.action === "sign-in" ? <Spinner className="size-3" /> : null}
                {connected ? "Reconnect" : "Sign in with GitHub"}
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

        {ghMissing ? (
          <p className="text-xs text-muted-foreground">
            {github.browserSignInUnavailableReason ||
              "Install GitHub CLI (gh) to sign in with your browser."}{" "}
            <button
              type="button"
              className="text-foreground underline underline-offset-2"
              onClick={() => void github.openExternal(GH_INSTALL_URL)}
            >
              Get GitHub CLI
            </button>
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
              Browser sign-in runs your installed GitHub CLI in a private, temporary folder. GitHub
              lists the grant as “GitHub CLI” under Authorized OAuth Apps; revoking it there also
              signs out gh on this computer.
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
