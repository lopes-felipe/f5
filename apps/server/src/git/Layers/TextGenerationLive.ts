import { resolveProjectProviderInstanceEnabled } from "@t3tools/shared/serverSettings";
import { readProjectSettings, readProjectForCwd } from "../../project/projectSettings.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ProjectionProjectRepository } from "../../persistence/Services/ProjectionProjects.ts";
import { ProjectionThreadRepository } from "../../persistence/Services/ProjectionThreads.ts";
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
import { Effect, Layer, Schema } from "effect";

import { readRepositoryWritingContext } from "../repositoryInstructions.ts";
import { TextGenerationError } from "../Errors.ts";
import {
  DEFAULT_GIT_TEXT_GENERATION_MODEL,
  ProviderInstanceId,
  type ModelSelection,
  type ServerProvider,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";

import {
  ProviderInstanceRegistry,
  type ProviderInstanceRegistryShape,
} from "../../provider/Services/ProviderInstanceRegistry.ts";
import type { ProviderInstance } from "../../provider/ProviderDriver.ts";
import { ProviderRegistry } from "../../provider/Services/ProviderRegistry";
import { TextGeneration, type TextGenerationShape } from "../Services/TextGeneration.ts";

type TextGenerationOp =
  | "generateCommitMessage"
  | "generatePrContent"
  | "generateBranchName"
  | "generateThreadTitle"
  | "generateStructuredJson";

const resolveInstance = (
  registry: ProviderInstanceRegistryShape,
  operation: TextGenerationOp,
  instanceId: ProviderInstanceId,
): Effect.Effect<ProviderInstance, TextGenerationError> =>
  registry.getInstance(instanceId).pipe(
    Effect.flatMap((instance) =>
      instance
        ? Effect.succeed(instance)
        : Effect.fail(
            new TextGenerationError({
              operation,
              detail: `No provider instance registered for id '${instanceId}'.`,
            }),
          ),
    ),
  );

const resolveInstanceSelection = (
  registry: ProviderInstanceRegistryShape,
  operation: TextGenerationOp,
  selection: ModelSelection,
  getProviders: Effect.Effect<ReadonlyArray<ServerProvider>>,
) =>
  resolveInstance(registry, operation, selection.instanceId).pipe(
    Effect.flatMap((instance) =>
      getProviders.pipe(
        Effect.map((providers) => {
          const snapshot = providers.find(
            (provider) => provider.instanceId === selection.instanceId,
          );
          return {
            instance,
            modelSelection: snapshot ? resolveAuxiliaryTextModel(selection, snapshot) : selection,
          };
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
  getProviders: Effect.Effect<ReadonlyArray<ServerProvider>> = Effect.succeed([]),
  resolveSelection: (
    operation: TextGenerationOp,
    input: { cwd: string; modelSelection?: ModelSelection; model?: string },
  ) => Effect.Effect<ModelSelection, TextGenerationError> = (_operation, input) =>
    Effect.succeed(input.modelSelection ?? defaultCodexModelSelection(input.model)),
): TextGenerationShape => ({
  generateCommitMessage: (input) =>
    resolveSelection("generateCommitMessage", input).pipe(
      Effect.flatMap((modelSelection) =>
        resolveInstanceSelection(
          registry,
          "generateCommitMessage",
          modelSelection,
          getProviders,
        ).pipe(
          Effect.flatMap(({ instance, modelSelection }) =>
            Effect.promise(() =>
              readRepositoryWritingContext(
                input.cwd,
                instance.driverKind,
                input.writingPreferences,
              ),
            ).pipe(
              Effect.flatMap((repositoryContext) =>
                instance.textGeneration.generateCommitMessage({
                  ...input,
                  modelSelection,
                  repositoryContext,
                }),
              ),
            ),
          ),
        ),
      ),
    ),
  generatePrContent: (input) =>
    resolveSelection("generatePrContent", input).pipe(
      Effect.flatMap((modelSelection) =>
        resolveInstanceSelection(registry, "generatePrContent", modelSelection, getProviders).pipe(
          Effect.flatMap(({ instance, modelSelection }) =>
            Effect.promise(() =>
              readRepositoryWritingContext(
                input.cwd,
                instance.driverKind,
                input.writingPreferences,
              ),
            ).pipe(
              Effect.flatMap((repositoryContext) =>
                instance.textGeneration.generatePrContent({
                  ...input,
                  modelSelection,
                  repositoryContext,
                }),
              ),
            ),
          ),
        ),
      ),
    ),
  generateBranchName: (input) =>
    resolveSelection("generateBranchName", input).pipe(
      Effect.flatMap((modelSelection) =>
        resolveInstanceSelection(registry, "generateBranchName", modelSelection, getProviders).pipe(
          Effect.flatMap(({ instance: tg, modelSelection }) =>
            tg.textGeneration.generateBranchName({ ...input, modelSelection }),
          ),
        ),
      ),
    ),
  generateThreadTitle: (input) =>
    resolveSelection("generateThreadTitle", input).pipe(
      Effect.flatMap((modelSelection) =>
        resolveInstanceSelection(
          registry,
          "generateThreadTitle",
          modelSelection,
          getProviders,
        ).pipe(
          Effect.flatMap(({ instance: tg, modelSelection }) =>
            tg.textGeneration.generateThreadTitle({ ...input, modelSelection }),
          ),
        ),
      ),
    ),
  generateStructuredJson: (input) =>
    resolveSelection("generateStructuredJson", input).pipe(
      Effect.flatMap((modelSelection) =>
        resolveInstanceSelection(
          registry,
          "generateStructuredJson",
          modelSelection,
          getProviders,
        ).pipe(
          Effect.flatMap(({ instance: tg, modelSelection }) =>
            input.isolation === "no-workspace" && !supportsNoWorkspaceIsolation(tg.driverKind)
              ? Effect.fail(
                  new TextGenerationError({
                    operation: input.operation,
                    detail: `${tg.driverKind} cannot run without workspace access; choose a Claude instance.`,
                    kind: "unsupported",
                  }),
                )
              : tg.textGeneration.generateStructuredJson({ ...input, modelSelection }),
          ),
        ),
      ),
    ),
});

/**
 * Drivers whose structured generation runs with no tools, strict empty MCP
 * config, slash commands disabled, and a scoped temp cwd. Codex `exec -s
 * read-only` can still read the filesystem, so it does not qualify.
 */
export function supportsNoWorkspaceIsolation(driverKind: string): boolean {
  return driverKind === "claudeAgent";
}

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
    const providers = yield* ProviderRegistry;
    const settings = yield* ServerSettingsService;
    const projects = yield* ProjectionProjectRepository;
    const threads = yield* ProjectionThreadRepository;
    return makeTextGenerationFromRegistry(registry, providers.getProviders, (operation, input) =>
      Effect.gen(function* () {
        const global = yield* settings.getSettings;
        const project = yield* readProjectForCwd(input.cwd).pipe(
          Effect.provideService(ProjectionProjectRepository, projects),
          Effect.provideService(ProjectionThreadRepository, threads),
        );
        const selected = input.modelSelection ?? defaultCodexModelSelection(input.model);
        if (resolveProjectProviderInstanceEnabled(global, project?.projectId, selected.instanceId))
          return selected;
        if (project) {
          const resolved = (yield* readProjectSettings(global, {
            ...project,
            id: project.projectId,
          })).settings;
          const fallback = resolved.textGenerationModelSelection;
          if (resolveProjectProviderInstanceEnabled(global, project.projectId, fallback.instanceId))
            return fallback;
        }
        return yield* new TextGenerationError({
          operation,
          detail: "No enabled provider is available for this project's text generation.",
        });
      }).pipe(
        Effect.mapError((cause) =>
          Schema.is(TextGenerationError)(cause)
            ? cause
            : new TextGenerationError({
                operation,
                detail: "Project provider settings could not be read.",
              }),
        ),
      ),
    );
  }),
);

const AUXILIARY_DEFAULT_MODELS = new Set([
  "gpt-6-luna",
  "gpt-5.4-mini",
  "claude-haiku-5-5",
  "claude-haiku-4-5",
  "claude-sonnet-4-6",
]);
const AUXILIARY_FALLBACKS: Record<string, readonly string[]> = {
  codex: ["gpt-6-luna", "gpt-5.6-luna", "gpt-5.4-mini"],
  claudeAgent: ["claude-haiku-5-5", "claude-haiku-4-5"],
};
export function resolveAuxiliaryTextModel(
  selection: ModelSelection,
  snapshot: ServerProvider,
): ModelSelection {
  if (!AUXILIARY_DEFAULT_MODELS.has(selection.model)) return selection;
  const selected = snapshot.models.find((model) => model.slug === selection.model);
  // A Claude version gate remains authoritative even if initialization fails.
  // Failed/partial Codex discovery cannot establish current availability.
  if (
    (snapshot.modelCatalog?.status === "failed" || snapshot.modelCatalog?.status === "partial") &&
    !(snapshot.driver === "claudeAgent" && selected?.isUnlisted === true)
  )
    return selection;
  if (selected?.isUnlisted !== true && (selected || snapshot.modelCatalog?.status !== "complete"))
    return selection;
  const listed = snapshot.models.filter((model) => model.isCustom || !model.isUnlisted);
  const fallback =
    AUXILIARY_FALLBACKS[snapshot.driver]
      ?.map((slug) => listed.find((model) => model.slug === slug))
      .find(Boolean) ?? listed[0];
  return fallback ? { ...selection, model: fallback.slug } : selection;
}
