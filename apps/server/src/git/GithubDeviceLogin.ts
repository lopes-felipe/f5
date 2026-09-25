import { randomUUID } from "node:crypto";
import type { GithubLoginStatus } from "@t3tools/contracts";
import { ProfileGithubAccount, type GithubAccountRequest } from "./ProfileGithubAccount";

/**
 * Public OAuth client ID of GitHub CLI's app. Device-flow client IDs are public (no secret);
 * F5 runs the device flow itself instead of `gh auth login`, because gh's login always rewrites
 * the OS keychain entry of the workstation gh (`activateUser` deletes `gh:<host>`).
 * The grant appears on GitHub as "GitHub CLI".
 */
export const GITHUB_CLI_OAUTH_CLIENT_ID = "178c6fc778ccc68e1d6a";
export const GITHUB_LOGIN_SCOPES = "repo read:org notifications";

/**
 * `F5_GITHUB_OAUTH_CLIENT_ID` overrides the default app (e.g. an F5-owned OAuth app);
 * an explicit empty value disables browser sign-in.
 */
export function resolveGithubOAuthClientId(env: NodeJS.ProcessEnv): string | undefined {
  const configured = env.F5_GITHUB_OAUTH_CLIENT_ID;
  if (configured === undefined) return GITHUB_CLI_OAUTH_CLIENT_ID;
  return configured.trim() || undefined;
}

interface Attempt {
  status: GithubLoginStatus;
  controller: AbortController;
  deviceCode?: string | undefined;
  interval: number;
  timer?: ReturnType<typeof setTimeout>;
}

/** One profile-owned device grant. Codes and tokens never enter process output or logs. */
export class GithubDeviceLogin {
  private attempt?: Attempt;
  constructor(
    private readonly account: ProfileGithubAccount,
    private readonly clientId: string | undefined,
    private readonly request: GithubAccountRequest = fetch,
  ) {}

  status(handle?: string): GithubLoginStatus {
    if (handle && this.attempt?.status.handle !== handle)
      return {
        available: Boolean(this.clientId),
        state: "expired",
        error: "Sign-in is no longer active. Start again.",
      };
    return this.attempt?.status ?? { available: Boolean(this.clientId), state: "idle" };
  }

  cancel(handle?: string): void {
    const attempt = this.attempt;
    if (!attempt || (handle && attempt.status.handle !== handle)) return;
    clearTimeout(attempt.timer);
    attempt.controller.abort();
    attempt.deviceCode = undefined;
    attempt.status = {
      available: Boolean(this.clientId),
      state: "cancelled",
      handle: attempt.status.handle,
    };
  }

  private current(attempt: Attempt): boolean {
    return (
      this.attempt === attempt &&
      !attempt.controller.signal.aborted &&
      attempt.status.state === "pending"
    );
  }

  private async post(
    path: string,
    body: Record<string, string>,
    attempt: Attempt,
  ): Promise<Record<string, unknown>> {
    const response = await this.request(`https://github.com/login/${path}`, {
      method: "POST",
      redirect: "error",
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body).toString(),
      signal: AbortSignal.any([attempt.controller.signal, AbortSignal.timeout(15000)]),
    });
    if (!response.ok) throw new Error("GitHub sign-in is temporarily unavailable.");
    return (await response.json()) as Record<string, unknown>;
  }

  async start(): Promise<GithubLoginStatus> {
    if (!this.clientId)
      throw new Error("Browser sign-in is disabled for this installation. Use a GitHub token.");
    this.cancel();
    const attempt: Attempt = {
      status: { available: true, state: "pending", handle: randomUUID() },
      controller: new AbortController(),
      interval: 5000,
    };
    this.attempt = attempt;
    try {
      const response = await this.post(
        "device/code",
        { client_id: this.clientId, scope: GITHUB_LOGIN_SCOPES },
        attempt,
      );
      if (!this.current(attempt)) return this.status(attempt.status.handle);
      if (
        typeof response.device_code !== "string" ||
        !response.device_code ||
        typeof response.user_code !== "string" ||
        !response.user_code ||
        response.verification_uri !== "https://github.com/login/device" ||
        typeof response.expires_in !== "number" ||
        !Number.isFinite(response.expires_in) ||
        response.expires_in <= 0 ||
        typeof response.interval !== "number" ||
        !Number.isFinite(response.interval) ||
        response.interval <= 0
      )
        throw new Error("Invalid GitHub authorization response.");
      attempt.deviceCode = response.device_code;
      attempt.interval = Math.max(1000, response.interval * 1000);
      attempt.status = {
        ...attempt.status,
        userCode: response.user_code,
        verificationUri: response.verification_uri,
        expiresAt: Date.now() + response.expires_in * 1000,
      };
      this.schedule(attempt);
    } catch {
      if (this.current(attempt))
        attempt.status = {
          available: true,
          state: "error",
          handle: attempt.status.handle,
          error: "Unable to start GitHub sign-in. Try again.",
        };
    }
    return this.status(attempt.status.handle);
  }

  private schedule(attempt: Attempt): void {
    if (!this.current(attempt)) return;
    const remaining = (attempt.status.expiresAt ?? 0) - Date.now();
    attempt.timer = setTimeout(
      () => {
        void this.poll(attempt);
      },
      Math.max(0, Math.min(attempt.interval, remaining)),
    );
    attempt.timer.unref?.();
  }

  private async poll(attempt: Attempt): Promise<void> {
    if (!this.current(attempt)) return;
    const finish = (state: "expired" | "error", error: string) => {
      attempt.status = { available: true, state, handle: attempt.status.handle, error };
      attempt.deviceCode = undefined;
    };
    if (Date.now() >= (attempt.status.expiresAt ?? 0)) {
      finish("expired", "Sign-in expired. Start again.");
      return;
    }
    try {
      const response = await this.post(
        "oauth/access_token",
        {
          client_id: this.clientId!,
          device_code: attempt.deviceCode!,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        },
        attempt,
      );
      if (!this.current(attempt)) return;
      if (typeof response.access_token === "string") {
        // This release deliberately supports the non-expiring OAuth app configuration only.
        if (response.refresh_token || response.expires_in) {
          finish(
            "error",
            "This OAuth app must use non-expiring tokens. Use a personal token instead.",
          );
          return;
        }
        try {
          const identity = await this.account.set("github.com", response.access_token, () =>
            this.current(attempt),
          );
          if (this.current(attempt))
            attempt.status = {
              available: true,
              state: "connected",
              handle: attempt.status.handle,
              login: identity.login,
            };
        } catch {
          if (this.current(attempt))
            finish("error", "Unable to save the GitHub connection. Try again.");
        }
        attempt.deviceCode = undefined;
        return;
      }
      if (response.error === "slow_down") attempt.interval += 5000;
      else if (response.error === "expired_token") {
        finish("expired", "Sign-in expired. Start again.");
        return;
      } else if (response.error !== "authorization_pending") {
        finish("error", "GitHub authorization was denied or is unavailable. Start again.");
        return;
      }
    } catch {
      // Network failures are retried within the grant lifetime; never surface token-bearing responses.
      if (!this.current(attempt)) return;
      attempt.interval = Math.min(30000, attempt.interval + 5000);
    }
    this.schedule(attempt);
  }
}
