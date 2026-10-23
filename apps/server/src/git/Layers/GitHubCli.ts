import { ProfileGithubAccount, assertGithubCredentialsAvailable } from "../ProfileGithubAccount";
import { isGithubPlaceholderToken } from "../GithubCliProjection";
import { buildAccountExecutionEnvironment } from "../../providerProcessEnv";
import * as NodePath from "node:path";
import { ServerConfig } from "../../config";
import { ServerSettingsService } from "../../serverSettings";
import { ServerSecretStore } from "../../auth/Services/ServerSecretStore";
import { normalizeGitHubCliError } from "../githubCliError.ts";
import { enforceGitHubRequestPolicy } from "../githubRequestPolicy.ts";
import { isCapturedPrTarget } from "../githubPrTarget.ts";
import { githubRequestScheduler } from "../githubRequestScheduler.ts";
import { makeGitHubHttpTransport } from "../githubHttpTransport.ts";
import { makeGitHubApi, GitHubCredentialScope, githubCredentialEnvironment } from "../githubApi.ts";
import { Effect, Layer, Option } from "effect";
import { makeGitHubHttpOperations } from "../githubHttpOperations.ts";
import { managedGitProcessEnvironment } from "../gitProcessEnvironment.ts";

import { runProcess } from "../../processRunner";
import { GitHubCliError } from "../Errors.ts";
import { GitHubCli, type GitHubCliShape } from "../Services/GitHubCli.ts";

const DEFAULT_TIMEOUT_MS = 30_000;

