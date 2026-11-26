import {
  ORCHESTRATION_WS_METHODS,
  type WorkflowPlatformCreateRunInput,
  WS_METHODS,
} from "@t3tools/contracts";
import { Effect, Struct } from "effect";

import type { CodeReviewWorkflowServiceShape } from "../../orchestration/Services/CodeReviewWorkflowService.ts";
import type { InvestigationWorkflowServiceShape } from "../../orchestration/Services/InvestigationWorkflowService.ts";
import type { OrchestrationEngineShape } from "../../orchestration/Services/OrchestrationEngine.ts";
import type { WorkflowServiceShape } from "../../orchestration/Services/WorkflowService.ts";
import { RouteRequestError } from "../../turnSubmissionErrors.ts";
import {
  BUILTIN_WORKFLOW_TEMPLATES,
  createWorkflowPlatformRun,
  inspectWorkflowPlatformRun,
} from "../../workflowPlatform.ts";
import type { RouteTable } from "./routeTable.ts";

type WorkflowMethod =
  | typeof ORCHESTRATION_WS_METHODS.createWorkflow
  | typeof ORCHESTRATION_WS_METHODS.archiveWorkflow
  | typeof ORCHESTRATION_WS_METHODS.unarchiveWorkflow
  | typeof ORCHESTRATION_WS_METHODS.createCodeReviewWorkflow
  | typeof ORCHESTRATION_WS_METHODS.createInvestigationWorkflow
  | typeof ORCHESTRATION_WS_METHODS.archiveCodeReviewWorkflow
  | typeof ORCHESTRATION_WS_METHODS.archiveInvestigationWorkflow
  | typeof ORCHESTRATION_WS_METHODS.unarchiveCodeReviewWorkflow
  | typeof ORCHESTRATION_WS_METHODS.unarchiveInvestigationWorkflow
  | typeof ORCHESTRATION_WS_METHODS.deleteWorkflow
  | typeof ORCHESTRATION_WS_METHODS.deleteCodeReviewWorkflow
  | typeof ORCHESTRATION_WS_METHODS.deleteInvestigationWorkflow
  | typeof ORCHESTRATION_WS_METHODS.skipDocumentReaderPass
  | typeof ORCHESTRATION_WS_METHODS.retryWorkflow
  | typeof ORCHESTRATION_WS_METHODS.retryCodeReviewWorkflow
  | typeof ORCHESTRATION_WS_METHODS.postCodeReviewWorkflow
  | typeof ORCHESTRATION_WS_METHODS.retryInvestigationWorkflow
  | typeof ORCHESTRATION_WS_METHODS.startImplementation
  | typeof WS_METHODS.workflowPlatformListTemplates
  | typeof WS_METHODS.workflowPlatformCreateRun
  | typeof WS_METHODS.workflowPlatformInspectRun;

export interface WorkflowRouteDependencies {
  readonly runtime: Effect.Effect<
    {
      readonly orchestrationEngine: Pick<OrchestrationEngineShape, "getReadModel">;
      readonly workflowService: WorkflowServiceShape;
      readonly codeReviewWorkflowService: CodeReviewWorkflowServiceShape;
      readonly investigationWorkflowService: InvestigationWorkflowServiceShape;
    },
    RouteRequestError
  >;
}

const withoutTag = <Body extends { readonly _tag: string }>(body: Body) =>
  Struct.omit(body, ["_tag"]);

/**
 * Multi-agent workflow routes (planning, code review, investigation) and
 * workflow platform template/run inspection endpoints.
 */
