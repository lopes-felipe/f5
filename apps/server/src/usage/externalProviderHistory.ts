import { execFile } from "node:child_process";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { Effect } from "effect";
import { makeNativeHistoryCapability } from "./nativeHistory.ts";
import { usageHistoryCutoff } from "./museHistory.ts";
import { readOpenCodeUsage } from "./opencodeUsageReader.ts";
import { readAntigravityUsage } from "./antigravityUsageReader.ts";
import { cursorAccountIdentity, readCursorAccountUsage } from "./cursorUsageReader.ts";
import { antigravityProfilesDirectory } from "../provider/acp/AntigravityAcpSupport.ts";

function canonical(directory: string) {
  const absolute = path.resolve(directory);
  return realpath(absolute).catch(() => absolute);
}

const cutoff = (retention: Parameters<typeof usageHistoryCutoff>[1]) =>
  Date.parse(usageHistoryCutoff(Date.now(), retention));

export function makeOpenCodeUsageHistory(env: NodeJS.ProcessEnv, enabled: boolean) {
  const home = env.HOME?.trim() || homedir();
  const root =
    env.OPENCODE_DATA_DIR?.trim() ||
    path.join(
      env.XDG_DATA_HOME && path.isAbsolute(env.XDG_DATA_HOME)
        ? env.XDG_DATA_HOME
        : path.join(home, ".local", "share"),
      "opencode",
    );
  return makeNativeHistoryCapability({
    provider: "opencode",
    displayName: "OpenCode",
    enabled,
    discover: Effect.promise(() => canonical(root)),
    scan: (source, retention) =>
      Effect.tryPromise(async (signal) => {
        const result = await readOpenCodeUsage(source, cutoff(retention), signal);
        if (result.error) {
          throw new Error("OpenCode usage history could not be read.");
        }
        return result.files.flatMap(({ records }) => records);
      }),
  });
}

export function makeAntigravityUsageHistory(
  env: NodeJS.ProcessEnv,
  profileDirectory: string,
  enabled: boolean,
) {
  const home = env.HOME?.trim() || homedir();
  const roots = [
    path.join(profileDirectory, "antigravity-acp"),
    ...(env.ANTIGRAVITY_DATA_DIR?.split(",")
      .map((root) => root.trim())
      .filter(Boolean) ?? [
      ...["antigravity", "antigravity-cli", "antigravity-ide", "antigravity-backup"].map((name) =>
        path.join(home, ".gemini", name),
      ),
      path.join(home, ".config", "antigravity"),
    ]),
  ];
  return makeNativeHistoryCapability({
    provider: "antigravity",
    displayName: "Antigravity",
    enabled,
    discover: Effect.promise(() => canonical(profileDirectory)),
    scan: (_, retention) =>
      Effect.tryPromise(async (signal) => {
        const directories = await Promise.all(roots.map(antigravityConversationDirectory));
        const files = await scanAntigravityHistory(directories, retention, signal);
        return files.flatMap(({ records }) => records);
      }),
  });
}

async function antigravityConversationDirectory(root: string) {
  const nested = path.join(root, "conversations");
  const hasNested = await stat(nested).then(
    (entry) => entry.isDirectory(),
    () => false,
  );
  return canonical(hasNested ? nested : root);
}

async function scanAntigravityHistory(
  directories: string[],
  retention: Parameters<typeof cutoff>[0],
  signal: AbortSignal,
) {
  const { files, errors } = await readAntigravityUsage(
    [...new Set(directories)],
    cutoff(retention),
    signal,
  );
  if (errors.length) throw new Error("Antigravity usage history could not be read.");
  return files;
}

export function makeRetiredAntigravityUsageHistory<E>(
  stateDir: string,
  configuredProfiles: Effect.Effect<ReadonlySet<string>, E>,
) {
  const profiles = antigravityProfilesDirectory(stateDir);
  return makeNativeHistoryCapability({
    provider: "antigravity",
    displayName: "Antigravity",
    enabled: true,
    discover: Effect.promise(() => canonical(profiles)),
    scan: (directory, retention) =>
      Effect.flatMap(configuredProfiles, (configured) =>
        Effect.tryPromise(async (signal) => {
          const entries = await readdir(directory, { withFileTypes: true }).catch(
            (error: NodeJS.ErrnoException) => {
              if (error.code === "ENOENT") return [];
              throw error;
            },
          );
          const profileByRoot = new Map<string, string>();
          for (const entry of entries) {
            signal.throwIfAborted();
            if (
              !entry.isDirectory() ||
              !/^[a-f0-9]{64}$/.test(entry.name) ||
              configured.has(entry.name)
            )
              continue;
            const profile = path.join(directory, entry.name);
            const root = await antigravityConversationDirectory(
              path.join(profile, "antigravity-acp"),
            );
            if (root.startsWith(profile + path.sep)) profileByRoot.set(root, entry.name);
          }
          const files = await scanAntigravityHistory([...profileByRoot.keys()], retention, signal);
          return files.flatMap(({ root, records }) =>
            records.map((record) => ({
              ...record,
              retiredAntigravityProfile: profileByRoot.get(root)!,
            })),
          );
        }),
      ),
  });
}

const runFile = promisify(execFile);

export function makeCursorUsageHistory(env: NodeJS.ProcessEnv, endpoint: string, enabled: boolean) {
  const home = env.HOME?.trim() || homedir();
  const directory =
    process.platform === "darwin"
      ? path.join(home, ".cursor")
      : process.platform === "win32"
        ? path.join(env.APPDATA || path.join(home, "AppData", "Roaming"), "Cursor")
        : path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "cursor");
  const authFile = path.join(directory, "auth.json");
  const explicitToken = env.CURSOR_AUTH_TOKEN?.trim();
  const store = env.AGENT_CLI_CREDENTIAL_STORE;
  const customEndpoint =
    (endpoint.trim() || env.CURSOR_API_ENDPOINT?.trim() || "https://api2.cursor.sh").replace(
      /\/$/,
      "",
    ) !== "https://api2.cursor.sh";
  const canUseKeychain = process.platform === "darwin" && home === homedir() && store !== "file";
  return makeNativeHistoryCapability({
    provider: "cursor",
    displayName: "Cursor",
    enabled: enabled && !customEndpoint && !env.CURSOR_API_KEY?.trim() && store !== "memory",
    discover: Effect.succeed("cursor"),
    resolveAccount: Effect.tryPromise(async (signal) => {
      const accessToken =
        explicitToken ??
        (canUseKeychain
          ? (
              await runFile(
                "/usr/bin/security",
                ["find-generic-password", "-a", "cursor-user", "-s", "cursor-access-token", "-w"],
                { signal, timeout: 10_000, maxBuffer: 16_384 },
              )
            ).stdout.trim()
          : (
              JSON.parse(await readFile(authFile, { encoding: "utf8", signal })) as {
                accessToken?: unknown;
              }
            ).accessToken);
      if (typeof accessToken !== "string" || !accessToken)
        throw new Error("Cursor login is missing.");
      return {
        source: `cursor:${cursorAccountIdentity(accessToken).accountKey}`,
        token: accessToken,
      };
    }),
    scan: (_, retention, accessToken) =>
      Effect.tryPromise(async (signal) => {
        if (!accessToken) throw new Error("Cursor login is missing.");
        const result = await readCursorAccountUsage(
          accessToken,
          cutoff(retention),
          Date.now(),
          fetch,
          signal,
        );
        if (result.error) {
          const error = new Error(result.error);
          if (result.missing) error.name = "CursorAuthenticationError";
          throw error;
        }
        return result.records;
      }),
  });
}
