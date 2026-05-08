/**
 * HarnessValidationLive - On-demand harness validation checks.
 *
 * Verifies supported provider CLIs are installed, authenticated enough to
 * start, and, where the adapter supports it, able to answer a minimal
 * one-off prompt.
 *
 * @module HarnessValidationLive
 */
import { randomUUID } from "node:crypto";

import type {
  CursorSettings,
  OpenCodeSettings,
  ProviderKind,
  ProviderStartOptions,
  ServerHarnessValidationResult,
  ServerProviderState,
  ServerSettings,
} from "@t3tools/contracts";
import { DEFAULT_SERVER_SETTINGS, ThreadId } from "@t3tools/contracts";
import { Cause, Effect, Exit, FileSystem, Layer, Option, Path, Ref, Result } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";

import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
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
import { checkOpenCodeProviderStatus } from "./OpenCodeProvider.ts";
import { parseCursorAboutOutput } from "./CursorProvider.ts";
import { OpenCodeRuntime } from "../opencodeRuntime.ts";
import { isCommandMissingCause as isProviderSnapshotCommandMissingCause } from "../providerSnapshot.ts";
import { runProviderCliCommand, type ProviderCliCommandResult } from "../providerCli.ts";

const HARNESS_CONNECTIVITY_TIMEOUT_MS = 20_000;
const CURSOR_HARNESS_ABOUT_TIMEOUT_MS = 10_000;
const HARNESS_CONNECTIVITY_PROMPT = "Reply exactly with OK. Do not use tools.";
const HARNESS_VALIDATION_ORDER = [
  "claudeAgent",
  "codex",
  "cursor",
  "opencode",
] as const satisfies ReadonlyArray<ProviderKind>;
const HARNESS_VALIDATION_THREAD_PREFIX = "harness-validation:";
const HARNESS_VALIDATION_BUSY_MESSAGE = "Harness validation is already in progress.";

function harnessConnectivityTimeoutMs(): number {
  const override = Number.parseInt(process.env.T3_HARNESS_CONNECTIVITY_TIMEOUT_MS ?? "", 10);
  return Number.isFinite(override) && override > 0 ? override : HARNESS_CONNECTIVITY_TIMEOUT_MS;
}

function selectProviderOptions(
  provider: ProviderKind,
  settings: ServerSettings,
  providerOptions?: ProviderStartOptions,
): ProviderStartOptions | undefined {
  // Validation is harness-scoped only: never forward MCP config or other
  // cross-provider settings into the one-off connectivity probe.
  if (provider === "codex") {
    return mergeCodexProviderOptions(settings, providerOptions);
  }
  if (provider === "claudeAgent") {
    return mergeClaudeProviderOptions(settings, providerOptions);
  }
  if (provider === "cursor") {
    return providerOptions?.cursor ? { cursor: providerOptions.cursor } : undefined;
  }
  return providerOptions?.opencode ? { opencode: providerOptions.opencode } : undefined;
}

