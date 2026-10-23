import type { ThreadSettlementService } from "../orchestration/Layers/ThreadSettlementService.ts";
import type { PullRequestWatchService } from "../orchestration/Layers/PullRequestWatchService.ts";
import type { makeHtmlRenderRuntime } from "../htmlRender/HtmlRenderRuntime.ts";
import { PullRequestKey } from "@t3tools/contracts";
import { Effect } from "effect";
import {
  formatSourceControlPullRequestKey,
  parseSourceControlPullRequestKey,
} from "@t3tools/shared/sourceControl";
import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import type { PrHubFederationShape } from "../prHub/Layers/PrHubFederation.ts";
import type { PrHubReviewGuideService } from "../prHub/Layers/PrHubReviewGuideService.ts";
import type { PrHubExtensions } from "../prHub/PrHubExtensions.ts";
import { ThreadToolError, type ThreadToolHandler } from "./threadMcpTools.ts";

export function makeThreadToolHandler(input: {
  readonly engine: Pick<OrchestrationEngineShape, "getReadModel">;
  readonly federation: Pick<PrHubFederationShape, "resolve" | "parseUrl">;
  readonly settlement: Pick<ThreadSettlementService["Service"], "settleFromAgent">;
  readonly watches: Pick<PullRequestWatchService["Service"], "startWatch" | "stopWatch">;
  readonly guides: PrHubReviewGuideService["Service"];
  readonly html: Effect.Success<ReturnType<typeof makeHtmlRenderRuntime>>;
  readonly links: Pick<PrHubExtensions["Service"], "getThreadLinks">;
}): ThreadToolHandler {
  return (threadId, request) =>
    Effect.gen(function* () {
      const model = yield* input.engine.getReadModel();
      const thread = model.threads.find((value) => value.id === threadId && !value.deletedAt);
      if (!thread)
        return yield* new ThreadToolError({ message: "This thread is no longer available." });
      if (request.name === "thread_settle")
        return yield* input.settlement.settleFromAgent(threadId);
      if (request.name === "thread_status")
        return {
          threadId,
          title: thread.title,
          archivedAt: thread.archivedAt,
          settledAt: thread.settledAt ?? null,
          settledBy: thread.settledBy ?? null,
          autoSettleDisabled: thread.autoSettleDisabled ?? false,
          pinnedAt: thread.pinnedAt,
          snoozedUntil: thread.snoozedUntil,
          latestTurn: thread.latestTurn,
          sessionStatus: thread.session?.status ?? null,
        };
      if (request.name === "html_preview")
        return yield* input.html.preview(threadId, request.input);
      if (request.name === "html_render") return yield* input.html.publish(threadId, request.input);
      if (request.name === "watch_pull_request" || request.name === "unwatch_pull_request") {
        const target = { threadId, ...(request.pr ? { pr: request.pr } : {}) };
        return request.name === "watch_pull_request"
          ? yield* input.watches.startWatch(target)
          : yield* input.watches.stopWatch(target).pipe(Effect.as({ stopped: true }));
      }
      if (thread.archivedAt && request.name === "pull_request_review_guide_write")
        return yield* new ThreadToolError({
          message: "Unarchive this thread before starting a guide.",
        });
      const links = yield* input.links.getThreadLinks(threadId);
      const parsed = request.pr
        ? (parseSourceControlPullRequestKey(request.pr) ??
          (yield* input.federation.parseUrl(request.pr)))
        : links.length === 1
          ? links[0]
          : null;
      if (!parsed)
        return yield* new ThreadToolError({
          message: "Specify a PR URL or key, or link exactly one PR to this thread.",
        });
      const key = PullRequestKey.makeUnsafe(formatSourceControlPullRequestKey(parsed));
      // Capture the verified account incarnation before starting any remote guide operation.
      const runtime = yield* input.federation.resolve({ key });
      const target = { key, accountGeneration: runtime.account.generation };
      return yield* request.name === "pull_request_review_guide_write"
        ? input.guides.generate(target)
        : input.guides.get({ ...target, mode: "force" });
    }).pipe(
      Effect.mapError(
        () =>
          new ThreadToolError({
            message:
              "Thread tool failed. Check the PR target, account and current thread, then retry.",
          }),
      ),
    );
}
