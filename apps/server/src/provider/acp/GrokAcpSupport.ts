import { type GrokSettings, ProviderDriverKind, type RuntimeMode } from "@t3tools/contracts";
import { normalizeModelSlug } from "@t3tools/shared/model";
import { Effect, Layer, Scope } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import type * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import { findModelConfigOption } from "./AcpRuntimeModel.ts";
import {
  AcpSessionRuntime,
  type AcpSessionRuntimeOptions,
  type AcpSessionRuntimeShape,
  type AcpSpawnInput,
} from "./AcpSessionRuntime.ts";

const GROK_API_KEY_ENV = "XAI_API_KEY";
const GROK_OAUTH2_REFERRER_ENV = "GROK_OAUTH2_REFERRER";
const T3_CODE_OAUTH_REFERRER = "t3code";
const GROK_AUTH_METHOD_API_KEY = "xai.api_key";
const GROK_AUTH_METHOD_CACHED_TOKEN = "cached_token";
const GROK_DRIVER_KIND = ProviderDriverKind.make("grok");

type GrokAcpRuntimeGrokSettings = Pick<GrokSettings, "binaryPath">;

export interface GrokAcpRuntimeInput extends Omit<
  AcpSessionRuntimeOptions,
  "authMethodId" | "clientCapabilities" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly grokSettings: GrokAcpRuntimeGrokSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
  readonly runtimeMode?: RuntimeMode;
}

/**
 * Supervised goes on the argv so an always-approve in the user's Grok config cannot skip the
 * approval prompts. Full access keeps Grok asking too: the adapter answers each request itself,
 * which keeps computer-use requests in front of the user.
 */
export function grokAcpSpawnArgs(runtimeMode?: RuntimeMode): ReadonlyArray<string> {
  return runtimeMode === "approval-required"
    ? ["--permission-mode", "default", "agent", "stdio"]
    : ["agent", "stdio"];
}

export function buildGrokAcpSpawnInput(
  grokSettings: GrokAcpRuntimeGrokSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
  runtimeMode?: RuntimeMode,
): AcpSpawnInput {
  return {
    command: grokSettings?.binaryPath || "grok",
    args: [...grokAcpSpawnArgs(runtimeMode)],
    cwd,
    env: {
      ...environment,
      [GROK_OAUTH2_REFERRER_ENV]: T3_CODE_OAUTH_REFERRER,
    },
  };
}

function resolveGrokAuthMethodId(environment: NodeJS.ProcessEnv | undefined): string {
  return environment?.[GROK_API_KEY_ENV]?.trim()
    ? GROK_AUTH_METHOD_API_KEY
    : GROK_AUTH_METHOD_CACHED_TOKEN;
}

export const makeGrokAcpRuntime = (
  input: GrokAcpRuntimeInput,
): Effect.Effect<AcpSessionRuntimeShape, EffectAcpErrors.AcpError, Scope.Scope> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildGrokAcpSpawnInput(
          input.grokSettings,
          input.cwd,
          input.environment,
          input.runtimeMode,
        ),
        authMethodId: resolveGrokAuthMethodId(input.environment),
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    return yield* Effect.service(AcpSessionRuntime).pipe(Effect.provide(acpContext));
  });

export function resolveGrokAcpBaseModelId(model: string | null | undefined): string {
  const trimmed = model?.trim();
  const base = trimmed && trimmed.length > 0 ? trimmed : "grok-build";
  return normalizeModelSlug(base, GROK_DRIVER_KIND) ?? "grok-build";
}

type AcpSessionSetupResult =
  | EffectAcpSchema.LoadSessionResponse
  | EffectAcpSchema.NewSessionResponse
  | EffectAcpSchema.ResumeSessionResponse;

/**
 * Where the runtime's `setSessionModel` writes the model. Grok uses
 * `session/set_model` (the session model state); custom ACP and Antigravity
 * write the model config option when the agent has one.
 */
export type AcpModelWriteTarget = "model-state" | "config-option";

/** The current model, read from the same place the runtime writes it. */
export function currentGrokModelIdFromSessionSetup(
  sessionSetupResult: AcpSessionSetupResult,
  writeTarget: AcpModelWriteTarget = "model-state",
): string | undefined {
  const modelOption = findModelConfigOption(sessionSetupResult.configOptions);
  if (writeTarget === "config-option" && modelOption)
    return modelOption.currentValue.trim() || undefined;
  const reported = sessionSetupResult.models?.currentModelId?.trim();
  if (reported) return reported;
  return modelOption?.currentValue.trim() || undefined;
}

/**
 * Models the agent offers through the selector the runtime writes, or
 * undefined when it lists none. Stored catalog choices can expire, so a
 * startup selection outside this list (and not a configured custom model) is
 * skipped instead of failing the session.
 */
export function offeredAcpModelIds(
  sessionSetupResult: AcpSessionSetupResult,
): ReadonlyArray<string> | undefined {
  const modelOption = findModelConfigOption(sessionSetupResult.configOptions);
  if (modelOption)
    return modelOption.options.flatMap((entry) =>
      "value" in entry ? [entry.value] : entry.options.map((choice) => choice.value),
    );
  return sessionSetupResult.models?.availableModels.map((model) => model.modelId);
}

export function applyGrokAcpModelSelection<E>(input: {
  readonly runtime: Pick<AcpSessionRuntimeShape, "setSessionModel">;
  readonly currentModelId: string | undefined;
  readonly requestedModelId: string | undefined;
  readonly defaultModelId?: string;
  /** When set, a requested model must be offered or a configured custom model. */
  readonly availableModels?: {
    readonly offered: ReadonlyArray<string> | undefined;
    readonly custom: ReadonlyArray<string>;
  };
  readonly mapError: (cause: EffectAcpErrors.AcpError) => E;
}): Effect.Effect<string | undefined, E> {
  const available = input.availableModels;
  if (
    !input.requestedModelId ||
    input.requestedModelId === (input.defaultModelId ?? "grok-build") ||
    input.requestedModelId === input.currentModelId ||
    (available?.offered !== undefined &&
      !available.offered.includes(input.requestedModelId) &&
      !available.custom.includes(input.requestedModelId))
  ) {
    return Effect.succeed(input.currentModelId);
  }
  return input.runtime
    .setSessionModel(input.requestedModelId)
    .pipe(Effect.mapError(input.mapError), Effect.as(input.requestedModelId));
}