function connectivityTimeoutMessage(provider: ProviderKind): string {
  switch (provider) {
    case "codex":
      return "Codex one-off prompt query timed out.";
    case "claudeAgent":
      return "Claude one-off prompt query timed out.";
    case "cursor":
      return "Cursor one-off prompt query timed out.";
    case "opencode":
      return "OpenCode one-off prompt query timed out.";
  }
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

function supportsOneOffConnectivityProbe(provider: ProviderKind): boolean {
  return provider === "codex" || provider === "claudeAgent";
}

function mergeCodexProviderOptions(
  settings: ServerSettings,
  providerOptions?: ProviderStartOptions,
): ProviderStartOptions | undefined {
  const settingsOptions = settings.providers.codex;
  const codex = {
    ...(settingsOptions.binaryPath ? { binaryPath: settingsOptions.binaryPath } : {}),
    ...(settingsOptions.homePath ? { homePath: settingsOptions.homePath } : {}),
    ...providerOptions?.codex,
  };
  return Object.keys(codex).length > 0 ? { codex } : undefined;
}

function mergeClaudeProviderOptions(
  settings: ServerSettings,
  providerOptions?: ProviderStartOptions,
): ProviderStartOptions | undefined {
  const settingsOptions = settings.providers.claudeAgent;
  const claudeAgent = {
    ...(settingsOptions.binaryPath ? { binaryPath: settingsOptions.binaryPath } : {}),
    ...providerOptions?.claudeAgent,
  };
  return Object.keys(claudeAgent).length > 0 ? { claudeAgent } : undefined;
}

function cursorSettingsForValidation(
  settings: ServerSettings,
  providerOptions?: ProviderStartOptions,
): CursorSettings {
  const overrides = providerOptions?.cursor;
  return {
    ...settings.providers.cursor,
    ...(overrides?.binaryPath ? { binaryPath: overrides.binaryPath } : {}),
    ...(overrides?.apiEndpoint ? { apiEndpoint: overrides.apiEndpoint } : {}),
  };
}

function openCodeSettingsForValidation(
  settings: ServerSettings,
  providerOptions?: ProviderStartOptions,
): OpenCodeSettings {
  const overrides = providerOptions?.opencode;
  return {
    ...settings.providers.opencode,
    ...(overrides?.binaryPath ? { binaryPath: overrides.binaryPath } : {}),
    ...(overrides?.serverUrl ? { serverUrl: overrides.serverUrl } : {}),
    ...(overrides?.serverPassword ? { serverPassword: overrides.serverPassword } : {}),
  };
}

function providerDisabledPreflight(provider: ProviderKind, checkedAt = new Date().toISOString()) {
  return {
    provider,
    status: "error" as const,
    available: false,
    authStatus: "unknown" as const,
    checkedAt,
    failureReason: "preflight" as const,
    message: `${providerDisplayName(provider)} is disabled in settings.`,
  } satisfies ProviderPreflightStatus;
}

function providerDisplayName(provider: ProviderKind): string {
  switch (provider) {
    case "codex":
      return "Codex";
    case "claudeAgent":
      return "Claude";
    case "cursor":
      return "Cursor";
    case "opencode":
      return "OpenCode";
  }
}

function providerStatusToPreflightStatus(status: ServerProviderState) {
  return status === "ready" || status === "warning" ? status : "error";
}

function failureKindFromProviderSnapshot(snapshot: {
  readonly auth: { readonly status: ProviderPreflightStatus["authStatus"] };
  readonly enabled: boolean;
  readonly installed: boolean;
  readonly message?: string | undefined;
  readonly status: ServerProviderState;
}): NonNullable<ServerHarnessValidationResult["failureKind"]> | undefined {
  if (!snapshot.enabled || snapshot.status === "disabled") {
    return "preflight";
  }
  if (!snapshot.installed) {
    return "notInstalled";
  }
  if (snapshot.auth.status === "unauthenticated") {
    return "unauthenticated";
  }
  if (snapshot.status !== "error") {
    return undefined;
  }

  const message = snapshot.message?.toLowerCase() ?? "";
  if (message.includes("too old") || message.includes("upgrade") || message.includes("requires")) {
    return "unsupportedVersion";
  }
  if (message.includes("timed out") || message.includes("timeout")) {
    return "versionProbeTimeout";
  }
  return "preflight";
}

function providerSnapshotToPreflightStatus(
  provider: ProviderKind,
  snapshot: {
    readonly auth: { readonly status: ProviderPreflightStatus["authStatus"] };
    readonly checkedAt: string;
    readonly enabled: boolean;
    readonly installed: boolean;
    readonly message?: string | undefined;
    readonly status: ServerProviderState;
    readonly version: string | null;
  },
): ProviderPreflightStatus {
  const failureReason = failureKindFromProviderSnapshot(snapshot);
  return {
    provider,
    status: providerStatusToPreflightStatus(snapshot.status),
    available: snapshot.enabled && snapshot.installed && snapshot.status !== "error",
    authStatus: snapshot.auth.status,
    checkedAt: snapshot.checkedAt,
    ...(failureReason ? { failureReason } : {}),
    ...(snapshot.version ? { version: snapshot.version } : {}),
    ...(snapshot.message ? { message: snapshot.message } : {}),
  };
}

function cursorAboutFailureMessage(
  result: ProviderCliCommandResult & { readonly timedOut?: boolean },
): string {
  const stderr = result.stderr.trim();
  if (stderr) return stderr;
  const stdout = result.stdout.trim();
  if (stdout) return stdout;
  if (result.timedOut) return "Timed out while running `agent about`.";
  return `Command exited with code ${result.code}.`;
}

function isCursorCommandMissingCause(error: unknown): boolean {
  return error instanceof Error && isProviderSnapshotCommandMissingCause(error);
}

function checkCursorProviderPreflight(
  cursorSettings: CursorSettings,
): Effect.Effect<ProviderPreflightStatus, never, ChildProcessSpawner.ChildProcessSpawner> {
  const checkedAt = new Date().toISOString();
  if (!cursorSettings.enabled) {
    return Effect.succeed(providerDisabledPreflight("cursor", checkedAt));
  }

  const binaryPath = cursorSettings.binaryPath;
  return runProviderCliCommand(binaryPath, ["about"], {
    binaryPath,
  }).pipe(
    Effect.timeoutOption(CURSOR_HARNESS_ABOUT_TIMEOUT_MS),
    Effect.result,
    Effect.map((probe) => {
      if (Result.isFailure(probe)) {
        const error = probe.failure;
        const commandMissing = isCursorCommandMissingCause(error);
        return {
          provider: "cursor",
          status: "error" as const,
          available: false,
          authStatus: "unknown" as const,
          checkedAt,
          failureReason: commandMissing ? "notInstalled" : "versionProbeFailed",
          message: commandMissing
            ? "Cursor Agent CLI (`agent`) is not installed or not on PATH."
            : `Failed to execute Cursor Agent CLI health check: ${error instanceof Error ? error.message : String(error)}.`,
        } satisfies ProviderPreflightStatus;
      }

      if (Option.isNone(probe.success)) {
        return {
          provider: "cursor",
          status: "error" as const,
          available: false,
          authStatus: "unknown" as const,
          checkedAt,
          failureReason: "versionProbeTimeout",
          message: "Cursor Agent CLI is installed but timed out while running `agent about`.",
        } satisfies ProviderPreflightStatus;
      }

      const result = probe.success.value;
      const parsed = parseCursorAboutOutput(result);
      if (result.code !== 0 && parsed.status === "ready") {
        return {
          provider: "cursor",
          status: "error" as const,
          available: false,
          authStatus: parsed.auth.status,
          checkedAt,
          failureReason: "versionProbeFailed",
          ...(parsed.version ? { version: parsed.version } : {}),
          message: cursorAboutFailureMessage(result),
        } satisfies ProviderPreflightStatus;
      }

      const failureReason =
        parsed.auth.status === "unauthenticated"
          ? "unauthenticated"
          : parsed.status === "ready"
            ? undefined
            : "preflight";

      return {
        provider: "cursor",
        status: parsed.status,
        available: parsed.status !== "error",
        authStatus: parsed.auth.status,
        checkedAt,
        ...(failureReason ? { failureReason } : {}),
        ...(parsed.version ? { version: parsed.version } : {}),
        ...(parsed.message ? { message: parsed.message } : {}),
      } satisfies ProviderPreflightStatus;
    }),
  );
}

export const HarnessValidationLive = Layer.effect(
  HarnessValidation,
  Effect.gen(function* () {
    const registry = yield* ProviderAdapterRegistry;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const serverConfig = yield* ServerConfig;
    const serverSettings = yield* ServerSettingsService;
    const openCodeRuntime = yield* OpenCodeRuntime;
    const inFlight = yield* Ref.make(false);

    const runProviderPreflight = (params: {
      readonly provider: ProviderKind;
      readonly settings: ServerSettings;
      readonly providerOptions?: ProviderStartOptions;
    }) => {
      switch (params.provider) {
        case "codex": {
          if (!params.settings.providers.codex.enabled) {
            return Effect.succeed(providerDisabledPreflight("codex"));
          }
          const providerOptions = mergeCodexProviderOptions(
            params.settings,
            params.providerOptions,
          );
          const preflightInput = providerOptions ? { providerOptions } : undefined;
          return checkCodexProviderPreflight(preflightInput).pipe(
            Effect.provideService(FileSystem.FileSystem, fileSystem),
            Effect.provideService(Path.Path, path),
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
          );
        }
        case "claudeAgent": {
          if (!params.settings.providers.claudeAgent.enabled) {
            return Effect.succeed(providerDisabledPreflight("claudeAgent"));
          }
          const providerOptions = mergeClaudeProviderOptions(
            params.settings,
            params.providerOptions,
          );
          const preflightInput = providerOptions ? { providerOptions } : undefined;
          return checkClaudeProviderPreflight(preflightInput).pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
          );
        }
        case "cursor":
          return checkCursorProviderPreflight(
            cursorSettingsForValidation(params.settings, params.providerOptions),
          ).pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
          );
        case "opencode": {
          const snapshot = checkOpenCodeProviderStatus(
            openCodeSettingsForValidation(params.settings, params.providerOptions),
            serverConfig.cwd,
            process.env,
          ).pipe(Effect.provideService(OpenCodeRuntime, openCodeRuntime));
          return Effect.map(snapshot, (providerSnapshot) =>
            providerSnapshotToPreflightStatus("opencode", providerSnapshot),
          );
        }
      }
    };

    const validateProvider = (params: {
      readonly provider: ProviderKind;
      readonly settings: ServerSettings;
      readonly providerOptions?: ProviderStartOptions;
    }) =>
      Effect.gen(function* () {
        const selectedProviderOptions = selectProviderOptions(
          params.provider,
          params.settings,
          params.providerOptions,
        );
        const preflight = yield* runProviderPreflight({
          provider: params.provider,
          settings: params.settings,
          ...(params.providerOptions ? { providerOptions: params.providerOptions } : {}),
        });

        if (preflight.failureReason !== undefined || preflight.status === "error") {
          return buildFailureResult(preflight, preflight.failureReason ?? "preflight");
        }

        if (!supportsOneOffConnectivityProbe(params.provider)) {
          return buildReadyResult(preflight);
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

        const settings = yield* serverSettings.getSettings.pipe(
          Effect.orElseSucceed(() => DEFAULT_SERVER_SETTINGS),
        );

        return yield* Effect.all(
          HARNESS_VALIDATION_ORDER.map((provider) =>
            validateProvider(
              input?.providerOptions
                ? {
                    provider,
                    settings,
                    providerOptions: input.providerOptions,
                  }
                : {
                    provider,
                    settings,
                  },
            ),
          ),
          { concurrency: 4 },
        ).pipe(Effect.ensuring(Ref.set(inFlight, false)));
      });

    return {
      validate,
    } satisfies HarnessValidationShape;
  }),
);
