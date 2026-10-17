import { useState } from "react";
import { Link } from "@tanstack/react-router";
import type { ServerProvider, ServerProviderVersionAdvisory } from "@t3tools/contracts";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogTrigger,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "../ui/dialog";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import {
  formatProviderInstallChannel,
  formatProviderUpdateCheckAge,
  formatProviderUpdateCommand,
} from "./providerStatus";

export function ProviderUpdateDialog({
  advisory,
  displayName,
  providers = [],
  showBadge,
  onRun,
  onCheck,
  onDismiss,
}: {
  readonly advisory: ServerProviderVersionAdvisory;
  readonly displayName: string;
  readonly providers?: readonly ServerProvider[] | undefined;
  readonly showBadge: boolean;
  readonly onRun?: (() => void) | undefined;
  readonly onCheck?: (() => Promise<void>) | undefined;
  readonly onDismiss?: ((version: string) => void) | undefined;
}) {
  const [open, setOpen] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { copyToClipboard, isCopied } = useCopyToClipboard();
  const bundled = advisory.installChannel === "bundled";
  const command = advisory.updateCommand
    ? formatProviderUpdateCommand(advisory.updateCommand)
    : null;
  const sharedNames = (advisory.sharedWith ?? []).map(
    (id) => providers.find((provider) => provider.instanceId === id)?.displayName ?? id,
  );
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button
            size="xs"
            variant="outline"
            className={
              showBadge
                ? "h-5 shrink-0 border-warning/50 text-warning"
                : "h-5 shrink-0 text-muted-foreground"
            }
            title={bundled ? (advisory.message ?? "Bundled with F5.") : undefined}
            aria-label={
              showBadge ? "Update available - view details" : `${displayName} update details`
            }
          >
            {bundled ? (
              <Badge variant="outline" size="sm">
                Bundled
              </Badge>
            ) : showBadge ? (
              "Update"
            ) : (
              "Updates"
            )}
          </Button>
        }
      />
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>{displayName} updates</DialogTitle>
          <DialogDescription>
            {advisory.currentVersion
              ? `Installed v${advisory.currentVersion}`
              : "Installed version unknown"}
            {advisory.latestVersion ? ` → available v${advisory.latestVersion}` : ""}
          </DialogDescription>
        </DialogHeader>
        <div className="grid min-w-0 gap-3 overflow-y-auto px-6 pb-4 text-xs">
          <p>
            {bundled
              ? "Bundled with F5"
              : `Installed via ${formatProviderInstallChannel(advisory.installChannel)}`}
          </p>
          {advisory.executablePath ? (
            <code className="block truncate text-muted-foreground" title={advisory.executablePath}>
              {advisory.executablePath}
            </code>
          ) : null}
          <p className="text-muted-foreground" title={advisory.checkedAt ?? undefined}>
            {formatProviderUpdateCheckAge(advisory.checkedAt)}
          </p>
          {sharedNames.length ? <p>Also used by: {sharedNames.join(", ")}</p> : null}
          {advisory.message ? <p>{advisory.message}</p> : null}
          {advisory.retryAt ? (
            <p>Retry after {new Date(advisory.retryAt).toLocaleString()}.</p>
          ) : null}
          {command ? (
            <div className="grid min-w-0 gap-2">
              <pre className="max-h-32 overflow-auto rounded-md border bg-muted/40 p-2 text-2xs whitespace-pre-wrap break-all">
                {command}
              </pre>
              <Button
                size="xs"
                variant="outline"
                className="justify-self-start"
                onClick={() => void copyToClipboard(command)}
                aria-label="Copy update command"
              >
                {isCopied ? "Copied" : "Copy command"}
              </Button>
            </div>
          ) : null}
          {command && advisory.blockedReason === "isolated_profile" ? (
            <p>Run provider updates from the Default profile.</p>
          ) : null}
          {command && advisory.blockedReason === "windows" ? (
            <p>Run this command in PowerShell, then refresh and verify.</p>
          ) : null}
          {advisory.canRunUpdate && onRun ? (
            <p className="text-muted-foreground">
              Runs this command on this machine. Idle sessions restart on their next turn; active
              work must finish first. Close any terminal sessions using this CLI.
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          ) : null}
        </div>
        <DialogFooter className="flex-wrap">
          {advisory.latestVersion && onDismiss && showBadge ? (
            <Button size="xs" variant="ghost" onClick={() => onDismiss(advisory.latestVersion!)}>
              Dismiss notification
            </Button>
          ) : null}
          {bundled ? (
            <Link
              to="/settings"
              search={{ category: "about", item: "about.updates" }}
              onClick={() => setOpen(false)}
              className="text-xs underline"
            >
              Open F5 updates
            </Link>
          ) : advisory.canRunUpdate &&
            onRun &&
            advisory.latestVersion &&
            advisory.status !== "current" ? (
            <Button
              size="xs"
              disabled={!!advisory.activeUpdate}
              onClick={() => {
                setOpen(false);
                onRun();
              }}
            >
              {advisory.activeUpdate ? "Updating…" : `Update to v${advisory.latestVersion}`}
            </Button>
          ) : null}
          {!bundled && onCheck ? (
            <Button
              size="xs"
              variant="outline"
              disabled={checking}
              onClick={() => {
                setChecking(true);
                setError(null);
                void onCheck()
                  .catch((cause: unknown) =>
                    setError(cause instanceof Error ? cause.message : String(cause)),
                  )
                  .finally(() => setChecking(false));
              }}
            >
              {checking ? "Checking…" : "Refresh and verify"}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
