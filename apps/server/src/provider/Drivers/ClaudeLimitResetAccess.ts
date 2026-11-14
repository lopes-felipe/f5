import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import * as NodeOS from "node:os";

import type { ClaudeSettings } from "@t3tools/contracts";
import { Effect, FileSystem, Path } from "effect";

import {
  makeClaudeLimitResetClient,
  readClaudeOAuthToken,
  type ClaudeLimitResetClient,
} from "../../usage/claudeLimitResets.ts";
import { asRecord, asTrimmedString } from "../../usage/accountUsageJson.ts";
import { isCustomClaudeApiEndpoint } from "../Layers/ClaudeProvider.ts";
import { resolveClaudeUserStatePath } from "../claudeInventory.ts";
import { makeClaudeEnvironment, readClaudeSettingsBaseUrl } from "./ClaudeHome.ts";

const SECURITY_TIMEOUT_MS = 10_000;

function runSecurity(args: ReadonlyArray<string>): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "/usr/bin/security",
      [...args],
      { timeout: SECURITY_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        // Never include stdout in the error: it holds the credentials payload.
        if (error) reject(new Error(`security exited with ${error.code ?? "an error"}`));
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
        platform: process.platform,
        fallbackUser,
        runSecurity,
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
    fetch: (url, init) => globalThis.fetch(url, init),
    now: () => Date.now(),
  });
});
