/**
 * HarnessValidationLive - On-demand harness validation checks.
 *
 * Verifies supported provider CLIs are installed, authenticated enough to
 * start, and able to answer a minimal one-off prompt.
 *
 * @module HarnessValidationLive
 */
import { randomUUID } from "node:crypto";

import type {
  ProviderKind,
  ProviderStartOptions,
  ServerHarnessValidationResult,
} from "@t3tools/contracts";
import { ThreadId } from "@t3tools/contracts";
import { Cause, Effect, Exit, FileSystem, Layer, Path, Ref } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";

import {
  ProviderAdapterRequestError,
  ProviderUnsupportedError,
  ProviderValidationBusyError,
  type ProviderAdapterError,
} from "../Errors.ts";
import { HarnessValidation, type HarnessValidationShape } from "../Services/HarnessValidation.ts";
import { ProviderAdapterRegistry } from "../Services/ProviderAdapterRegistry.ts";
import {
  checkClaudeProviderPreflight,
  checkCodexProviderPreflight,
  type ProviderPreflightStatus,
} from "./ProviderHealth.ts";

const HARNESS_CONNECTIVITY_TIMEOUT_MS = 20_000;
const HARNESS_CONNECTIVITY_PROMPT = "Reply exactly with OK. Do not use tools.";
const HARNESS_VALIDATION_ORDER = [
  "claudeAgent",
  "codex",
] as const satisfies ReadonlyArray<ProviderKind>;
const HARNESS_VALIDATION_THREAD_PREFIX = "harness-validation:";
const HARNESS_VALIDATION_BUSY_MESSAGE = "Harness validation is already in progress.";

function harnessConnectivityTimeoutMs(): number {
  const override = Number.parseInt(process.env.T3_HARNESS_CONNECTIVITY_TIMEOUT_MS ?? "", 10);
  return Number.isFinite(override) && override > 0 ? override : HARNESS_CONNECTIVITY_TIMEOUT_MS;
}

function selectProviderOptions(
  provider: ProviderKind,
  providerOptions?: ProviderStartOptions,
): ProviderStartOptions | undefined {
  // Validation is harness-scoped only: never forward MCP config or other
  // cross-provider settings into the one-off connectivity probe.
  if (provider === "codex") {
    return providerOptions?.codex ? { codex: providerOptions.codex } : undefined;
  }
  return providerOptions?.claudeAgent ? { claudeAgent: providerOptions.claudeAgent } : undefined;
}

function connectivityTimeoutMessage(provider: ProviderKind): string {
  return provider === "codex"
    ? "Codex one-off prompt query timed out."
    : "Claude one-off prompt query timed out.";
}

function toHarnessMessage(
  error: ProviderAdapterError | ProviderUnsupportedError | unknown,
): string {
  const taggedError =
    error && typeof error === "object" && "_tag" in error
      ? (error as { _tag?: string; detail?: string; issue?: string })
      : null;

  switch (taggedError?._tag) {
    case "ProviderAdapterProcessError":
    case "ProviderAdapterRequestError":
      return taggedError.detail ?? "Validation failed.";
    case "ProviderAdapterValidationError":
      return taggedError.issue ?? "Validation failed.";
    case "ProviderUnsupportedError":
      return "Provider is not supported by this build.";
  }
  return "Validation failed.";
}

function buildFailureResult(
  status: ProviderPreflightStatus,
  failureKind: NonNullable<ServerHarnessValidationResult["failureKind"]>,
  message?: string,
): ServerHarnessValidationResult {
  return {
    provider: status.provider,
    status: "error",
    installed: failureKind !== "notInstalled",
    authStatus: failureKind === "unauthenticated" ? "unauthenticated" : status.authStatus,
    failureKind,
    checkedAt: status.checkedAt,
    ...(status.version ? { version: status.version } : {}),
    ...((message ?? status.message) ? { message: message ?? status.message } : {}),
  };
}

function buildReadyResult(status: ProviderPreflightStatus): ServerHarnessValidationResult {
  return {
    provider: status.provider,
    status: "ready",
    installed: true,
    authStatus: status.authStatus,
    checkedAt: status.checkedAt,
    ...(status.version ? { version: status.version } : {}),
    ...(status.message ? { message: status.message } : {}),
  };
}

