/**
 * TextGenerationLive — registry-backed implementation of the `TextGeneration`
 * service tag.
 *
 * The `TextGeneration` tag is kept as a thin facade over
 * `ProviderInstanceRegistry`. Every op pulls `modelSelection.instanceId`,
 * looks up the matching `ProviderInstance`, and delegates to that instance's
 * own `textGeneration` closure (built by its driver's `create()`).
 *
 * There is deliberately no per-driver dispatch here — the registry already
 * knows which driver backs each instance, and each `ProviderInstance`
 * carries the fully-bound `TextGenerationShape` produced by its driver.
 * That means:
 *
 *   - Multiple instances of the same driver (e.g. `codex_personal`,
 *     `codex_work`) each get their own text-generation closure bound to
 *     their own settings — the routing is by instance, not by driver.
 *   - Unknown or disabled instances surface a `TextGenerationError` with
 *     the missing `instanceId`, instead of silently falling back to a
 *     default.
 *
 * This replaces the old `RoutingTextGenerationLive`, which tried to route
 * by driver-kind and misused `modelSelection.instanceId` as a driver-id
 * literal.
 *
 * @module git/Layers/TextGenerationLive
 */
import { Effect, Layer } from "effect";

import { TextGenerationError } from "../Errors.ts";
import {
  DEFAULT_GIT_TEXT_GENERATION_MODEL,
  ProviderInstanceId,
  type ModelSelection,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";

import {
  ProviderInstanceRegistry,
  type ProviderInstanceRegistryShape,
} from "../../provider/Services/ProviderInstanceRegistry.ts";
import type { ProviderInstance } from "../../provider/ProviderDriver.ts";
import { TextGeneration, type TextGenerationShape } from "../Services/TextGeneration.ts";

type TextGenerationOp =
  | "generateCommitMessage"
  | "generatePrContent"
  | "generateBranchName"
  | "generateThreadTitle";

const resolveInstance = (
  registry: ProviderInstanceRegistryShape,
  operation: TextGenerationOp,
  instanceId: ProviderInstanceId,
): Effect.Effect<ProviderInstance["textGeneration"], TextGenerationError> =>
  registry.getInstance(instanceId).pipe(
    Effect.flatMap((instance) =>
      instance
        ? Effect.succeed(instance.textGeneration)
        : Effect.fail(
            new TextGenerationError({
              operation,
              detail: `No provider instance registered for id '${instanceId}'.`,
            }),
          ),
    ),
  );

/**
 * Build a `TextGenerationShape` that routes every call through the
 * registry. Exposed separately from the Layer so tests can construct it
 * against a stub registry without layering gymnastics.
 */
export const makeTextGenerationFromRegistry = (
  registry: ProviderInstanceRegistryShape,
): TextGenerationShape => ({
  generateCommitMessage: (input) =>
    Effect.succeed(input.modelSelection ?? defaultCodexModelSelection(input.model)).pipe(
      Effect.flatMap((modelSelection) =>
        resolveInstance(registry, "generateCommitMessage", modelSelection.instanceId).pipe(
          Effect.flatMap((tg) => tg.generateCommitMessage({ ...input, modelSelection })),
        ),
      ),
    ),
  generatePrContent: (input) =>
    Effect.succeed(input.modelSelection ?? defaultCodexModelSelection(input.model)).pipe(
      Effect.flatMap((modelSelection) =>
        resolveInstance(registry, "generatePrContent", modelSelection.instanceId).pipe(
          Effect.flatMap((tg) => tg.generatePrContent({ ...input, modelSelection })),
        ),
      ),
    ),
  generateBranchName: (input) =>
    Effect.succeed(input.modelSelection ?? defaultCodexModelSelection(input.model)).pipe(
      Effect.flatMap((modelSelection) =>
        resolveInstance(registry, "generateBranchName", modelSelection.instanceId).pipe(
          Effect.flatMap((tg) => tg.generateBranchName({ ...input, modelSelection })),
        ),
      ),
    ),
  generateThreadTitle: (input) =>
    Effect.succeed(input.modelSelection ?? defaultCodexModelSelection(input.model)).pipe(
      Effect.flatMap((modelSelection) =>
        resolveInstance(registry, "generateThreadTitle", modelSelection.instanceId).pipe(
          Effect.flatMap((tg) => tg.generateThreadTitle({ ...input, modelSelection })),
        ),
      ),
    ),
});

const defaultCodexModelSelection = (model?: string): ModelSelection =>
  createModelSelection(
    ProviderInstanceId.make("codex"),
    model ?? DEFAULT_GIT_TEXT_GENERATION_MODEL,
  );

/**
 * `TextGeneration` Layer wired to the `ProviderInstanceRegistry`. The rest
 * of the server keeps using `yield* TextGeneration` — only the underlying
 * wiring changed from kind-based routing to instance-based routing.
 */
export const TextGenerationLive = Layer.effect(
  TextGeneration,
  Effect.gen(function* () {
    const registry = yield* ProviderInstanceRegistry;
    return makeTextGenerationFromRegistry(registry);
  }),
);
