/**
 * Per-driver account strategy for CLI-managed sign-in: which commands sign
 * in, sign out and report status, how that status reads, and which
 * configured credentials a sign-out clears. `ProviderAccountService` owns the
 * shared PTY, lease and refresh lifecycle.
 */
import type { ServerProviderAuthStatus } from "@t3tools/contracts";

import { parseClaudeAuthStatusFromOutput } from "../provider/Layers/ProviderHealth";

export type CliAccountDriver = "codex" | "claudeAgent" | "cursor";

export interface CliAccountStatus {
  readonly status: ServerProviderAuthStatus;
  readonly detail: string;
}

export interface CliAccountStrategy {
  readonly statusArgs: ReadonlyArray<string>;
  readonly loginArgs: (method: "browser" | "device-code") => ReadonlyArray<string>;
  readonly logoutArgs: ReadonlyArray<string>;
  readonly parseStatus: (result: {
    readonly code: number | null;
    readonly stdout: string;
    readonly stderr: string;
  }) => CliAccountStatus;
  /** Environment credentials that override the CLI's own sign-in. */
  readonly credentialVariables: ReadonlySet<string>;
  /** Fixed OAuth callback port the CLI's browser login binds, if any. */
  readonly oauthCallbackPort?: number;
  /**
   * Instances whose CLI credentials live in the same store share one account:
   * a sign-in or sign-out refreshes, and a sign-out busy-checks, all of them.
   */
  readonly sharesCredentialStore: boolean;
}

/** `agent status --format json` (Cursor CLI 2026.07.09). */
export function parseCursorAccountStatus(result: {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}): CliAccountStatus {
  try {
    const parsed = JSON.parse(result.stdout) as {
      isAuthenticated?: unknown;
      status?: unknown;
      userInfo?: { email?: unknown };
    };
    const authenticated = parsed.isAuthenticated === true || parsed.status === "authenticated";
    const email = typeof parsed.userInfo?.email === "string" ? parsed.userInfo.email : undefined;
    return authenticated
      ? {
          status: "authenticated",
          detail: email ? `Signed in to Cursor as ${email}.` : "Signed in to Cursor.",
        }
      : { status: "unauthenticated", detail: "Not signed in to Cursor." };
  } catch {
    return {
      status: result.code === 0 ? "unknown" : "unauthenticated",
      detail: (result.stdout || result.stderr).trim().slice(0, 2000),
    };
  }
}

export function cliAccountStrategy(driver: CliAccountDriver): CliAccountStrategy {
  switch (driver) {
    case "codex":
      return {
        statusArgs: ["login", "status"],
        loginArgs: (method) => ["login", ...(method === "device-code" ? ["--device-auth"] : [])],
        logoutArgs: ["logout"],
        parseStatus: (result) => ({
          status: result.code === 0 ? "authenticated" : "unauthenticated",
          detail: result.stdout || result.stderr,
        }),
        credentialVariables: new Set(["OPENAI_API_KEY"]),
        oauthCallbackPort: 1455,
        sharesCredentialStore: false,
      };
    case "claudeAgent":
      return {
        statusArgs: ["auth", "status"],
        loginArgs: () => ["auth", "login"],
        logoutArgs: ["auth", "logout"],
        parseStatus: (result) => ({
          status: parseClaudeAuthStatusFromOutput({ ...result, code: result.code ?? -1 })
            .authStatus,
          detail: result.stdout || result.stderr,
        }),
        credentialVariables: new Set([
          "ANTHROPIC_API_KEY",
          "ANTHROPIC_AUTH_TOKEN",
          "CLAUDE_CODE_OAUTH_TOKEN",
        ]),
        sharesCredentialStore: false,
      };
    case "cursor":
      return {
        statusArgs: ["status", "--format", "json"],
        loginArgs: () => ["login"],
        logoutArgs: ["logout"],
        parseStatus: parseCursorAccountStatus,
        credentialVariables: new Set(["CURSOR_API_KEY", "CURSOR_AUTH_TOKEN"]),
        sharesCredentialStore: true,
      };
  }
}

export function isCliAccountDriver(driver: string): driver is CliAccountDriver {
  return driver === "codex" || driver === "claudeAgent" || driver === "cursor";
}