export const workflowRoutes = ({
  runtime,
}: WorkflowRouteDependencies): RouteTable<WorkflowMethod, never, RouteRequestError> => ({
  [ORCHESTRATION_WS_METHODS.createWorkflow]: (request) =>
    Effect.gen(function* () {
      const { workflowService } = yield* runtime;
      const workflowId = yield* workflowService
        .createWorkflow(withoutTag(request))
        .pipe(
          Effect.mapError(
            (cause) =>
              new RouteRequestError({ message: `Failed to create workflow: ${String(cause)}` }),
          ),
        );
      return { workflowId };
    }),

  [ORCHESTRATION_WS_METHODS.archiveWorkflow]: (request) =>
    Effect.gen(function* () {
      const { workflowService } = yield* runtime;
      yield* workflowService
        .archiveWorkflow(request.workflowId)
        .pipe(
          Effect.mapError(
            (cause) =>
              new RouteRequestError({ message: `Failed to archive workflow: ${String(cause)}` }),
          ),
        );
      return undefined;
    }),

  [ORCHESTRATION_WS_METHODS.unarchiveWorkflow]: (request) =>
    Effect.gen(function* () {
      const { workflowService } = yield* runtime;
      yield* workflowService
        .unarchiveWorkflow(request.workflowId)
        .pipe(
          Effect.mapError(
            (cause) =>
              new RouteRequestError({ message: `Failed to unarchive workflow: ${String(cause)}` }),
          ),
        );
      return undefined;
    }),

  [ORCHESTRATION_WS_METHODS.createCodeReviewWorkflow]: (request) =>
    Effect.gen(function* () {
      const { codeReviewWorkflowService } = yield* runtime;
      const workflowId = yield* codeReviewWorkflowService.createWorkflow(withoutTag(request)).pipe(
        Effect.mapError(
          (cause) =>
            new RouteRequestError({
              message: `Failed to create code review workflow: ${String(cause)}`,
            }),
        ),
      );
      return { workflowId };
    }),

  [ORCHESTRATION_WS_METHODS.createInvestigationWorkflow]: (request) =>
    Effect.gen(function* () {
      const { investigationWorkflowService } = yield* runtime;
      const workflowId = yield* investigationWorkflowService
        .createWorkflow(withoutTag(request))
        .pipe(
          Effect.mapError(
            (cause) =>
              new RouteRequestError({
                message: `Failed to create investigation workflow: ${String(cause)}`,
              }),
          ),
        );
      return { workflowId };
    }),

  [ORCHESTRATION_WS_METHODS.archiveCodeReviewWorkflow]: (request) =>
    Effect.gen(function* () {
      const { codeReviewWorkflowService } = yield* runtime;
      yield* codeReviewWorkflowService.archiveWorkflow(request.workflowId).pipe(
        Effect.mapError(
          (cause) =>
            new RouteRequestError({
              message: `Failed to archive code review workflow: ${String(cause)}`,
            }),
        ),
      );
      return undefined;
    }),

  [ORCHESTRATION_WS_METHODS.archiveInvestigationWorkflow]: (request) =>
    Effect.gen(function* () {
      const { investigationWorkflowService } = yield* runtime;
      yield* investigationWorkflowService.archiveWorkflow(request.workflowId).pipe(
        Effect.mapError(
          (cause) =>
            new RouteRequestError({
              message: `Failed to archive investigation workflow: ${String(cause)}`,
            }),
        ),
      );
      return undefined;
    }),

  [ORCHESTRATION_WS_METHODS.unarchiveCodeReviewWorkflow]: (request) =>
    Effect.gen(function* () {
      const { codeReviewWorkflowService } = yield* runtime;
      yield* codeReviewWorkflowService.unarchiveWorkflow(request.workflowId).pipe(
        Effect.mapError(
          (cause) =>
            new RouteRequestError({
              message: `Failed to unarchive code review workflow: ${String(cause)}`,
            }),
        ),
      );
      return undefined;
    }),

  [ORCHESTRATION_WS_METHODS.unarchiveInvestigationWorkflow]: (request) =>
    Effect.gen(function* () {
      const { investigationWorkflowService } = yield* runtime;
      yield* investigationWorkflowService.unarchiveWorkflow(request.workflowId).pipe(
        Effect.mapError(
          (cause) =>
            new RouteRequestError({
              message: `Failed to unarchive investigation workflow: ${String(cause)}`,
            }),
        ),
      );
      return undefined;
    }),

  [ORCHESTRATION_WS_METHODS.deleteWorkflow]: (request) =>
    Effect.gen(function* () {
      const { workflowService } = yield* runtime;
      return yield* workflowService
        .deleteWorkflow(request.workflowId, request.deleteThreads)
        .pipe(
          Effect.mapError(
            (cause) =>
              new RouteRequestError({ message: `Failed to delete workflow: ${String(cause)}` }),
          ),
        );
    }),

  [ORCHESTRATION_WS_METHODS.deleteCodeReviewWorkflow]: (request) =>
    Effect.gen(function* () {
      const { codeReviewWorkflowService } = yield* runtime;
      return yield* codeReviewWorkflowService
        .deleteWorkflow(request.workflowId, request.deleteThreads)
        .pipe(
          Effect.mapError(
            (cause) =>
              new RouteRequestError({
                message: `Failed to delete code review workflow: ${String(cause)}`,
              }),
          ),
        );
    }),

  [ORCHESTRATION_WS_METHODS.deleteInvestigationWorkflow]: (request) =>
    Effect.gen(function* () {
      const { investigationWorkflowService } = yield* runtime;
      return yield* investigationWorkflowService
        .deleteWorkflow(request.workflowId, request.deleteThreads)
        .pipe(
          Effect.mapError(
            (cause) =>
              new RouteRequestError({
                message: `Failed to delete investigation workflow: ${String(cause)}`,
              }),
          ),
        );
    }),

  [ORCHESTRATION_WS_METHODS.skipDocumentReaderPass]: (request) =>
    Effect.gen(function* () {
      const { workflowService } = yield* runtime;
      return yield* workflowService.skipDocumentReaderPass(withoutTag(request)).pipe(
        Effect.mapError(
          (cause) =>
            new RouteRequestError({
              message: `Failed to finish without reader review: ${String(cause)}`,
            }),
        ),
      );
    }),

  [ORCHESTRATION_WS_METHODS.retryWorkflow]: (request) =>
    Effect.gen(function* () {
      const { workflowService } = yield* runtime;
      return yield* workflowService
        .retryWorkflow(withoutTag(request))
        .pipe(
          Effect.mapError(
            (cause) =>
              new RouteRequestError({ message: `Failed to retry workflow: ${String(cause)}` }),
          ),
        );
    }),

  [ORCHESTRATION_WS_METHODS.retryCodeReviewWorkflow]: (request) =>
    Effect.gen(function* () {
      const { codeReviewWorkflowService } = yield* runtime;
      return yield* codeReviewWorkflowService.retryWorkflow(withoutTag(request)).pipe(
        Effect.mapError(
          (cause) =>
            new RouteRequestError({
              message: `Failed to retry code review workflow: ${String(cause)}`,
            }),
        ),
      );
    }),

  [ORCHESTRATION_WS_METHODS.postCodeReviewWorkflow]: (request) =>
    Effect.gen(function* () {
      const { codeReviewWorkflowService } = yield* runtime;
      return yield* codeReviewWorkflowService
        .postWorkflow(withoutTag(request))
        .pipe(Effect.mapError((cause) => new RouteRequestError({ message: cause.message })));
    }),

  [ORCHESTRATION_WS_METHODS.retryInvestigationWorkflow]: (request) =>
    Effect.gen(function* () {
      const { investigationWorkflowService } = yield* runtime;
      yield* investigationWorkflowService.retryWorkflow(withoutTag(request)).pipe(
        Effect.mapError(
          (cause) =>
            new RouteRequestError({
              message: `Failed to retry investigation workflow: ${String(cause)}`,
            }),
        ),
      );
      return undefined;
    }),

  [ORCHESTRATION_WS_METHODS.startImplementation]: (request) =>
    Effect.gen(function* () {
      const { workflowService } = yield* runtime;
      const body = withoutTag(request);
      yield* workflowService
        .startImplementation({
          workflowId: body.workflowId,
          provider: body.provider,
          model: body.model,
          runtimeMode: body.runtimeMode,
          codeReviewEnabled: body.codeReviewEnabled,
          envMode: body.envMode,
          ...(body.modelOptions ? { modelOptions: body.modelOptions } : {}),
          ...(body.providerOptions ? { providerOptions: body.providerOptions } : {}),
          ...(body.baseBranch ? { baseBranch: body.baseBranch } : {}),
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new RouteRequestError({
                message: `Failed to start implementation: ${String(cause)}`,
              }),
          ),
        );
      return undefined;
    }),

  [WS_METHODS.workflowPlatformListTemplates]: () =>
    Effect.succeed({ templates: BUILTIN_WORKFLOW_TEMPLATES }),

  [WS_METHODS.workflowPlatformCreateRun]: (request) =>
    Effect.gen(function* () {
      const { workflowService, codeReviewWorkflowService, investigationWorkflowService } =
        yield* runtime;
      const body = withoutTag(request) as WorkflowPlatformCreateRunInput;
      return yield* createWorkflowPlatformRun(body, {
        planning: workflowService,
        codeReview: codeReviewWorkflowService,
        investigation: investigationWorkflowService,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new RouteRequestError({ message: `Failed to create workflow run: ${String(cause)}` }),
        ),
      );
    }),

  [WS_METHODS.workflowPlatformInspectRun]: (request) =>
    Effect.gen(function* () {
      const body = withoutTag(request);
      const { orchestrationEngine } = yield* runtime;
      const snapshot = yield* orchestrationEngine.getReadModel();
      return yield* Effect.try({
        try: () => ({
          inspection: inspectWorkflowPlatformRun(body, snapshot),
          ...(body.includeWorkflow
            ? {
                workflowDetails:
                  body.runKind === "planning"
                    ? {
                        runKind: "planning" as const,
                        workflow: snapshot.planningWorkflows.find(
                          (workflow) => workflow.id === body.workflowId,
                        )!,
                      }
                    : body.runKind === "codeReview"
                      ? {
                          runKind: "codeReview" as const,
                          workflow: snapshot.codeReviewWorkflows.find(
                            (workflow) => workflow.id === body.workflowId,
                          )!,
                        }
                      : {
                          runKind: "investigation" as const,
                          workflow: snapshot.investigationWorkflows.find(
                            (workflow) => workflow.id === body.workflowId,
                          )!,
                        },
              }
            : {}),
        }),
        catch: (cause) =>
          new RouteRequestError({ message: `Failed to inspect workflow run: ${String(cause)}` }),
      });
    }),
});
