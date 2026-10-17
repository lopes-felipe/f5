import type { ServerProvider, ServerProviderUpdateCommand } from "@t3tools/contracts";

/**
 * Visual treatment for each server-reported provider status. Centralized so
 * the default-driver card and per-instance cards share the same language.
 */
export const PROVIDER_STATUS_STYLES = {
  // Disabled is a choice, not a fault: a neutral dot rather than a warning.
  disabled: {
    dot: "bg-faint-foreground",
  },
  error: {
    dot: "bg-destructive",
  },
  ready: {
    dot: "bg-success",
  },
  warning: {
    dot: "bg-warning",
  },
} as const;

export type ProviderStatusKey = keyof typeof PROVIDER_STATUS_STYLES;

/**
 * Derive the headline + detail copy shown under a provider's name in the
 * settings page. Prefers `provider.message` for server-supplied detail and
 * falls back to generic phrasing when the server has not yet reported any
 * state — which happens before the first probe or when an instance names a
 * driver this build does not ship.
 */
export function getProviderSummary(provider: ServerProvider | undefined) {
  if (!provider) {
    return {
      headline: "Checking provider status",
      detail: "Waiting for the server to report installation and authentication details.",
    };
  }
  if (!provider.enabled) {
    return {
      headline: "Disabled",
      detail:
        provider.message ?? "This provider is installed but disabled for new sessions in T3 Code.",
    };
  }
  if (!provider.installed) {
    return {
      headline: "Not found",
      detail: provider.message ?? "CLI not detected on PATH.",
    };
  }
  if (provider.auth.status === "authenticated") {
    const authLabel = provider.auth.label ?? provider.auth.type;
    return {
      headline: authLabel ? `Authenticated · ${authLabel}` : "Authenticated",
      detail: provider.message ?? null,
    };
  }
  if (provider.auth.status === "unauthenticated") {
    return {
      headline: "Not authenticated",
      detail: provider.message ?? null,
    };
  }
  if (provider.status === "warning") {
    return {
      headline: "Needs attention",
      detail:
        provider.message ?? "The provider is installed, but the server could not fully verify it.",
    };
  }
  if (provider.status === "error") {
    return {
      headline: "Unavailable",
      detail: provider.message ?? "The provider failed its startup checks.",
    };
  }
  return {
    headline: "Available",
    detail: provider.message ?? "Installed and ready, but authentication could not be verified.",
  };
}

/**
 * Normalize a version string for display. Adds the `v` prefix when the
 * driver reported a bare version (e.g. `1.2.3`) so cards render
 * consistently regardless of driver.
 */
export function getProviderVersionLabel(version: string | null | undefined) {
  if (!version) return null;
  return version.startsWith("v") ? version : `v${version}`;
}

const SHELL_SAFE_TOKEN_PATTERN = /^[A-Za-z0-9_@%+=:,./-]+$/;
const SHELL_SAFE_ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

function quoteShellToken(token: string): string {
  if (token.length > 0 && SHELL_SAFE_TOKEN_PATTERN.test(token)) return token;
  return `'${token.replaceAll("'", "'\\''")}'`;
}

export function formatProviderUpdateCommand(command: ServerProviderUpdateCommand): string {
  if (command.shell === "powershell") {
    const quote = (token: string) => `'${token.replaceAll("'", "''")}'`;
    const environment = Object.entries(command.env ?? {})
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => `$env:${key}=${quote(value)}; `)
      .join("");
    const pathPrefix = command.pathPrepend
      ? `$env:PATH=${quote(command.pathPrepend + ";")}+$env:PATH; `
      : "";
    return `${pathPrefix}${command.cwd ? `Set-Location ${quote(command.cwd)}; ` : ""}${environment}& ${quote(command.executable)} ${command.args.map(quote).join(" ")}`;
  }
  const commandTokens = [command.executable, ...command.args].map(quoteShellToken).join(" ");
  const envEntries = Object.entries(command.env ?? {}).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  const envPrefix =
    envEntries.length === 0
      ? ""
      : `${envEntries
          .map(([key, value]) =>
            SHELL_SAFE_ENV_KEY_PATTERN.test(key)
              ? `${key}=${quoteShellToken(value)}`
              : quoteShellToken(`${key}=${value}`),
          )
          .join(" ")} `;
  const pathPrefix = command.pathPrepend
    ? `PATH=${quoteShellToken(command.pathPrepend)}:"$PATH" `
    : "";
  if (!command.cwd) return `${envPrefix}${pathPrefix}${commandTokens}`;
  return `cd ${quoteShellToken(command.cwd)} && ${envPrefix}${pathPrefix}${commandTokens}`;
}

export function formatProviderInstallChannel(
  channel: import("@t3tools/contracts").ServerProviderVersionAdvisory["installChannel"],
): string {
  switch (channel) {
    case "npm":
      return "npm";
    case "homebrew":
      return "Homebrew";
    case "self-update":
      return "built-in updater";
    case "bundled":
      return "Bundled with F5";
    case "remote":
      return "a remote OpenCode server";
    default:
      return "an installer F5 doesn't recognize";
  }
}

export function formatProviderUpdateCheckAge(checkedAt: string | null, now = Date.now()): string {
  if (!checkedAt) return "Not checked yet";
  const minutes = Math.max(0, Math.floor((now - Date.parse(checkedAt)) / 60_000));
  return minutes === 0
    ? "Last checked just now"
    : minutes < 60
      ? `Last checked ${minutes}m ago`
      : `Last checked ${Math.floor(minutes / 60)}h ago`;
}

export function getProviderUpdateResultMessage(
  result: import("@t3tools/contracts").ServerRunProviderUpdateResult,
  channel: string,
  latest: string | null,
): string {
  switch (result.outcome) {
    case "updated":
      return `Updated to v${result.currentVersion}.`;
    case "unchanged":
      return `Update finished, but the version is still v${result.currentVersion ?? "unknown"}. ${channel} may not have published v${latest ?? "the latest release"} yet.`;
    case "unexpected_version":
      return `Installed v${result.currentVersion ?? "unknown"}, expected v${latest ?? "the requested release"}.`;
    case "unverified":
      return "The update finished, but F5 couldn't confirm the new version. Check the provider status.";
    case "failed":
      return `Update failed (${result.timedOut ? "timed out" : result.exitCode === null ? "could not start" : `exit ${result.exitCode}`}).`;
  }
}

export function hasProviderUpdateNotification(
  advisory: import("@t3tools/contracts").ServerProviderVersionAdvisory | undefined,
  dismissedVersion?: string,
): boolean {
  return (
    !!advisory?.latestVersion &&
    (advisory.updateAvailable ??
      (advisory.status === "behind_latest" || advisory.status === "manual")) &&
    advisory.status !== "bundled" &&
    advisory.status !== "current" &&
    advisory.status !== "unknown" &&
    advisory.latestVersion !== dismissedVersion
  );
}
