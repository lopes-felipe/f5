import { NONINTERACTIVE_GIT_ENV } from "../remoteInspection.ts";
import { runProcess } from "../../processRunner.ts";
import { ProfileGithubAccount } from "../ProfileGithubAccount";
import { readFile } from "node:fs/promises";
import { ServerConfig } from "../../config";
import { ServerSettingsService } from "../../serverSettings";
import { ServerSecretStore } from "../../auth/Services/ServerSecretStore";
import { profileGitEnvironment } from "../profileGitEnvironment";
import { managedGitProcessEnvironment } from "../gitProcessEnvironment.ts";
import { resolveGitExecutable } from "../../spawn/resolveCommand.ts";
import { terminateOnRelease } from "../../spawn/terminateOnRelease.ts";
/**
 * Git process helpers - Effect-native git execution with typed errors.
 *
 * Centralizes child-process git invocation for server modules. This module
 * only executes git commands and reports structured failures.
 *
 * @module GitServiceLive
 */
import { Effect, Layer, Option, Schema, Semaphore, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { GitCommandError } from "../Errors.ts";
import {
  ExecuteGitInput,
  ExecuteGitResult,
  GitService,
  GitServiceShape,
} from "../Services/GitService.ts";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1_000_000;
/**
 * Short commands share these slots across every service instance, so a burst
 * (status polling across many threads) cannot spawn unbounded processes and
 * stall the server. Longer or unbounded commands bypass the pool: a slow push
 * or clone never holds a slot that short commands wait on. Queue time does not
 * count toward a command's timeout.
 */
const gitProcesses = Semaphore.makeUnsafe(8);

function quoteGitCommand(args: ReadonlyArray<string>): string {
  return `git ${args.join(" ")}`;
}

function toGitCommandError(
  input: Pick<ExecuteGitInput, "operation" | "cwd" | "args">,
  detail: string,
) {
  return (cause: unknown) =>
    Schema.is(GitCommandError)(cause)
      ? cause
      : new GitCommandError({
          operation: input.operation,
          command: quoteGitCommand(input.args),
          cwd: input.cwd,
          detail: `${cause instanceof Error && cause.message.length > 0 ? cause.message : "Unknown error"} - ${detail}`,
          ...(cause !== undefined ? { cause } : {}),
        });
}

const collectOutput = Effect.fn(function* <E>(
  input: Pick<ExecuteGitInput, "operation" | "cwd" | "args">,
  stream: Stream.Stream<Uint8Array, E>,
  maxOutputBytes: number,
  consume?: (chunk: Uint8Array) => void,
): Effect.fn.Return<string, GitCommandError> {
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";

  yield* Stream.runForEach(stream, (chunk) =>
    Effect.gen(function* () {
      if (consume) {
        consume(chunk);
        // Streaming consumers still need bounded diagnostics on failure.
        text = (text + decoder.decode(chunk, { stream: true })).slice(-4096);
        return;
      }
      bytes += chunk.byteLength;
      if (bytes > maxOutputBytes) {
        return yield* new GitCommandError({
          operation: input.operation,
          command: quoteGitCommand(input.args),
          cwd: input.cwd,
          detail: `${quoteGitCommand(input.args)} output exceeded ${maxOutputBytes} bytes and was truncated.`,
        });
      }
      text += decoder.decode(chunk, { stream: true });
    }),
  ).pipe(Effect.mapError(toGitCommandError(input, "output stream failed.")));

  text += decoder.decode();
  return text;
});

const makeGitService = Effect.gen(function* () {
  const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const profileConfig = yield* Effect.serviceOption(ServerConfig);
  const profileSettings = yield* Effect.serviceOption(ServerSettingsService);
  const profileSecrets = yield* Effect.serviceOption(ServerSecretStore);

  const execute: GitServiceShape["execute"] = Effect.fnUntraced(function* (input) {
    const commandInput = {
      ...input,
      args: [...input.args],
    } as const;
    const timeoutMs = input.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : input.timeoutMs;
    const maxOutputBytes = input.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;

    const commandEffect = Effect.gen(function* () {
      let settings = Option.isSome(profileSettings)
        ? yield* profileSettings.value.getSettings.pipe(Effect.orElseSucceed(() => undefined))
        : undefined;
      if (!settings && Option.isSome(profileConfig) && profileConfig.value.settingsPath) {
        settings = yield* Effect.tryPromise({
          try: () =>
            readFile(profileConfig.value.settingsPath!, "utf8").then(
              (value) => JSON.parse(value),
              (cause: NodeJS.ErrnoException) => {
                if (cause.code === "ENOENT") return undefined;
                throw cause;
              },
            ),
          catch: toGitCommandError(commandInput, "Could not read profile Git identity settings."),
        });
      }
      const environment = Option.isSome(profileConfig)
        ? yield* Effect.tryPromise({
            try: () =>
              profileGitEnvironment({
                config: profileConfig.value,
                cwd: input.cwd,
                args: input.args,
                overrides: input.env,
                authorName: settings?.gitAuthorName ?? "",
                authorEmail: settings?.gitAuthorEmail ?? "",
                tokenForHost: async (host) => {
                  const value = Option.isSome(profileSecrets)
                    ? await new ProfileGithubAccount(
                        profileSecrets.value,
                        fetch,
                        profileConfig.value,
                      ).token(host)
                    : null;
                  return value;
                },
              }),
            catch: toGitCommandError(commandInput, "profile Git environment failed."),
          })
        : { ...process.env, ...input.env };

      const protectedEnvironment = yield* Effect.try({
        try: () => managedGitProcessEnvironment(environment),
        catch: toGitCommandError(commandInput, "Invalid Git process configuration."),
      });
      Object.assign(environment, protectedEnvironment);
      Object.assign(environment, NONINTERACTIVE_GIT_ENV, {
        SSH_ASKPASS_REQUIRE: "force",
        // Required mutation locks still apply. Passive reads must not write a
        // refreshed index beside a user's own Git operation or generation.
        GIT_OPTIONAL_LOCKS: "0",
      });
      if (["fetch", "push", "pull", "ls-remote", "clone"].includes(input.args[0] ?? "")) {
        const configured = environment.GIT_SSH_COMMAND
          ? null
          : yield* Effect.tryPromise({
              try: () =>
                runProcess("git", ["config", "--get", "--", "core.sshCommand"], {
                  cwd: input.cwd,
                  env: environment,
                  allowNonZeroExit: true,
                  timeoutMs: 10_000,
                }),
              catch: toGitCommandError(commandInput, "Could not resolve SSH configuration."),
            });
        const shellQuote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
        const ssh =
          environment.GIT_SSH_COMMAND ||
          configured?.stdout.trim() ||
          (environment.GIT_SSH ? shellQuote(environment.GIT_SSH) : "ssh");
        environment.GIT_SSH_COMMAND = /(?:plink|tortoiseplink)(?:\.exe)?(?:["' ]|$)/i.test(ssh)
          ? `${ssh} -batch`
          : `${ssh} -o BatchMode=yes -o ConnectTimeout=30 -o ServerAliveInterval=30 -o ServerAliveCountMax=3`;
      }

      // The pinned Effect NodeSink does not handle stdin "error" events. Git may
      // close input before a checkpoint write completes (especially on shutdown).
      // Use the shared native runner for input-fed commands and await its shutdown
      // before releasing the repository's calling scope.
      const runWithInput = Effect.acquireUseRelease(
        Effect.sync(() => {
          const controller = new AbortController();
          const pending = runProcess(resolveGitExecutable(environment), commandInput.args, {
            cwd: commandInput.cwd,
            env: environment,
            stdin: input.stdin,
            timeoutMs: null, // The enclosing Effect owns the command deadline.
            allowNonZeroExit: true,
            maxBufferBytes: maxOutputBytes,
            onStdoutChunk: input.onStdoutChunk,
            onStderrChunk: input.onStderrChunk,
            signal: controller.signal,
          });
          return { controller, pending };
        }),
        ({ pending }) =>
          Effect.tryPromise({
            try: () => pending,
            catch: toGitCommandError(commandInput, "stdin command failed."),
          }).pipe(
            Effect.flatMap((result) =>
              result.signal
                ? Effect.fail(
                    toGitCommandError(
                      commandInput,
                      "failed to report exit code.",
                    )(new Error("Git process exited with signal " + result.signal)),
                  )
                : Effect.succeed([result.stdout, result.stderr, result.code ?? 1] as const),
            ),
          ),
        ({ controller, pending }) =>
          Effect.promise(async () => {
            controller.abort();
            await pending.catch(() => {});
          }),
      );
      const runWithoutInput = Effect.gen(function* () {
        const child = yield* commandSpawner
          .spawn(
            ChildProcess.make(resolveGitExecutable(environment), commandInput.args, {
              cwd: commandInput.cwd,
              env: environment,
            }),
          )
          .pipe(
            Effect.mapError(toGitCommandError(commandInput, "failed to spawn.")),
            // Hooks, credential helpers and ssh can ignore SIGTERM on timeout.
            Effect.tap(terminateOnRelease),
            Effect.uninterruptible,
          );

        return yield* Effect.all(
          [
            collectOutput(commandInput, child.stdout, maxOutputBytes, input.onStdoutChunk),
            collectOutput(commandInput, child.stderr, maxOutputBytes, input.onStderrChunk),
            child.exitCode.pipe(
              Effect.map((value) => Number(value)),
              Effect.mapError(toGitCommandError(commandInput, "failed to report exit code.")),
            ),
          ],
          { concurrency: "unbounded" },
        );
      });
      const [stdout, stderr, exitCode] = yield* input.stdin === undefined
        ? runWithoutInput
        : runWithInput;

      if (!input.allowNonZeroExit && exitCode !== 0) {
        const trimmedStderr = stderr.trim();
        return yield* new GitCommandError({
          operation: commandInput.operation,
          command: quoteGitCommand(commandInput.args),
          cwd: commandInput.cwd,
          detail:
            trimmedStderr.length > 0
              ? `${quoteGitCommand(commandInput.args)} failed: ${trimmedStderr}`
              : `${quoteGitCommand(commandInput.args)} failed with code ${exitCode}.`,
        });
      }

      return { code: exitCode, stdout, stderr } satisfies ExecuteGitResult;
    });

    if (timeoutMs === null) return yield* commandEffect.pipe(Effect.scoped);

    const timed = commandEffect.pipe(
      Effect.scoped,
      Effect.timeoutOption(timeoutMs),
      Effect.flatMap((result) =>
        Option.match(result, {
          onNone: () =>
            Effect.fail(
              new GitCommandError({
                operation: commandInput.operation,
                command: quoteGitCommand(commandInput.args),
                cwd: commandInput.cwd,
                detail: `${quoteGitCommand(commandInput.args)} timed out.`,
              }),
            ),
          onSome: Effect.succeed,
        }),
      ),
    );
    return yield* timeoutMs > DEFAULT_TIMEOUT_MS ? timed : gitProcesses.withPermits(1)(timed);
  });

  return {
    execute,
  } satisfies GitServiceShape;
});

export const GitServiceLive = Layer.effect(GitService, makeGitService);
