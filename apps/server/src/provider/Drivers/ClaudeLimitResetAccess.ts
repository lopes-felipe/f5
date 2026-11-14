import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import * as NodeOS from "node:os";

import type { ClaudeSettings, UsageConsumeResetCreditResult } from "@t3tools/contracts";
import { Effect, FileSystem, Path } from "effect";

import {
  ClaudeLimitResetRequestError,
  makeClaudeLimitResetClient,
  readClaudeOAuthToken,
  SecurityCommandError,
  type ClaudeLimitResetClient,
  type ClaudeLimitResetClientDeps,
} from "../../usage/claudeLimitResets.ts";
import { asRecord, asTrimmedString } from "../../usage/accountUsageJson.ts";
import { ProviderDriverError } from "../Errors.ts";
import { isCustomClaudeApiEndpoint } from "../Layers/ClaudeProvider.ts";
import { resolveClaudeUserStatePath } from "../claudeInventory.ts";
import { makeClaudeEnvironment, readClaudeSettingsBaseUrl } from "./ClaudeHome.ts";

/** Short enough that a waiting Keychain prompt can't stall a usage refresh for long. */
const SECURITY_TIMEOUT_MS = 5_000;

function runSecurity(args: ReadonlyArray<string>): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "/usr/bin/security",
      [...args],
      { timeout: SECURITY_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        // Never include stdout in the error: it holds the credentials payload.
        if (error)
          reject(new SecurityCommandError(typeof error.code === "number" ? error.code : null));
        else resolve(stdout);
      },
    );
  });
}

function currentUsername(): string {
  try {
    return NodeOS.userInfo().username;
  } catch {
    // Claude Code falls back to a fixed account name too.
    return "";
  }
}

/**
 * Builds the limit-reset client for one Claude instance, reading credentials
 * from the same config dir the instance's CLI child uses.
 */
export const makeClaudeLimitResetAccess = Effect.fn("makeClaudeLimitResetAccess")(function* (
  settings: ClaudeSettings,
  processEnvironment: NodeJS.ProcessEnv,
  options: {
    readonly cwd: string;
    /** Makes the CLI refresh its stored token. */
    readonly refreshToken: () => Promise<void>;
    /** Test seams. */
    readonly platform?: NodeJS.Platform;
    readonly runSecurity?: (args: ReadonlyArray<string>) => Promise<string>;
    readonly fetch?: ClaudeLimitResetClientDeps["fetch"];
  },
): Effect.fn.Return<ClaudeLimitResetClient, never, Path.Path | FileSystem.FileSystem> {
  const path = yield* Path.Path;
  const environment = yield* makeClaudeEnvironment(settings, processEnvironment);
  const configDir = (
    environment.CLAUDE_CONFIG_DIR ||
    path.join(environment.HOME || environment.USERPROFILE || NodeOS.homedir(), ".claude")
  ).normalize("NFC");
  const userStatePath = resolveClaudeUserStatePath(environment, configDir);
  const customEndpoint = isCustomClaudeApiEndpoint(
    yield* readClaudeSettingsBaseUrl(settings, processEnvironment, options.cwd),
  );
  const fallbackUser = currentUsername();
  return makeClaudeLimitResetClient({
    readToken: () =>
      readClaudeOAuthToken({
        configDir,
        env: environment,
        platform: options.platform ?? process.platform,
        fallbackUser,
        runSecurity: options.runSecurity ?? runSecurity,
        readFile: (file) => readFile(file, "utf8"),
        customEndpoint,
      }),
    readOrganizationUuid: async () => {
      try {
        const state = asRecord(JSON.parse(await readFile(userStatePath, "utf8")));
        return asTrimmedString(asRecord(state?.oauthAccount)?.organizationUuid);
      } catch {
        return null;
      }
    },
    refreshToken: options.refreshToken,
    fetch: options.fetch ?? ((url, init) => globalThis.fetch(url, init)),
    now: () => Date.now(),
  });
});

/**
 * The instance's `consumeResetCredit`. Claude needs the grant to claim; any
 * unsettled claim fails, so the coordinator keeps its request id pending.
 */
export const makeClaudeConsumeResetCredit =
  (client: Pick<ClaudeLimitResetClient, "claim">, driver: string, instanceId: string) =>
  (
    idempotencyKey: string,
    grantId?: string,
  ): Effect.Effect<UsageConsumeResetCreditResult, ProviderDriverError> =>
    grantId
      ? Effect.tryPromise({
          try: (signal) => client.claim(grantId, idempotencyKey, signal),
          catch: (cause) =>
            new ProviderDriverError({
              driver,
              instanceId,
              detail:
                cause instanceof ClaudeLimitResetRequestError
                  ? cause.message
                  : "Could not claim a Claude limit reset.",
              cause,
            }),
        })
      : Effect.fail(
          new ProviderDriverError({ driver, instanceId, detail: "Choose a limit reset to claim." }),
        );