function makeValidationThreadId(provider: ProviderKind) {
  return ThreadId.makeUnsafe(`${HARNESS_VALIDATION_THREAD_PREFIX}${provider}:${randomUUID()}`);
}

export const HarnessValidationLive = Layer.effect(
  HarnessValidation,
  Effect.gen(function* () {
    const registry = yield* ProviderAdapterRegistry;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const inFlight = yield* Ref.make(false);

    const validateProvider = (params: {
      readonly provider: ProviderKind;
      readonly providerOptions?: ProviderStartOptions;
    }) =>
      Effect.gen(function* () {
        const selectedProviderOptions = selectProviderOptions(
          params.provider,
          params.providerOptions,
        );
        const preflightInput = selectedProviderOptions
          ? {
              providerOptions: selectedProviderOptions,
            }
          : undefined;
        const preflight =
          params.provider === "codex"
            ? yield* checkCodexProviderPreflight(preflightInput).pipe(
                Effect.provideService(FileSystem.FileSystem, fileSystem),
                Effect.provideService(Path.Path, path),
                Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
              )
            : yield* checkClaudeProviderPreflight(preflightInput).pipe(
                Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
              );

        if (preflight.failureReason !== undefined || preflight.status === "error") {
          return buildFailureResult(preflight, preflight.failureReason ?? "preflight");
        }

        const connectivityExit = yield* Effect.scoped(
          Effect.gen(function* () {
            const adapterExit = yield* registry.getByProvider(params.provider).pipe(Effect.exit);
            if (Exit.isFailure(adapterExit)) {
              return buildFailureResult(
                preflight,
                "connectivity",
                toHarnessMessage(Cause.squash(adapterExit.cause)),
              );
            }
            const adapter = adapterExit.value;

            if (!adapter.runOneOffPrompt) {
              return buildFailureResult(
                preflight,
                "connectivity",
                toHarnessMessage(new ProviderUnsupportedError({ provider: params.provider })),
              );
            }

            const cwd = yield* fileSystem.makeTempDirectoryScoped({
              prefix: `t3-harness-validation-${params.provider}-`,
            });
            const providerOptions = selectedProviderOptions;
            const timeoutMs = harnessConnectivityTimeoutMs();
            const timeoutError = new ProviderAdapterRequestError({
              provider: params.provider,
              method: "runOneOffPrompt",
              detail: connectivityTimeoutMessage(params.provider),
            });
            const promptResult = yield* adapter
              .runOneOffPrompt({
                threadId: makeValidationThreadId(params.provider),
                provider: params.provider,
                prompt: HARNESS_CONNECTIVITY_PROMPT,
                cwd,
                ...(providerOptions ? { providerOptions } : {}),
                ...(params.provider === "codex"
                  ? { runtimeMode: "approval-required" as const }
                  : {}),
                timeoutMs,
              })
              .pipe(
                Effect.timeoutOrElse({
                  duration: timeoutMs,
                  onTimeout: () => Effect.fail(timeoutError),
                }),
                Effect.exit,
              );

            return Exit.isSuccess(promptResult)
              ? buildReadyResult(preflight)
              : buildFailureResult(
                  preflight,
                  "connectivity",
                  toHarnessMessage(Cause.squash(promptResult.cause)),
                );
          }),
        ).pipe(Effect.exit);

        return Exit.isSuccess(connectivityExit)
          ? connectivityExit.value
          : buildFailureResult(
              preflight,
              "connectivity",
              toHarnessMessage(Cause.squash(connectivityExit.cause)),
            );
      });

    const validate: HarnessValidationShape["validate"] = (input) =>
      Effect.gen(function* () {
        const acquired = yield* Ref.modify(inFlight, (busy) => [!busy, true]);
        if (!acquired) {
          return yield* new ProviderValidationBusyError({
            message: HARNESS_VALIDATION_BUSY_MESSAGE,
          });
        }

        return yield* Effect.all(
          HARNESS_VALIDATION_ORDER.map((provider) =>
            validateProvider(
              input?.providerOptions
                ? {
                    provider,
                    providerOptions: input.providerOptions,
                  }
                : {
                    provider,
                  },
            ),
          ),
          { concurrency: 2 },
        ).pipe(Effect.ensuring(Ref.set(inFlight, false)));
      });

    return {
      validate,
    } satisfies HarnessValidationShape;
  }),
);