export const makeGitHubCli = (
  options: {
    resolveToken?: (host: string, cwd: string) => Effect.Effect<string, GitHubCliError>;
    scheduler?: typeof githubRequestScheduler;
  } = {},
) =>
  Effect.gen(function* () {
    const scheduler = options.scheduler ?? githubRequestScheduler;
    const secretStore = yield* Effect.serviceOption(ServerSecretStore);
    const serverConfig = yield* Effect.serviceOption(ServerConfig);
    const serverSettings = yield* Effect.serviceOption(ServerSettingsService);
    const isolated = Option.isSome(serverConfig);
    const execute: GitHubCliShape["execute"] = (input) =>
      Effect.gen(function* () {
        const capture = yield* Effect.serviceOption(GitHubCredentialScope);
        const context = input.env === undefined && Option.isSome(capture) ? capture.value : null;
        const args = [...input.args];
        if (context && args[0] === "api") {
          const hostIndex = args.indexOf("--hostname");
          if (hostIndex >= 0 && args[hostIndex + 1]?.toLowerCase() !== context.host) {
            return yield* new GitHubCliError({
              operation: "execute",
              kind: "forbidden",
              detail: "GitHub request host does not match the captured account.",
            });
          }
          if (hostIndex < 0) args.push("--hostname", context.host);
        }
        if (context && !isCapturedPrTarget(args, context.host))
          return yield* new GitHubCliError({
            operation: "execute",
            kind: "forbidden",
            detail:
              "A credential-scoped `gh pr` command must name its target explicitly: pass " +
              `--repo <owner>/<name> or a full https://${context.host}/ pull request URL.`,
          });
        const command = Effect.try({
          try: () => {
            if (Option.isSome(serverConfig))
              assertGithubCredentialsAvailable(serverConfig.value.stateDir);
          },
          catch: (cause) =>
            new GitHubCliError({
              operation: "execute",
              kind: "unauthenticated",
              detail:
                "GitHub credentials are unavailable. Reconnect in Settings > Integrations > GitHub.",
              cause,
            }),
        }).pipe(
          Effect.andThen(
            Effect.tryPromise({
              try: (signal) => {
                if (
                  input.stdin !== undefined &&
                  Buffer.byteLength(input.stdin, "utf8") > 1024 * 1024
                ) {
                  return Promise.reject(new Error("GitHub request exceeds the 1 MiB body limit."));
                }
                const supplied = context ? githubCredentialEnvironment(context) : input.env;
                const environment = Option.isSome(serverConfig)
                  ? buildAccountExecutionEnvironment({
                      purpose: "git",
                      profile: serverConfig.value.profile,
                      stateDir: serverConfig.value.stateDir,
                      baseEnv: supplied ?? process.env,
                    })
                  : { ...(supplied ?? process.env) };
                if (context) {
                  environment.GH_HOST = context.host;
                  delete environment.GH_REPO;
                }
                // Only the explicit credential scope may restore tokens stripped from the inherited base.
                for (const key of [
                  "GH_TOKEN",
                  "GITHUB_TOKEN",
                  "GH_ENTERPRISE_TOKEN",
                  "GITHUB_ENTERPRISE_TOKEN",
                ]) {
                  if (isolated || supplied) delete environment[key];
                  if (supplied?.[key]) environment[key] = supplied[key];
                }
                if (isolated && !context && !input.env)
                  for (const key of Object.keys(environment))
                    if (
                      /^(?:GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|GITHUB_ENTERPRISE_TOKEN|GH_CONFIG_DIR|GH_DEBUG)$/i.test(
                        key,
                      )
                    )
                      if (isolated || supplied) delete environment[key];
                if (isolated && Option.isSome(serverConfig))
                  environment.GH_CONFIG_DIR = NodePath.join(serverConfig.value.stateDir, "github");
                return runProcess("gh", args, {
                  cwd: input.cwd,
                  env: environment,
                  timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
                  allowNonZeroExit: input.allowNonZeroExit ?? false,
                  stdin: input.stdin,
                  signal: input.signal ? AbortSignal.any([signal, input.signal]) : signal,
                  maxStdoutBytes: input.maxStdoutBytes ?? 8 * 1024 * 1024,
                  outputMode: "error",
                });
              },
              catch: (error) => normalizeGitHubCliError("execute", error),
            }),
          ),
        );

        if (!context) return yield* command;
        // Classify by proving a read, never by failing to recognise a write: `gh api`
        // defaults to POST as soon as a body is supplied, and `gh pr` keeps growing
        // mutating subcommands. Anything unrecognised is treated as a write.
        const methodIndex = Math.max(args.indexOf("--method"), args.indexOf("-X"));
        const method = methodIndex >= 0 ? args[methodIndex + 1]?.toUpperCase() : undefined;
        const bodyFlags = ["--input", "--field", "--raw-field", "-F", "-f"];
        const sendsBody = args.some(
          (arg) => bodyFlags.includes(arg) || bodyFlags.some((flag) => arg.startsWith(`${flag}=`)),
        );
        const writes =
          args[0] === "pr"
            ? !["list", "view", "diff", "status", "checks"].includes(args[1] ?? "")
            : args[0] === "api"
              ? method === undefined
                ? sendsBody
                : method !== "GET" && method !== "HEAD"
              : false;
        const checked = writes
          ? Effect.gen(function* () {
              const current = yield* api.getCredentialContext({
                cwd: input.cwd,
                host: context.host,
              });
              if (current.generation !== context.generation)
                return yield* new GitHubCliError({
                  operation: "execute",
                  kind: "forbidden",
                  detail: "The GitHub account changed before the write. Nothing was sent.",
                });
              return yield* enforceGitHubRequestPolicy(command, true);
            })
          : enforceGitHubRequestPolicy(command, false);
        return yield* scheduler.run(
          context.host,
          writes ? "write" : args[0] === "search" ? "search" : "rest",
          checked,
        );
      });

    const cliTokens = new Map<string, { token: string; expires: number }>();
    const httpTransport = makeGitHubHttpTransport();
    // `githubTransport: "gh"` sends the same captured requests through `gh api`,
    // as before the HTTP move. Read per request so the setting applies at once.
    const transport: GitHubCliShape["execute"] = (input) =>
      (Option.isSome(serverSettings)
        ? serverSettings.value.getSettings.pipe(
            Effect.map((settings) => settings.githubTransport),
            Effect.orElseSucceed(() => "http" as const),
          )
        : Effect.succeed("http" as const)
      ).pipe(Effect.flatMap((mode) => (mode === "gh" ? execute(input) : httpTransport(input))));
    const api = makeGitHubApi(
      transport,
      scheduler,
      (host, cwd) =>
        Effect.gen(function* () {
          if (options.resolveToken) return yield* options.resolveToken(host, cwd);
          const saved = Option.isSome(secretStore)
            ? yield* Effect.tryPromise({
                try: () =>
                  new ProfileGithubAccount(
                    secretStore.value,
                    fetch,
                    Option.isSome(serverConfig) ? serverConfig.value : undefined,
                  ).token(host),
                catch: (cause) =>
                  new GitHubCliError({
                    operation: "credentials",
                    kind: "unauthenticated",
                    detail: String(cause),
                  }),
              })
            : null;
          if (saved || isolated) return saved ?? "";
          const names =
            host === "github.com"
              ? ["GH_TOKEN", "GITHUB_TOKEN"]
              : ["GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"];
          const ambient = names
            .map(
              (name) =>
                Object.entries(process.env).find(([key]) => key.toUpperCase() === name)?.[1],
            )
            .find((value) => value?.trim());
          if (ambient) return ambient.trim();
          // The profile projection answers disconnected hosts with a placeholder, and gh exits
          // non-zero ("no oauth token") for hosts it does not know. Both mean "not connected";
          // anything else (timeout, missing gh, unavailable credentials) keeps its real cause.
          const cachedToken = cliTokens.get(host);
          if (cachedToken && cachedToken.expires > Date.now()) return cachedToken.token;
          const projected = yield* execute({
            cwd,
            args: ["auth", "token", "--hostname", host],
            maxStdoutBytes: 65536,
          }).pipe(
            Effect.map((result) => result.stdout.trim()),
            Effect.catch((error) =>
              error.kind === "unauthenticated" ? Effect.succeed("") : Effect.fail(error),
            ),
          );
          const token = isGithubPlaceholderToken(projected) ? "" : projected;
          cliTokens.set(host, { token, expires: Date.now() + (token ? 300_000 : 10_000) });
          return token;
        }),
      {
        invalidateToken: (host) => {
          cliTokens.delete(host);
        },
      },
    );
    const operations = makeGitHubHttpOperations(api, (cwd, args) =>
      Effect.tryPromise({
        try: (signal) =>
          runProcess("git", args, {
            cwd,
            env: managedGitProcessEnvironment(process.env),
            signal,
            timeoutMs: 5_000,
            maxStdoutBytes: 64 * 1024,
            allowNonZeroExit: true,
          }),
        catch: () =>
          new GitHubCliError({
            operation: "repository",
            kind: "generic",
            detail: "Could not read this checkout's GitHub repository configuration.",
          }),
      }).pipe(
        Effect.flatMap((result) =>
          !result.timedOut &&
          !result.signal &&
          !result.aborted &&
          !result.stdoutTruncated &&
          (result.code === 0 || result.code === 1)
            ? Effect.succeed(result.stdout)
            : Effect.fail(
                new GitHubCliError({
                  operation: "repository",
                  kind: "generic",
                  detail: "Could not read this checkout's GitHub repository configuration.",
                }),
              ),
        ),
      ),
    );
    return {
      ...api,
      ...operations,
      execute,
      checkoutPullRequest: (input) =>
        execute({
          cwd: input.cwd,
          args: ["pr", "checkout", input.reference, ...(input.force ? ["--force"] : [])],
        }).pipe(Effect.asVoid),
    } satisfies GitHubCliShape;
  });

export const GitHubCliLive = Layer.effect(GitHubCli, makeGitHubCli());
